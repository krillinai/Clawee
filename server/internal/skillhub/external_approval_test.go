package skillhub

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestExternalApprovalLifecycleAndGates(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	upload := func(version string) MutationResult {
		t.Helper()
		result, err := svc.UploadVersion(ctx, UploadVersionInput{Version: version, CreatedBy: "writer", UploadedByUserID: "writer", Origin: "app_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("external-approval")}}))})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := upload("1")
	if err := svc.SetSpaceApproval(ctx, first.Skill.SpaceID, "dingtalk", "PROC-1", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.PublishOwnVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "writer"); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("self publish: %v", err)
	}
	if _, err := svc.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("direct publish: %v", err)
	}
	if err := svc.SetSpaceApprover(ctx, first.Skill.SpaceID, "reviewer", "admin"); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("local approver: %v", err)
	}
	if _, err := svc.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "reviewer", true, ""); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("local review: %v", err)
	}
	item, _, _, err := svc.BeginApproval(ctx, first.Skill.SkillID, first.Version.VersionID, "writer", "staff-writer", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := svc.BeginApproval(ctx, first.Skill.SkillID, first.Version.VersionID, "writer", "staff-writer", false); !errors.Is(err, ErrExternalApprovalConflict) {
		t.Fatalf("duplicate: %v", err)
	}
	if err := svc.SetSpaceApproval(ctx, first.Skill.SpaceID, "dingtalk", "PROC-2", "admin"); !errors.Is(err, ErrExternalApprovalConflict) {
		t.Fatalf("active configuration: %v", err)
	}
	if _, err := svc.FinishSubmission(ctx, item.ID, "instance-1", "running"); err != nil {
		t.Fatal(err)
	}
	if err := svc.ApplyApprovalResult(ctx, "instance-1", "wrong", "finish", "agree"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("wrong template published: %v", err)
	}
	if err := svc.ApplyApprovalResult(ctx, "instance-1", "PROC-1", "finish", "agree"); err != nil {
		t.Fatal(err)
	}
	if err := svc.ApplyApprovalResult(ctx, "instance-1", "PROC-1", "finish", "refuse"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); err != nil {
		t.Fatalf("approved version: %v", err)
	}
	second := upload("2")
	if err := svc.SetSpaceApproval(ctx, first.Skill.SpaceID, "dingtalk", "PROC-2", "admin"); err != nil {
		t.Fatal(err)
	}
	current, err := svc.GetPublished(ctx, first.Skill.SkillID)
	if err != nil || current.VersionID != first.Version.VersionID {
		t.Fatalf("published version after switch: %#v %v", current, err)
	}
	if _, err := svc.SetCurrentVersion(ctx, first.Skill.SkillID, second.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("unapproved second version: %v", err)
	}
	if _, err := svc.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("old approval reused: %v", err)
	}
}

func TestExternalApprovalRetryAndMigration(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	result, err := svc.UploadVersion(ctx, UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "app_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("retry-approval")}}))})
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.SetSpaceApproval(ctx, result.Skill.SpaceID, "dingtalk", "PROC", "admin"); err != nil {
		t.Fatal(err)
	}
	item, _, _, err := svc.BeginApproval(ctx, result.Skill.SkillID, result.Version.VersionID, "writer", "staff-writer", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.FinishSubmission(ctx, item.ID, "", "uncertain"); err != nil {
		t.Fatal(err)
	}
	space, err := svc.CreateSpace(ctx, "目标空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.MoveSkillsToSpace(ctx, []string{result.Skill.SkillID}, space.SpaceID); !errors.Is(err, ErrExternalApprovalConflict) {
		t.Fatalf("active migration: %v", err)
	}
	if _, err = svc.ResolveApproval(ctx, item.ID, "not_created", ""); err != nil {
		t.Fatal(err)
	}
	second, _, _, err := svc.BeginApproval(ctx, result.Skill.SkillID, result.Version.VersionID, "writer", "staff-writer", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.FinishSubmission(ctx, second.ID, "instance-2", "running"); err != nil {
		t.Fatal(err)
	}
	if err = svc.ApplyApprovalResult(ctx, "instance-2", "PROC", "finish", "refuse"); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("rejected version published: %v", err)
	}
	if _, err = svc.MoveSkillsToSpace(ctx, []string{result.Skill.SkillID}, space.SpaceID); err != nil {
		t.Fatal(err)
	}
	if err = svc.SetSpaceApproval(ctx, space.SpaceID, "dingtalk", "PROC", "admin"); err != nil {
		t.Fatal(err)
	}
	if err = svc.ApplyApprovalResult(ctx, "instance-2", "PROC", "finish", "agree"); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("late event published: %v", err)
	}
}
