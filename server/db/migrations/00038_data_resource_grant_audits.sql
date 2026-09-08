-- +goose Up
CREATE TABLE IF NOT EXISTS data_resource_grant_audits (
    audit_id TEXT PRIMARY KEY,
    operator_user_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    before_actions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    after_actions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    result TEXT NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_resource_grant_audits_created_at
    ON data_resource_grant_audits (created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS data_resource_grant_audits;
