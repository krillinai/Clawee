-- +goose Up
ALTER TABLE office_agents
    ADD COLUMN IF NOT EXISTS mcp_agent_id TEXT
    REFERENCES mcp_agents(agent_id)
    ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_office_agents_mcp_agent_id
    ON office_agents (mcp_agent_id)
    WHERE mcp_agent_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS uq_office_agents_mcp_agent_id;

ALTER TABLE office_agents
    DROP COLUMN IF EXISTS mcp_agent_id;
