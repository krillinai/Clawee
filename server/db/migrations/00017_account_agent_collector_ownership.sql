-- +goose Up
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM account_agents
        GROUP BY agent_id
        HAVING COUNT(DISTINCT user_id) > 1
    ) THEN
        RAISE EXCEPTION 'P1.1 migration blocked: agent has multiple owners';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM office_collector_tokens
        GROUP BY token_hash
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'P1.1 migration blocked: collector token hash is duplicated';
    END IF;
END $$;
-- +goose StatementEnd

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_agents_agent_id
    ON account_agents (agent_id);

ALTER TABLE office_collector_tokens
    ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES accounts(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_office_collector_tokens_token_hash
    ON office_collector_tokens (token_hash);

ALTER TABLE office_collector_registration_codes
    ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES accounts(user_id);

UPDATE office_collector_registration_codes
SET revoked_at = COALESCE(revoked_at, now()),
    registration_code = '';

ALTER TABLE mcp_list_audit_records
    ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';

ALTER TABLE mcp_proxy_audit_records
    ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';

ALTER TABLE mcp_gate_requests
    ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE mcp_gate_requests DROP COLUMN IF EXISTS user_id;
ALTER TABLE mcp_proxy_audit_records DROP COLUMN IF EXISTS user_id;
ALTER TABLE mcp_list_audit_records DROP COLUMN IF EXISTS user_id;
ALTER TABLE office_collector_registration_codes DROP COLUMN IF EXISTS user_id;
DROP INDEX IF EXISTS uq_office_collector_tokens_token_hash;
ALTER TABLE office_collector_tokens DROP COLUMN IF EXISTS user_id;
DROP INDEX IF EXISTS uq_account_agents_agent_id;
