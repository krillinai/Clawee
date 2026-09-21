-- +goose Up
ALTER TABLE workflow_node_tasks ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
DROP INDEX workflow_tasks_assignee_status;
CREATE INDEX workflow_tasks_assignee_status ON workflow_node_tasks (assignee_user_id, status, created_at DESC, id DESC);

-- +goose Down
DROP INDEX workflow_tasks_assignee_status;
CREATE INDEX workflow_tasks_assignee_status ON workflow_node_tasks (assignee_user_id, status, id);
ALTER TABLE workflow_node_tasks DROP COLUMN created_at;
