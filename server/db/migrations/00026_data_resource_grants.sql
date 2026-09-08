-- +goose Up
CREATE TABLE IF NOT EXISTS data_resource_grants (
    grant_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (user_id, resource_type, resource_id, action)
);

CREATE INDEX IF NOT EXISTS idx_data_resource_grants_user_action
    ON data_resource_grants (user_id, resource_type, action);

CREATE INDEX IF NOT EXISTS idx_data_resource_grants_resource_action
    ON data_resource_grants (resource_type, resource_id, action);

-- +goose Down
DROP TABLE IF EXISTS data_resource_grants;
