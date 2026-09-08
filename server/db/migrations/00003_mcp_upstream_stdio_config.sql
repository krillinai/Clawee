-- +goose Up
ALTER TABLE mcp_upstream_servers
    ADD COLUMN IF NOT EXISTS stdio_config JSONB;

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

-- +goose Down
DROP TABLE IF EXISTS mcp_upstream_sync_logs;

ALTER TABLE mcp_upstream_servers
    DROP COLUMN IF EXISTS stdio_config;
