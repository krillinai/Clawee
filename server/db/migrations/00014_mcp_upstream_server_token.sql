-- +goose Up
ALTER TABLE mcp_upstream_servers
    ADD COLUMN IF NOT EXISTS token_ciphertext BYTEA;

-- +goose Down
ALTER TABLE mcp_upstream_servers
    DROP COLUMN IF EXISTS token_ciphertext;
