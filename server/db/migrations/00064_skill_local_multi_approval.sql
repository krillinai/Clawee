-- +goose Up
CREATE TABLE approval_config_approvers (
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    PRIMARY KEY (scope_type,scope_id,user_id)
);
CREATE TABLE approval_requests (
    id TEXT PRIMARY KEY,
    business_type TEXT NOT NULL,
    business_id TEXT NOT NULL,
    action TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','invalidated')),
    created_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ
);
CREATE INDEX approval_requests_business ON approval_requests(business_type,business_id,action);
CREATE UNIQUE INDEX approval_requests_pending ON approval_requests(business_type,business_id,action) WHERE status='pending';
CREATE TABLE approval_request_approvers (
    request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES accounts(user_id),
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    comment TEXT NOT NULL DEFAULT '',
    decided_at TIMESTAMPTZ,
    PRIMARY KEY (request_id,user_id)
);

INSERT INTO approval_config_approvers(scope_type,scope_id,user_id)
SELECT 'skill_space',space_id,approver_user_id FROM skill_spaces WHERE approver_user_id IS NOT NULL;
INSERT INTO approval_requests(id,business_type,business_id,action,scope_type,scope_id,content_digest,status,created_at,finished_at)
SELECT 'legacy-' || v.version_id,'skill_version',v.version_id,'publish','skill_space',s.space_id,v.package_sha256,
    CASE WHEN v.reviewed_by=sp.approver_user_id AND v.approved_space_id=s.space_id AND v.approval_status IN ('approved','rejected') THEN v.approval_status ELSE 'pending' END,
    v.created_at,
    CASE WHEN v.reviewed_by=sp.approver_user_id AND v.approved_space_id=s.space_id AND v.approval_status IN ('approved','rejected') THEN v.reviewed_at ELSE NULL END
FROM skill_versions v JOIN skills s ON s.skill_id=v.skill_id JOIN skill_spaces sp ON sp.space_id=s.space_id
WHERE sp.approval_provider='local' AND sp.approver_user_id IS NOT NULL AND s.current_version_id IS DISTINCT FROM v.version_id;
INSERT INTO approval_request_approvers(request_id,user_id,status,comment,decided_at)
SELECT r.id,sp.approver_user_id,r.status,CASE WHEN r.status='pending' THEN '' ELSE v.review_comment END,
    CASE WHEN r.status='pending' THEN NULL ELSE v.reviewed_at END
FROM approval_requests r JOIN skill_versions v ON v.version_id=r.business_id
JOIN skills s ON s.skill_id=v.skill_id JOIN skill_spaces sp ON sp.space_id=s.space_id;
UPDATE skill_versions v SET approval_status='pending',approved_space_id=NULL,reviewed_by=NULL,reviewed_at=NULL,review_comment=''
FROM approval_requests r WHERE r.business_id=v.version_id AND r.status='pending' AND v.approval_status<>'pending';
ALTER TABLE skill_spaces DROP COLUMN approver_user_id;

-- +goose Down
ALTER TABLE skill_spaces ADD COLUMN approver_user_id TEXT REFERENCES accounts(user_id) ON DELETE SET NULL;
UPDATE skill_spaces sp SET approver_user_id=(SELECT user_id FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=sp.space_id ORDER BY user_id LIMIT 1);
DROP TABLE approval_request_approvers;
DROP TABLE approval_requests;
DROP TABLE approval_config_approvers;
