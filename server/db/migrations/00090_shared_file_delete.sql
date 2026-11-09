-- +goose Up
ALTER TABLE shared_file_storage_cleanup_tasks
    DROP CONSTRAINT IF EXISTS shared_file_storage_cleanup_tasks_source_check,
    ADD CONSTRAINT shared_file_storage_cleanup_tasks_source_check
    CHECK (source IN ('upload_compensation', 'replace_old_object', 'migration_source', 'file_delete'));

INSERT INTO data_resource_grants (grant_id, user_id, resource_type, resource_id, action, created_by, created_at, updated_at)
SELECT 'drg_spacedelete_' || md5(s.space_id || COALESCE(s.personal_owner_user_id, s.created_by)),
       COALESCE(s.personal_owner_user_id, s.created_by),
       'shared_space', s.space_id, 'delete', 'system', now(), now()
FROM shared_spaces s
JOIN accounts a ON a.user_id = COALESCE(s.personal_owner_user_id, s.created_by) AND a.status = 'active'
ON CONFLICT (user_id, resource_type, resource_id, action) DO NOTHING;

-- +goose Down
DELETE FROM shared_file_storage_cleanup_tasks WHERE source = 'file_delete';
ALTER TABLE shared_file_storage_cleanup_tasks
    DROP CONSTRAINT IF EXISTS shared_file_storage_cleanup_tasks_source_check,
    ADD CONSTRAINT shared_file_storage_cleanup_tasks_source_check
    CHECK (source IN ('upload_compensation', 'replace_old_object', 'migration_source'));
DELETE FROM data_resource_grants WHERE resource_type = 'shared_space' AND action = 'delete' AND created_by = 'system';
