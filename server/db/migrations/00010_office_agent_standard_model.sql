-- +goose Up
CREATE TABLE IF NOT EXISTS office_agent_tool_calls (
    collector_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    external_tool_call_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    sub_agent_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL,
    tool_type TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    input JSONB NOT NULL DEFAULT '{}'::jsonb,
    response JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_text TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    source_event_start_id TEXT NOT NULL DEFAULT '',
    source_event_end_id TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collector_id, agent_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_office_agent_tool_calls_started_at
    ON office_agent_tool_calls (started_at);

CREATE INDEX IF NOT EXISTS idx_office_agent_tool_calls_agent_started_at
    ON office_agent_tool_calls (collector_id, agent_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_office_agent_tool_calls_turn
    ON office_agent_tool_calls (collector_id, agent_id, turn_id, started_at);

CREATE INDEX IF NOT EXISTS idx_office_agent_tool_calls_external
    ON office_agent_tool_calls (collector_id, external_tool_call_id);

-- +goose Down
DROP TABLE IF EXISTS office_agent_tool_calls;
