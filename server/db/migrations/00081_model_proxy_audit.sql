-- +goose Up
CREATE TABLE IF NOT EXISTS model_proxy_audit_records (
    audit_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    user_name_snapshot TEXT NOT NULL DEFAULT '',
    api_key_id TEXT NOT NULL DEFAULT '',
    api_key_fingerprint TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    gateway_status INTEGER NOT NULL DEFAULT 0,
    upstream_status INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    usage_available BOOLEAN NOT NULL DEFAULT FALSE,
    request_headers JSONB,
    request_body JSONB,
    response_headers JSONB,
    response_body JSONB,
    request_bytes BIGINT NOT NULL DEFAULT 0,
    response_bytes BIGINT NOT NULL DEFAULT 0,
    response_chunks BIGINT NOT NULL DEFAULT 0,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_model_proxy_audit_user_created
    ON model_proxy_audit_records (user_id, created_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_model_proxy_audit_model_created
    ON model_proxy_audit_records (model, created_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_model_proxy_audit_status_created
    ON model_proxy_audit_records (status, created_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_model_proxy_audit_request_id
    ON model_proxy_audit_records (request_id);

-- +goose Down
DROP TABLE IF EXISTS model_proxy_audit_records;
