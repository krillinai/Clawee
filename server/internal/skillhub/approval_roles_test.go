package skillhub

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestLocalRoleApprovalKeepsConfiguredSubjectsAndHistoricalMembers(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	members := map[string][]Approver{
		"first":  {{UserID: "alice"}, {UserID: "bob"}},
		"second": {{UserID: "bob"}},
		"empty":  {},
	}
	store.SetApprovalRoleLookup(func(_ context.Context, id string) (ApprovalRole, []Approver, error) {
		people, ok := members[id]
		if !ok {
			return ApprovalRole{}, nil, ErrInvalidRequest
		}
		return ApprovalRole{RoleID: id, Name: id}, people, nil
	})
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	if _, err := service.SetSpaceApprovalSubjects(ctx, DefaultSpaceID, "local", "", []string{"alice"}, []string{"first", "second"}, true, "admin"); err != nil {
		t.Fatal(err)
	}
	upload := func(number string) MutationResult {
		t.Helper()
		result, err := service.UploadVersion(ctx, UploadVersionInput{Version: number, CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("role-review")}}))})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := upload("1")
	space, err := service.GetSpace(ctx, DefaultSpaceID)
	if err != nil || len(space.Approvers) != 1 || len(space.ApproverRoles) != 2 || len(space.ApproverRoleIDs) != 2 {
		t.Fatalf("配置主体被展开覆盖: %#v %v", space, err)
	}
	requestID := store.localApprovals[first.Version.VersionID][0].ID
	members["first"], members["second"] = []Approver{{UserID: "alice"}, {UserID: "carol"}}, []Approver{{UserID: "carol"}}
	if _, err := service.SetSpaceApprovalSubjects(ctx, DefaultSpaceID, "local", "", []string{"alice"}, []string{"second", "first"}, false, "admin"); err != nil {
		t.Fatal(err)
	}
	detail, err := service.GetAdmin(ctx, first.Skill.SkillID)
	if err != nil || detail.Versions[0].LocalApproval.Total != 2 || detail.Versions[0].LocalApproval.Approvers[1].UserID != "bob" || store.localApprovals[first.Version.VersionID][0].ID != requestID {
		t.Fatalf("成员变化改写旧请求: %#v %v", detail, err)
	}
	if _, err := reviewVersionForTest(service, ctx, first.Skill.SkillID, first.Version.VersionID, "carol", true, ""); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("新增成员审批旧请求: %v", err)
	}
	partial, err := reviewVersionForTest(service, ctx, first.Skill.SkillID, first.Version.VersionID, "alice", true, "")
	if err != nil || partial.ApprovalStatus != "pending" || partial.LocalApproval.Approved != 1 {
		t.Fatalf("部分通过: %#v %v", partial, err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("部分通过允许发布: %v", err)
	}
	if _, err := reviewVersionForTest(service, ctx, first.Skill.SkillID, first.Version.VersionID, "bob", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ClearCurrentVersion(ctx, first.Skill.SkillID); err != nil {
		t.Fatal(err)
	}
	detail, err = service.GetAdmin(ctx, first.Skill.SkillID)
	if err != nil || detail.Versions[0].ApprovalStatus != "approved" || len(store.localApprovals[first.Version.VersionID]) != 1 {
		t.Fatalf("reset 因成员变化使旧批准失效: %#v %v", detail, err)
	}
	second := upload("2")
	detail, err = service.GetAdmin(ctx, second.Skill.SkillID)
	if err != nil || detail.Versions[0].LocalApproval.Total != 2 || detail.Versions[0].LocalApproval.Approvers[1].UserID != "carol" {
		t.Fatalf("新请求未展开当前成员: %#v %v", detail, err)
	}
	count, err := service.SetSpaceApprovalSubjects(ctx, DefaultSpaceID, "local", "", nil, []string{"first"}, false, "admin")
	if err != nil || count != 2 {
		t.Fatalf("主体改变未要求确认: %d %v", count, err)
	}
	if _, err = service.SetSpaceApprovalSubjects(ctx, DefaultSpaceID, "local", "", nil, []string{"first"}, true, "admin"); err != nil {
		t.Fatal(err)
	}
	space, _ = service.GetSpace(ctx, DefaultSpaceID)
	if len(space.Approvers) != 0 || len(space.ApproverRoleIDs) != 1 {
		t.Fatalf("纯角色配置: %#v", space)
	}
	rejected, err := reviewVersionForTest(service, ctx, second.Skill.SkillID, second.Version.VersionID, "carol", false, "驳回")
	if err != nil || rejected.ApprovalStatus != "rejected" {
		t.Fatalf("驳回: %#v %v", rejected, err)
	}
	members["first"] = nil
	unchanged, err := service.MoveSkillsToSpace(ctx, []string{first.Skill.SkillID}, DefaultSpaceID)
	if err != nil || unchanged.UnchangedCount != 1 {
		t.Fatalf("成员变空影响无变化操作: %#v %v", unchanged, err)
	}
}

func TestLocalEmptyRoleBlocksSubmissionAndExternalRoles(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetApprovalRoleLookup(func(_ context.Context, id string) (ApprovalRole, []Approver, error) {
		return ApprovalRole{RoleID: id, Name: "空角色"}, nil, nil
	})
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	if _, err := service.SetSpaceApprovalSubjects(ctx, DefaultSpaceID, "local", "", nil, []string{"empty"}, true, "admin"); err != nil {
		t.Fatal(err)
	}
	_, err := service.UploadVersion(ctx, UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("empty-role")}}))})
	if !errors.Is(err, ErrMemberNotFound) || len(store.skills) != 0 || len(store.versions) != 0 {
		t.Fatalf("空角色提交未拒绝或产生残留: %v", err)
	}
	if _, err := service.SetSpaceApprovalSubjects(ctx, DefaultSpaceID, "dingtalk", "template", nil, []string{"empty"}, true, "admin"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("外部审批混入角色: %v", err)
	}
	if _, err := service.SetSpaceApprovalSubjects(ctx, DefaultSpaceID, "local", "", nil, []string{"empty", "empty"}, true, "admin"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("重复角色未拒绝: %v", err)
	}
}
