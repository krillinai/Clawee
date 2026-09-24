package store

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/krillinai/Clawee/server/db/migrations"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestSkillApprovalMigrationAndLifecycleOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool := openMCPGatewayPostgresTestPool(t)
	db := stdlib.OpenDB(*pool.Config().ConnConfig)
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = provider.UpTo(ctx, 55); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES
('reviewer','reviewer@example.com','审批人一','unused','active',now(),now()),
('second','second@example.com','审批人二','unused','active',now(),now()),
('writer','writer@example.com','提交人','unused','active',now(),now());
INSERT INTO skills(skill_id,name,created_by,created_at,updated_at) VALUES('legacy','legacy','writer',now(),now());
INSERT INTO skill_versions(version_id,skill_id,version,description,package_path,package_sha256,created_at) VALUES
('legacy-v1','legacy','1','旧版','v1.zip',repeat('a',64),now());`); err != nil {
		t.Fatal(err)
	}
	if _, err = provider.UpTo(ctx, 63); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE skill_spaces SET approver_user_id='reviewer' WHERE space_id='skillspace_default';
UPDATE skill_versions SET approval_status='approved',approved_space_id='skillspace_default',reviewed_by='reviewer',reviewed_at=now() WHERE version_id='legacy-v1';
INSERT INTO skill_versions(version_id,skill_id,version,description,package_path,package_sha256,created_at,skill_name,approval_status,approved_space_id,reviewed_by,reviewed_at)
VALUES ('legacy-v2','legacy','2','不可信旧结论','v2.zip',repeat('b',64),now(),'legacy','approved','skillspace_default','writer',now());`); err != nil {
		t.Fatal(err)
	}
	if _, err = provider.UpTo(ctx, 64); err != nil {
		t.Fatal(err)
	}
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewPostgresStore(pool), PackageRoot: t.TempDir()})
	for _, id := range []string{"reviewer", "second"} {
		if _, err = service.SetSpaceMember(ctx, skillhub.DefaultSpaceID, id, []string{skillhub.SpaceActionRead}, "writer", false); err != nil {
			t.Fatal(err)
		}
	}
	space, err := service.GetSpace(ctx, skillhub.DefaultSpaceID)
	if err != nil || len(space.Approvers) != 1 || space.Approvers[0].UserID != "reviewer" {
		t.Fatalf("旧配置迁移: %#v %v", space, err)
	}
	detail, err := service.GetAdmin(ctx, "legacy")
	if err != nil || len(detail.Versions) != 2 || detail.Versions[0].ApprovalStatus != "pending" || detail.Versions[1].ApprovalStatus != "approved" {
		t.Fatalf("旧结论迁移: %#v %v", detail, err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v2"); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("无效旧批准发布: %v", err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v1"); err != nil {
		t.Fatalf("有效旧批准发布: %v", err)
	}
	count, err := service.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{"reviewer", "second"}, false, "writer")
	if err != nil || count != 1 {
		t.Fatalf("重审预确认: %d %v", count, err)
	}
	if _, err = service.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{"reviewer", "second"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ReviewVersion(ctx, "legacy", "legacy-v2", "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v2"); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("部分批准发布: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, "legacy", "legacy-v2", "second", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v2"); err != nil {
		t.Fatal(err)
	}
	target, err := service.CreateSpace(ctx, "目标空间", "", "writer")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetSpaceMember(ctx, target.SpaceID, "second", []string{skillhub.SpaceActionRead}, "writer", false); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetSpaceApprovers(ctx, target.SpaceID, "local", "", []string{"second"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.MoveSkillsToSpace(ctx, []string{"legacy"}, target.SpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v2"); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("迁移后旧批准发布: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, "legacy", "legacy-v2", "second", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v2"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetSpaceMember(ctx, target.SpaceID, "reviewer", []string{skillhub.SpaceActionRead}, "writer", false); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetSpaceApprovers(ctx, target.SpaceID, "local", "", []string{"reviewer"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.GetPublished(ctx, "legacy"); err != nil {
		t.Fatalf("改名单影响已发布版本: %v", err)
	}
	detail, err = service.GetAdmin(ctx, "legacy")
	if err != nil || detail.Versions[0].LocalApproval == nil || detail.Versions[0].LocalApproval.Status != "approved" || detail.Versions[0].LocalApproval.Approvers[0].UserID != "second" {
		t.Fatalf("已发布版本审批记录丢失: %#v %v", detail, err)
	}
	if _, err = service.ClearCurrentVersion(ctx, "legacy"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v2"); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("撤销后复用旧批准: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, "legacy", "legacy-v2", "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v2"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ClearCurrentVersion(ctx, "legacy"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, "legacy", "legacy-v2"); err != nil {
		t.Fatalf("名单未变却要求再次审批: %v", err)
	}
	if _, err = service.SetSpaceApprovers(ctx, target.SpaceID, "local", "", nil, true, "writer"); err != nil {
		t.Fatal(err)
	}
	var retained string
	if err = pool.QueryRow(ctx, `SELECT status FROM approval_requests WHERE business_id='legacy-v2' AND status='approved' ORDER BY created_at DESC LIMIT 1`).Scan(&retained); err != nil || retained != "approved" {
		t.Fatalf("关闭审批丢失已发布记录: %q %v", retained, err)
	}
	detail, err = service.GetAdmin(ctx, "legacy")
	if err != nil || detail.Versions[0].LocalApproval != nil {
		t.Fatalf("关闭审批仍展示本地人员: %#v %v", detail, err)
	}
	if _, err = service.SetSpaceApprovers(ctx, target.SpaceID, "local", "", []string{"reviewer"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	if _, err = provider.Down(ctx); err != nil {
		t.Fatal(err)
	}
	var restored string
	if err = pool.QueryRow(ctx, `SELECT approver_user_id FROM skill_spaces WHERE space_id=$1`, skillhub.DefaultSpaceID).Scan(&restored); err != nil || restored != "reviewer" {
		t.Fatalf("回滚单人配置: %q %v", restored, err)
	}
}
