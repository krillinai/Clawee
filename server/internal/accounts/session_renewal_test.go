package accounts

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestClaweeSessionRenewsWithoutBreakingInflightTokens(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, Clock: func() time.Time { return now }, SessionDuration: 7 * 24 * time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	account := Account{UserID: "usr_renew", Status: StatusActive}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	batch, err := svc.IssueTokens(ctx, account, []TokenRequest{{Audience: AudienceFrontend, ClientID: ClientClaweeAgent, AgentID: "clawee_renew"}})
	if err != nil {
		t.Fatal(err)
	}
	original := batch.Token(AudienceFrontend)
	now = now.Add(6 * 24 * time.Hour)
	renewed, err := svc.RenewClaweeSession(ctx, original.Token)
	if err != nil {
		t.Fatal(err)
	}
	if renewed.Session.SessionID != original.Session.SessionID || !renewed.Session.ExpiresAt.Equal(now.Add(7*24*time.Hour)) {
		t.Fatalf("续期会话 = %#v", renewed.Session)
	}
	if _, err := svc.AuthenticateToken(ctx, original.Token, AudienceFrontend); err != nil {
		t.Fatalf("原 Token 的在途请求失效: %v", err)
	}
	now = now.Add(2 * 24 * time.Hour)
	if _, err := svc.AuthenticateToken(ctx, renewed.Token, AudienceFrontend); err != nil {
		t.Fatalf("续期后跨越原到期时间: %v", err)
	}
	if _, err := svc.RenewClaweeSession(ctx, original.Token); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("过期 Token 续期 = %v", err)
	}
	if err := svc.RevokeToken(ctx, renewed.Token, AudienceFrontend); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RenewClaweeSession(ctx, renewed.Token); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("撤销后续期 = %v", err)
	}
}

func TestClaweeSessionRejectsIdleAndRevokedSessions(t *testing.T) {
	for _, scenario := range []string{"闲置到期", "重置密码", "账号禁用", "Web 会话"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := context.Background()
			now := time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)
			store := NewMemoryStore()
			svc := NewService(Config{Store: store, Clock: func() time.Time { return now }, SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
			account := Account{UserID: "usr_renew", Status: StatusActive}
			if err := store.SaveAccount(ctx, account); err != nil {
				t.Fatal(err)
			}
			request := TokenRequest{Audience: AudienceFrontend, ClientID: ClientClaweeAgent, AgentID: "clawee_renew"}
			if scenario == "Web 会话" {
				request = TokenRequest{Audience: AudienceFrontend, ClientID: ClientWeb}
			}
			batch, err := svc.IssueTokens(ctx, account, []TokenRequest{request})
			if err != nil {
				t.Fatal(err)
			}
			original := batch.Token(AudienceFrontend)
			switch scenario {
			case "闲置到期":
				now = now.Add(time.Hour)
			case "重置密码":
				if _, err := svc.ResetAccountPassword(ctx, account.UserID, "new-passw0rd!"); err != nil {
					t.Fatal(err)
				}
			case "账号禁用":
				account.Status = StatusDisabled
				if err := store.SaveAccount(ctx, account); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := svc.RenewClaweeSession(ctx, original.Token); !errors.Is(err, ErrInvalidSession) {
				t.Fatalf("续期 = %v", err)
			}
		})
	}
}

func TestExtendingSessionCannotResurrectOrShortenIt(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	session := Session{SessionID: "sess_renew", ExpiresAt: now.Add(time.Hour)}
	if err := store.SaveSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	for _, expiry := range []time.Time{now.Add(3 * time.Hour), now.Add(2 * time.Hour)} {
		updated, err := store.ExtendSession(ctx, session.SessionID, now, expiry)
		if err != nil || !updated.ExpiresAt.Equal(now.Add(3*time.Hour)) {
			t.Fatalf("并发续期不能缩短有效期: %#v, %v", updated, err)
		}
	}
	if err := store.DeleteSession(ctx, session.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ExtendSession(ctx, session.SessionID, now, now.Add(time.Hour)); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("删除后续期 = %v", err)
	}
	if err := store.SaveSession(ctx, Session{SessionID: session.SessionID, ExpiresAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ExtendSession(ctx, session.SessionID, now, now.Add(time.Hour)); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("到期后续期 = %v", err)
	}
}
