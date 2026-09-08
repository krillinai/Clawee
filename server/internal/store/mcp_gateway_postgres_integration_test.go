package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestP8MigrationRunsOnPostgres(t *testing.T) {
	pool := openMCPGatewayPostgresTestPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, p8LegacySchema); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := pool.Exec(ctx, `
INSERT INTO accounts (user_id, status) VALUES ('user-a', 'active');
INSERT INTO mcp_agents (agent_id) VALUES ('agent-a'), ('agent-b');
INSERT INTO account_agents (user_id, agent_id, created_at) VALUES
    ('user-a', 'agent-a', $1), ('user-a', 'agent-b', $1);
INSERT INTO mcp_capabilities (capability_id) VALUES ('cap-a');
INSERT INTO mcp_agent_tokens
    (token_id, agent_id, token_hash, token_ciphertext, fingerprint, status, expires_at, issuer, scopes, created_at, updated_at)
	VALUES
	    ('token-old', 'agent-a', 'hash-old', decode('01', 'hex'), 'old', 'active', NULL, '', '[]', $2, $2),
	    ('token-new', 'agent-b', 'hash-new', decode('02', 'hex'), 'new', 'active', NULL, '', '[]', $3, $3),
	    ('token-no-cipher', 'agent-a', 'hash-no-cipher', NULL, 'no-cipher', 'active', NULL, '', '[]', $3, $3),
	    ('token-expired', 'agent-a', 'hash-expired', decode('03', 'hex'), 'expired', 'active', $4, '', '[]', $3, $3);
INSERT INTO mcp_agent_grants
    (grant_id, agent_id, capability_id, grant_type, data_scope, expires_at, created_by, created_at, updated_at)
VALUES
    ('grant-old', 'agent-a', 'cap-a', 'tool', NULL, NULL, '', $2, $2),
    ('grant-new', 'agent-b', 'cap-a', 'tool', NULL, NULL, '', $3, $3);`,
		pgx.QueryExecModeSimpleProtocol, now, now.Add(-2*time.Hour), now.Add(-time.Hour), now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}

	if err := executeP8Migration(ctx, pool); err != nil {
		t.Fatalf("execute P8 migration: %v", err)
	}

	var activeTokenID string
	if err := pool.QueryRow(ctx, `SELECT token_id FROM mcp_account_tokens WHERE user_id = 'user-a' AND status = 'active'`).Scan(&activeTokenID); err != nil {
		t.Fatal(err)
	}
	if activeTokenID != "token-new" {
		t.Fatalf("active token = %q, want token-new", activeTokenID)
	}
	for tokenID, wantStatus := range map[string]string{"token-old": "revoked", "token-no-cipher": "revoked", "token-expired": "expired"} {
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM mcp_account_tokens WHERE token_id = $1`, tokenID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != wantStatus {
			t.Fatalf("token %s status = %q, want %q", tokenID, status, wantStatus)
		}
	}
	var grantID string
	if err := pool.QueryRow(ctx, `SELECT grant_id FROM mcp_account_grants WHERE user_id = 'user-a'`).Scan(&grantID); err != nil {
		t.Fatal(err)
	}
	if grantID != "grant-new" {
		t.Fatalf("surviving grant = %q, want grant-new", grantID)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO mcp_account_grants
    (grant_id, user_id, capability_id, grant_type, created_by, created_at, updated_at)
VALUES ('grant-duplicate', 'user-a', 'cap-a', 'tool', '', $1, $1)`, now); !isUniqueViolation(err) {
		t.Fatalf("duplicate account grant error = %v, want PostgreSQL unique violation", err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO mcp_account_tokens
    (token_id, user_id, token_hash, token_ciphertext, fingerprint, status, issuer, scopes, created_at, updated_at)
VALUES ('token-duplicate-active', 'user-a', 'hash-duplicate-active', decode('04', 'hex'), '', 'active', '', '[]', $1, $1)`, now); !isUniqueViolation(err) {
		t.Fatalf("duplicate active account token error = %v, want PostgreSQL unique violation", err)
	}
}

func TestP8MigrationRejectsInvalidLegacyOwnershipAndGrantConflicts(t *testing.T) {
	for _, test := range []struct {
		name string
		seed string
	}{
		{"token without owner", `
INSERT INTO accounts (user_id, status) VALUES ('user-a', 'active');
INSERT INTO mcp_agents (agent_id) VALUES ('agent-orphan');
INSERT INTO mcp_agent_tokens
    (token_id, agent_id, token_hash, fingerprint, status, issuer, scopes, created_at, updated_at)
VALUES ('token-orphan', 'agent-orphan', 'hash-orphan', '', 'active', '', '[]', now(), now());`},
		{"grant without owner", `
INSERT INTO accounts (user_id, status) VALUES ('user-a', 'active');
INSERT INTO mcp_agents (agent_id) VALUES ('agent-orphan');
INSERT INTO mcp_capabilities (capability_id) VALUES ('cap-a');
INSERT INTO mcp_agent_grants
    (grant_id, agent_id, capability_id, grant_type, created_by, created_at, updated_at)
VALUES ('grant-orphan', 'agent-orphan', 'cap-a', 'tool', '', now(), now());`},
		{"conflicting data scope", p8ConflictingGrantSeed(`'{"region":"north"}'`, `'{"region":"south"}'`, "NULL", "NULL")},
		{"conflicting expiry", p8ConflictingGrantSeed("NULL", "NULL", "now() + interval '1 day'", "now() + interval '2 days'")},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := openMCPGatewayPostgresTestPool(t)
			ctx := context.Background()
			if _, err := pool.Exec(ctx, p8LegacySchema); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, test.seed); err != nil {
				t.Fatal(err)
			}
			if err := executeP8Migration(ctx, pool); err == nil {
				t.Fatal("P8 migration succeeded, want precondition failure")
			}
		})
	}
}

func TestRotateAccountTokenSerializesOnPostgresAccount(t *testing.T) {
	pool := openMCPGatewayPostgresTestPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, p8AccountTokenSchema); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (user_id, status) VALUES ('user-a', 'active'), ('user-disabled', 'disabled')`); err != nil {
		t.Fatal(err)
	}
	store := NewMCPGatewayStore(pool)
	if err := store.RotateAccountToken(ctx, "user-a", postgresTestAccountToken("token-initial", "user-a", time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	failedToken := postgresTestAccountToken("token-insert-failure", "user-a", time.Now().UTC())
	failedToken.TokenHash = "hash-token-initial"
	if err := store.RotateAccountToken(ctx, "user-a", failedToken); !isUniqueViolation(err) {
		t.Fatalf("failed rotation error = %v, want PostgreSQL unique violation", err)
	}
	var activeAfterFailure string
	if err := pool.QueryRow(ctx, `SELECT token_id FROM mcp_account_tokens WHERE user_id = 'user-a' AND status = 'active'`).Scan(&activeAfterFailure); err != nil {
		t.Fatal(err)
	}
	if activeAfterFailure != "token-initial" {
		t.Fatalf("active token after failed rotation = %q, want token-initial", activeAfterFailure)
	}

	const rotations = 8
	errorsFound := make(chan error, rotations)
	var wait sync.WaitGroup
	for index := range rotations {
		wait.Add(1)
		go func() {
			defer wait.Done()
			tokenID := fmt.Sprintf("token-%d", index)
			errorsFound <- store.RotateAccountToken(ctx, "user-a", postgresTestAccountToken(tokenID, "user-a", time.Now().UTC()))
		}()
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatalf("concurrent rotate: %v", err)
		}
	}
	var activeCount, revokedCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FILTER (WHERE status = 'active'), COUNT(*) FILTER (WHERE status = 'revoked') FROM mcp_account_tokens WHERE user_id = 'user-a'`).Scan(&activeCount, &revokedCount); err != nil {
		t.Fatal(err)
	}
	if activeCount != 1 || revokedCount != rotations {
		t.Fatalf("token counts active=%d revoked=%d, want 1/%d", activeCount, revokedCount, rotations)
	}
	if err := store.RotateAccountToken(ctx, "user-a", postgresTestAccountToken("token-mismatch", "user-b", time.Now().UTC())); !errors.Is(err, mcpgateway.ErrAgentOwnerUnavailable) {
		t.Fatalf("mismatched token owner error = %v", err)
	}
	if err := store.RotateAccountToken(ctx, "user-disabled", postgresTestAccountToken("token-disabled", "user-disabled", time.Now().UTC())); !errors.Is(err, accounts.ErrAccountNotActive) {
		t.Fatalf("disabled account error = %v", err)
	}
	if err := store.RotateAccountToken(ctx, "user-missing", postgresTestAccountToken("token-missing", "user-missing", time.Now().UTC())); !errors.Is(err, accounts.ErrAccountNotFound) {
		t.Fatalf("missing account error = %v", err)
	}
}

func postgresTestAccountToken(tokenID, userID string, now time.Time) mcpgateway.AccountToken {
	return mcpgateway.AccountToken{
		ID: tokenID, UserID: userID, TokenHash: "hash-" + tokenID,
		TokenCiphertext: []byte(tokenID), Fingerprint: tokenID, Status: mcpgateway.StatusActive,
		Scopes: []string{"mcp:call"}, CreatedAt: now, UpdatedAt: now,
	}
}

func isUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

func executeP8Migration(ctx context.Context, pool *pgxpool.Pool) error {
	raw, err := os.ReadFile("../../db/migrations/00047_mcp_account_authorization.sql")
	if err != nil {
		return err
	}
	up := strings.SplitN(string(raw), "-- +goose Down", 2)[0]
	_, err = pool.Exec(ctx, up)
	return err
}

func p8ConflictingGrantSeed(firstScope, secondScope, firstExpiry, secondExpiry string) string {
	return fmt.Sprintf(`
INSERT INTO accounts (user_id, status) VALUES ('user-a', 'active');
INSERT INTO mcp_agents (agent_id) VALUES ('agent-a'), ('agent-b');
INSERT INTO account_agents (user_id, agent_id, created_at) VALUES
    ('user-a', 'agent-a', now()), ('user-a', 'agent-b', now());
INSERT INTO mcp_capabilities (capability_id) VALUES ('cap-a');
INSERT INTO mcp_agent_grants
    (grant_id, agent_id, capability_id, grant_type, data_scope, expires_at, created_by, created_at, updated_at)
VALUES
    ('grant-a', 'agent-a', 'cap-a', 'tool', %s, %s, '', now(), now()),
    ('grant-b', 'agent-b', 'cap-a', 'tool', %s, %s, '', now(), now());`, firstScope, firstExpiry, secondScope, secondExpiry)
}

func openMCPGatewayPostgresTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("CLAW_MCP_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置，跳过 PostgreSQL MCP Gateway 集成测试")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" || !strings.HasSuffix(strings.TrimPrefix(parsed.Path, "/"), "_test") {
		t.Fatal("CLAW_MCP_TEST_DATABASE_URL 必须指向名称以 _test 结尾的数据库")
	}
	base, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("mcp_gateway_test_%d", time.Now().UnixNano())
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
	return pool
}

const p8LegacySchema = `
CREATE TABLE accounts (user_id TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE mcp_agents (agent_id TEXT PRIMARY KEY);
CREATE TABLE account_agents (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES mcp_agents(agent_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, agent_id)
);
CREATE UNIQUE INDEX uq_account_agents_agent_id ON account_agents (agent_id);
CREATE TABLE mcp_agent_tokens (
    token_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES mcp_agents(agent_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_ciphertext BYTEA,
    fingerprint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    issuer TEXT NOT NULL DEFAULT '',
    scopes JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_mcp_agent_tokens_agent ON mcp_agent_tokens (agent_id, status);
CREATE TABLE mcp_capabilities (capability_id TEXT PRIMARY KEY);
CREATE TABLE mcp_agent_grants (
    grant_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    capability_id TEXT NOT NULL REFERENCES mcp_capabilities(capability_id) ON DELETE CASCADE,
    grant_type TEXT NOT NULL,
    data_scope JSONB,
    expires_at TIMESTAMPTZ,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_mcp_agent_grants_agent ON mcp_agent_grants (agent_id);
CREATE INDEX idx_mcp_agent_grants_target ON mcp_agent_grants (agent_id, capability_id, grant_type);
CREATE UNIQUE INDEX uq_mcp_agent_grants_target ON mcp_agent_grants (agent_id, capability_id, grant_type);
`

const p8AccountTokenSchema = `
CREATE TABLE accounts (user_id TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE mcp_account_tokens (
    token_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_ciphertext BYTEA,
    fingerprint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    issuer TEXT NOT NULL DEFAULT '',
    scopes JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX uq_mcp_account_tokens_active ON mcp_account_tokens (user_id) WHERE status = 'active';
`
