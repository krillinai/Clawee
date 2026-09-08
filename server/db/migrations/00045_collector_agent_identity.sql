-- +goose Up
ALTER TABLE office_collector_tokens
    ADD COLUMN IF NOT EXISTS agent_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_office_collector_tokens_agent
    ON office_collector_tokens (agent_id)
    WHERE agent_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS uq_office_collector_tokens_agent;

ALTER TABLE office_collector_tokens
    DROP COLUMN IF EXISTS agent_id;
