-- +goose Up
CREATE TABLE IF NOT EXISTS rbac_roles (
    role_id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS account_roles (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES rbac_roles(role_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_account_roles_role_id
    ON account_roles (role_id);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id TEXT NOT NULL REFERENCES rbac_roles(role_id) ON DELETE CASCADE,
    permission_code TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (role_id, permission_code)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_code
    ON role_permissions (permission_code);

CREATE TABLE IF NOT EXISTS rbac_operation_audits (
    audit_id TEXT PRIMARY KEY,
    operator_user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_snapshot JSONB NOT NULL,
    after_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rbac_operation_audits_created_at
    ON rbac_operation_audits (created_at DESC);

INSERT INTO rbac_roles (role_id, code, name, is_system, created_at, updated_at)
VALUES ('role_admin', 'admin', '系统管理员', TRUE, now(), now())
ON CONFLICT (role_id) DO UPDATE SET
    code = EXCLUDED.code,
    name = EXCLUDED.name,
    is_system = TRUE,
    updated_at = EXCLUDED.updated_at;

INSERT INTO account_roles (user_id, role_id, created_at)
SELECT user_id, 'role_admin', now()
FROM accounts
WHERE role = 'admin'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- +goose Down
DROP TABLE IF EXISTS rbac_operation_audits;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS account_roles;
DROP TABLE IF EXISTS rbac_roles;
