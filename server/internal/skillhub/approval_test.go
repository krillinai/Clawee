package skillhub

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func uploadApprovedVersion(service *Service, ctx context.Context, input UploadVersionInput) (MutationResult, error) {
	result, err := service.UploadVersion(ctx, input)
	if err != nil {
		return result, err
	}
	if err := service.SetSpaceApprover(ctx, result.Skill.SpaceID, "test-reviewer", "test-admin"); err != nil {
		return MutationResult{}, err
	}
	if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "test-reviewer", true, "测试发布前审批"); err != nil {
		return MutationResult{}, err
	}
	return service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID)
}

func TestSkillApprovalGatesUploadsUpdatesAndSpaceMoves(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	upload := func(name, version, target string, autoPublish bool) MutationResult {
		t.Helper()
		resolution := VersionResolutionByName
		if target != "" {
			resolution = VersionResolutionReplace
		}
		result, err := service.CreateVersionFromPackage(ctx, CreateVersionInput{Version: version, TargetSkillID: target, Resolution: resolution, Publish: autoPublish, CreatedBy: "writer", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD(name)}}))})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := upload("approval-test", "1", "", true)
	if first.Skill.CurrentVersionID != nil || first.Version.ApprovalStatus != "pending" {
		t.Fatalf("upload = %#v", first)
	}
	if _, err := service.GetPublished(ctx, first.Skill.SkillID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending visible: %v", err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("publish without approval: %v", err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "admin", true, ""); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("unconfigured review: %v", err)
	}
	if err := service.SetSpaceApprover(ctx, DefaultSpaceID, "reviewer", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "writer", true, ""); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("non-reviewer: %v", err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "reviewer", false, "需要修订"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("rejected publish: %v", err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "reviewer", true, "已确认"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	update := upload("renamed-after-review", "2", first.Skill.SkillID, true)
	published, err := service.GetPublished(ctx, first.Skill.SkillID)
	if err != nil || published.VersionID != first.Version.VersionID || published.Name != "approval-test" {
		t.Fatalf("pending update changed published: %#v %v", published, err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, update.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("update bypassed: %v", err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, update.Version.VersionID, "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, update.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	published, err = service.GetPublished(ctx, first.Skill.SkillID)
	if err != nil || published.Name != "renamed-after-review" {
		t.Fatalf("approved rename: %#v %v", published, err)
	}
	space, err := service.CreateSpace(ctx, "目标空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.SetSpaceApprover(ctx, space.SpaceID, "target-reviewer", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.MoveSkillsToSpace(ctx, []string{first.Skill.SkillID}, space.SpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetPublished(ctx, first.Skill.SkillID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("moved still visible: %v", err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, update.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("old space approval used: %v", err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, update.Version.VersionID, "reviewer", true, ""); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("old reviewer: %v", err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, update.Version.VersionID, "target-reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, update.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	if err := service.SetSpaceApprover(ctx, space.SpaceID, "", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, update.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("unconfigured space allowed publish: %v", err)
	}
}
