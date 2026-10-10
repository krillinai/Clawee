-- +goose Up
CREATE TABLE skill_space_ai_review_configs (
    space_id TEXT PRIMARY KEY REFERENCES skill_spaces(space_id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    agent_id TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK ((enabled AND agent_id <> '') OR (NOT enabled AND agent_id = ''))
);

CREATE TABLE skill_ai_review_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','manual')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    report JSONB,
    error TEXT NOT NULL DEFAULT '',
    manual_by TEXT NOT NULL DEFAULT '',
    manual_at TIMESTAMPTZ,
    manual_comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX skill_ai_review_attempts_request ON skill_ai_review_attempts(request_id, created_at, attempt_id);
CREATE INDEX skill_ai_review_attempts_pending ON skill_ai_review_attempts(agent_id) WHERE status='pending';

-- +goose Down
DROP TABLE skill_ai_review_attempts;
DROP TABLE skill_space_ai_review_configs;
