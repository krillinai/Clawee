-- +goose Up
CREATE TABLE IF NOT EXISTS skills (
    skill_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    current_version_id TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
    version_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(skill_id),
    version TEXT NOT NULL,
    description TEXT NOT NULL,
    changelog TEXT NOT NULL DEFAULT '',
    package_path TEXT NOT NULL,
    package_sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (skill_id, version),
    UNIQUE (skill_id, version_id)
);

ALTER TABLE skills
    ADD CONSTRAINT fk_skills_current_version
    FOREIGN KEY (skill_id, current_version_id)
    REFERENCES skill_versions (skill_id, version_id);

CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_created_at ON skill_versions(skill_id, created_at DESC);

-- +goose Down
ALTER TABLE skills DROP CONSTRAINT IF EXISTS fk_skills_current_version;
DROP TABLE IF EXISTS skill_versions;
DROP TABLE IF EXISTS skills;
