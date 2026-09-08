-- +goose Up
CREATE TABLE IF NOT EXISTS skill_sources (
    source_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider = 'github'),
    repository_owner TEXT NOT NULL,
    repository_name TEXT NOT NULL,
    branch TEXT NOT NULL,
    scan_root TEXT NOT NULL DEFAULT '.',
    exclude_paths TEXT[] NOT NULL DEFAULT '{}',
    token_ciphertext BYTEA,
    auto_publish BOOLEAN NOT NULL DEFAULT FALSE,
    schedule TEXT NOT NULL CHECK (schedule IN ('manual', 'hourly', 'daily')),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_synced_commit_sha TEXT,
    last_error_summary TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (repository_owner, repository_name)
);

CREATE TABLE IF NOT EXISTS skill_source_items (
    source_item_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES skill_sources(source_id),
    skill_path TEXT NOT NULL,
    discovered_name TEXT NOT NULL DEFAULT '',
    skill_id TEXT REFERENCES skills(skill_id),
    status TEXT NOT NULL CHECK (status IN ('active', 'name_conflict', 'name_changed', 'invalid', 'missing')),
    last_seen_commit_sha TEXT,
    last_content_sha256 TEXT,
    last_version_id TEXT REFERENCES skill_versions(version_id),
    last_error_summary TEXT NOT NULL DEFAULT '',
    missing_since TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (source_id, skill_path)
);

CREATE UNIQUE INDEX uq_skill_source_items_bound_skill
    ON skill_source_items(skill_id) WHERE skill_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS skill_source_sync_runs (
    run_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES skill_sources(source_id),
    trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'partial', 'failed', 'skipped', 'interrupted')),
    requested_by TEXT NOT NULL,
    before_commit_sha TEXT,
    target_commit_sha TEXT,
    discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
    created_version_count INTEGER NOT NULL DEFAULT 0 CHECK (created_version_count >= 0),
    published_count INTEGER NOT NULL DEFAULT 0 CHECK (published_count >= 0),
    conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    error_summary TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX uq_skill_source_active_run
    ON skill_source_sync_runs(source_id) WHERE status IN ('queued', 'running');

ALTER TABLE skill_versions
    ADD COLUMN IF NOT EXISTS source_id TEXT REFERENCES skill_sources(source_id),
    ADD COLUMN IF NOT EXISTS source_path TEXT,
    ADD COLUMN IF NOT EXISTS source_commit_sha TEXT,
    ADD COLUMN IF NOT EXISTS source_content_sha256 TEXT;

ALTER TABLE skill_versions ADD CONSTRAINT ck_skill_versions_source_evidence CHECK (
    (source_id IS NULL AND source_path IS NULL AND source_commit_sha IS NULL AND source_content_sha256 IS NULL)
    OR
    (source_id IS NOT NULL AND source_path IS NOT NULL AND source_commit_sha IS NOT NULL AND source_content_sha256 IS NOT NULL AND length(source_commit_sha) = 40 AND length(source_content_sha256) = 64)
);

CREATE UNIQUE INDEX uq_skill_versions_source_commit
    ON skill_versions(source_id, source_path, source_commit_sha)
    WHERE source_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS uq_skill_versions_source_commit;
ALTER TABLE skill_versions DROP CONSTRAINT IF EXISTS ck_skill_versions_source_evidence;
ALTER TABLE skill_versions DROP CONSTRAINT IF EXISTS skill_versions_source_id_fkey;
DROP TABLE IF EXISTS skill_source_sync_runs;
DROP TABLE IF EXISTS skill_source_items;
DROP TABLE IF EXISTS skill_sources;
ALTER TABLE skill_versions
    DROP COLUMN IF EXISTS source_content_sha256,
    DROP COLUMN IF EXISTS source_commit_sha,
    DROP COLUMN IF EXISTS source_path,
    DROP COLUMN IF EXISTS source_id;
