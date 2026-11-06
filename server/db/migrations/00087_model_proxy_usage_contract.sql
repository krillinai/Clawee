-- +goose Up
ALTER TABLE model_proxy_audit_records
    ADD COLUMN IF NOT EXISTS requested_model TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS upstream_model TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS response_model TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reasoning_tokens BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS usage_status TEXT NOT NULL DEFAULT 'unavailable',
    ADD COLUMN IF NOT EXISTS usage_source TEXT NOT NULL DEFAULT 'unavailable';

UPDATE model_proxy_audit_records
SET usage_status = CASE WHEN usage_available THEN 'complete' ELSE 'unavailable' END,
    usage_source = CASE WHEN usage_available THEN 'upstream' ELSE 'unavailable' END
WHERE usage_status = '' OR usage_status = 'unavailable';

-- +goose Down
ALTER TABLE model_proxy_audit_records
    DROP COLUMN IF EXISTS usage_source,
    DROP COLUMN IF EXISTS usage_status,
    DROP COLUMN IF EXISTS reasoning_tokens,
    DROP COLUMN IF EXISTS cache_creation_tokens,
    DROP COLUMN IF EXISTS response_model,
    DROP COLUMN IF EXISTS upstream_model,
    DROP COLUMN IF EXISTS requested_model;
