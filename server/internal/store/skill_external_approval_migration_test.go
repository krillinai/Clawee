package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/krillinai/Clawee/server/db/migrations"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestExternalSkillApprovalMigrationAndPostgresGate(t *testing.T) {
	ctx := context.Background()
	pool := openMCPGatewayPostgresTestPool(t)
	db := stdlib.OpenDB(*pool.Config().ConnConfig)
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES('writer','writer@example.com','提交人','unused','active',now(),now())`); err != nil {
		t.Fatal(err)
	}
	store := skillhub.NewPostgresStore(pool)
	svc := skillhub.NewService(skillhub.Config{Store: store, PackageRoot: t.TempDir()})
	now := time.Now().UTC()
	skill, version, err := store.CreateVersion(ctx, skillhub.Skill{SkillID: "oa-skill", SpaceID: skillhub.DefaultSpaceID, Name: "oa-skill", CreatedBy: "writer", CreatedAt: now, UpdatedAt: now}, skillhub.Version{VersionID: "oa-v1", Version: "1", PackagePath: "oa-v1.zip", PackageSHA256: "sha-1", UploadedByUserID: "writer", CreatedAt: now}, skillhub.CreateVersionOptions{Resolution: skillhub.VersionResolutionCreateOnly, Origin: "admin_upload"})
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.SetSpaceApproval(ctx, skill.SpaceID, "dingtalk", "PROC", "writer"); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.SetCurrentVersion(ctx, skill.SkillID, version.VersionID); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("published without OA: %v", err)
	}
	item, _, _, err := svc.BeginApproval(ctx, skill.SkillID, version.VersionID, "writer", "staff-writer", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = svc.BeginApproval(ctx, skill.SkillID, version.VersionID, "writer", "staff-writer", false); !errors.Is(err, skillhub.ErrExternalApprovalConflict) {
		t.Fatalf("duplicate request: %v", err)
	}
	if _, err = svc.FinishSubmission(ctx, item.ID, "instance-1", "running"); err != nil {
		t.Fatal(err)
	}
	if err = svc.ApplyApprovalResult(ctx, "instance-1", "PROC", "finish", "agree"); err != nil {
		t.Fatal(err)
	}
	if err = svc.ApplyApprovalResult(ctx, "instance-1", "PROC", "finish", "refuse"); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.SetCurrentVersion(ctx, skill.SkillID, version.VersionID); err != nil {
		t.Fatal(err)
	}
	if err = svc.SetSpaceApproval(ctx, skill.SpaceID, "dingtalk", "PROC-2", "writer"); err != nil {
		t.Fatal(err)
	}
	if published, err := svc.GetPublished(ctx, skill.SkillID); err != nil || published.VersionID != version.VersionID {
		t.Fatalf("published after switch: %#v %v", published, err)
	}
	if _, err = svc.SetCurrentVersion(ctx, skill.SkillID, version.VersionID); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("old OA reused: %v", err)
	}
}
