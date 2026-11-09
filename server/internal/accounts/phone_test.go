package accounts

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPhoneAccountsAndPasswordLogin(t *testing.T) {
	ctx := context.Background()
	svc := NewService(Config{Store: NewMemoryStore()})
	first, err := svc.Register(ctx, RegisterRequest{Phone: "+8613800000000", Name: "员工一", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Account.Email != "" || first.Account.Phone != "13800000000" {
		t.Fatalf("account = %#v", first.Account)
	}
	if _, err := svc.Register(ctx, RegisterRequest{Phone: "13900000000", Name: "员工二", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}
	account, err := svc.AuthenticateCredentials(ctx, LoginRequest{Phone: "008613800000000", Password: "passw0rd!"})
	if err != nil || account.UserID != first.Account.UserID {
		t.Fatalf("login = %#v, %v", account, err)
	}
	if _, err := svc.Register(ctx, RegisterRequest{Phone: "13800000000", Name: "重复员工", Password: "passw0rd!"}); !errors.Is(err, ErrPhoneExists) {
		t.Fatalf("duplicate = %v", err)
	}
	for _, phone := range []string{"", "123", "1380000000x"} {
		if _, err := svc.Register(ctx, RegisterRequest{Phone: phone, Name: "无效员工", Password: "passw0rd!"}); !errors.Is(err, ErrInvalidAccountRequest) {
			t.Fatalf("phone %q: %v", phone, err)
		}
	}
}

func TestExternalPhoneProfilePreservesAccountAndRejectsConflicts(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	identity := AccountIdentity{ProviderType: "dingtalk", ProviderKey: "demo", ProviderSubject: "union-1", ExternalUserID: "000123", EnterpriseUserID: "demo-1", VerifiedAt: time.Now()}
	account, _, err := svc.ProvisionExternalAccountWithCreated(ctx, identity, ExternalAccountRequest{Phone: "13800000000", Name: "员工"}, true, true)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := svc.SyncExternalAccountProfile(ctx, identity, ExternalAccountRequest{Phone: "13900000000", Name: "新姓名"})
	if err != nil || updated.UserID != account.UserID || updated.Phone != "13900000000" {
		t.Fatalf("sync = %#v, %v", updated, err)
	}
	if _, err := store.GetAccountByPhone(ctx, "13800000000"); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("old phone = %v", err)
	}
	if _, err := svc.CreateAccount(ctx, CreateAccountRequest{Phone: "13700000000", Name: "其他员工", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SyncExternalAccountProfile(ctx, identity, ExternalAccountRequest{Phone: "13700000000"}); !errors.Is(err, ErrExternalAccountConflict) {
		t.Fatalf("conflict = %v", err)
	}
	identity.EnterpriseUserID = "demo-other"
	if _, err := svc.SyncExternalAccountProfile(ctx, identity, ExternalAccountRequest{Phone: "13600000000"}); !errors.Is(err, ErrExternalAccountConflict) {
		t.Fatalf("employee mismatch = %v", err)
	}
}

func TestExplicitPhoneBindingRejectsCollisionWithoutPersistingIdentity(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	account, err := svc.CreateAccount(ctx, CreateAccountRequest{Email: "legacy@example.com", Name: "员工", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateAccount(ctx, CreateAccountRequest{Phone: "13800000000", Name: "其他员工", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}
	identity := AccountIdentity{ProviderType: "dingtalk", ProviderKey: "demo", ProviderSubject: "union-1", ExternalUserID: "000123", EnterpriseUserID: "demo-1", VerifiedAt: time.Now()}
	if err := svc.BindExternalIdentityWithProfile(ctx, account.UserID, identity, ExternalAccountRequest{Phone: "13800000000"}); !errors.Is(err, ErrExternalAccountConflict) {
		t.Fatalf("conflict = %v", err)
	}
	if _, err := svc.AccountIdentityForUser(ctx, account.UserID, "dingtalk", "demo"); !errors.Is(err, ErrAccountIdentityNotFound) {
		t.Fatal("conflicting binding persisted")
	}
	if err := svc.BindExternalIdentityWithProfile(ctx, account.UserID, identity, ExternalAccountRequest{Phone: "13900000000"}); err != nil {
		t.Fatal(err)
	}
	bound, err := store.GetAccountByPhone(ctx, "13900000000")
	if err != nil || bound.UserID != account.UserID || bound.Email != account.Email || bound.PasswordHash != account.PasswordHash {
		t.Fatalf("bound = %#v, %v", bound, err)
	}
}

type concurrentProfileStore struct {
	*MemoryStore
	mutate  bool
	disable bool
}

func (s *concurrentProfileStore) GetAccount(ctx context.Context, userID string) (Account, error) {
	account, err := s.MemoryStore.GetAccount(ctx, userID)
	if err == nil && s.mutate {
		s.mutate = false
		updated := account
		updated.PasswordHash = "new-password-hash"
		if s.disable {
			updated.Status = StatusDisabled
		}
		if err := s.MemoryStore.SaveAccount(ctx, updated); err != nil {
			return Account{}, err
		}
	}
	return account, err
}

func TestExternalProfileDoesNotOverwriteConcurrentPasswordOrStatusChanges(t *testing.T) {
	for _, disable := range []bool{false, true} {
		ctx := context.Background()
		store := &concurrentProfileStore{MemoryStore: NewMemoryStore(), disable: disable}
		svc := NewService(Config{Store: store})
		identity := AccountIdentity{ProviderType: "dingtalk", ProviderKey: "demo", ProviderSubject: "union-1", ExternalUserID: "000123", EnterpriseUserID: "demo-1", VerifiedAt: time.Now()}
		account, _, err := svc.ProvisionExternalAccountWithCreated(ctx, identity, ExternalAccountRequest{Phone: "13800000000", Name: "员工"}, true, true)
		if err != nil {
			t.Fatal(err)
		}
		store.mutate = true
		_, err = svc.SyncExternalAccountProfile(ctx, identity, ExternalAccountRequest{Phone: "13900000000"})
		if disable && !errors.Is(err, ErrAccountNotActive) || !disable && err != nil {
			t.Fatalf("sync = %v", err)
		}
		stored, err := store.MemoryStore.GetAccount(ctx, account.UserID)
		if err != nil || stored.PasswordHash != "new-password-hash" || disable && stored.Status != StatusDisabled {
			t.Fatalf("concurrent mutation lost: %#v, %v", stored, err)
		}
	}
}
