-- +goose Up
ALTER TABLE mcp_upstream_servers
    ADD COLUMN IF NOT EXISTS collector_id TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE mcp_upstream_servers
    DROP COLUMN IF EXISTS collector_id;
