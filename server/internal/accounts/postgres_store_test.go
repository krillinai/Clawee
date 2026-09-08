package accounts

import (
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
	dsn := strings.TrimSpace(os.Getenv("CLAW_MCP_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置，跳过 PostgreSQL 账户集成测试")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" || !strings.HasSuffix(strings.TrimPrefix(parsed.Path, "/"), "_test") {
		t.Fatal("CLAW_MCP_TEST_DATABASE_URL 必须指向名称以 _test 结尾的数据库")
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
			email TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL
		);
			CREATE TABLE account_identities (
			provider_type TEXT NOT NULL,
			provider_key TEXT NOT NULL,
			provider_subject TEXT NOT NULL,
			user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
			external_user_id TEXT NOT NULL DEFAULT '',
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
