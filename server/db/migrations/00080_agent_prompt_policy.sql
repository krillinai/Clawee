-- +goose Up
CREATE TABLE IF NOT EXISTS agent_prompt_policy (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  version BIGINT NOT NULL DEFAULT 0,
  server_agent_prompt TEXT NOT NULL DEFAULT '',
  clawee_agent_prompt TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agent_prompt_policy (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- +goose Down
DROP TABLE IF EXISTS agent_prompt_policy;
