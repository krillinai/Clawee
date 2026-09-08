-- +goose Up
ALTER TABLE mcp_upstream_servers
    DROP COLUMN IF EXISTS environment;

-- +goose Down
ALTER TABLE mcp_upstream_servers
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT '';
