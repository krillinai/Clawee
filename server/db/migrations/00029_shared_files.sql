-- +goose Up
CREATE TABLE IF NOT EXISTS shared_spaces (
    space_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_spaces_name_unique
    ON shared_spaces (lower(name));

CREATE INDEX IF NOT EXISTS idx_shared_spaces_updated
    ON shared_spaces (updated_at DESC, space_id);

CREATE TABLE IF NOT EXISTS shared_files (
    file_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES shared_spaces(space_id) ON DELETE RESTRICT,
    logical_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    sha256 CHAR(64) NOT NULL,
    content_type TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    created_by_user_id TEXT NOT NULL,
    created_by_agent_id TEXT NOT NULL,
    updated_by_user_id TEXT NOT NULL,
    updated_by_agent_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (space_id, logical_path)
);

CREATE INDEX IF NOT EXISTS idx_shared_files_space_updated
    ON shared_files (space_id, updated_at DESC, file_id);

CREATE INDEX IF NOT EXISTS idx_shared_files_updated
    ON shared_files (updated_at DESC, file_id);

-- +goose Down
DROP TABLE IF EXISTS shared_files;
DROP TABLE IF EXISTS shared_spaces;
