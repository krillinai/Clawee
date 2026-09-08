-- +goose Up
CREATE TABLE IF NOT EXISTS mcp_upstream_servers (
    server_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL,
    endpoint TEXT NOT NULL DEFAULT '',
    stdio_config JSONB,
    auth_type TEXT NOT NULL DEFAULT '',
    credential_ref TEXT NOT NULL DEFAULT '',
    owner_team TEXT NOT NULL DEFAULT '',
    environment TEXT NOT NULL DEFAULT '',
    namespace TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_agents (
    agent_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    tenant_id TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_agents_status
    ON mcp_agents (status);

CREATE TABLE IF NOT EXISTS mcp_agent_tokens (
    token_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES mcp_agents(agent_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    issuer TEXT NOT NULL DEFAULT '',
    scopes JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_agent_tokens_agent
    ON mcp_agent_tokens (agent_id, status);

CREATE TABLE IF NOT EXISTS mcp_capabilities (
    capability_id TEXT PRIMARY KEY,
    upstream_server_id TEXT NOT NULL REFERENCES mcp_upstream_servers(server_id) ON DELETE CASCADE,
    capability_type TEXT NOT NULL,
    upstream_name TEXT NOT NULL,
    exposed_name TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    input_schema JSONB,
    output_schema JSONB,
    annotations JSONB,
    risk_level TEXT NOT NULL DEFAULT '',
    read_only BOOLEAN NOT NULL DEFAULT FALSE,
    destructive BOOLEAN NOT NULL DEFAULT FALSE,
    idempotent BOOLEAN NOT NULL DEFAULT FALSE,
    approval_required BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL,
    schema_hash TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_capabilities_server
    ON mcp_capabilities (upstream_server_id);

CREATE INDEX IF NOT EXISTS idx_mcp_capabilities_type_status
    ON mcp_capabilities (capability_type, status);

CREATE TABLE IF NOT EXISTS mcp_upstream_sync_logs (
    sync_id TEXT PRIMARY KEY,
    upstream_server_id TEXT NOT NULL REFERENCES mcp_upstream_servers(server_id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_upstream_sync_logs_server_completed
    ON mcp_upstream_sync_logs (upstream_server_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS mcp_agent_grants (
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

CREATE INDEX IF NOT EXISTS idx_mcp_agent_grants_agent
    ON mcp_agent_grants (agent_id);

CREATE INDEX IF NOT EXISTS idx_mcp_agent_grants_target
    ON mcp_agent_grants (agent_id, capability_id, grant_type);

CREATE TABLE IF NOT EXISTS mcp_list_audit_records (
    audit_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL DEFAULT '',
    tenant_id TEXT NOT NULL DEFAULT '',
    capability_type TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL,
    decision_reason TEXT NOT NULL DEFAULT '',
    returned_count INTEGER NOT NULL DEFAULT 0,
    filtered_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_list_audit_records_created_at
    ON mcp_list_audit_records (created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_proxy_audit_records (
    audit_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    inbound_session_id TEXT NOT NULL DEFAULT '',
    upstream_session_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL DEFAULT '',
    tenant_id TEXT NOT NULL DEFAULT '',
    token_id TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL DEFAULT '',
    upstream_server_id TEXT NOT NULL DEFAULT '',
    capability_id TEXT NOT NULL DEFAULT '',
    capability_type TEXT NOT NULL DEFAULT '',
    exposed_name TEXT NOT NULL DEFAULT '',
    upstream_name TEXT NOT NULL DEFAULT '',
    request_headers JSONB,
    request_body JSONB,
    response_headers JSONB,
    response_body JSONB,
    decision TEXT NOT NULL,
    decision_reason TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    duration_ms BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_proxy_audit_records_created_at
    ON mcp_proxy_audit_records (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_proxy_audit_records_agent
    ON mcp_proxy_audit_records (agent_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS mcp_proxy_audit_records;
DROP TABLE IF EXISTS mcp_list_audit_records;
DROP TABLE IF EXISTS mcp_agent_grants;
DROP TABLE IF EXISTS mcp_upstream_sync_logs;
DROP TABLE IF EXISTS mcp_capabilities;
DROP TABLE IF EXISTS mcp_agent_tokens;
DROP TABLE IF EXISTS mcp_agents;
DROP TABLE IF EXISTS mcp_upstream_servers;
