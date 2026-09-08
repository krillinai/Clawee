-- +goose Up
CREATE TABLE IF NOT EXISTS office_collector_tokens (
    collector_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    device_label TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS office_collector_devices (
    collector_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    collector_version TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collector_id, device_id)
);

CREATE TABLE IF NOT EXISTS office_agents (
    collector_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    workspace_name TEXT NOT NULL DEFAULT '',
    current_session_id TEXT NOT NULL DEFAULT '',
    current_turn_id TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collector_id, agent_id)
);

CREATE TABLE IF NOT EXISTS office_agent_sessions (
    collector_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    workspace_name TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collector_id, agent_id, session_id)
);

CREATE TABLE IF NOT EXISTS office_agent_turns (
    collector_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    sub_agent_id TEXT NOT NULL DEFAULT '',
    parent_agent_id TEXT NOT NULL DEFAULT '',
    parent_turn_id TEXT NOT NULL DEFAULT '',
    spawn_tool_call_id TEXT NOT NULL DEFAULT '',
    user_prompt TEXT NOT NULL DEFAULT '',
    assistant_summary TEXT NOT NULL DEFAULT '',
    last_assistant_message TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (collector_id, agent_id, turn_id)
);

CREATE TABLE IF NOT EXISTS office_agent_sub_agents (
    collector_id TEXT NOT NULL,
    parent_agent_id TEXT NOT NULL,
    sub_agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    parent_turn_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    current_activity TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    nickname TEXT NOT NULL DEFAULT '',
    spawn_tool_call_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (collector_id, parent_agent_id, sub_agent_id)
);

CREATE TABLE IF NOT EXISTS office_agent_activities (
    collector_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    sub_agent_id TEXT,
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    activity_type TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tool_call_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (collector_id, agent_id, activity_id)
);

CREATE TABLE IF NOT EXISTS office_agent_source_events (
    collector_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    standard_event_type TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    source_type TEXT NOT NULL DEFAULT '',
    source_event_type TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    sub_agent_id TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT NOT NULL DEFAULT '',
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    standard_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    parse_status TEXT NOT NULL DEFAULT 'parsed',
    parse_error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (collector_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_office_agents_last_seen_at
    ON office_agents (collector_id, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_office_agent_source_events_received_at
    ON office_agent_source_events (received_at);

CREATE INDEX IF NOT EXISTS idx_office_agent_source_events_scope
    ON office_agent_source_events (collector_id, source_type, session_id, turn_id, received_at);

CREATE INDEX IF NOT EXISTS idx_office_agent_activities_agent_started_at
    ON office_agent_activities (collector_id, agent_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_office_agent_activities_open
    ON office_agent_activities (collector_id, agent_id, COALESCE(sub_agent_id, ''), session_id, turn_id, activity_type)
    WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_office_agent_sub_agents_parent_status
    ON office_agent_sub_agents (collector_id, parent_agent_id, status);

CREATE INDEX IF NOT EXISTS idx_office_agent_sessions_active
    ON office_agent_sessions (collector_id, agent_id, started_at DESC)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_office_agent_turns_active
    ON office_agent_turns (collector_id, agent_id, started_at DESC)
    WHERE completed_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS office_agent_source_events;
DROP TABLE IF EXISTS office_agent_activities;
DROP TABLE IF EXISTS office_agent_sub_agents;
DROP TABLE IF EXISTS office_agent_turns;
DROP TABLE IF EXISTS office_agent_sessions;
DROP TABLE IF EXISTS office_agents;
DROP TABLE IF EXISTS office_collector_devices;
DROP TABLE IF EXISTS office_collector_tokens;
