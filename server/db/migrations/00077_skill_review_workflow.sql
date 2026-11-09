-- +goose Up
ALTER TABLE skill_ai_review_attempts
    ADD COLUMN review_skill_version TEXT NOT NULL DEFAULT '',
    ADD COLUMN review_skill_sha256 TEXT NOT NULL DEFAULT '',
    ADD COLUMN error_code TEXT NOT NULL DEFAULT '',
    ADD COLUMN result_sha256 TEXT NOT NULL DEFAULT '';

-- result_sha256 仅保存规范化回传的摘要，用于成功、失败和无效报告的幂等校验，不保存原始错误。

-- 保留旧申请、意见与分数；仅重建接入范围内尚未发布且仍可发布的人工版本。
CREATE TEMP TABLE p9_review_rebuild ON COMMIT DROP AS
SELECT v.version_id,s.space_id,v.package_sha256,
       'approval_p9_' || md5(v.version_id || clock_timestamp()::text || random()::text) AS request_id,
       ARRAY(SELECT user_id FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=s.space_id ORDER BY user_id) AS user_ids,
       ARRAY(SELECT role_id FROM approval_config_roles WHERE scope_type='skill_space' AND scope_id=s.space_id ORDER BY role_id) AS role_ids
FROM skill_versions v JOIN skills s ON s.skill_id=v.skill_id JOIN skill_spaces sp ON sp.space_id=s.space_id
WHERE v.source_id IS NULL AND sp.approval_provider='local' AND v.approval_status IN ('pending','approved')
AND s.current_version_id IS DISTINCT FROM v.version_id
AND (EXISTS(SELECT 1 FROM approval_config_approvers c WHERE c.scope_type='skill_space' AND c.scope_id=s.space_id)
  OR EXISTS(SELECT 1 FROM approval_config_roles c WHERE c.scope_type='skill_space' AND c.scope_id=s.space_id));

-- +goose StatementBegin
DO $$
DECLARE affected BIGINT;
BEGIN
 SELECT count(*) INTO affected FROM p9_review_rebuild;
 RAISE NOTICE 'P9: rebuilding % unpublished skill versions; old requests and scores retained', affected;
 IF EXISTS(SELECT 1 FROM p9_review_rebuild p WHERE NOT EXISTS(
   SELECT 1 FROM accounts a WHERE a.status='active' AND (a.user_id=ANY(p.user_ids)
     OR EXISTS(SELECT 1 FROM effective_account_roles ar WHERE ar.user_id=a.user_id AND ar.role_id=ANY(p.role_ids)))
 )) THEN RAISE EXCEPTION 'P9: review configuration has no active reviewers; resolve configuration before migration'; END IF;
END $$;
-- +goose StatementEnd

UPDATE approval_requests r SET status='invalidated',finished_at=now()
FROM p9_review_rebuild p WHERE r.business_type='skill_version' AND r.action='publish'
AND r.business_id=p.version_id AND r.status<>'invalidated';

UPDATE skill_versions v SET approval_status='pending',approved_space_id=NULL,reviewed_by=NULL,reviewed_at=NULL,review_comment=''
FROM p9_review_rebuild p WHERE v.version_id=p.version_id;

INSERT INTO approval_requests(id,business_type,business_id,action,scope_type,scope_id,content_digest,status,created_at,approver_user_ids,approver_role_ids,scoring_standard_version)
SELECT p.request_id,'skill_version',p.version_id,'publish','skill_space',p.space_id,p.package_sha256,'pending',
 GREATEST(now(),COALESCE((SELECT max(created_at)+interval '1 microsecond' FROM approval_requests r WHERE r.business_type='skill_version' AND r.business_id=p.version_id AND r.action='publish'),now())),
 p.user_ids,p.role_ids,'manual-v1' FROM p9_review_rebuild p;

INSERT INTO approval_request_approvers(request_id,user_id,status)
SELECT p.request_id,a.user_id,'pending' FROM p9_review_rebuild p JOIN accounts a ON a.status='active'
AND (a.user_id=ANY(p.user_ids) OR EXISTS(SELECT 1 FROM effective_account_roles ar WHERE ar.user_id=a.user_id AND ar.role_id=ANY(p.role_ids)));

INSERT INTO skill_ai_review_attempts(attempt_id,request_id,agent_id,status,created_at,updated_at)
SELECT 'ai_attempt_p9_' || md5(request_id),request_id,'','pending',now(),now() FROM p9_review_rebuild;

-- +goose Down
-- 旧审批意见不可逆地作为历史保留，回退字段不会恢复被新规则作废的审核轮次。
ALTER TABLE skill_ai_review_attempts DROP COLUMN result_sha256,DROP COLUMN error_code,DROP COLUMN review_skill_sha256,DROP COLUMN review_skill_version;
