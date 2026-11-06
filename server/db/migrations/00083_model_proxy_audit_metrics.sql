-- +goose Up
ALTER TABLE model_proxy_audit_records
    ADD COLUMN IF NOT EXISTS request_type TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS cache_read_tokens BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS first_byte_ms BIGINT NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE model_proxy_audit_records
    DROP COLUMN IF EXISTS first_byte_ms,
    DROP COLUMN IF EXISTS cache_read_tokens,
    DROP COLUMN IF EXISTS request_type;
