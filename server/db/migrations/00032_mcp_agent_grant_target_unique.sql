-- +goose Up
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_agent_grants_target
    ON mcp_agent_grants (agent_id, capability_id, grant_type);

-- +goose Down
DROP INDEX IF EXISTS uq_mcp_agent_grants_target;
