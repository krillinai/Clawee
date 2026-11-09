package accounts

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSaveAccountMapsEmailUniqueViolation(t *testing.T) {
	runner := accountErrorRunner{err: &pgconn.PgError{Code: "23505", ConstraintName: "accounts_email_key"}}
	err := saveAccount(context.Background(), runner, Account{UserID: "usr_1", Email: "one@example.com", Name: "Alice"})
	if !errors.Is(err, ErrEmailExists) {
		t.Fatalf("SaveAccount() error = %v, want %v", err, ErrEmailExists)
	}
}

func TestSaveAccountMapsPhoneUniqueViolation(t *testing.T) {
	runner := accountErrorRunner{err: &pgconn.PgError{Code: "23505", ConstraintName: "accounts_phone_key"}}
	if err := saveAccount(context.Background(), runner, Account{UserID: "usr_1", Phone: "13800000000"}); !errors.Is(err, ErrPhoneExists) {
		t.Fatalf("phone conflict = %v", err)
	}
}

func TestPostgresStorePersistsAvatarAndDoesNotOverwriteItOnBackfill(t *testing.T) {
	ctx := context.Background()
	store := NewPostgresStore(openAccountsTestPool(t))
	now := time.Now().UTC()
	account := Account{UserID: "usr_avatar", Email: "avatar@example.com", Name: "Avatar", PasswordHash: "unused", Status: StatusActive, CreatedAt: now, UpdatedAt: now}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAccountAvatarIfMissing(ctx, account.UserID, GeneratedAvatar(account)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAccountAvatar(ctx, account.UserID, AccountAvatar{Data: []byte("dingtalk"), ContentType: "image/png", Source: AvatarSourceDingTalk}); err != nil {
		t.Fatal(err)
	}
	avatar := AccountAvatar{Data: []byte{0, 1, 2, 255}, ContentType: "image/png", Source: AvatarSourceUpload}
	if err := store.SaveAccountAvatar(ctx, account.UserID, avatar); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAccountAvatarIfMissing(ctx, account.UserID, GeneratedAvatar(account)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAccountAvatar(ctx, account.UserID, AccountAvatar{Data: []byte("dingtalk-new"), ContentType: "image/png", Source: AvatarSourceDingTalk}); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetAccountAvatar(ctx, account.UserID)
	if err != nil || !bytes.Equal(stored.Data, avatar.Data) || stored.Source != AvatarSourceUpload || stored.ContentType != "image/png" {
		t.Fatalf("stored avatar = %#v, %v", stored, err)
	}
}

func TestPostgresStoreBindsExternalIdentity(t *testing.T) {
	ctx := context.Background()
	pool := openAccountsTestPool(t)
	store := NewPostgresStore(pool)
	service := NewService(Config{Store: store})
	now := time.Now().UTC()
	account := Account{
		UserID: "usr_dingtalk_bind", Email: "dingtalk-bind@example.com", Name: "DingTalk Bind",
		PasswordHash: "unused", Status: StatusActive, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	identity := AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-test-user",
		ExternalUserID: "staff-test-user", VerifiedAt: now,
	}
	if err := service.BindExternalIdentity(ctx, account.UserID, identity); err != nil {
		t.Fatalf("BindExternalIdentity() error = %v", err)
	}
	stored, err := service.AccountIdentityForUser(ctx, account.UserID, "dingtalk", "default")
	if err != nil {
		t.Fatal(err)
	}
	if stored.ProviderSubject != identity.ProviderSubject || stored.ExternalUserID != identity.ExternalUserID {
		t.Fatalf("stored identity = %#v, want subject %q and external user %q", stored, identity.ProviderSubject, identity.ExternalUserID)
	}

	authorizationCode := OAuthAuthorizationCode{
		CodeHash: strings.Repeat("a", 64), UserID: account.UserID, AgentID: "clawee_test_agent",
		RedirectURI:   "http://127.0.0.1:49152/enterprise/dingtalk/callback",
		PKCEChallenge: strings.Repeat("b", 43), CreatedAt: now, ExpiresAt: now.Add(time.Minute),
	}
	if err := service.SaveOAuthAuthorizationCode(ctx, authorizationCode); err != nil {
		t.Fatalf("SaveOAuthAuthorizationCode() error = %v", err)
	}
	consume := OAuthAuthorizationCodeConsumeRequest{
		CodeHash: authorizationCode.CodeHash, AgentID: authorizationCode.AgentID, RedirectURI: authorizationCode.RedirectURI,
		PKCEChallenge: authorizationCode.PKCEChallenge, Now: now,
	}
	wrong := consume
	wrong.PKCEChallenge = strings.Repeat("c", 43)
	if _, err := service.ConsumeOAuthAuthorizationCode(ctx, wrong); !errors.Is(err, ErrOAuthAuthorizationCodeNotFound) {
		t.Fatalf("wrong challenge error = %v", err)
	}
	wrong = consume
	wrong.AgentID = "other-agent"
	if _, err := service.ConsumeOAuthAuthorizationCode(ctx, wrong); !errors.Is(err, ErrOAuthAuthorizationCodeNotFound) {
		t.Fatalf("wrong agent error = %v", err)
	}
	wrong = consume
	wrong.RedirectURI = "http://127.0.0.1:49153/enterprise/dingtalk/callback"
	if _, err := service.ConsumeOAuthAuthorizationCode(ctx, wrong); !errors.Is(err, ErrOAuthAuthorizationCodeNotFound) {
		t.Fatalf("wrong redirect error = %v", err)
	}
	consumed, err := service.ConsumeOAuthAuthorizationCode(ctx, consume)
	if err != nil || consumed.UserID != account.UserID {
		t.Fatalf("ConsumeOAuthAuthorizationCode() = %#v, %v", consumed, err)
	}
	if _, err := service.ConsumeOAuthAuthorizationCode(ctx, consume); !errors.Is(err, ErrOAuthAuthorizationCodeNotFound) {
		t.Fatalf("authorization code replay error = %v", err)
	}

	concurrentCode := authorizationCode
	concurrentCode.CodeHash = strings.Repeat("d", 64)
	if err := service.SaveOAuthAuthorizationCode(ctx, concurrentCode); err != nil {
		t.Fatal(err)
	}
	concurrentConsume := consume
	concurrentConsume.CodeHash = concurrentCode.CodeHash
	start := make(chan struct{})
	errorsCh := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, err := service.ConsumeOAuthAuthorizationCode(ctx, concurrentConsume)
			errorsCh <- err
		}()
	}
	close(start)
	successes, misses := 0, 0
	for range 2 {
		err := <-errorsCh
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrOAuthAuthorizationCodeNotFound):
			misses++
		default:
			t.Fatalf("concurrent consume error = %v", err)
		}
	}
	if successes != 1 || misses != 1 {
		t.Fatalf("concurrent successes=%d misses=%d", successes, misses)
	}

	expiredCode := authorizationCode
	expiredCode.CodeHash = strings.Repeat("e", 64)
	expiredCode.CreatedAt = now.Add(-2 * time.Minute)
	expiredCode.ExpiresAt = now.Add(-time.Minute)
	if err := service.SaveOAuthAuthorizationCode(ctx, expiredCode); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteExpiredOAuthAuthorizationCodes(ctx, now); err != nil {
		t.Fatal(err)
	}
	expiredConsume := consume
	expiredConsume.CodeHash = expiredCode.CodeHash
	if _, err := service.ConsumeOAuthAuthorizationCode(ctx, expiredConsume); !errors.Is(err, ErrOAuthAuthorizationCodeNotFound) {
		t.Fatalf("expired cleanup error = %v", err)
	}
	if err := store.DeleteAccountIdentity(ctx, account.UserID, "dingtalk", "default"); err != nil {
		t.Fatalf("DeleteAccountIdentity() error = %v", err)
	}
	if _, err := service.AccountIdentityForUser(ctx, account.UserID, "dingtalk", "default"); !errors.Is(err, ErrAccountIdentityNotFound) {
		t.Fatalf("identity after delete error = %v, want %v", err, ErrAccountIdentityNotFound)
	}
	if err := store.DeleteAccountIdentity(ctx, account.UserID, "dingtalk", "default"); !errors.Is(err, ErrAccountIdentityNotFound) {
		t.Fatalf("repeated DeleteAccountIdentity() error = %v, want %v", err, ErrAccountIdentityNotFound)
	}
}

