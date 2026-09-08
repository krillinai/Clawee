package accountgovernance

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresStoreAppliesAccountTokenAndGrantSemantics(t *testing.T) {
	pool := openGovernanceTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	seedGovernanceFixture(t, pool, now)
	store := NewPostgresStore(pool)
	store.clock = func() time.Time { return now.Add(time.Minute) }

	transfer, err := store.TransferAgent(ctx, TransferAgentInput{
		AgentID: "agent-transfer", SourceUserID: "user-source", TargetUserID: "user-target",
		Reason: "transfer test", OperatorUserID: "user-admin", RequestID: "req-transfer",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !transfer.TokensPreserved || !transfer.GrantsPreserved || transfer.TokenCount != 0 || transfer.GrantCount != 0 {
		t.Fatalf("transfer result = %+v", transfer)
	}
	assertAccountAccessRows(t, pool, "user-source", "token-transfer", "grant-transfer")
	assertAgentOwner(t, pool, "agent-transfer", "user-target")
	assertCollectorOwner(t, pool, "agent-transfer", "user-target")
	assertCount(t, pool, `SELECT count(*) FROM account_sessions WHERE agent_id = 'agent-transfer'`, 0)

	merge, err := store.MergeAccounts(ctx, MergeAccountsInput{
		SourceUserID: "user-disabled", TargetUserID: "user-target",
		Reason: "merge test", OperatorUserID: "user-admin", RequestID: "req-merge",
	})
	if err != nil {
		t.Fatal(err)
	}
	if merge.TokensPreserved || !merge.GrantsPreserved || merge.TokenCount != 1 || merge.GrantCount != 1 {
		t.Fatalf("merge result = %+v", merge)
	}
	assertCount(t, pool, `SELECT count(*) FROM mcp_account_tokens WHERE token_id = 'token-merge'`, 0)
	assertAccountAccessRows(t, pool, "user-target", "token-target", "grant-merge")
	assertAgentOwner(t, pool, "agent-merge", "user-target")
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE user_id = 'user-disabled'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE user_id = 'user-target'`, 2)
	assertCount(t, pool, `SELECT count(*) FROM data_resource_grants WHERE user_id = 'user-target'`, 2)
	assertCount(t, pool, `SELECT count(*) FROM account_identities WHERE user_id = 'user-target'`, 2)
	assertCount(t, pool, `SELECT count(*) FROM office_collector_tokens WHERE user_id = 'user-target'`, 2)
	assertCount(t, pool, `SELECT count(*) FROM account_governance_audits WHERE tokens_preserved AND grants_preserved`, 1)
	assertCount(t, pool, `SELECT count(*) FROM account_governance_audits WHERE NOT tokens_preserved AND grants_preserved`, 1)
}

func TestPostgresStoreRejectsConflictsWithoutChanges(t *testing.T) {
	pool := openGovernanceTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	seedGovernanceFixture(t, pool, now)
	if _, err := pool.Exec(ctx, `INSERT INTO mcp_gate_requests (gate_id, agent_id, status) VALUES ('gate-1', 'agent-transfer', 'pending')`); err != nil {
		t.Fatal(err)
	}
	store := NewPostgresStore(pool)
	_, err := store.TransferAgent(ctx, TransferAgentInput{AgentID: "agent-transfer", SourceUserID: "user-source", TargetUserID: "user-target", Reason: "blocked", OperatorUserID: "user-admin"})
	if err != ErrPendingGate {
		t.Fatalf("error = %v, want %v", err, ErrPendingGate)
	}
	assertAgentOwner(t, pool, "agent-transfer", "user-source")
	assertAccountAccessRows(t, pool, "user-source", "token-transfer", "grant-transfer")
}

func TestPostgresStoreRejectsAccountGrantConflictWithoutChanges(t *testing.T) {
	tests := []struct {
		name                 string
		insertTargetGrant    func(context.Context, *pgxpool.Pool, time.Time) error
		targetUnchangedQuery string
	}{
		{
			name: "data scope",
			insertTargetGrant: func(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
				_, err := pool.Exec(ctx, `
					INSERT INTO mcp_account_grants (grant_id, user_id, capability_id, grant_type, data_scope, updated_at)
					VALUES ('grant-target-conflict', 'user-target', 'cap-merge', 'tool', '{"department":"sales"}', $1)`, now)
				return err
			},
			targetUnchangedQuery: `SELECT count(*) FROM mcp_account_grants WHERE user_id = 'user-target' AND capability_id = 'cap-merge' AND data_scope = '{"department":"sales"}'::jsonb AND expires_at IS NULL`,
		},
		{
			name: "expiration",
			insertTargetGrant: func(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
				_, err := pool.Exec(ctx, `
					INSERT INTO mcp_account_grants (grant_id, user_id, capability_id, grant_type, expires_at, updated_at)
					VALUES ('grant-target-conflict', 'user-target', 'cap-merge', 'tool', $1, $2)`, now.Add(time.Hour), now)
				return err
			},
			targetUnchangedQuery: `SELECT count(*) FROM mcp_account_grants WHERE user_id = 'user-target' AND capability_id = 'cap-merge' AND data_scope IS NULL AND expires_at IS NOT NULL`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := openGovernanceTestPool(t)
			ctx := context.Background()
			now := time.Now().UTC().Truncate(time.Microsecond)
			seedGovernanceFixture(t, pool, now)
			if err := test.insertTargetGrant(ctx, pool, now); err != nil {
				t.Fatal(err)
			}

			store := NewPostgresStore(pool)
			_, err := store.MergeAccounts(ctx, MergeAccountsInput{
				SourceUserID: "user-disabled", TargetUserID: "user-target",
				Reason: "grant conflict", OperatorUserID: "user-admin", RequestID: "req-grant-conflict",
			})
			if err != ErrAccountGrantConflict {
				t.Fatalf("error = %v, want %v", err, ErrAccountGrantConflict)
			}

			assertCount(t, pool, `SELECT count(*) FROM accounts WHERE user_id = 'user-disabled'`, 1)
			assertAgentOwner(t, pool, "agent-merge", "user-disabled")
			assertCount(t, pool, `SELECT count(*) FROM mcp_account_tokens WHERE token_id = 'token-merge' AND user_id = 'user-disabled'`, 1)
			assertCount(t, pool, `SELECT count(*) FROM mcp_account_grants WHERE user_id = 'user-disabled' AND capability_id = 'cap-merge'`, 1)
			assertCount(t, pool, `SELECT count(*) FROM mcp_account_grants WHERE user_id = 'user-target' AND capability_id = 'cap-merge'`, 1)
			assertCount(t, pool, test.targetUnchangedQuery, 1)
			assertCount(t, pool, `SELECT count(*) FROM account_governance_audits WHERE request_id = 'req-grant-conflict'`, 0)
		})
	}
}

func TestPostgresStoreDoesNotMigrateAccountTokens(t *testing.T) {
	raw, err := os.ReadFile("postgres_store.go")
	if err != nil {
		t.Fatal(err)
	}
	source := strings.ToLower(string(raw))
	for _, forbidden := range []string{
		"update mcp_account_tokens", "insert into mcp_account_tokens",
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("账号治理实现包含禁止的账户 Token 迁移操作: %q", forbidden)
		}
	}
}

func seedGovernanceFixture(t *testing.T, pool *pgxpool.Pool, now time.Time) {
	t.Helper()
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO accounts (user_id, status) VALUES ('user-admin', 'active'), ('user-source', 'active'), ('user-disabled', 'disabled'), ('user-target', 'active')`)
	batch.Queue(`INSERT INTO mcp_agents (agent_id, actor_id, updated_at) VALUES ('agent-transfer', 'user-source', $1), ('agent-merge', 'user-disabled', $1)`, now)
	batch.Queue(`INSERT INTO account_agents (user_id, agent_id, created_at) VALUES ('user-source', 'agent-transfer', $1), ('user-disabled', 'agent-merge', $1)`, now)
	batch.Queue(`INSERT INTO mcp_account_tokens (token_id, user_id, token_hash) VALUES ('token-transfer', 'user-source', 'hash-transfer'), ('token-merge', 'user-disabled', 'hash-merge'), ('token-target', 'user-target', 'hash-target')`)
	batch.Queue(`INSERT INTO mcp_account_grants (grant_id, user_id, capability_id, grant_type, updated_at) VALUES ('grant-transfer', 'user-source', 'cap-transfer', 'tool', $1), ('grant-merge', 'user-disabled', 'cap-merge', 'tool', $1)`, now)
	batch.Queue(`INSERT INTO account_sessions (session_id, user_id, agent_id) VALUES ('session-transfer', 'user-source', 'agent-transfer'), ('session-merge', 'user-disabled', 'agent-merge')`)
	batch.Queue(`INSERT INTO rbac_roles (role_id) VALUES ('role-a'), ('role-b')`)
	batch.Queue(`INSERT INTO account_roles (user_id, role_id, created_at) VALUES ('user-target', 'role-a', $1), ('user-disabled', 'role-a', $1), ('user-disabled', 'role-b', $1)`, now)
	batch.Queue(`INSERT INTO data_resource_grants (grant_id, user_id, resource_type, resource_id, action, updated_at) VALUES ('data-target', 'user-target', 'knowledge', 'shared', 'read', $1), ('data-duplicate', 'user-disabled', 'knowledge', 'shared', 'read', $1), ('data-source', 'user-disabled', 'knowledge', 'source-only', 'read', $1)`, now)
	batch.Queue(`INSERT INTO account_identities (provider_type, provider_key, provider_subject, user_id, updated_at) VALUES ('dingtalk', 'default', 'target-subject', 'user-target', $1), ('github', 'default', 'source-subject', 'user-disabled', $1)`, now)
	batch.Queue(`INSERT INTO office_collector_tokens (collector_id, user_id, agent_id) VALUES ('collector-transfer', 'user-source', 'agent-transfer'), ('collector-merge', 'user-disabled', 'agent-merge')`)
	batch.Queue(`INSERT INTO office_collector_registration_codes (registration_code_hash, user_id) VALUES ('registration-1', 'user-disabled')`)
	batch.Queue(`INSERT INTO oauth_login_states (state_hash, bind_user_id) VALUES ('state-1', 'user-disabled')`)
	batch.Queue(`INSERT INTO oauth_authorization_codes (code_hash, user_id) VALUES ('code-1', 'user-disabled')`)
	results := pool.SendBatch(context.Background(), batch)
	if err := results.Close(); err != nil {
		t.Fatal(err)
	}
}

func assertAccountAccessRows(t *testing.T, pool *pgxpool.Pool, userID, tokenID, grantID string) {
	t.Helper()
	var gotTokenID, gotGrantID string
	if err := pool.QueryRow(context.Background(), `SELECT token_id FROM mcp_account_tokens WHERE user_id = $1 ORDER BY token_id LIMIT 1`, userID).Scan(&gotTokenID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT grant_id FROM mcp_account_grants WHERE user_id = $1 ORDER BY grant_id LIMIT 1`, userID).Scan(&gotGrantID); err != nil {
		t.Fatal(err)
	}
	if gotTokenID != tokenID || gotGrantID != grantID {
		t.Fatalf("access rows = token %q, grant %q; want %q, %q", gotTokenID, gotGrantID, tokenID, grantID)
	}
}

func assertAgentOwner(t *testing.T, pool *pgxpool.Pool, agentID, want string) {
	t.Helper()
	var owner, actor string
	if err := pool.QueryRow(context.Background(), `SELECT aa.user_id, ma.actor_id FROM account_agents aa JOIN mcp_agents ma ON ma.agent_id = aa.agent_id WHERE aa.agent_id = $1`, agentID).Scan(&owner, &actor); err != nil {
		t.Fatal(err)
	}
	if owner != want || actor != want {
		t.Fatalf("agent %s owner=%q actor=%q, want %q", agentID, owner, actor, want)
	}
}

func assertCollectorOwner(t *testing.T, pool *pgxpool.Pool, agentID, want string) {
	t.Helper()
	var owner string
	if err := pool.QueryRow(context.Background(), `SELECT user_id FROM office_collector_tokens WHERE agent_id = $1`, agentID).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != want {
		t.Fatalf("collector for agent %s owner=%q, want %q", agentID, owner, want)
	}
}

func assertCount(t *testing.T, pool *pgxpool.Pool, query string, want int) {
	t.Helper()
	var got int
	if err := pool.QueryRow(context.Background(), query).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("count for %q = %d, want %d", query, got, want)
	}
}

func openGovernanceTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("CLAW_MCP_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置，跳过 PostgreSQL 账号治理集成测试")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" || !strings.HasSuffix(strings.TrimPrefix(parsed.Path, "/"), "_test") {
		t.Fatal("CLAW_MCP_TEST_DATABASE_URL 必须指向名称以 _test 结尾的数据库")
	}
	base, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("account_governance_test_%d", time.Now().UnixNano())
	if _, err := base.Exec(context.Background(), "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		base.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = base.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		base.Close()
	})
	if _, err := pool.Exec(context.Background(), governanceTestSchema); err != nil {
		t.Fatal(err)
	}
	return pool
}

const governanceTestSchema = `
	CREATE TABLE accounts (user_id TEXT PRIMARY KEY, status TEXT NOT NULL);
	CREATE TABLE mcp_agents (agent_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
	CREATE TABLE account_agents (user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE, agent_id TEXT NOT NULL UNIQUE REFERENCES mcp_agents(agent_id), created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (user_id, agent_id));
	CREATE TABLE mcp_account_tokens (token_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE, token_hash TEXT NOT NULL);
	CREATE TABLE mcp_account_grants (grant_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE, capability_id TEXT NOT NULL, grant_type TEXT NOT NULL, data_scope JSONB, expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL, UNIQUE(user_id, capability_id, grant_type));
	CREATE TABLE mcp_gate_requests (gate_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL);
	CREATE TABLE account_sessions (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE, agent_id TEXT, FOREIGN KEY (user_id, agent_id) REFERENCES account_agents(user_id, agent_id) ON DELETE CASCADE);
	CREATE TABLE rbac_roles (role_id TEXT PRIMARY KEY);
	CREATE TABLE account_roles (user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES rbac_roles(role_id), created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (user_id, role_id));
	CREATE TABLE data_resource_grants (grant_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, action TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE(user_id, resource_type, resource_id, action));
	CREATE TABLE account_identities (provider_type TEXT NOT NULL, provider_key TEXT NOT NULL, provider_subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(provider_type, provider_key, provider_subject), UNIQUE(user_id, provider_type, provider_key));
	CREATE TABLE office_collector_tokens (collector_id TEXT PRIMARY KEY, user_id TEXT REFERENCES accounts(user_id), agent_id TEXT UNIQUE);
	CREATE TABLE office_collector_registration_codes (registration_code_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES accounts(user_id));
	CREATE TABLE oauth_login_states (state_hash TEXT PRIMARY KEY, bind_user_id TEXT REFERENCES accounts(user_id) ON DELETE CASCADE);
	CREATE TABLE oauth_authorization_codes (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE);
	CREATE TABLE account_governance_audits (audit_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, operator_user_id TEXT NOT NULL, action TEXT NOT NULL, agent_id TEXT NOT NULL, source_user_id TEXT NOT NULL, target_user_id TEXT NOT NULL, reason TEXT NOT NULL, tokens_preserved BOOLEAN NOT NULL, grants_preserved BOOLEAN NOT NULL, before_snapshot JSONB NOT NULL, after_snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL);
`
