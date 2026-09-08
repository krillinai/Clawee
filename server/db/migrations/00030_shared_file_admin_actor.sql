-- +goose Up
ALTER TABLE shared_files
    ALTER COLUMN created_by_agent_id DROP NOT NULL,
    ALTER COLUMN updated_by_agent_id DROP NOT NULL;

-- +goose Down
UPDATE shared_files
SET created_by_agent_id = ''
WHERE created_by_agent_id IS NULL;

UPDATE shared_files
SET updated_by_agent_id = ''
WHERE updated_by_agent_id IS NULL;

ALTER TABLE shared_files
    ALTER COLUMN created_by_agent_id SET NOT NULL,
    ALTER COLUMN updated_by_agent_id SET NOT NULL;
