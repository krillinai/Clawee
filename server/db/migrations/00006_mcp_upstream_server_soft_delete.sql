-- +goose Up
ALTER TABLE mcp_upstream_servers
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mcp_upstream_servers_deleted_at
    ON mcp_upstream_servers (deleted_at);

-- +goose Down
DROP INDEX IF EXISTS idx_mcp_upstream_servers_deleted_at;

ALTER TABLE mcp_upstream_servers
    DROP COLUMN IF EXISTS deleted_at;
