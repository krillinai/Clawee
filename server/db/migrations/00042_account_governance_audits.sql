-- +goose Up
CREATE TABLE IF NOT EXISTS account_governance_audits (
    audit_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL DEFAULT '',
    operator_user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('agent_transfer', 'account_merge')),
    agent_id TEXT NOT NULL DEFAULT '',
    source_user_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    tokens_preserved BOOLEAN NOT NULL,
    grants_preserved BOOLEAN NOT NULL,
    before_snapshot JSONB NOT NULL,
    after_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_governance_audits_created_at
    ON account_governance_audits (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_governance_audits_source_target
    ON account_governance_audits (source_user_id, target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_governance_audits_agent
    ON account_governance_audits (agent_id, created_at DESC)
    WHERE agent_id <> '';

-- +goose Down
DROP TABLE IF EXISTS account_governance_audits;
