package skillhub

import (
	"context"
	"errors"
	"testing"

	"github.com/krillinai/Clawee/server/internal/approvals"
)

func TestAdminApprovalsScopeHistoryAndReviewBoundary(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, _, _ := personalApprovalFixture(t, backend)
			ctx := context.Background()
			result := personalUpload(t, service, "admin-history", "1")
			filter := approvals.Filter{View: "all", Status: "all", Channel: "all"}
			items, err := service.ListAdminApprovals(ctx, "other", filter, 20, false)
			if err != nil || len(items) != 1 || items[0].ProgressTotal != 2 {
				t.Fatalf("有空间权限的非参与管理员应可查询: %#v %v", items, err)
			}
			item, detail, err := service.GetAdminApproval(ctx, "other", "skill", items[0].ID)
			if err != nil || item.CanProcess || detail.CanReview || len(detail.Versions) != 1 {
				t.Fatalf("管理详情不赋予审批资格: %#v %#v %v", item, detail, err)
			}
			input := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "other", true, "越权", input); !errors.Is(err, ErrReviewForbidden) {
				t.Fatalf("非审批人不能处理: %v", err)
			}
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"alice"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			old, oldDetail, err := service.GetAdminApproval(ctx, "other", "skill", item.ID)
			if err != nil || old.Status != "invalidated" || old.MaterialsAvailable || oldDetail.Versions[0].LocalApproval.RequestID != item.ID || oldDetail.Versions[0].LocalApproval.Total != 2 {
				t.Fatalf("历史详情不能冒充新轮次: %#v %#v %v", old, oldDetail, err)
			}
			if _, err = service.ListAdminApprovalFiles(ctx, "other", "skill", item.ID); !errors.Is(err, ErrConflict) {
				t.Fatalf("失效轮次不可读取材料: %v", err)
			}
			if err := service.RemoveSpaceMember(ctx, DefaultSpaceID, "other"); err != nil {
				t.Fatal(err)
			}
			itemsAfter, err := service.ListAdminApprovals(ctx, "other", filter, 20, false)
			if err != nil || len(itemsAfter) != 0 {
				t.Fatalf("撤销空间权限必须过滤: %#v %v", itemsAfter, err)
			}
			summary, err := service.AdminApprovalSummary(ctx, "other", filter)
			if err != nil || summary.Total != 0 {
				t.Fatalf("统计不能泄露: %#v %v", summary, err)
			}
			if _, _, err := service.GetAdminApproval(ctx, "other", "skill", item.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("撤权后的详情: %v", err)
			}
		})
	}
}

func TestAdminApprovalsPagingFiltersAndExternal(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, _, _ := personalApprovalFixture(t, backend)
			ctx := context.Background()
			for _, name := range []string{"page-a", "page-b", "page-c"} {
				personalUpload(t, service, name, "1")
			}
			filter := approvals.Filter{View: "all", Status: "all", Channel: "all"}
			first, err := service.ListAdminApprovals(ctx, "other", filter, 2, false)
			if err != nil || len(first) != 2 {
				t.Fatal(first, err)
			}
			filter.BeforeTime, filter.BeforeKind, filter.BeforeID = first[1].CreatedAt, first[1].Kind, first[1].ID
			second, err := service.ListAdminApprovals(ctx, "other", filter, 2, false)
			if err != nil || len(second) != 1 || second[0].ID == first[0].ID || second[0].ID == first[1].ID {
				t.Fatalf("同时间分页: %#v %v", second, err)
			}
			summary, err := service.AdminApprovalSummary(ctx, "other", filter)
			if err != nil || summary.Total != 3 || summary.Pending != 3 {
				t.Fatalf("统计不受分页影响: %#v %v", summary, err)
			}
			filter.BeforeTime, filter.BeforeKind, filter.BeforeID = first[0].CreatedAt.AddDate(-1, 0, 0), "", ""
			filter.Search = "page-b"
			summary, err = service.AdminApprovalSummary(ctx, "other", filter)
			if err != nil || summary.Total != 1 {
				t.Fatal(summary, err)
			}
			space, err := service.CreateSpace(ctx, "外部审批", "", "writer")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = service.SetSpaceMember(ctx, space.SpaceID, "other", []string{SpaceActionRead}, "writer", false); err != nil {
				t.Fatal(err)
			}
			if _, err = service.SetSpaceApprovers(ctx, space.SpaceID, "dingtalk", "template", nil, true, "writer"); err != nil {
				t.Fatal(err)
			}
			result := personalUpload(t, service, "external-admin", "1")
			if _, err = service.MoveSkillsToSpace(ctx, []string{result.Skill.SkillID}, space.SpaceID); err != nil {
				t.Fatal(err)
			}
			external, _, _, err := service.BeginApproval(ctx, result.Skill.SkillID, result.Version.VersionID, "writer", "external-writer", false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = service.FinishSubmission(ctx, external.ID, "", "uncertain"); err != nil {
				t.Fatal(err)
			}
			filter = approvals.Filter{View: "error", Status: "all", Channel: "dingtalk"}
			items, err := service.ListAdminApprovals(ctx, "other", filter, 20, false)
			if err != nil || len(items) != 1 || items[0].Kind != "skill_external" || items[0].BusinessStatus != "uncertain" || items[0].Status != "error" {
				t.Fatal(items, err)
			}
			if _, _, err = service.GetAdminApproval(ctx, "other", "skill_external", external.ID); err != nil {
				t.Fatal(err)
			}
		})
	}
}
