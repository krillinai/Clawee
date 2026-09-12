-- +goose Up
CREATE TABLE shared_file_storage_profiles (
    profile_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('local', 'aliyun_oss')),
    endpoint TEXT,
    region TEXT,
    bucket TEXT,
    object_prefix TEXT,
    credential_mode TEXT CHECK (credential_mode IS NULL OR credential_mode IN ('ecs_ram_role', 'access_key')),
    access_key_id_ciphertext BYTEA,
    access_key_secret_ciphertext BYTEA,
    access_key_id_hint TEXT,
    status TEXT NOT NULL CHECK (status IN ('enabled', 'retired')),
    last_probe_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_probe_status IN ('unknown', 'success', 'failed')),
    last_probe_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (
        (provider = 'local' AND endpoint IS NULL AND region IS NULL AND bucket IS NULL AND object_prefix IS NULL AND credential_mode IS NULL AND access_key_id_ciphertext IS NULL AND access_key_secret_ciphertext IS NULL)
        OR
        (provider = 'aliyun_oss' AND endpoint IS NOT NULL AND region IS NOT NULL AND bucket IS NOT NULL AND object_prefix IS NOT NULL AND credential_mode IS NOT NULL
            AND (credential_mode = 'ecs_ram_role' OR (access_key_id_ciphertext IS NOT NULL AND access_key_secret_ciphertext IS NOT NULL)))
    )
);

INSERT INTO shared_file_storage_profiles
    (profile_id, name, provider, status, created_by, updated_by, created_at, updated_at)
VALUES
    ('shared_files_local_default', '服务器本地存储', 'local', 'enabled', 'system', 'system', NOW(), NOW());

CREATE TABLE shared_file_storage_settings (
    id TEXT PRIMARY KEY CHECK (id = 'default'),
    active_profile_id TEXT NOT NULL REFERENCES shared_file_storage_profiles(profile_id) ON DELETE RESTRICT,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

INSERT INTO shared_file_storage_settings
    (id, active_profile_id, revision, updated_by, created_at, updated_at)
VALUES
    ('default', 'shared_files_local_default', 1, 'system', NOW(), NOW());

ALTER TABLE shared_files ADD COLUMN storage_profile_id TEXT;
UPDATE shared_files SET storage_profile_id = 'shared_files_local_default';
ALTER TABLE shared_files
    ALTER COLUMN storage_profile_id SET NOT NULL,
    ADD CONSTRAINT fk_shared_files_storage_profile
        FOREIGN KEY (storage_profile_id) REFERENCES shared_file_storage_profiles(profile_id) ON DELETE RESTRICT;
CREATE INDEX idx_shared_files_storage_profile ON shared_files (storage_profile_id);

CREATE TABLE shared_file_storage_migrations (
    migration_id TEXT PRIMARY KEY,
    source_profile_id TEXT NOT NULL REFERENCES shared_file_storage_profiles(profile_id) ON DELETE RESTRICT,
    target_profile_id TEXT NOT NULL REFERENCES shared_file_storage_profiles(profile_id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'completed_with_failures', 'completed_with_cleanup_pending', 'cancelled')),
    total_count BIGINT NOT NULL DEFAULT 0,
    success_count BIGINT NOT NULL DEFAULT 0,
    failed_count BIGINT NOT NULL DEFAULT 0,
    skipped_count BIGINT NOT NULL DEFAULT 0,
    cleanup_pending_count BIGINT NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CHECK (source_profile_id <> target_profile_id)
);
CREATE UNIQUE INDEX idx_shared_file_storage_migration_source_running
    ON shared_file_storage_migrations (source_profile_id)
    WHERE status IN ('pending', 'running');

CREATE TABLE shared_file_storage_migration_items (
    migration_id TEXT NOT NULL REFERENCES shared_file_storage_migrations(migration_id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    source_profile_id TEXT NOT NULL REFERENCES shared_file_storage_profiles(profile_id) ON DELETE RESTRICT,
    source_storage_key TEXT NOT NULL,
    source_revision BIGINT NOT NULL,
    source_size_bytes BIGINT NOT NULL,
    source_sha256 CHAR(64) NOT NULL,
    target_storage_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    heartbeat_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    PRIMARY KEY (migration_id, file_id)
);
CREATE INDEX idx_shared_file_storage_migration_items_claim
    ON shared_file_storage_migration_items (status, heartbeat_at);

CREATE TABLE shared_file_storage_cleanup_tasks (
    cleanup_id TEXT PRIMARY KEY,
    storage_profile_id TEXT NOT NULL REFERENCES shared_file_storage_profiles(profile_id) ON DELETE RESTRICT,
    storage_key TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('upload_compensation', 'replace_old_object', 'migration_source')),
    file_id TEXT,
    migration_id TEXT REFERENCES shared_file_storage_migrations(migration_id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_shared_file_storage_cleanup_pending_object
    ON shared_file_storage_cleanup_tasks (storage_profile_id, storage_key)
    WHERE status IN ('pending', 'running', 'failed');

CREATE TABLE shared_file_storage_audits (
    audit_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    operator_user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    object_id TEXT NOT NULL,
    result TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL
);

-- +goose Down
DROP TABLE IF EXISTS shared_file_storage_audits;
DROP TABLE IF EXISTS shared_file_storage_cleanup_tasks;
DROP TABLE IF EXISTS shared_file_storage_migration_items;
DROP TABLE IF EXISTS shared_file_storage_migrations;
DROP INDEX IF EXISTS idx_shared_files_storage_profile;
ALTER TABLE shared_files DROP CONSTRAINT IF EXISTS fk_shared_files_storage_profile;
ALTER TABLE shared_files DROP COLUMN IF EXISTS storage_profile_id;
DROP TABLE IF EXISTS shared_file_storage_settings;
DROP TABLE IF EXISTS shared_file_storage_profiles;
