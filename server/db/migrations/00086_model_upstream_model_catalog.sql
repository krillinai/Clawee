-- +goose Up
ALTER TABLE model_upstream_accounts
    ADD COLUMN IF NOT EXISTS synced_models JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS manual_models JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS model_sync_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS model_sync_error TEXT NOT NULL DEFAULT '';

UPDATE model_upstream_accounts
SET manual_models = models
WHERE manual_models = '[]'::jsonb
  AND models <> '[]'::jsonb;

-- +goose Down
ALTER TABLE model_upstream_accounts
    DROP COLUMN IF EXISTS model_sync_error,
    DROP COLUMN IF EXISTS model_sync_at,
    DROP COLUMN IF EXISTS manual_models,
    DROP COLUMN IF EXISTS synced_models;
