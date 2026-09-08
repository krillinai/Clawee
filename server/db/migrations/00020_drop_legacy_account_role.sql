-- +goose Up
DROP INDEX IF EXISTS idx_accounts_role_status;

CREATE INDEX IF NOT EXISTS idx_accounts_status
    ON accounts (status);

ALTER TABLE accounts
    DROP COLUMN IF EXISTS role;

-- +goose Down
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

UPDATE accounts
SET role = 'admin'
WHERE user_id IN (
    SELECT user_id
    FROM account_roles
    WHERE role_id = 'role_admin'
);

ALTER TABLE accounts
    ALTER COLUMN role DROP DEFAULT;

DROP INDEX IF EXISTS idx_accounts_status;

CREATE INDEX IF NOT EXISTS idx_accounts_role_status
    ON accounts (role, status);
