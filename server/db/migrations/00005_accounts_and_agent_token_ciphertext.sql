-- +goose Up
CREATE TABLE IF NOT EXISTS accounts (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_role_status
    ON accounts (role, status);

CREATE TABLE IF NOT EXISTS account_sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_account_sessions_user
    ON account_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_account_sessions_expires_at
    ON account_sessions (expires_at);

CREATE TABLE IF NOT EXISTS account_agents (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES mcp_agents(agent_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_account_agents_agent
    ON account_agents (agent_id);

CREATE TABLE IF NOT EXISTS account_bootstrap_locks (
    lock_id TEXT PRIMARY KEY
);

INSERT INTO account_bootstrap_locks (lock_id)
VALUES ('first_admin')
ON CONFLICT DO NOTHING;

ALTER TABLE mcp_agent_tokens
    ADD COLUMN IF NOT EXISTS token_ciphertext BYTEA;

-- +goose Down
ALTER TABLE mcp_agent_tokens
    DROP COLUMN IF EXISTS token_ciphertext;

DROP TABLE IF EXISTS account_bootstrap_locks;
DROP TABLE IF EXISTS account_agents;
DROP TABLE IF EXISTS account_sessions;
DROP TABLE IF EXISTS accounts;
