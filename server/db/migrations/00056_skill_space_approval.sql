-- +goose Up
ALTER TABLE skill_spaces ADD COLUMN approver_user_id TEXT REFERENCES accounts(user_id) ON DELETE SET NULL;
ALTER TABLE skill_versions
    ADD COLUMN skill_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
    ADD COLUMN approved_space_id TEXT REFERENCES skill_spaces(space_id),
    ADD COLUMN reviewed_by TEXT,
    ADD COLUMN reviewed_at TIMESTAMPTZ,
    ADD COLUMN review_comment TEXT NOT NULL DEFAULT '';
UPDATE skill_versions v SET skill_name=s.name FROM skills s WHERE s.skill_id=v.skill_id;
-- 存量版本保留，未经审批的发布版本撤下后重新送审。
UPDATE skills SET current_version_id=NULL WHERE current_version_id IS NOT NULL;

-- +goose Down
ALTER TABLE skill_versions DROP COLUMN review_comment, DROP COLUMN reviewed_at, DROP COLUMN reviewed_by,
    DROP COLUMN approved_space_id, DROP COLUMN approval_status, DROP COLUMN skill_name;
ALTER TABLE skill_spaces DROP COLUMN approver_user_id;
