package skillhub

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"sync"
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

func TestManualReviewResubmitConcurrencyAndLateDecision(t *testing.T) {
	ctx := context.Background()
	service, store, result, input := manualFixture(t, "alice", "bob")
	input.Scores = &ReviewScores{ReuseValue: manualTestScores(1, 1, 1, 5).ReuseValue}
	if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", false, "需修订", input); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, input.RequestID, "alice"); !errors.Is(err, ErrReviewForbidden) {
		t.Fatalf("非上传人重提: %v", err)
	}
	var wait sync.WaitGroup
	errorsCh := make(chan error, 8)
	for index := 0; index < 8; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, input.RequestID, "writer")
			errorsCh <- err
		}()
	}
	wait.Wait()
	close(errorsCh)
	succeeded := 0
	for err := range errorsCh {
		if err == nil {
			succeeded++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if succeeded != 1 || len(store.localApprovals[result.Version.VersionID]) != 2 {
		t.Fatalf("并发重提 %d", succeeded)
	}
	old := store.localApprovals[result.Version.VersionID][0]
	if old.Status != "rejected" || *old.Decisions["alice"].Scores.ReuseValue != 5 || old.Decisions["alice"].Comment != "需修订" {
		t.Fatal("旧记录丢失")
	}
	input.Scores = manualTestScores(5, 5, 5, 5)
	if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "bob", true, "", input); !errors.Is(err, ErrConflict) {
		t.Fatalf("迟到旧决策污染新轮: %v", err)
	}
	current := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
	if current.RequestID == input.RequestID {
		t.Fatal("重提复用旧 ID")
	}
	for _, person := range store.localApprovals[result.Version.VersionID][1].Decisions {
		if person.Scores != nil || person.Status != "pending" {
			t.Fatal("新轮复制旧评分")
		}
	}
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

func TestManualReviewResubmitGuards(t *testing.T) {
	ctx := context.Background()
	for _, mode := range []string{"pending", "approved", "invalidated", "old_request", "published", "source", "read_revoked"} {
		t.Run(mode, func(t *testing.T) {
			service, store, result, input := manualFixture(t, "reviewer")
			if mode != "pending" {
				if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "reviewer", false, "修订", input); err != nil {
					t.Fatal(err)
				}
			}
			want := ErrConflict
			switch mode {
			case "approved":
				store.localApprovals[result.Version.VersionID][0].Status = "approved"
			case "invalidated":
				store.localApprovals[result.Version.VersionID][0].Status = "invalidated"
			case "old_request":
				input.RequestID = "old-request"
			case "published":
				skill := store.skills[result.Skill.SkillID]
				skill.CurrentVersionID = &result.Version.VersionID
				store.skills[result.Skill.SkillID] = skill
			case "source":
				store.versions[result.Skill.SkillID][0].Source = &VersionSourceEvidence{SourceID: "source"}
				want = ErrReviewForbidden
			case "read_revoked":
				if _, err := service.SetSpaceMember(ctx, DefaultSpaceID, "reviewer", []string{SpaceActionRead}, "writer", false); err != nil {
					t.Fatal(err)
				}
				want = ErrReviewForbidden
			}
			if _, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, input.RequestID, "writer"); !errors.Is(err, want) {
				t.Fatalf("重提边界: %v，预期 %v", err, want)
			}
			if len(store.localApprovals[result.Version.VersionID]) != 1 {
				t.Fatal("失败重提创建新请求")
			}
		})
	}
}

func TestManualReviewResubmitUsesCurrentRoleMembers(t *testing.T) {
	ctx := context.Background()
	for _, empty := range []bool{false, true} {
		t.Run(map[bool]string{false: "新名单去重", true: "空名单回滚"}[empty], func(t *testing.T) {
			service, store, result, _ := manualFixture(t, "alice")
			members := []Approver{{UserID: "alice"}}
			store.SetApprovalRoleLookup(func(context.Context, string) (ApprovalRole, []Approver, error) {
				return ApprovalRole{RoleID: "role"}, members, nil
			})
			if _, err := service.SetSpaceApprovalSubjects(ctx, DefaultSpaceID, "local", "", nil, []string{"role"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			input := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", false, "修订", input); err != nil {
				t.Fatal(err)
			}
			before := len(store.localApprovals[result.Version.VersionID])
			members = []Approver{{UserID: "bob"}, {UserID: "carol"}, {UserID: "bob"}}
			if empty {
				members = nil
			}
			version, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, input.RequestID, "writer")
			if empty {
				if !errors.Is(err, ErrMemberNotFound) || len(store.localApprovals[result.Version.VersionID]) != before {
					t.Fatalf("空名单未回滚: %v", err)
				}
				return
			}
			if err != nil || version.LocalApproval.Total != 2 || version.LocalApproval.Approvers[0].UserID != "bob" || version.LocalApproval.Approvers[1].UserID != "carol" {
				t.Fatalf("新名单展开错误: %#v %v", version.LocalApproval, err)
			}
		})
	}
}
