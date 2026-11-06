-- +goose Up
CREATE TABLE rose_departments (
    dingtalk_dept_id TEXT PRIMARY KEY,
    rose_dept_id TEXT NOT NULL,
    parent_dingtalk_dept_id TEXT NOT NULL,
    name TEXT NOT NULL,
    order_num INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('0', '1')),
    in_scope BOOLEAN NOT NULL DEFAULT TRUE,
    role_id TEXT NOT NULL UNIQUE REFERENCES rbac_roles(role_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE rose_department_members (
    dingtalk_dept_id TEXT NOT NULL REFERENCES rose_departments(dingtalk_dept_id),
    rose_user_id TEXT NOT NULL,
    dingtalk_user_id TEXT NOT NULL,
    PRIMARY KEY (dingtalk_dept_id, rose_user_id)
);
CREATE INDEX rose_department_members_user ON rose_department_members(rose_user_id);
CREATE TABLE rose_account_roles (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES rose_departments(role_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);
CREATE INDEX rose_account_roles_role ON rose_account_roles(role_id);
CREATE VIEW effective_account_roles AS
    SELECT user_id, role_id FROM account_roles
    UNION SELECT user_id, role_id FROM rose_account_roles;
CREATE TABLE rose_organization_sync_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    status TEXT NOT NULL DEFAULT 'never' CHECK (status IN ('never', 'running', 'success', 'failed')),
    trigger_source TEXT NOT NULL DEFAULT '',
    operator_user_id TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_daily_date TEXT NOT NULL DEFAULT '',
    counts JSONB NOT NULL DEFAULT '{}',
    error_code TEXT NOT NULL DEFAULT '',
    error_summary TEXT NOT NULL DEFAULT ''
);
INSERT INTO rose_organization_sync_state(singleton) VALUES (TRUE);

-- +goose Down
DROP VIEW effective_account_roles;
DROP TABLE rose_account_roles;
DROP TABLE rose_department_members;
DROP TABLE rose_departments;
DROP TABLE rose_organization_sync_state;
