-- +goose Up
ALTER TABLE account_sessions
    ADD COLUMN IF NOT EXISTS agent_id TEXT;

ALTER TABLE account_sessions
    ADD CONSTRAINT fk_account_sessions_agent_owner
    FOREIGN KEY (user_id, agent_id)
    REFERENCES account_agents (user_id, agent_id)
    ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_account_sessions_agent_owner
    ON account_sessions (user_id, agent_id)
    WHERE agent_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_account_sessions_agent_owner;

ALTER TABLE account_sessions
    DROP CONSTRAINT IF EXISTS fk_account_sessions_agent_owner;

ALTER TABLE account_sessions
    DROP COLUMN IF EXISTS agent_id;
