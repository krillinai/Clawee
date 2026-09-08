-- +goose Up
ALTER TABLE mcp_agents
    ADD COLUMN IF NOT EXISTS creation_source TEXT NOT NULL DEFAULT 'legacy';

UPDATE mcp_agents a
SET creation_source = 'collector'
WHERE EXISTS (
    SELECT 1
    FROM mcp_agent_tokens t
    WHERE t.agent_id = a.agent_id
      AND t.issuer = 'claw-collector'
);

UPDATE mcp_agents
SET creation_source = 'clawee_login'
WHERE creation_source = 'legacy'
  AND client_id = 'clawee-agent';

-- +goose Down
ALTER TABLE mcp_agents
    DROP COLUMN IF EXISTS creation_source;
