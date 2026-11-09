-- +goose Up
CREATE TABLE skill_contribution_coverage (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO skill_contribution_coverage (id) VALUES (TRUE);

CREATE TABLE skill_first_approvals (
    skill_id TEXT PRIMARY KEY,
    first_approved_at TIMESTAMPTZ NOT NULL,
    snapshot JSONB NOT NULL
);
CREATE INDEX idx_skill_first_approvals_time ON skill_first_approvals (first_approved_at, skill_id);

ALTER TABLE employee_ai_activity_facts ADD COLUMN version_label TEXT;
ALTER TABLE employee_ai_activity_facts ADD COLUMN actor_name TEXT;
UPDATE employee_ai_activity_facts f SET version_label=v.version, actor_name=v.uploaded_by_name
FROM skill_versions v WHERE v.version_id=f.source_event_key;

-- +goose Down
ALTER TABLE employee_ai_activity_facts DROP COLUMN actor_name;
ALTER TABLE employee_ai_activity_facts DROP COLUMN version_label;
DROP TABLE skill_first_approvals;
DROP TABLE skill_contribution_coverage;
