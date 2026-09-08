-- +goose Up
ALTER TABLE skill_source_sync_runs
    ADD COLUMN repository_mode TEXT NOT NULL DEFAULT 'remote'
    CHECK (repository_mode IN ('remote', 'local'));

-- +goose Down
ALTER TABLE skill_source_sync_runs
    DROP COLUMN IF EXISTS repository_mode;
