-- +goose Up
CREATE TABLE IF NOT EXISTS model_upstream_accounts (
    upstream_account_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_ciphertext BYTEA NOT NULL,
    models JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'active',
    health_status TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS model_upstream_groups (
    group_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    route_strategy TEXT NOT NULL DEFAULT 'failover',
    default_model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS model_upstream_group_accounts (
    group_id TEXT NOT NULL REFERENCES model_upstream_groups(group_id) ON DELETE CASCADE,
    upstream_account_id TEXT NOT NULL REFERENCES model_upstream_accounts(upstream_account_id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 0,
    weight INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (group_id, upstream_account_id)
);

CREATE TABLE IF NOT EXISTS model_user_group_assignments (
    user_id TEXT PRIMARY KEY REFERENCES accounts(user_id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES model_upstream_groups(group_id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_user_group_assignments_group
    ON model_user_group_assignments (group_id, user_id);

INSERT INTO model_upstream_groups (
    group_id, name, route_strategy, default_model, status, created_at, updated_at
)
VALUES ('default', '默认模型组', 'failover', '', 'active', NOW(), NOW())
ON CONFLICT (group_id) DO NOTHING;

-- +goose Down
DROP TABLE IF EXISTS model_user_group_assignments;
DROP TABLE IF EXISTS model_upstream_group_accounts;
DROP TABLE IF EXISTS model_upstream_groups;
DROP TABLE IF EXISTS model_upstream_accounts;
