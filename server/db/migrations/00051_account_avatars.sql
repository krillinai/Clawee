-- +goose Up
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS avatar_data BYTEA,
    ADD COLUMN IF NOT EXISTS avatar_content_type TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS avatar_source TEXT NOT NULL DEFAULT 'generated';

-- +goose Down
ALTER TABLE accounts
    DROP COLUMN IF EXISTS avatar_data,
    DROP COLUMN IF EXISTS avatar_content_type,
    DROP COLUMN IF EXISTS avatar_source;
