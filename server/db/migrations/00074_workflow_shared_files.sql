-- +goose Up
ALTER TABLE workflow_templates ADD COLUMN shared_space_id TEXT REFERENCES shared_spaces(space_id);
CREATE UNIQUE INDEX workflow_template_shared_space ON workflow_templates(shared_space_id) WHERE shared_space_id IS NOT NULL;
ALTER TABLE workflow_instances ADD COLUMN shared_files_initialized BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE workflow_node_tasks ADD COLUMN artifacts_json JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(artifacts_json) = 'array');

-- +goose Down
ALTER TABLE workflow_node_tasks DROP COLUMN artifacts_json;
ALTER TABLE workflow_instances DROP COLUMN shared_files_initialized;
ALTER TABLE workflow_templates DROP COLUMN shared_space_id;
