-- +goose Up
DROP INDEX IF EXISTS uq_accounts_name_ci;

-- +goose Down
CREATE UNIQUE INDEX uq_accounts_name_ci
    ON accounts (lower(btrim(name)))
    WHERE btrim(name) <> '';
