package skillhub

import (
	"context"
	"testing"
)

func TestSkillEffectiveRoleApprovalUsesEffectiveRolesAndPreservesSnapshot(t *testing.T) {
	service, _, pool := personalApprovalFixture(t, "postgres")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO rbac_roles(role_id,code,name,is_system,created_at,updated_at) VALUES('demo-team','rose_team','团队默认角色',FALSE,now(),now()),('demo-manager','rose_dept_mgr_test','团队管理员角色',FALSE,now(),now()); INSERT INTO rose_departments(dingtalk_dept_id,rose_dept_id,parent_dingtalk_dept_id,name,order_num,status,role_id,manager_role_id) VALUES('dept','demo','1','团队',0,'0','demo-team','demo-manager'); INSERT INTO rose_account_roles(user_id,role_id) VALUES('bob','demo-team'),('other','demo-manager'); INSERT INTO account_roles(user_id,role_id,created_at) VALUES('alice','demo-team',now()),('bob','demo-team',now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM approval_config_approvers WHERE scope_id=$1;`, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO approval_config_roles(scope_type,scope_id,role_id) VALUES('skill_space',$1,'demo-team'),('skill_space',$1,'demo-manager')`, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	first := personalUpload(t, service, "demo-role-review", "1")
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_request_approvers a JOIN approval_requests r ON r.id=a.request_id WHERE r.business_id=$1`, first.Version.VersionID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("effective role count %d %v", count, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rose_account_roles; DELETE FROM account_roles WHERE user_id='bob' AND role_id='demo-team'`); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_request_approvers a JOIN approval_requests r ON r.id=a.request_id WHERE r.business_id=$1`, first.Version.VersionID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("snapshot changed %d %v", count, err)
	}
	second := personalUpload(t, service, "demo-role-review", "2")
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_request_approvers a JOIN approval_requests r ON r.id=a.request_id WHERE r.business_id=$1`, second.Version.VersionID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("current members %d %v", count, err)
	}
}
