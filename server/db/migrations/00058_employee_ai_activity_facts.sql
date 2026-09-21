-- +goose Up
CREATE TABLE employee_ai_activity_facts (
    fact_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN ('skill.created', 'skill.version_uploaded')),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
    actor_user_id TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('app_upload', 'admin_upload', 'source_sync')),
    target_id TEXT NOT NULL,
    target_name TEXT NOT NULL CHECK (char_length(target_name) BETWEEN 1 AND 128),
    source_system TEXT NOT NULL CHECK (source_system = 'skillhub'),
    source_event_key TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT employee_ai_activity_actor CHECK (
        (actor_kind = 'user' AND actor_user_id IS NOT NULL AND actor_user_id <> '' AND origin IN ('app_upload', 'admin_upload'))
        OR (actor_kind = 'system' AND actor_user_id IS NULL AND origin = 'source_sync')
    ),
    UNIQUE (source_system, source_event_key)
);

CREATE INDEX idx_employee_ai_activity_type_time ON employee_ai_activity_facts (event_type, occurred_at);
CREATE INDEX idx_employee_ai_activity_user_time ON employee_ai_activity_facts (actor_user_id, occurred_at);

-- +goose Down
DROP TABLE employee_ai_activity_facts;
