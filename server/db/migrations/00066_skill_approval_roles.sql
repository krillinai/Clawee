-- +goose Up
CREATE TABLE approval_config_roles (
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES rbac_roles(role_id) ON DELETE RESTRICT,
    PRIMARY KEY (scope_type,scope_id,role_id)
);
ALTER TABLE approval_requests ADD COLUMN approver_user_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE approval_requests ADD COLUMN approver_role_ids TEXT[] NOT NULL DEFAULT '{}';
UPDATE approval_requests r SET approver_user_ids=ARRAY(
    SELECT user_id FROM approval_request_approvers WHERE request_id=r.id ORDER BY user_id
);

-- +goose Down
ALTER TABLE approval_requests DROP COLUMN approver_role_ids;
ALTER TABLE approval_requests DROP COLUMN approver_user_ids;
DROP TABLE approval_config_roles;
