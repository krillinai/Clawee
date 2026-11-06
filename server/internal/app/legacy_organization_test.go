package app

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
)

func TestLegacyOrganizationGuardPreservesPermissions(t *testing.T) {
	ctx := context.Background()
	if err := ensureNoLegacyOrganization(ctx, nil); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, testpostgres.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := ensureNoLegacyOrganization(ctx, pool); err != nil {
		t.Fatalf("新建数据库应可启动：%v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES('demo','demo@example.com','演示成员','unused','active',now(),now());
		INSERT INTO rbac_roles(role_id,code,name,created_at,updated_at) VALUES('demo-team','demo_team','演示团队',now(),now());
		INSERT INTO rose_departments(dingtalk_dept_id,rose_dept_id,parent_dingtalk_dept_id,name,order_num,status,role_id)
		VALUES('dept','demo','1','演示团队',0,'0','demo-team');
		INSERT INTO rose_account_roles(user_id,role_id) VALUES('demo','demo-team');`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := ensureNoLegacyOrganization(ctx, pool); err == nil {
			t.Fatal("已有组织数据的实例必须拒绝启动")
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM effective_account_roles WHERE user_id='demo' AND role_id='demo-team'`).Scan(&count); err != nil || count != 1 {
			t.Fatalf("启动检查不得修改历史权限：count=%d err=%v", count, err)
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rose_account_roles`); err != nil {
		t.Fatal(err)
	}
	if err := ensureNoLegacyOrganization(ctx, pool); err == nil {
		t.Fatal("即使暂无角色成员，已有部门也需单独迁移")
	}
}
