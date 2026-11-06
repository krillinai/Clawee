-- +goose Up
CREATE TABLE workflow_task_assignees (
    task_id TEXT NOT NULL REFERENCES workflow_node_tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES accounts(user_id),
    PRIMARY KEY (task_id, user_id)
);
CREATE INDEX workflow_task_assignees_user ON workflow_task_assignees (user_id, task_id);

INSERT INTO workflow_task_assignees (task_id, user_id)
SELECT id, assignee_user_id FROM workflow_node_tasks;

UPDATE workflow_instances
SET template_snapshot_json = (
    SELECT jsonb_agg(node || jsonb_build_object('resolved_user_ids', jsonb_build_array(node->>'assignee_user_id')) ORDER BY position)
    FROM jsonb_array_elements(template_snapshot_json) WITH ORDINALITY AS nodes(node, position)
)
WHERE jsonb_array_length(template_snapshot_json) > 0;

UPDATE workflow_node_tasks
SET complete_response_json = jsonb_set(
    complete_response_json, '{next_task,assignee_user_ids}',
    jsonb_build_array(complete_response_json->'next_task'->>'assignee_user_id')
)
WHERE jsonb_typeof(complete_response_json->'next_task') = 'object';

-- +goose Down
DROP TABLE workflow_task_assignees;
