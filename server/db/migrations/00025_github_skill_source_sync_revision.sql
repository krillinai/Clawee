-- +goose Up
ALTER TABLE skill_sources
    ADD COLUMN sync_revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE skill_source_sync_runs
    ADD COLUMN source_revision BIGINT NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE skill_source_sync_runs
    DROP COLUMN IF EXISTS source_revision;

ALTER TABLE skill_sources
    DROP COLUMN IF EXISTS sync_revision;
