-- +goose Up
ALTER TABLE feedback_reports ADD COLUMN last_occurred_at TIMESTAMPTZ;
UPDATE feedback_reports SET last_occurred_at = created_at;
ALTER TABLE feedback_reports ALTER COLUMN last_occurred_at SET NOT NULL;
ALTER TABLE feedback_reports ALTER COLUMN last_occurred_at SET DEFAULT now();
CREATE INDEX idx_feedback_last_occurred ON feedback_reports (last_occurred_at DESC, report_id DESC);
CREATE INDEX idx_feedback_incident_filter ON feedback_reports ((COALESCE(NULLIF(report_data->>'kind',''),'manual')), (report_data->'incident'->>'layer'), (report_data->'incident'->>'error_code'), last_occurred_at DESC);

-- +goose Down
DROP INDEX idx_feedback_incident_filter;
DROP INDEX idx_feedback_last_occurred;
ALTER TABLE feedback_reports DROP COLUMN last_occurred_at;
