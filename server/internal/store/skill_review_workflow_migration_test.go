package store

import (
	"context"
	"testing"
)

func TestP9MigrationRebuildsOnlyUnpublishedLocalUploads(t *testing.T) {
	ctx := context.Background()
	pool, provider := skillRoleTestDatabase(t, 76)
	seedSkillRoleAccounts(t, pool)
	execSkillRoleSQL(t, pool, `
INSERT INTO approval_config_roles(scope_type,scope_id,role_id) VALUES('skill_space','skillspace_default','review-one');
INSERT INTO skills(skill_id,space_id,name,created_by,created_at,updated_at) VALUES('p9','skillspace_default','p9','writer',now(),now());
INSERT INTO skill_versions(version_id,skill_id,version,skill_name,description,package_path,package_sha256,approval_status,approved_space_id,created_at) VALUES
('published','p9','1','p9','','1.zip',repeat('a',64),'approved','skillspace_default',now()),
('unpublished','p9','2','p9','','2.zip',repeat('b',64),'approved','skillspace_default',now()),
('pending','p9','3','p9','','3.zip',repeat('c',64),'pending',NULL,now()),
('rejected','p9','4','p9','','4.zip',repeat('d',64),'rejected',NULL,now());
UPDATE skills SET current_version_id='published' WHERE skill_id='p9';
INSERT INTO approval_requests(id,business_type,business_id,action,scope_type,scope_id,content_digest,status,created_at,scoring_standard_version)
VALUES('old','skill_version','unpublished','publish','skill_space','skillspace_default',repeat('b',64),'approved',now(),'manual-v1');
INSERT INTO approval_request_approvers(request_id,user_id,status,comment,scenario_value,result_effectiveness,ease_of_use,reuse_value)
VALUES('old','alice','approved','保留历史意见',5,5,5,5);
INSERT INTO skill_ai_review_attempts(attempt_id,request_id,agent_id,status,created_at,updated_at)
VALUES('old-manual','old','old-agent','manual',now(),now());`)
	if _, err := provider.UpTo(ctx, 77); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_requests WHERE id LIKE 'approval_p9_%'`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("重建范围: %d %v", count, err)
	}
	var preserved bool
	if err := pool.QueryRow(ctx, `SELECT r.status='invalidated' AND a.comment='保留历史意见' AND a.scenario_value=5 AND ai.status='manual' AND ai.review_skill_version='' FROM approval_requests r JOIN approval_request_approvers a ON a.request_id=r.id JOIN skill_ai_review_attempts ai ON ai.request_id=r.id WHERE r.id='old'`).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("历史丢失: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_requests r JOIN skill_ai_review_attempts ai ON ai.request_id=r.id WHERE r.id LIKE 'approval_p9_%' AND r.status='pending' AND ai.status='pending' AND ai.agent_id='' AND ai.review_skill_version='' AND r.approver_role_ids=ARRAY['review-one']::text[] AND (SELECT count(*) FROM approval_request_approvers a WHERE a.request_id=r.id)=2`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("角色快照或新AI轮次: %d %v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM skill_versions WHERE version_id IN ('published','rejected') AND approval_status IN ('approved','rejected')`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("已发布或已结束记录改变: %v", err)
	}
	if _, err := provider.UpTo(ctx, 77); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_requests WHERE id LIKE 'approval_p9_%'`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("升级重复重建: %v", err)
	}
}
