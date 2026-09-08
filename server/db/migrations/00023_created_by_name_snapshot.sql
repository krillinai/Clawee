-- +goose Up
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM accounts
        WHERE btrim(name) <> ''
        GROUP BY lower(btrim(name))
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'migration blocked: accounts contain duplicate case-insensitive names';
    END IF;
END $$;
-- +goose StatementEnd

UPDATE skills AS target
SET created_by = COALESCE(NULLIF(btrim(account.name), ''), NULLIF(btrim(account.email), ''), account.user_id)
FROM accounts AS account
WHERE target.created_by = account.user_id;

UPDATE knowledge_bases AS target
SET created_by = COALESCE(NULLIF(btrim(account.name), ''), NULLIF(btrim(account.email), ''), account.user_id)
FROM accounts AS account
WHERE target.created_by = account.user_id;

UPDATE mcp_agent_grants AS target
SET created_by = COALESCE(NULLIF(btrim(account.name), ''), NULLIF(btrim(account.email), ''), account.user_id)
FROM accounts AS account
WHERE target.created_by = account.user_id;

UPDATE office_collector_registration_codes AS target
SET created_by = COALESCE(NULLIF(btrim(account.name), ''), NULLIF(btrim(account.email), ''), account.user_id)
FROM accounts AS account
WHERE target.created_by = account.user_id;

CREATE UNIQUE INDEX uq_accounts_name_ci
    ON accounts (lower(btrim(name)))
    WHERE btrim(name) <> '';

-- +goose Down
DROP INDEX IF EXISTS uq_accounts_name_ci;
