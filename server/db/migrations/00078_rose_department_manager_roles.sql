-- +goose Up
ALTER TABLE rose_departments
    ADD COLUMN manager_role_id TEXT UNIQUE REFERENCES rbac_roles(role_id) ON DELETE RESTRICT,
    ADD COLUMN manager_userids TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE rose_account_roles
    DROP CONSTRAINT rose_account_roles_role_id_fkey,
    ADD CONSTRAINT rose_account_roles_role_id_fkey
        FOREIGN KEY (role_id) REFERENCES rbac_roles(role_id) ON DELETE RESTRICT;
