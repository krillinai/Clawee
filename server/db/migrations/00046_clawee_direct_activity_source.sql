-- +goose Up
ALTER TABLE office_collector_tokens
    ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'collector';

-- +goose Down
ALTER TABLE office_collector_tokens
    DROP COLUMN IF EXISTS source_type;
