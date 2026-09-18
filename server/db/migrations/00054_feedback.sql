-- +goose Up
CREATE TABLE feedback_reports (
 report_id text PRIMARY KEY,
 client_feedback_id text NOT NULL UNIQUE,
 report_data jsonb NOT NULL,
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes >= 0),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX feedback_reports_created ON feedback_reports(created_at DESC, report_id DESC);
CREATE TABLE feedback_report_artifacts (
 report_id text NOT NULL REFERENCES feedback_reports(report_id) ON DELETE CASCADE,
 artifact_id text NOT NULL,
 artifact_data jsonb NOT NULL,
 PRIMARY KEY(report_id, artifact_id)
);
CREATE TABLE feedback_report_events (
 event_id text PRIMARY KEY,
 report_id text NOT NULL REFERENCES feedback_reports(report_id) ON DELETE CASCADE,
 actor_user_id text NOT NULL,
 operation text NOT NULL,
 idempotency_key text NOT NULL,
 event_data jsonb NOT NULL,
 UNIQUE(report_id, actor_user_id, operation, idempotency_key)
);
CREATE TABLE feedback_cleanup_tasks (
 storage_key text PRIMARY KEY,
 profile_id text NOT NULL DEFAULT 'feedback-local',
 report_id text NOT NULL,
 reason text NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE feedback_deployment_credentials (
 credential_id text PRIMARY KEY,
 source_id text NOT NULL,
 token_hash text NOT NULL UNIQUE,
 enabled boolean NOT NULL DEFAULT true,
 expires_at timestamptz NOT NULL,
 capacity_bytes bigint NOT NULL DEFAULT 2147483648 CHECK(capacity_bytes > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz
);
CREATE TABLE feedback_rate_limits (
 bucket_hash text PRIMARY KEY,
 window_at timestamptz NOT NULL,
 count integer NOT NULL
);
-- +goose Down
DROP TABLE feedback_rate_limits;
DROP TABLE feedback_deployment_credentials;
DROP TABLE feedback_cleanup_tasks;
DROP TABLE feedback_report_events;
DROP TABLE feedback_report_artifacts;
DROP TABLE feedback_reports;
