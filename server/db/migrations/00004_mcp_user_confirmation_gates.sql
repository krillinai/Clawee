-- +goose Up
ALTER TABLE mcp_capabilities
    ADD COLUMN IF NOT EXISTS confirm_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS confirm_template TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS mcp_gate_requests (
    gate_id TEXT PRIMARY KEY,
    gate_type TEXT NOT NULL,
    gate_provider TEXT NOT NULL DEFAULT 'internal',
    trace_id TEXT NOT NULL,
    request_audit_id TEXT NOT NULL DEFAULT '',
    execution_audit_id TEXT NOT NULL DEFAULT '',
    tenant_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL DEFAULT '',
    token_id TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL DEFAULT '',
    capability_id TEXT NOT NULL,
    capability_type TEXT NOT NULL DEFAULT '',
    upstream_server_id TEXT NOT NULL DEFAULT '',
    inbound_session_id TEXT NOT NULL DEFAULT '',
    upstream_session_id TEXT NOT NULL DEFAULT '',
    exposed_name TEXT NOT NULL DEFAULT '',
    upstream_name TEXT NOT NULL DEFAULT '',
    request_headers JSONB,
    request_body JSONB,
    arguments_hash TEXT NOT NULL DEFAULT '',
    schema_hash TEXT NOT NULL DEFAULT '',
    gate_summary JSONB,
    status TEXT NOT NULL,
    confirm_url TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL DEFAULT '',
    decision_reason TEXT NOT NULL DEFAULT '',
    decided_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    response_headers JSONB,
    response_body JSONB,
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_gate_requests_status_created
    ON mcp_gate_requests (gate_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_gate_requests_actor_created
    ON mcp_gate_requests (gate_type, tenant_id, actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_gate_requests_trace
    ON mcp_gate_requests (trace_id);

-- +goose Down
DROP TABLE IF EXISTS mcp_gate_requests;

ALTER TABLE mcp_capabilities
    DROP COLUMN IF EXISTS confirm_template,
    DROP COLUMN IF EXISTS confirm_required;
