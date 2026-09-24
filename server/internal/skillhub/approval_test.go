package skillhub

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
)

func TestLocalMultiApprovalSnapshotAndPublishGate(t *testing.T) {
	ctx := context.Background()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
	makeVersion := func(number string) MutationResult {
		t.Helper()
		result, err := service.UploadVersion(ctx, UploadVersionInput{Version: number, CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("multi-review")}}))})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := makeVersion("1")
	count, err := service.SetSpaceApprovers(ctx, first.Skill.SpaceID, "local", "", []string{"alice", "bob"}, false, "admin")
	if err != nil || count != 1 {
		t.Fatalf("confirmation = %d, %v", count, err)
	}
	if detail, err := service.GetAdmin(ctx, first.Skill.SkillID); err != nil || detail.Versions[0].LocalApproval != nil {
		t.Fatalf("preflight changed approval: %#v %v", detail, err)
	}
	if _, err = service.SetSpaceApprovers(ctx, first.Skill.SpaceID, "local", "", []string{"alice", "bob"}, true, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetSpaceApprovers(ctx, first.Skill.SpaceID, "local", "", []string{"alice", "alice"}, true, "admin"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("duplicate approvers: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "alice", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("partial approval published: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "alice", true, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate vote: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "mallory", true, ""); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("outsider vote: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "bob", true, "同意"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); err != nil {
		t.Fatal(err)
	}

	second := makeVersion("2")
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, id := range []string{"alice", "bob"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, err := service.ReviewVersion(ctx, second.Skill.SkillID, second.Version.VersionID, id, true, "")
			results <- err
		}(id)
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	detail, err := service.GetAdmin(ctx, first.Skill.SkillID)
	if err != nil || detail.Versions[0].LocalApproval.Approved != 2 {
		t.Fatalf("concurrent votes: %#v %v", detail, err)
	}
	count, err = service.SetSpaceApprovers(ctx, first.Skill.SpaceID, "local", "", []string{"alice", "carol"}, false, "admin")
	if err != nil || count != 1 {
		t.Fatalf("reset confirmation: %d %v", count, err)
	}
	if _, err = service.SetSpaceApprovers(ctx, first.Skill.SpaceID, "local", "", []string{"alice", "carol"}, true, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, second.Skill.SkillID, second.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("stale approval published: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, second.Skill.SkillID, second.Version.VersionID, "bob", true, ""); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("old reviewer voted: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, second.Skill.SkillID, second.Version.VersionID, "carol", false, "修订"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ReviewVersion(ctx, second.Skill.SkillID, second.Version.VersionID, "alice", true, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("rejected version changed: %v", err)
	}
	if _, err = service.SetCurrentVersion(ctx, second.Skill.SkillID, second.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("rejected version published: %v", err)
	}
}

func TestPublishedVersionNeedsNewApprovalAfterApproversChangeAndUnpublish(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	result, err := service.UploadVersion(ctx, UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("republish-review")}}))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetSpaceApprovers(ctx, result.Skill.SpaceID, "local", "", []string{"alice"}, true, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetSpaceApprovers(ctx, result.Skill.SpaceID, "local", "", []string{"bob"}, false, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.GetPublished(ctx, result.Skill.SkillID); err != nil {
		t.Fatalf("configuration took published version offline: %v", err)
	}
	detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
	if err != nil || detail.Versions[0].LocalApproval == nil || detail.Versions[0].LocalApproval.Status != "approved" || detail.Versions[0].LocalApproval.Approvers[0].UserID != "alice" {
		t.Fatalf("published approval history was lost: %#v %v", detail, err)
	}
	if _, err = service.ClearCurrentVersion(ctx, result.Skill.SkillID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("old approval reused: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", true, ""); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("old reviewer reused: %v", err)
	}
	if _, err = service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "bob", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ClearCurrentVersion(ctx, result.Skill.SkillID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); err != nil {
		t.Fatalf("unchanged approvers required another review: %v", err)
	}
	for _, config := range []struct {
		provider, template string
		approvers          []string
	}{
		{provider: "local"},
		{provider: "dingtalk", template: "PROC"},
	} {
		if _, err = service.SetSpaceApprovers(ctx, result.Skill.SpaceID, config.provider, config.template, config.approvers, true, "admin"); err != nil {
			t.Fatal(err)
		}
		detail, err = service.GetAdmin(ctx, result.Skill.SkillID)
		if err != nil || detail.Versions[0].LocalApproval != nil || store.localApprovals[result.Version.VersionID][len(store.localApprovals[result.Version.VersionID])-1].Status != "approved" {
			t.Fatalf("published approval history after %s: %#v %v", config.provider, detail, err)
		}
	}
}

func TestReplacingCurrentVersionResetsStalePublishedApproval(t *testing.T) {
	ctx := context.Background()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
	upload := func(version string) MutationResult {
		t.Helper()
		result, err := service.UploadVersion(ctx, UploadVersionInput{Version: version, CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("replace-current")}}))})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := upload("1")
	if _, err := service.SetSpaceApprovers(ctx, first.Skill.SpaceID, "local", "", []string{"alice"}, true, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "alice", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	second := upload("2")
	if _, err := service.SetSpaceApprovers(ctx, first.Skill.SpaceID, "local", "", []string{"bob"}, true, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReviewVersion(ctx, second.Skill.SkillID, second.Version.VersionID, "bob", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, second.Skill.SkillID, second.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("superseded version reused old approval: %v", err)
	}
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "bob", true, ""); err != nil {
		t.Fatalf("superseded version was not resubmitted: %v", err)
	}
}

