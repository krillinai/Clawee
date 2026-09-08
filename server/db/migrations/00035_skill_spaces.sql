-- +goose Up
CREATE TABLE IF NOT EXISTS skill_spaces (
    space_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_spaces_name_unique ON skill_spaces (lower(name));
CREATE INDEX IF NOT EXISTS idx_skill_spaces_updated ON skill_spaces (updated_at DESC, space_id);

INSERT INTO skill_spaces (space_id,name,description,created_by,updated_by,created_at,updated_at)
VALUES ('skillspace_default','默认技能空间','迁移前已有技能的默认归属空间','system','system',now(),now())
ON CONFLICT (space_id) DO NOTHING;

ALTER TABLE skills ADD COLUMN space_id TEXT REFERENCES skill_spaces(space_id);
UPDATE skills SET space_id='skillspace_default' WHERE space_id IS NULL;
ALTER TABLE skills ALTER COLUMN space_id SET NOT NULL, ALTER COLUMN space_id SET DEFAULT 'skillspace_default';
CREATE INDEX IF NOT EXISTS idx_skills_space_updated ON skills (space_id, updated_at DESC, skill_id);

ALTER TABLE skill_sources ADD COLUMN space_id TEXT REFERENCES skill_spaces(space_id);
UPDATE skill_sources SET space_id='skillspace_default' WHERE space_id IS NULL;
ALTER TABLE skill_sources ALTER COLUMN space_id SET NOT NULL, ALTER COLUMN space_id SET DEFAULT 'skillspace_default';
CREATE INDEX IF NOT EXISTS idx_skill_sources_space_created ON skill_sources (space_id, created_at DESC, source_id);

ALTER TABLE skill_versions ADD COLUMN uploaded_by_user_id TEXT, ADD COLUMN uploaded_by_agent_id TEXT;

INSERT INTO data_resource_grants (grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at)
SELECT 'drg_skillspace_read_' || md5(a.user_id),a.user_id,'skill_space','skillspace_default','read','system',now(),now()
FROM accounts a WHERE a.status='active'
ON CONFLICT (user_id,resource_type,resource_id,action) DO NOTHING;

INSERT INTO data_resource_grants (grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at)
SELECT 'drg_skillspace_write_' || md5(a.user_id),a.user_id,'skill_space','skillspace_default','write','system',now(),now()
FROM accounts a
WHERE a.status='active' AND (
    EXISTS (SELECT 1 FROM account_roles ar JOIN rbac_roles r ON r.role_id=ar.role_id WHERE ar.user_id=a.user_id AND r.code='admin')
    OR EXISTS (SELECT 1 FROM account_roles ar JOIN role_permissions rp ON rp.role_id=ar.role_id WHERE ar.user_id=a.user_id AND rp.permission_code='console:skill:manage')
)
ON CONFLICT (user_id,resource_type,resource_id,action) DO NOTHING;

-- +goose Down
DELETE FROM data_resource_grants WHERE resource_type='skill_space';
ALTER TABLE skill_versions DROP COLUMN IF EXISTS uploaded_by_agent_id, DROP COLUMN IF EXISTS uploaded_by_user_id;
DROP INDEX IF EXISTS idx_skill_sources_space_created;
ALTER TABLE skill_sources DROP COLUMN IF EXISTS space_id;
DROP INDEX IF EXISTS idx_skills_space_updated;
ALTER TABLE skills DROP COLUMN IF EXISTS space_id;
DROP TABLE IF EXISTS skill_spaces;
