package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
)

func TestPhoneAccountsMigrationAndExternalProfileTransaction(t *testing.T) {
	ctx := context.Background()
	pool, migrations := skillRoleTestDatabase(t, 70)
	execSkillRoleSQL(t, pool, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES ('legacy','legacy@example.com','历史员工','unused','active',now(),now())`)
	if _, err := migrations.UpTo(ctx, 71); err != nil {
		t.Fatal(err)
	}
	store := accounts.NewPostgresStore(pool)
	service := accounts.NewService(accounts.Config{Store: store})
	legacy, err := store.GetAccountByEmail(ctx, "legacy@example.com")
	if err != nil || legacy.UserID != "legacy" || legacy.Phone != "" {
		t.Fatalf("legacy = %#v, %v", legacy, err)
	}
	identity := accounts.AccountIdentity{ProviderType: "dingtalk", ProviderKey: "demo", ProviderSubject: "union-1", ExternalUserID: "000123", EnterpriseUserID: "demo-1", VerifiedAt: time.Now()}
	first, _, err := service.ProvisionExternalAccountWithCreated(ctx, identity, accounts.ExternalAccountRequest{Phone: "13800000000", Name: "员工一"}, true, true)
	if err != nil {
		t.Fatal(err)
	}
	identity.ProviderSubject = "union-2"
	identity.ExternalUserID = "000456"
	identity.EnterpriseUserID = "demo-2"
	second, _, err := service.ProvisionExternalAccountWithCreated(ctx, identity, accounts.ExternalAccountRequest{Phone: "13900000000", Name: "员工二"}, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SyncExternalAccountProfile(ctx, identity, accounts.ExternalAccountRequest{Phone: first.Phone, Name: "不应保存"}); !errors.Is(err, accounts.ErrExternalAccountConflict) {
		t.Fatalf("collision = %v", err)
	}
	second, err = store.GetAccount(ctx, second.UserID)
	if err != nil || second.Phone != "13900000000" || second.Name != "员工二" {
		t.Fatalf("transaction did not roll back: %#v, %v", second, err)
	}
	updated, err := service.SyncExternalAccountProfile(ctx, identity, accounts.ExternalAccountRequest{Phone: "13700000000", Name: "更新员工"})
	if err != nil || updated.UserID != second.UserID {
		t.Fatalf("update = %#v, %v", updated, err)
	}
	stored, err := service.AccountIdentityForUser(ctx, second.UserID, "dingtalk", "demo")
	if err != nil || stored.ExternalUserID != "000456" || stored.EnterpriseUserID != "demo-2" {
		t.Fatalf("identity = %#v, %v", stored, err)
	}
	finished := make(chan error, 1)
	if err := store.WithBootstrapLock(ctx, func(txCtx context.Context) error {
		local, err := store.GetAccount(txCtx, second.UserID)
		if err != nil {
			return err
		}
		started := make(chan struct{})
		go func() {
			close(started)
			_, err := service.SyncExternalAccountProfile(ctx, identity, accounts.ExternalAccountRequest{Phone: "13600000000"})
			finished <- err
		}()
		<-started
		select {
		case err := <-finished:
			t.Fatalf("external update bypassed local account lock: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		local.PasswordHash = "reset-password-hash"
		return store.SaveAccount(txCtx, local)
	}); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	concurrent, err := store.GetAccount(ctx, second.UserID)
	if err != nil || concurrent.Phone != "13600000000" || concurrent.PasswordHash != "reset-password-hash" {
		t.Fatalf("concurrent update lost: %#v, %v", concurrent, err)
	}
	if _, err := migrations.DownTo(ctx, 70); err == nil {
		t.Fatal("phone data rollback was allowed")
	}
}
