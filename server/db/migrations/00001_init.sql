-- +goose Up
CREATE TABLE IF NOT EXISTS agent_action_runs (
    run_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    semantic_version TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor JSONB NOT NULL,
    agent_id TEXT NOT NULL,
    agent JSONB NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL DEFAULT '',
    resource_id TEXT NOT NULL DEFAULT '',
    resource JSONB NOT NULL,
    context JSONB,
    risk JSONB NOT NULL,
    decision TEXT NOT NULL,
    decision_reason TEXT NOT NULL DEFAULT '',
    policy_rule_id TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_action_runs_completed_at
    ON agent_action_runs (completed_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
    event_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL REFERENCES agent_action_runs(audit_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES agent_action_runs(run_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    data JSONB,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at
    ON audit_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_audit_id
    ON audit_events (audit_id);

-- +goose Down
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS agent_action_runs;