func TestExternalIdentityLockKeyIsStableAndPostgresSafe(t *testing.T) {
	got := externalIdentityLockKey("dingtalk", "default", "union-test-user")
	if len(got) != 64 {
		t.Fatalf("lock key length = %d, want 64", len(got))
	}
	if strings.ContainsRune(got, '\x00') {
		t.Fatal("lock key contains a NUL byte")
	}
	if got != externalIdentityLockKey("dingtalk", "default", "union-test-user") {
		t.Fatal("lock key is not deterministic")
	}
	if got == externalIdentityLockKey("dingtalk", "default", "union-other-user") {
		t.Fatal("different identities produced the same lock key")
	}
}

func openAccountsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("CLAW_GATEWAY_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_GATEWAY_TEST_DATABASE_URL 未设置，跳过 PostgreSQL 账户集成测试")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" || !strings.HasSuffix(strings.TrimPrefix(parsed.Path, "/"), "_test") {
		t.Fatal("CLAW_GATEWAY_TEST_DATABASE_URL 必须指向名称以 _test 结尾的数据库")
	}
	base, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := base.Ping(context.Background()); err != nil {
		base.Close()
		t.Fatalf("测试数据库不可用: %v", err)
	}
	schema := fmt.Sprintf("accounts_test_%d", time.Now().UnixNano())
	if _, err := base.Exec(context.Background(), "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		base.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		base.Close()
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		base.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = base.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		base.Close()
	})
	if _, err := pool.Exec(context.Background(), `
		CREATE TABLE accounts (
			user_id TEXT PRIMARY KEY,
			email TEXT NOT NULL DEFAULT '',
			phone TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL,
			avatar_data BYTEA,
			avatar_content_type TEXT NOT NULL DEFAULT '',
			avatar_source TEXT NOT NULL DEFAULT 'generated'
		);
		CREATE UNIQUE INDEX accounts_email_key ON accounts(email) WHERE email <> '';
		CREATE UNIQUE INDEX accounts_phone_key ON accounts(phone) WHERE phone <> '';
			CREATE TABLE account_identities (
			provider_type TEXT NOT NULL,
			provider_key TEXT NOT NULL,
			provider_subject TEXT NOT NULL,
			user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
			external_user_id TEXT NOT NULL DEFAULT '',
			enterprise_user_id TEXT NOT NULL DEFAULT '',
			verified_at TIMESTAMPTZ NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL,
			PRIMARY KEY (provider_type, provider_key, provider_subject),
			UNIQUE (user_id, provider_type, provider_key)
			);
			CREATE TABLE oauth_authorization_codes (
				code_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
				agent_id TEXT NOT NULL,
				redirect_uri TEXT NOT NULL,
				pkce_challenge TEXT NOT NULL,
				account_scoped_agent BOOLEAN NOT NULL DEFAULT FALSE,
				created_at TIMESTAMPTZ NOT NULL,
				expires_at TIMESTAMPTZ NOT NULL
			)
		`); err != nil {
		t.Fatal(err)
	}
	return pool
}

