-- +goose Up
CREATE TABLE workflow_templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('draft', 'enabled', 'disabled')),
    revision INTEGER NOT NULL DEFAULT 1, definition_json JSONB NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL REFERENCES accounts(user_id), updated_by TEXT NOT NULL REFERENCES accounts(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE workflow_instances (
    id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES workflow_templates(id),
    template_revision INTEGER NOT NULL, template_snapshot_json JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'rejected', 'terminated')),
    current_node_id TEXT, initial_input_json JSONB NOT NULL,
    started_by TEXT NOT NULL REFERENCES accounts(user_id), start_key TEXT NOT NULL,
    start_digest TEXT NOT NULL, start_response_json JSONB,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
    UNIQUE (template_id, started_by, start_key)
);
CREATE INDEX workflow_instances_status_time ON workflow_instances (status, started_at DESC, id DESC);
CREATE TABLE workflow_instance_participants (
    instance_id TEXT NOT NULL REFERENCES workflow_instances(id),
    user_id TEXT NOT NULL REFERENCES accounts(user_id), PRIMARY KEY (instance_id, user_id)
);
CREATE INDEX workflow_participants_user ON workflow_instance_participants (user_id, instance_id);
CREATE TABLE workflow_node_tasks (
    id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES workflow_instances(id),
    node_id TEXT NOT NULL, node_order INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('approval', 'agent')),
    assignee_user_id TEXT NOT NULL REFERENCES accounts(user_id),
    input_json JSONB NOT NULL, output_json JSONB,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'rejected', 'cancelled')),
    decision TEXT, comment TEXT NOT NULL DEFAULT '', complete_key TEXT,
    complete_digest TEXT, complete_response_json JSONB,
    handled_by TEXT, completed_at TIMESTAMPTZ,
    UNIQUE (instance_id, node_id)
);
CREATE INDEX workflow_tasks_assignee_status ON workflow_node_tasks (assignee_user_id, status, id);
CREATE UNIQUE INDEX workflow_one_pending_task ON workflow_node_tasks (instance_id) WHERE status = 'pending';
CREATE TABLE workflow_events (
    id TEXT PRIMARY KEY, template_id TEXT, instance_id TEXT, task_id TEXT,
    event_type TEXT NOT NULL, actor_user_id TEXT NOT NULL, actor_agent_id TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE workflow_events;
DROP TABLE workflow_node_tasks;
DROP TABLE workflow_instance_participants;
DROP TABLE workflow_instances;
DROP TABLE workflow_templates;
