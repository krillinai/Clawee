package store

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

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
	if _, err := provider.UpTo(ctx, 55); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
        INSERT INTO accounts (user_id,email,name,password_hash,status,created_at,updated_at) VALUES
        ('reviewer','reviewer@example.com','空间审批人','unused','active',now(),now()),
        ('writer','writer@example.com','提交人','unused','active',now(),now());
        INSERT INTO skills (skill_id,name,created_by,created_at,updated_at) VALUES ('legacy','legacy','writer',now(),now());
        INSERT INTO skill_versions (version_id,skill_id,version,description,package_path,package_sha256,created_at)
        VALUES ('legacy-v1','legacy','1','旧版','legacy.zip',repeat('a',64),now());
        UPDATE skills SET current_version_id='legacy-v1' WHERE skill_id='legacy';
    `); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 56); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 62); err != nil {
		t.Fatal(err)
	}
	store := skillhub.NewPostgresStore(pool)
	service := skillhub.NewService(skillhub.Config{Store: store, PackageRoot: t.TempDir()})
	detail, err := service.GetAdmin(ctx, "legacy")
	if err != nil || detail.Skill.CurrentVersionID != nil || len(detail.Versions) != 1 || detail.Versions[0].ApprovalStatus != "pending" || detail.Versions[0].SkillName != "legacy" {
		t.Fatalf("迁移未撤下或保留存量版本：%#v %v", detail, err)
	}
	if _, err := service.GetPublished(ctx, "legacy"); !errors.Is(err, skillhub.ErrNotFound) {
		t.Fatalf("未经审批版本可用：%v", err)
	}
	if err := service.SetSpaceApprover(ctx, skillhub.DefaultSpaceID, "reviewer", "admin"); err != nil {
		t.Fatal(err)
	}
	space, err := service.GetSpace(ctx, skillhub.DefaultSpaceID)
	if err != nil || space.ApproverUserID != "reviewer" || space.ApproverName != "空间审批人" {
		t.Fatalf("审批人配置：%#v %v", space, err)
	}
	if _, err := service.ReviewVersion(ctx, "legacy", "legacy-v1", "writer", true, ""); !errors.Is(err, skillhub.ErrReviewForbidden) {
		t.Fatalf("提交人越权：%v", err)
	}
	if _, err := service.ReviewVersion(ctx, "legacy", "legacy-v1", "reviewer", true, "确认旧版"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, "legacy", "legacy-v1"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := skillhub.NewPostgresSourceStore(pool).CreateSource(ctx, skillhub.GitHubSource{SourceID: "approval-source", Provider: skillhub.GitHubSourceProvider, RepositoryOwner: "clawee", RepositoryName: "skills", Branch: "main", ScanRoot: ".", ExcludePaths: []string{}, Schedule: skillhub.SourceScheduleManual, Status: skillhub.SourceStatusActive, CreatedBy: "writer", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	source := &skillhub.VersionSourceEvidence{SourceID: "approval-source", RepositoryOwner: "clawee", RepositoryName: "skills", Path: "skills/renamed", CommitSHA: strings.Repeat("c", 40), ContentSHA256: strings.Repeat("d", 64)}
	_, version, err := store.CreateVersion(ctx, skillhub.Skill{SpaceID: skillhub.DefaultSpaceID, Name: "renamed"}, skillhub.Version{VersionID: "v2", Version: "2", Description: "新版", PackagePath: "v2.zip", PackageSHA256: strings.Repeat("b", 64), CreatedAt: now, UploadedByUserID: "writer", UploadedByAgentID: "agent-writer", Source: source}, skillhub.CreateVersionOptions{Publish: true, Resolution: skillhub.VersionResolutionReplace, TargetSkillID: "legacy"})
	if err != nil || version.ApprovalStatus != "pending" {
		t.Fatalf("上传新版：%#v %v", version, err)
	}
	published, err := service.GetPublished(ctx, "legacy")
	if err != nil || published.Name != "legacy" || published.VersionID != "legacy-v1" {
		t.Fatalf("待审批更新改变旧版：%#v %v", published, err)
	}
	if _, err := service.SetCurrentVersion(ctx, "legacy", "v2"); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("更新绕过门禁：%v", err)
	}
	rejected, err := service.ReviewVersion(ctx, "legacy", "v2", "reviewer", false, "驳回")
	if err != nil {
		t.Fatal(err)
	}
	if rejected.SkillName != "renamed" || rejected.UploadedByUserID != "writer" || rejected.UploadedByAgentID != "agent-writer" || !reflect.DeepEqual(rejected.Source, source) || rejected.ApprovalStatus != "rejected" || rejected.ReviewComment != "驳回" {
		t.Fatalf("审核响应丢失版本数据：%#v", rejected)
	}
	t.Run("更换审批人时不能使用旧授权审核", func(t *testing.T) {
		raceCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		tx, err := pool.Begin(raceCtx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		var blockerPID int
		if err := tx.QueryRow(raceCtx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(raceCtx, `UPDATE skill_spaces SET approver_user_id='writer' WHERE space_id=$1`, skillhub.DefaultSpaceID); err != nil {
			t.Fatal(err)
		}
		result := make(chan error, 1)
		go func() {
			_, err := service.ReviewVersion(raceCtx, "legacy", "v2", "reviewer", true, "旧授权")
			result <- err
		}()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			var blocked bool
			if err := pool.QueryRow(raceCtx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blockerPID).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked {
				break
			}
			select {
			case <-ticker.C:
			case err := <-result:
				t.Fatalf("审核没有等待审批人配置锁：%v", err)
			case <-raceCtx.Done():
				t.Fatal("审核锁等待超时")
			}
		}
		if err := tx.Commit(raceCtx); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-result:
			if !errors.Is(err, skillhub.ErrReviewForbidden) {
				t.Fatalf("旧审批人并发越权：%v", err)
			}
		case <-raceCtx.Done():
			t.Fatal("审核未结束")
		}
	})
	if err := service.SetSpaceApprover(ctx, skillhub.DefaultSpaceID, "reviewer", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, "legacy", "v2"); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("驳回版本发布：%v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE user_id='reviewer'`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReviewVersion(ctx, "legacy", "v2", "reviewer", true, ""); !errors.Is(err, skillhub.ErrReviewForbidden) {
		t.Fatalf("停用审批人通过：%v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='active' WHERE user_id='reviewer'`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReviewVersion(ctx, "legacy", "v2", "reviewer", true, "通过"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, "legacy", "v2"); err != nil {
		t.Fatal(err)
	}
	detail, err = service.GetAdmin(ctx, "legacy")
	if err != nil || detail.Skill.Name != "renamed" || detail.Versions[0].ReviewedAt == nil || detail.Versions[0].ReviewComment != "通过" {
		t.Fatalf("发布与审批记录：%#v %v", detail, err)
	}
	target, err := service.CreateSpace(ctx, "目标空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.MoveSkillsToSpace(ctx, []string{"legacy"}, target.SpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetPublished(ctx, "legacy"); !errors.Is(err, skillhub.ErrNotFound) {
		t.Fatalf("移动未撤下：%v", err)
	}
	if _, err := service.SetCurrentVersion(ctx, "legacy", "v2"); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("复用原空间审批：%v", err)
	}
	if _, err := service.ReviewVersion(ctx, "legacy", "v2", "reviewer", true, ""); !errors.Is(err, skillhub.ErrReviewForbidden) {
		t.Fatalf("原空间审批人仍有权：%v", err)
	}
	if err := service.SetSpaceApprover(ctx, target.SpaceID, "writer", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReviewVersion(ctx, "legacy", "v2", "writer", true, "目标空间通过"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, "legacy", "v2"); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Down(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM skill_versions WHERE skill_id='legacy'`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("回滚丢失版本：%d %v", count, err)
	}
}
