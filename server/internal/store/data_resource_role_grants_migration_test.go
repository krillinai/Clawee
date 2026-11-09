package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/krillinai/Clawee/server/db/migrations"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestDataResourceRoleGrantsMigrationDefinition(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00065_data_resource_role_grants.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"-- +goose Up", "-- +goose Down", "CREATE TABLE data_resource_role_grants",
		"REFERENCES rbac_roles(role_id) ON DELETE RESTRICT", "REFERENCES skill_spaces(space_id) ON DELETE CASCADE",
		"CHECK (resource_type = 'skill_space')", "CHECK (action IN ('read', 'write'))",
		"UNIQUE (role_id, resource_type, resource_id, action)",
		"CREATE VIEW effective_data_resource_permissions (user_id, resource_type, resource_id, action)",
		"\nUNION\n", "JOIN account_roles ar ON ar.role_id = grants.role_id", "ADD COLUMN target_role_id TEXT",
		"DROP VIEW effective_data_resource_permissions", "DROP TABLE data_resource_role_grants",
	} {
		if !strings.Contains(string(raw), required) {
			t.Fatalf("迁移缺少 %q", required)
		}
	}
}

func TestDataResourceRoleGrantsPostgres(t *testing.T) {
	pool := openMCPGatewayPostgresTestPool(t)
	ctx := context.Background()
	var database, schema string
	if err := pool.QueryRow(ctx, `SELECT current_database(),current_schema()`).Scan(&database, &schema); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(database, "_test") || !strings.HasPrefix(schema, "mcp_gateway_test_") {
		t.Fatal("测试必须运行在隔离测试数据库及独立随机 schema")
	}
	db := stdlib.OpenDB(*pool.Config().ConnConfig)
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 64); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO accounts (user_id,email,name,password_hash,status,created_at,updated_at) VALUES
('user-1','user-1@example.com','账户一','unused','active',now(),now()),
('user-2','user-2@example.com','账户二','unused','active',now(),now()),
('user-3','user-3@example.com','直接账户','unused','active',now(),now());
INSERT INTO rbac_roles (role_id,code,name,created_at,updated_at) VALUES
('role-1','reviewers-1','审核角色一',now(),now()),
('role-2','reviewers-2','审核角色二',now(),now()),
('role-3','unbound','未绑定角色',now(),now());
INSERT INTO account_roles (user_id,role_id,created_at) VALUES
('user-1','role-1',now()),('user-1','role-2',now()),('user-2','role-1',now());
INSERT INTO skill_spaces (space_id,name,created_by,updated_by,created_at,updated_at) VALUES
('space-1','技能空间一','operator','operator',now(),now()),
('space-2','技能空间二','operator','operator',now(),now());
INSERT INTO data_resource_grants (grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at) VALUES
('legacy-1','user-1','skill_space','space-1','read','operator',now(),now()),
('legacy-3','user-3','skill_space','space-1','read','operator',now(),now());
INSERT INTO data_resource_grant_audits
(audit_id,operator_user_id,target_user_id,resource_type,resource_id,result,created_at) VALUES
('legacy-audit','operator','user-1','skill_space','space-1','success',now());`); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 65); err != nil {
		t.Fatal(err)
	}
	packageRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(packageRoot, "version-1.zip"), []byte("角色授权下载测试"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO skills (skill_id,space_id,name,created_by,created_at,updated_at)
VALUES ('skill-1','space-1','角色技能','operator',now(),now());
INSERT INTO skill_versions
(version_id,skill_id,version,description,package_path,package_sha256,approval_status,approved_space_id,created_at)
VALUES ('version-1','skill-1','1','角色授权验证','version-1.zip','test-hash','approved','space-1',now());
UPDATE skills SET current_version_id='version-1' WHERE skill_id='skill-1';`); err != nil {
		t.Fatal(err)
	}
	skillStore := skillhub.NewPostgresStore(pool)
	skillService := skillhub.NewService(skillhub.Config{Store: skillStore, PackageRoot: packageRoot})
	rows, err := pool.Query(ctx, `SELECT column_name FROM information_schema.columns
WHERE table_schema=current_schema() AND table_name='effective_data_resource_permissions' ORDER BY ordinal_position`)
	if err != nil {
		t.Fatal(err)
	}
	columns := []string{}
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		columns = append(columns, column)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(columns, []string{"user_id", "resource_type", "resource_id", "action"}) {
		t.Fatalf("有效权限视图列 = %v", columns)
	}
	service := dataaccess.NewService(dataaccess.NewPostgresStore(pool))
	roleInput := func(roleID, spaceID string, actions ...string) dataaccess.SetInput {
		return dataaccess.SetInput{RoleID: roleID, ResourceType: dataaccess.ResourceSkillSpace, ResourceID: spaceID,
			Actions: actions, CreatedBy: "operator", RequestID: "role-request"}
	}
	for _, input := range []dataaccess.SetInput{
		roleInput("role-1", "space-1", "read", "write"),
		roleInput("role-2", "space-1", "read", "write"),
		roleInput("role-1", "space-2", "read"),
		roleInput("role-3", "space-1", "read"),
	} {
		if _, err := service.Create(ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	assertAction := func(userID, spaceID, action string, want bool) {
		t.Helper()
		allowed, err := service.HasAction(ctx, userID, "skill_space", spaceID, action)
		if err != nil || allowed != want {
			t.Fatalf("HasAction(%s,%s,%s) = %v,%v，预期 %v", userID, spaceID, action, allowed, err, want)
		}
	}
	assertAction("user-1", "space-1", "write", true)
	assertAction("user-2", "space-1", "read", true)
	assertAction("user-2", "space-1", "write", true)
	assertAction("user-3", "space-1", "read", true)
	assertAction("user-3", "space-1", "write", false)
	spaces, err := skillStore.ListAuthorizedSpaces(ctx, "user-1")
	if err != nil || len(spaces) != 2 {
		t.Fatalf("技能空间列表未去重: %#v, %v", spaces, err)
	}
	if err := skillStore.CheckSpaceAccess(ctx, "user-2", "space-1", "write"); err != nil {
		t.Fatalf("角色上传权限未生效: %v", err)
	}
	if err := skillService.CheckSkillRead(ctx, "user-2", "skill-1"); err != nil {
		t.Fatalf("角色技能读取未生效: %v", err)
	}
	published, err := skillStore.ListPublishedForUser(ctx, "user-1", "space-1")
	if err != nil || len(published) != 1 {
		t.Fatalf("技能列表未去重: %#v, %v", published, err)
	}
	download, err := skillService.OpenCurrentPackageForUser(ctx, "user-2", "skill-1", "version-1")
	if err != nil {
		t.Fatalf("角色下载未生效: %v", err)
	}
	if err := download.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	effective, err := service.List(ctx, dataaccess.Filter{UserID: "user-1", ResourceType: "skill_space", Effective: true})
	if err != nil || len(effective) != 3 {
		t.Fatalf("重叠授权未去重: %#v, %v", effective, err)
	}
	direct, err := service.List(ctx, dataaccess.Filter{UserID: "user-1", ResourceType: "skill_space"})
	if err != nil || len(direct) != 1 || direct[0].GrantID != "legacy-1" {
		t.Fatalf("账户配置来源发生变化: %#v, %v", direct, err)
	}
	if _, err := service.Create(ctx, roleInput("role-1", "space-1", "read")); !errors.Is(err, dataaccess.ErrConflict) {
		t.Fatalf("重复角色授权 = %v", err)
	}
	for _, input := range []dataaccess.SetInput{roleInput("missing", "space-1", "read"), roleInput("role-1", "missing", "read")} {
		if _, err := service.Create(ctx, input); !errors.Is(err, dataaccess.ErrNotFound) {
			t.Fatalf("不存在主体或空间 = %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM rbac_roles WHERE role_id='role-3'`); err == nil {
		t.Fatal("仍有角色授权时不得绕过角色删除限制")
	} else {
		var postgresError *pgconn.PgError
		if !errors.As(err, &postgresError) || postgresError.Code != "23503" {
			t.Fatalf("角色删除约束 = %v", err)
		}
	}
	if err := service.RemoveSubject(ctx, roleInput("role-1", "space-1")); err != nil {
		t.Fatal(err)
	}
	assertAction("user-1", "space-1", "write", true)
	assertAction("user-2", "space-1", "read", false)
	assertAction("user-2", "space-1", "write", false)
	if err := skillService.CheckSkillRead(ctx, "user-2", "skill-1"); !errors.Is(err, skillhub.ErrNotFound) {
		t.Fatalf("角色授权撤销后仍可读技能: %v", err)
	}
	if _, err := skillService.UploadVersionForUser(ctx, "user-2", "", skillhub.UploadVersionInput{SpaceID: "space-1"}); !errors.Is(err, skillhub.ErrSpaceNotFound) {
		t.Fatalf("角色授权撤销后上传入口未拒绝: %v", err)
	}
	if _, err := skillService.OpenCurrentPackageForUser(ctx, "user-2", "skill-1", "version-1"); !errors.Is(err, skillhub.ErrNotFound) {
		t.Fatalf("角色授权撤销后下载入口未拒绝: %v", err)
	}
	published, err = skillStore.ListPublishedForUser(ctx, "user-2", "space-1")
	if err != nil || len(published) != 0 {
		t.Fatalf("角色授权撤销后技能列表仍可见: %#v, %v", published, err)
	}
	if _, err := service.Replace(ctx, roleInput("role-2", "space-1", "read")); err != nil {
		t.Fatal(err)
	}
	assertAction("user-1", "space-1", "write", false)
	assertAction("user-1", "space-1", "read", true)
	if err := service.RecordFailure(ctx, roleInput("role-2", "space-1", "read")); err != nil {
		t.Fatal(err)
	}
	var userTarget *string
	var before, after []string
	if err := pool.QueryRow(ctx, `SELECT target_user_id,before_actions,after_actions FROM data_resource_grant_audits
WHERE target_role_id='role-2' AND result='failed' AND operator_user_id='operator' AND request_id='role-request'`).Scan(&userTarget, &before, &after); err != nil {
		t.Fatal(err)
	}
	if userTarget != nil || !reflect.DeepEqual(before, []string{"read"}) || !reflect.DeepEqual(before, after) {
		t.Fatalf("角色失败审计不正确: user=%v before=%v after=%v", userTarget, before, after)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM account_roles WHERE user_id='user-1' AND role_id='role-2'`); err != nil {
		t.Fatal(err)
	}
	assertAction("user-1", "space-1", "read", true)
	download, err = skillService.OpenCurrentPackageForUser(ctx, "user-1", "skill-1", "version-1")
	if err != nil {
		t.Fatalf("撤销角色绑定不应移除账户直接下载权限: %v", err)
	}
	if err := download.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	if err := service.RemoveBy(ctx, "user-1", "skill_space", "space-1", "operator", "account-request"); err != nil {
		t.Fatal(err)
	}
	assertAction("user-1", "space-1", "read", false)
	if _, err := skillService.OpenCurrentPackageForUser(ctx, "user-1", "skill-1", "version-1"); !errors.Is(err, skillhub.ErrNotFound) {
		t.Fatalf("所有授权来源移除后下载仍可用: %v", err)
	}
	assertAction("user-1", "space-2", "read", true)
	if _, err := pool.Exec(ctx, `DELETE FROM account_roles WHERE user_id='user-1' AND role_id='role-1'`); err != nil {
		t.Fatal(err)
	}
	assertAction("user-1", "space-2", "read", false)
	spaces, err = skillStore.ListAuthorizedSpaces(ctx, "user-1")
	if err != nil || len(spaces) != 0 {
		t.Fatalf("移除角色绑定后空间仍可见: %#v, %v", spaces, err)
	}
	assertAction("user-3", "space-1", "read", true)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for index := 0; index < 2; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			_, err := service.Create(ctx, roleInput("role-3", "space-2", "read"))
			results <- err
		}()
	}
	close(start)
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, dataaccess.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("并发授权失败: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("并发重复授权 success=%d conflict=%d", successes, conflicts)
	}
	var successfulAudits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM data_resource_grant_audits
WHERE target_role_id='role-3' AND resource_id='space-2' AND result='success'`).Scan(&successfulAudits); err != nil || successfulAudits != 1 {
		t.Fatalf("并发授权成功审计数=%d, %v", successfulAudits, err)
	}
	if err := service.RemoveSubject(ctx, roleInput("role-2", "space-1")); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT target_user_id,before_actions,after_actions FROM data_resource_grant_audits
WHERE target_role_id='role-1' AND resource_id='space-1' AND cardinality(after_actions)=0`).Scan(&userTarget, &before, &after); err != nil {
		t.Fatal(err)
	}
	if userTarget != nil || !reflect.DeepEqual(before, []string{"read", "write"}) || len(after) != 0 {
		t.Fatalf("撤销角色审计不正确: user=%v before=%v after=%v", userTarget, before, after)
	}
	if _, err := provider.DownTo(ctx, 64); err != nil {
		t.Fatal(err)
	}
	var roleTable, effectiveView *string
	if err := pool.QueryRow(ctx, `SELECT to_regclass('data_resource_role_grants')::text,to_regclass('effective_data_resource_permissions')::text`).Scan(&roleTable, &effectiveView); err != nil {
		t.Fatal(err)
	}
	if roleTable != nil || effectiveView != nil {
		t.Fatal("Down 未清理角色表及有效权限视图")
	}
	var remaining, legacyAudits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM data_resource_grants WHERE grant_id='legacy-3'`).Scan(&remaining); err != nil || remaining != 1 {
		t.Fatalf("Down 损坏账户授权: %d, %v", remaining, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM data_resource_grant_audits WHERE audit_id='legacy-audit'`).Scan(&legacyAudits); err != nil || legacyAudits != 1 {
		t.Fatalf("Down 损坏账户历史审计: %d, %v", legacyAudits, err)
	}
	if _, err := provider.UpTo(ctx, 65); err != nil {
		t.Fatal(err)
	}
	assertAction("user-3", "space-1", "read", true)
}
