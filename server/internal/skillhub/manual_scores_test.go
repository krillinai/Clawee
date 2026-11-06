package skillhub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestManualReviewCannotBypassScores(t *testing.T) {
	ctx := context.Background()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
	if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"reviewer"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	result, err := service.UploadVersion(ctx, UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("manual-scores")}}))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "reviewer", true, ""); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("无 request_id 与评分的审批必须拒绝，实际: %v", err)
	}
}

func reviewVersionForTest(service *Service, ctx context.Context, skillID, versionID, reviewer string, approve bool, comment string) (Version, error) {
	return service.ReviewVersion(ctx, skillID, versionID, reviewer, approve, comment, reviewInputForTest(ctx, service, skillID, versionID))
}

func reviewInputForTest(ctx context.Context, service *Service, skillID, versionID string) ReviewInput {
	approveAIInFixture(service, skillID, versionID)
	input := ReviewInput{RequestID: "missing", Scores: manualTestScores(3, 3, 3, 3)}
	if detail, err := service.GetAdmin(ctx, skillID); err == nil {
		for _, version := range detail.Versions {
			if version.VersionID == versionID && version.LocalApproval != nil {
				input.RequestID = version.LocalApproval.RequestID
			}
		}
	}
	return input
}

func manualTestScores(scenario, result, ease, reuse int) *ReviewScores {
	return &ReviewScores{&scenario, &result, &ease, &reuse}
}

func manualFixture(t *testing.T, reviewers ...string) (*Service, *MemoryStore, MutationResult, ReviewInput) {
	t.Helper()
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", reviewers, true, "writer"); err != nil {
		t.Fatal(err)
	}
	result, err := service.UploadVersion(ctx, UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("manual-scores")}}))})
	if err != nil {
		t.Fatal(err)
	}
	return service, store, result, reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
}

func TestManualReviewValidation(t *testing.T) {
	cases := []struct {
		name    string
		approve bool
		comment string
		scores  *ReviewScores
	}{
		{"缺项", true, "", &ReviewScores{}},
		{"空评分", true, "", nil},
		{"部分评分", true, "", &ReviewScores{ScenarioValue: manualTestScores(1, 1, 1, 1).ScenarioValue}},
		{"零分", true, "", manualTestScores(0, 3, 3, 3)},
		{"六分", true, "", manualTestScores(3, 6, 3, 3)},
		{"负分", false, "驳回", manualTestScores(3, 3, -1, 3)},
		{"空白驳回", false, " \t\n", nil},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			service, store, result, input := manualFixture(t, "reviewer")
			input.Scores = item.scores
			if _, err := service.ReviewVersion(context.Background(), result.Skill.SkillID, result.Version.VersionID, "reviewer", item.approve, item.comment, input); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("非法评分未拒绝: %v", err)
			}
			if store.localApprovals[result.Version.VersionID][0].Decisions["reviewer"].Status != "pending" {
				t.Fatal("非法输入污染决策")
			}
		})
	}
}

func TestManualReviewSummaryAndDeepCopy(t *testing.T) {
	ctx := context.Background()
	service, _, result, input := manualFixture(t, "alice", "bob", "carol")
	for index, userID := range []string{"alice", "bob", "carol"} {
		value := 1
		if index == 2 {
			value = 2
		}
		input.Scores = manualTestScores(value, value, value, value)
		version, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, userID, true, "", input)
		if err != nil {
			t.Fatal(err)
		}
		if index < 2 && version.LocalApproval.ScoreSummary != nil {
			t.Fatal("pending 出现汇总")
		}
		if index == 2 && (version.LocalApproval.ScoreSummary == nil || version.LocalApproval.ScoreSummary.Total != float64(16)/3 || version.LocalApproval.ScoreSummary.ScenarioValue != float64(4)/3) {
			t.Fatalf("原始总和精度错误: %#v", version.LocalApproval.ScoreSummary)
		}
		*input.Scores.ScenarioValue = 5
		*version.LocalApproval.Approvers[index].Scores.ScenarioValue = 5
	}
	detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	if *detail.Versions[0].LocalApproval.Approvers[0].Scores.ScenarioValue != 1 {
		t.Fatal("输入或返回指针污染存储")
	}
	before := detail.Versions[0].LocalApproval
	items, err := service.ListAdmin(ctx)
	if err != nil || !reflect.DeepEqual(items[0].LatestVersion.LocalApproval, before) {
		t.Fatalf("列表与详情不同: %v", err)
	}
	*before.Approvers[0].Scores.ScenarioValue = 5
	*items[0].LatestVersion.LocalApproval.Approvers[1].Scores.ScenarioValue = 5
	detail, _ = service.GetAdmin(ctx, result.Skill.SkillID)
	if *detail.Versions[0].LocalApproval.Approvers[0].Scores.ScenarioValue != 1 || *detail.Versions[0].LocalApproval.Approvers[1].Scores.ScenarioValue != 1 {
		t.Fatal("读取指针污染原始评分")
	}
}

func TestManualReviewReturnedScoresCannotPollutePublish(t *testing.T) {
	ctx := context.Background()
	service, _, result, input := manualFixture(t, "reviewer")
	input.Scores = manualTestScores(1, 1, 1, 1)
	version, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "reviewer", true, "", input)
	if err != nil {
		t.Fatal(err)
	}
	*version.LocalApproval.Approvers[0].Scores.ScenarioValue = 5
	version.LocalApproval.ScoreSummary.Total = 20
	published, err := service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID)
	if err != nil || published.Version.LocalApproval == nil || *published.Version.LocalApproval.Approvers[0].Scores.ScenarioValue != 1 || published.Version.LocalApproval.ScoreSummary.Total != 4 {
		t.Fatalf("返回对象污染后续评分响应: %#v %v", published.Version.LocalApproval, err)
	}
}

