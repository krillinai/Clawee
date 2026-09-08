-- +goose Up
ALTER TABLE mcp_list_audit_records
    ADD COLUMN IF NOT EXISTS endpoint_type TEXT NOT NULL DEFAULT 'aggregate',
    ADD COLUMN IF NOT EXISTS endpoint_upstream_server_id TEXT NOT NULL DEFAULT '';

ALTER TABLE mcp_proxy_audit_records
    ADD COLUMN IF NOT EXISTS endpoint_type TEXT NOT NULL DEFAULT 'aggregate',
    ADD COLUMN IF NOT EXISTS endpoint_upstream_server_id TEXT NOT NULL DEFAULT '';

ALTER TABLE mcp_gate_requests
    ADD COLUMN IF NOT EXISTS endpoint_type TEXT NOT NULL DEFAULT 'aggregate',
    ADD COLUMN IF NOT EXISTS endpoint_upstream_server_id TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE mcp_gate_requests
    DROP COLUMN IF EXISTS endpoint_upstream_server_id,
    DROP COLUMN IF EXISTS endpoint_type;

ALTER TABLE mcp_proxy_audit_records
    DROP COLUMN IF EXISTS endpoint_upstream_server_id,
    DROP COLUMN IF EXISTS endpoint_type;

ALTER TABLE mcp_list_audit_records
    DROP COLUMN IF EXISTS endpoint_upstream_server_id,
    DROP COLUMN IF EXISTS endpoint_type;
