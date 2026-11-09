-- +goose Up
CREATE TABLE IF NOT EXISTS model_api_keys (
    api_key_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    api_key_hash TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_model_api_keys_active
    ON model_api_keys (user_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_model_api_keys_user_created
    ON model_api_keys (user_id, created_at DESC, api_key_id DESC);

-- +goose Down
DROP TABLE IF EXISTS model_api_keys;
