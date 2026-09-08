-- +goose Up
DELETE FROM role_permissions
WHERE permission_code = 'console:industry:read';

-- +goose Down
-- Removed role assignments cannot be reconstructed safely; rollback does not recreate grants.
