-- +goose Up
ALTER TABLE skills ADD COLUMN created_by_user_id TEXT;
ALTER TABLE skill_versions ADD COLUMN uploaded_by_name TEXT NOT NULL DEFAULT '';

UPDATE skills s
SET created_by_user_id = first_version.uploaded_by_user_id
FROM (
    SELECT DISTINCT ON (skill_id) skill_id, uploaded_by_user_id
    FROM skill_versions
    ORDER BY skill_id, created_at, version_id
) first_version
WHERE first_version.skill_id = s.skill_id;

UPDATE skill_versions v
SET uploaded_by_name = a.name
FROM accounts a
WHERE a.user_id = v.uploaded_by_user_id;

CREATE INDEX idx_skill_versions_skill_uploader_created
ON skill_versions(skill_id, uploaded_by_user_id, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS idx_skill_versions_skill_uploader_created;
ALTER TABLE skill_versions DROP COLUMN IF EXISTS uploaded_by_name;
ALTER TABLE skills DROP COLUMN IF EXISTS created_by_user_id;
