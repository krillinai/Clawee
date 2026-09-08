-- +goose Up
DELETE FROM data_resource_grants AS legacy
WHERE legacy.resource_type = 'knowledge_base'
  AND legacy.action = 'search'
  AND EXISTS (
      SELECT 1
      FROM data_resource_grants AS current
      WHERE current.user_id = legacy.user_id
        AND current.resource_type = legacy.resource_type
        AND current.resource_id = legacy.resource_id
        AND current.action = 'mcp'
  );

UPDATE data_resource_grants
SET action = 'mcp', updated_at = now()
WHERE resource_type = 'knowledge_base'
  AND action = 'search';

UPDATE mcp_agent_grants AS agent_grant
SET data_scope = NULL, updated_at = now()
FROM mcp_capabilities AS capability
WHERE capability.capability_id = agent_grant.capability_id
  AND capability.upstream_server_id = 'knowledge-adapter'
  AND capability.upstream_name = 'search';

-- +goose Down
UPDATE data_resource_grants
SET action = 'search', updated_at = now()
WHERE resource_type = 'knowledge_base'
  AND action = 'mcp';
