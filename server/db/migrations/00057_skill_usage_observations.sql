-- +goose Up
CREATE TABLE office_agent_skill_evidence (
    collector_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    skill_key TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('enterprise', 'local')),
    version_id TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL CHECK (evidence IN ('explicit_request', 'skill_file_read', 'skill_resource_run')),
    invocation TEXT NOT NULL CHECK (invocation IN ('explicit', 'implicit')),
    occurred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (collector_id, source_event_id),
    FOREIGN KEY (collector_id, source_event_id)
        REFERENCES office_agent_source_events (collector_id, source_event_id) ON DELETE CASCADE
);

CREATE INDEX idx_office_agent_skill_evidence_range
    ON office_agent_skill_evidence (occurred_at, source, skill_key);

-- +goose Down
DROP TABLE office_agent_skill_evidence;
