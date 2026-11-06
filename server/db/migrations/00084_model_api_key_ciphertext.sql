-- +goose Up
ALTER TABLE model_api_keys
    ADD COLUMN IF NOT EXISTS api_key_ciphertext BYTEA;

-- +goose Down
ALTER TABLE model_api_keys
    DROP COLUMN IF EXISTS api_key_ciphertext;
