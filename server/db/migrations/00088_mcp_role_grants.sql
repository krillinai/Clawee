-- +goose Up
ALTER TABLE mcp_account_grants
    ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE mcp_account_grants
    ADD COLUMN role_id TEXT REFERENCES rbac_roles(role_id) ON DELETE RESTRICT;

ALTER TABLE mcp_account_grants
    ADD CONSTRAINT mcp_account_grants_one_target
    CHECK ((user_id IS NOT NULL) <> (role_id IS NOT NULL));

DROP INDEX IF EXISTS uq_mcp_account_grants_target;

CREATE UNIQUE INDEX uq_mcp_account_grants_user_target
    ON mcp_account_grants (user_id, capability_id, grant_type)
    WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_mcp_account_grants_role_target
    ON mcp_account_grants (role_id, capability_id, grant_type)
    WHERE role_id IS NOT NULL;

CREATE INDEX idx_mcp_account_grants_role
    ON mcp_account_grants (role_id)
    WHERE role_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_mcp_account_grants_role;
DROP INDEX IF EXISTS uq_mcp_account_grants_role_target;
DROP INDEX IF EXISTS uq_mcp_account_grants_user_target;
DROP INDEX IF EXISTS uq_mcp_account_grants_target;

ALTER TABLE mcp_account_grants
    DROP CONSTRAINT IF EXISTS mcp_account_grants_one_target;

ALTER TABLE mcp_account_grants
    DROP COLUMN IF EXISTS role_id;

ALTER TABLE mcp_account_grants
    ALTER COLUMN user_id SET NOT NULL;

CREATE UNIQUE INDEX uq_mcp_account_grants_target
    ON mcp_account_grants (user_id, capability_id, grant_type);
