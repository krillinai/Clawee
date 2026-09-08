-- +goose Up
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM mcp_agent_tokens token
        LEFT JOIN account_agents owner ON owner.agent_id = token.agent_id
        WHERE owner.user_id IS NULL
    ) THEN
        RAISE EXCEPTION 'P8 migration blocked: mcp token agent has no account owner';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM mcp_agent_grants grant_row
        LEFT JOIN account_agents owner ON owner.agent_id = grant_row.agent_id
        WHERE owner.user_id IS NULL
    ) THEN
        RAISE EXCEPTION 'P8 migration blocked: mcp grant agent has no account owner';
    END IF;

    IF EXISTS (
        WITH mapped AS (
            SELECT
                owner.user_id,
                grant_row.capability_id,
                grant_row.grant_type,
                jsonb_build_array(
                    COALESCE(grant_row.data_scope, 'null'::jsonb),
                    to_jsonb(grant_row.expires_at)
                ) AS semantics
            FROM mcp_agent_grants grant_row
            JOIN account_agents owner ON owner.agent_id = grant_row.agent_id
        )
        SELECT 1
        FROM mapped
        GROUP BY user_id, capability_id, grant_type
        HAVING COUNT(DISTINCT semantics) > 1
    ) THEN
        RAISE EXCEPTION 'P8 migration blocked: account has conflicting mcp grants';
    END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE mcp_agent_tokens
    ADD COLUMN user_id TEXT REFERENCES accounts(user_id) ON DELETE CASCADE;

UPDATE mcp_agent_tokens token
SET user_id = owner.user_id
FROM account_agents owner
WHERE owner.agent_id = token.agent_id;

ALTER TABLE mcp_agent_tokens
    ALTER COLUMN user_id SET NOT NULL;

UPDATE mcp_agent_tokens
SET status = 'expired', updated_at = now()
WHERE status = 'active'
  AND expires_at IS NOT NULL
  AND expires_at <= now();

WITH ranked AS (
    SELECT
        token_id,
        row_number() OVER (
            PARTITION BY user_id
            ORDER BY created_at DESC, token_id DESC
        ) AS row_number
    FROM mcp_agent_tokens
    WHERE status = 'active'
      AND token_ciphertext IS NOT NULL
      AND octet_length(token_ciphertext) > 0
)
UPDATE mcp_agent_tokens token
SET status = 'revoked', updated_at = now()
WHERE token.status = 'active'
  AND NOT EXISTS (
      SELECT 1
      FROM ranked
      WHERE ranked.token_id = token.token_id
        AND ranked.row_number = 1
  );

DROP INDEX IF EXISTS idx_mcp_agent_tokens_agent;

ALTER TABLE mcp_agent_tokens
    DROP CONSTRAINT IF EXISTS mcp_agent_tokens_agent_id_fkey;

ALTER TABLE mcp_agent_tokens
    DROP COLUMN agent_id;

ALTER TABLE mcp_agent_tokens
    RENAME TO mcp_account_tokens;

CREATE INDEX idx_mcp_account_tokens_user_status
    ON mcp_account_tokens (user_id, status, created_at DESC);

CREATE UNIQUE INDEX uq_mcp_account_tokens_active
    ON mcp_account_tokens (user_id)
    WHERE status = 'active';

ALTER TABLE mcp_agent_grants
    ADD COLUMN user_id TEXT REFERENCES accounts(user_id) ON DELETE CASCADE;

UPDATE mcp_agent_grants grant_row
SET user_id = owner.user_id
FROM account_agents owner
WHERE owner.agent_id = grant_row.agent_id;

ALTER TABLE mcp_agent_grants
    ALTER COLUMN user_id SET NOT NULL;

WITH ranked AS (
    SELECT
        grant_id,
        row_number() OVER (
            PARTITION BY user_id, capability_id, grant_type
            ORDER BY updated_at DESC, grant_id
        ) AS row_number
    FROM mcp_agent_grants
)
DELETE FROM mcp_agent_grants grant_row
USING ranked
WHERE grant_row.grant_id = ranked.grant_id
  AND ranked.row_number > 1;

DROP INDEX IF EXISTS idx_mcp_agent_grants_agent;
DROP INDEX IF EXISTS idx_mcp_agent_grants_target;
DROP INDEX IF EXISTS uq_mcp_agent_grants_target;

ALTER TABLE mcp_agent_grants
    DROP COLUMN agent_id;

ALTER TABLE mcp_agent_grants
    RENAME TO mcp_account_grants;

CREATE INDEX idx_mcp_account_grants_user
    ON mcp_account_grants (user_id);

CREATE INDEX idx_mcp_account_grants_capability
    ON mcp_account_grants (capability_id);

CREATE UNIQUE INDEX uq_mcp_account_grants_target
    ON mcp_account_grants (user_id, capability_id, grant_type);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    RAISE EXCEPTION 'P8 migration is irreversible; restore the pre-deployment backup';
END $$;
-- +goose StatementEnd