func uploadApprovedVersion(service *Service, ctx context.Context, input UploadVersionInput) (MutationResult, error) {
	input.Origin = "admin_upload"
	if input.UploadedByUserID == "" {
		input.UploadedByUserID = "test-admin"
	}
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

func TestSelfPublishRequiresUploaderAndDisabledApproval(t *testing.T) {
	ctx := context.Background()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
	result, err := service.UploadVersion(ctx, UploadVersionInput{
		Version: "1", CreatedBy: "writer", UploadedByUserID: "writer-id", Origin: "app_upload",
		Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("self-publish")}})),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"writer-id", "other-id"} {
		if _, err := service.SetSpaceMember(ctx, result.Skill.SpaceID, userID, []string{SpaceActionRead, SpaceActionWrite}, "admin", false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.PublishOwnVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "other-id"); !errors.Is(err, ErrSelfPublishForbidden) {
		t.Fatalf("other user published: %v", err)
	}
	if _, err := service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("admin bypassed uploader: %v", err)
	}
	if err := service.SetSpaceApprover(ctx, result.Skill.SpaceID, "reviewer", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.PublishOwnVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "writer-id"); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("uploader bypassed approval: %v", err)
	}
	if err := service.SetSpaceApprover(ctx, result.Skill.SpaceID, "", "admin"); err != nil {
		t.Fatal(err)
	}
	published, err := service.PublishOwnVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "writer-id")
	if err != nil || published.Skill.CurrentVersionID == nil || published.Version.ApprovalStatus != "approved" {
		t.Fatalf("self publish = %#v, %v", published, err)
	}
}

func TestOwnPendingVersionsRequireWriteAccessAndDisabledApproval(t *testing.T) {
	ctx := context.Background()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
	result, err := service.UploadVersion(ctx, UploadVersionInput{
		Version: "1", CreatedBy: "writer", UploadedByUserID: "writer-id", Origin: "app_upload",
		Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("pending-own")}})),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetSpaceMember(ctx, result.Skill.SpaceID, "writer-id", []string{SpaceActionRead, SpaceActionWrite}, "admin", false); err != nil {
		t.Fatal(err)
	}
	check := func(user string, want int) {
		t.Helper()
		items, err := service.ListOwnPendingVersions(ctx, user)
		if err != nil || len(items) != want {
			t.Fatalf("pending for %s = %#v, %v; want %d", user, items, err, want)
		}
	}
	check("writer-id", 1)
	check("other-id", 0)
	if err := service.SetSpaceApprover(ctx, result.Skill.SpaceID, "reviewer-id", "admin"); err != nil {
		t.Fatal(err)
	}
	check("writer-id", 0)
	if err := service.SetSpaceApprover(ctx, result.Skill.SpaceID, "", "admin"); err != nil {
		t.Fatal(err)
	}
	if err := service.RemoveSpaceMember(ctx, result.Skill.SpaceID, "writer-id"); err != nil {
		t.Fatal(err)
	}
	check("writer-id", 0)
	if _, err := service.PublishOwnVersionForUser(ctx, result.Skill.SkillID, result.Version.VersionID, "writer-id"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked writer published: %v", err)
	}
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
		result, err := service.CreateVersionFromPackage(ctx, CreateVersionInput{Version: version, TargetSkillID: target, Resolution: resolution, Publish: autoPublish, CreatedBy: "writer", UploadedByUserID: "writer-id", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD(name)}}))})
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
	if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "reviewer", true, "已确认"); !errors.Is(err, ErrConflict) {
		t.Fatalf("rejected version changed: %v", err)
	}
	first = upload("approval-test", "1.1", first.Skill.SkillID, true)
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