func TestManualReviewLegacyAndUnsupportedStandard(t *testing.T) {
	ctx := context.Background()
	t.Run("历史已有无分通过", func(t *testing.T) {
		service, store, result, input := manualFixture(t, "alice", "bob")
		request := &store.localApprovals[result.Version.VersionID][0]
		request.ScoringStandardVersion = ""
		old := request.Decisions["alice"]
		old.Status = "approved"
		request.Decisions["alice"] = old
		if _, err := service.GetAdmin(ctx, result.Skill.SkillID); err != nil {
			t.Fatal(err)
		}
		if request.ScoringStandardVersion != "" {
			t.Fatal("读取绑定历史标准")
		}
		version, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "bob", true, "", input)
		if err != nil || version.LocalApproval.ScoreSummary != nil || version.LocalApproval.ScoringStandardVersion != manualScoringStandard || version.LocalApproval.Approvers[0].Scores != nil {
			t.Fatalf("旧分值被补造: %#v %v", version.LocalApproval, err)
		}
	})
	for _, scored := range []bool{false, true} {
		t.Run(map[bool]string{false: "无分驳回不绑定", true: "部分分驳回绑定"}[scored], func(t *testing.T) {
			service, store, result, input := manualFixture(t, "reviewer")
			store.localApprovals[result.Version.VersionID][0].ScoringStandardVersion = ""
			input.Scores = nil
			if scored {
				input.Scores = &ReviewScores{EaseOfUse: manualTestScores(1, 1, 1, 1).EaseOfUse}
			}
			version, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "reviewer", false, "修订", input)
			if err != nil || (version.LocalApproval.ScoringStandardVersion == manualScoringStandard) != scored || version.LocalApproval.ScoreSummary != nil {
				t.Fatalf("首次实际评分绑定错误: %#v %v", version.LocalApproval, err)
			}
		})
	}
	t.Run("未知标准不能覆盖", func(t *testing.T) {
		service, store, result, input := manualFixture(t, "reviewer")
		store.localApprovals[result.Version.VersionID][0].ScoringStandardVersion = "future-v2"
		if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "reviewer", true, "", input); !errors.Is(err, ErrConflict) {
			t.Fatalf("未知标准未拒绝: %v", err)
		}
		if store.localApprovals[result.Version.VersionID][0].ScoringStandardVersion != "future-v2" {
			t.Fatal("未知标准被覆盖")
		}
	})
}

func TestManualReviewRequestBinding(t *testing.T) {
	for _, change := range []string{"request", "digest", "space", "read", "invalidated"} {
		t.Run(change, func(t *testing.T) {
			ctx := context.Background()
			service, store, result, input := manualFixture(t, "reviewer")
			switch change {
			case "request":
				input.RequestID = "old-request"
			case "digest":
				store.localApprovals[result.Version.VersionID][0].Digest = "different"
			case "space":
				store.localApprovals[result.Version.VersionID][0].SpaceID = "different"
			case "invalidated":
				store.localApprovals[result.Version.VersionID][0].Status = "invalidated"
			case "read":
				if _, err := service.SetSpaceMember(ctx, DefaultSpaceID, "writer", []string{SpaceActionRead}, "writer", false); err != nil {
					t.Fatal(err)
				}
			}
			want := ErrConflict
			if change == "read" {
				want = ErrReviewForbidden
			}
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "reviewer", true, "", input); !errors.Is(err, want) {
				t.Fatalf("轮次或权限错误: %v，预期 %v", err, want)
			}
			if store.localApprovals[result.Version.VersionID][0].Decisions["reviewer"].Status != "pending" {
				t.Fatal("失败写入评分")
			}
		})
	}
}

// 既有人工评分测试显式准备已通过的 AI 阶段；P9 门禁测试直接调用服务接口。
func approveAIInFixture(service *Service, skillID, versionID string) {
	report := &AIReviewReport{Conclusion: "recommend_approve", Summary: "测试材料静态分析通过", Findings: []AIReviewFinding{}}
	switch store := service.store.(type) {
	case *MemoryStore:
		store.mu.Lock()
		defer store.mu.Unlock()
		if store.aiIdentityLookup == nil {
			store.aiIdentityLookup = func(context.Context, string, string) error { return nil }
		}
		requests := store.localApprovals[versionID]
		if len(requests) == 0 {
			return
		}
		request := &requests[len(requests)-1]
		if len(request.AIAttempts) == 0 {
			return
		}
		current := &request.AIAttempts[len(request.AIAttempts)-1]
		if current.Status != "pending" {
			return
		}
		current.Status, current.ReviewSkillVersion, current.ReviewSkillSHA256, current.Report = "completed", "test-v1", strings.Repeat("a", 64), report
	case *PostgresStore:
		data, _ := json.Marshal(report)
		_, _ = store.pool.Exec(context.Background(), `UPDATE skill_ai_review_attempts SET status='completed',review_skill_version='test-v1',review_skill_sha256=$2,report=$3
 WHERE request_id=(SELECT id FROM approval_requests WHERE business_id=$1 AND status<>'invalidated' ORDER BY created_at DESC,id DESC LIMIT 1) AND status='pending'`, versionID, strings.Repeat("a", 64), data)
	}
}
