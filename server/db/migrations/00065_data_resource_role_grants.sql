-- +goose Up
CREATE TABLE data_resource_role_grants (
    grant_id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL REFERENCES rbac_roles(role_id) ON DELETE RESTRICT,
    resource_type TEXT NOT NULL CHECK (resource_type = 'skill_space'),
    resource_id TEXT NOT NULL REFERENCES skill_spaces(space_id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('read', 'write')),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (role_id, resource_type, resource_id, action)
);

CREATE INDEX idx_data_resource_role_grants_resource_action
    ON data_resource_role_grants (resource_type, resource_id, action);

CREATE VIEW effective_data_resource_permissions (user_id, resource_type, resource_id, action) AS
SELECT user_id, resource_type, resource_id, action FROM data_resource_grants
UNION
SELECT ar.user_id, grants.resource_type, grants.resource_id, grants.action
FROM data_resource_role_grants grants
JOIN account_roles ar ON ar.role_id = grants.role_id;

ALTER TABLE data_resource_grant_audits ALTER COLUMN target_user_id DROP NOT NULL;
ALTER TABLE data_resource_grant_audits ADD COLUMN target_role_id TEXT;

-- +goose Down
ALTER TABLE data_resource_grant_audits DROP COLUMN target_role_id;
DELETE FROM data_resource_grant_audits WHERE target_user_id IS NULL;
ALTER TABLE data_resource_grant_audits ALTER COLUMN target_user_id SET NOT NULL;
DROP VIEW effective_data_resource_permissions;
DROP TABLE data_resource_role_grants;