type accountErrorRunner struct {
	err error
}

func (r accountErrorRunner) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, r.err
}

func (accountErrorRunner) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("unexpected Query")
}

func (accountErrorRunner) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected QueryRow")
}

func TestPostgresClaweeSessionRenewal(t *testing.T) {
	ctx := context.Background()
	pool := openAccountsTestPool(t)
	if _, err := pool.Exec(ctx, `CREATE TABLE account_sessions (
		session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
		agent_id TEXT, token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL,
		created_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ
	)`); err != nil {
		t.Fatal(err)
	}
	store := NewPostgresStore(pool)
	now := time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)
	svc := NewService(Config{Store: store, Clock: func() time.Time { return now }, SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	account := Account{UserID: "usr_pg_renew", Name: "续期用户", Status: StatusActive, CreatedAt: now, UpdatedAt: now}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	batch, err := svc.IssueTokens(ctx, account, []TokenRequest{{Audience: AudienceFrontend, ClientID: ClientClaweeAgent, AgentID: "clawee_pg_renew"}})
	if err != nil {
		t.Fatal(err)
	}
	original := batch.Token(AudienceFrontend)
	now = now.Add(30 * time.Minute)
	renewed, err := svc.RenewClaweeSession(ctx, original.Token)
	if err != nil {
		t.Fatal(err)
	}
	if renewed.Session.LastSeenAt == nil || !renewed.Session.LastSeenAt.Equal(now) {
		t.Fatal("未记录本次用户活动")
	}
	if _, err := svc.AuthenticateToken(ctx, original.Token, AudienceFrontend); err != nil {
		t.Fatalf("在途 Token = %v", err)
	}
	shorter, err := store.ExtendSession(ctx, original.Session.SessionID, now.Add(-time.Minute), now.Add(time.Minute))
	if err != nil || !shorter.ExpiresAt.Equal(renewed.Session.ExpiresAt) || !shorter.LastSeenAt.Equal(now) {
		t.Fatalf("较早请求缩短会话: %#v, %v", shorter, err)
	}
	now = now.Add(40 * time.Minute)
	if _, err := svc.AuthenticateToken(ctx, renewed.Token, AudienceFrontend); err != nil {
		t.Fatalf("续期后跨越原到期时间: %v", err)
	}
	now = renewed.Session.ExpiresAt
	if _, err := svc.RenewClaweeSession(ctx, renewed.Token); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("闲置到期后续期 = %v", err)
	}
	if _, err := store.ExtendSession(ctx, original.Session.SessionID, now, now.Add(time.Hour)); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("复活过期会话 = %v", err)
	}
	if err := store.DeleteSession(ctx, original.Session.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ExtendSession(ctx, original.Session.SessionID, now, now.Add(time.Hour)); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("复活已删除会话 = %v", err)
	}
}
