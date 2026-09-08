-- +goose Up
UPDATE mcp_agents a
SET name = COALESCE(NULLIF(BTRIM(owner.name), ''), NULLIF(BTRIM(owner.email), ''), owner.user_id) || '的Codex',
    updated_at = now()
FROM account_agents aa
JOIN accounts owner ON owner.user_id = aa.user_id
WHERE aa.agent_id = a.agent_id
  AND a.creation_source = 'collector'
  AND (BTRIM(a.name) = '' OR a.name IN ('Codex Local', 'Codex Windows'));

-- +goose Down
-- Default-name normalization is intentionally irreversible.
