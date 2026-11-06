-- +goose Up
ALTER TABLE accounts ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ALTER COLUMN email SET DEFAULT '';
ALTER TABLE accounts DROP CONSTRAINT accounts_email_key;
CREATE UNIQUE INDEX accounts_email_key ON accounts (email) WHERE email <> '';
CREATE UNIQUE INDEX accounts_phone_key ON accounts (phone) WHERE phone <> '';
ALTER TABLE accounts ADD CONSTRAINT accounts_login_identifier_check CHECK (email <> '' OR phone <> '');
ALTER TABLE account_identities ADD COLUMN enterprise_user_id TEXT NOT NULL DEFAULT '';

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM accounts WHERE phone <> '') THEN
        RAISE EXCEPTION 'Cannot roll back phone accounts while phone data exists';
    END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE account_identities DROP COLUMN enterprise_user_id;
ALTER TABLE accounts DROP CONSTRAINT accounts_login_identifier_check;
DROP INDEX accounts_phone_key;
DROP INDEX accounts_email_key;
ALTER TABLE accounts ADD CONSTRAINT accounts_email_key UNIQUE (email);
ALTER TABLE accounts ALTER COLUMN email DROP DEFAULT;
ALTER TABLE accounts DROP COLUMN phone;
