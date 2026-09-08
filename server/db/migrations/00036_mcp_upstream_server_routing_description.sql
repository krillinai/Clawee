-- +goose Up
ALTER TABLE mcp_upstream_servers
    ADD COLUMN IF NOT EXISTS routing_description TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE mcp_upstream_servers
    DROP COLUMN IF EXISTS routing_description;
