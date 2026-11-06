-- +goose Up
ALTER TABLE shared_spaces ADD COLUMN personal_owner_user_id TEXT REFERENCES accounts(user_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX idx_shared_spaces_personal_owner ON shared_spaces(personal_owner_user_id) WHERE personal_owner_user_id IS NOT NULL;

-- +goose Down
DROP INDEX idx_shared_spaces_personal_owner;
ALTER TABLE shared_spaces DROP COLUMN personal_owner_user_id;
