package skillhub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
)

func aiTestService(t *testing.T, postgres bool) (*Service, func(string), func(string)) {
	t.Helper()
	ctx := context.Background()
	var store Store
	var setTime func(string)
	var setAccount func(string)
	if postgres {
		pool, err := pgxpool.New(ctx, testpostgres.New(t))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		_, err = pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES
('writer','writer@ai.test','writer','x','active',now(),now()),('alice','alice@ai.test','alice','x','active',now(),now()),('bob','bob@ai.test','bob','x','active',now(),now()),('runner','runner@ai.test','runner','x','active',now(),now()),('other','other@ai.test','other','x','active',now(),now());
INSERT INTO mcp_agents(agent_id,status,created_at,updated_at) VALUES('agent-review','active',now(),now());
INSERT INTO account_agents(user_id,agent_id,created_at) VALUES('runner','agent-review',now())`)
		if err != nil {
			t.Fatal(err)
		}
		store = NewPostgresStore(pool)
		setTime = func(request string) {
			t.Helper()
			_, err := pool.Exec(ctx, `UPDATE skill_ai_review_attempts SET started_at=now()-interval '16 minutes' WHERE request_id=$1 AND status='running'`, request)
			if err != nil {
				t.Fatal(err)
			}
		}
		setAccount = func(status string) {
			t.Helper()
			_, err := pool.Exec(ctx, `UPDATE accounts SET status=$1 WHERE user_id='runner'`, status)
			if err != nil {
				t.Fatal(err)
			}
		}
	} else {
		memory := NewMemoryStore()
		store = memory
		active := true
		memory.aiIdentityLookup = func(_ context.Context, user, agent string) error {
			if user == "runner" && !active || agent != "" && (agent != "agent-review" || !active || user != "" && user != "runner") {
				return ErrReviewForbidden
			}
			return nil
		}
		setTime = func(request string) {
			memory.mu.Lock()
			defer memory.mu.Unlock()
			for _, requests := range memory.localApprovals {
				for index := range requests {
					if requests[index].ID == request {
						at := time.Now().Add(-16 * time.Minute)
						requests[index].AIAttempts[len(requests[index].AIAttempts)-1].StartedAt = &at
					}
				}
			}
		}
		setAccount = func(status string) { active = status == "active" }
	}
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	for _, user := range []string{"writer", "alice", "bob", "runner", "other"} {
		if _, err := service.SetSpaceMember(ctx, DefaultSpaceID, user, []string{SpaceActionRead, SpaceActionWrite}, "writer", false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"alice", "bob"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	return service, setTime, setAccount
}

func aiTestUpload(t *testing.T, service *Service, number string) (MutationResult, *LocalApproval) {
	t.Helper()
	result, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: number, CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("ai-review")}, {name: "asset.bin", body: "\x00\x01"}}))})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := service.GetAdmin(context.Background(), result.Skill.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	for _, version := range detail.Versions {
		if version.VersionID == result.Version.VersionID {
			return result, version.LocalApproval
		}
	}
	t.Fatal("缺少轮次")
	return result, nil
}

func aiTestEnable(t *testing.T, service *Service, enabled bool) {
	t.Helper()
	agent := ""
	if enabled {
		agent = "agent-review"
	}
	if _, err := service.SetAIReviewConfig(context.Background(), DefaultSpaceID, AIReviewConfig{Enabled: enabled, AgentID: agent}, "writer"); err != nil {
		t.Fatal(err)
	}
}

func TestAIReviewStoreLifecycle(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		name := "memory"
		if postgres {
			name = "postgres"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			service, _, _ := aiTestService(t, postgres)
			_, old := aiTestUpload(t, service, "1")
			if old.AIReview != nil {
				t.Fatal("默认关闭")
			}
			aiTestEnable(t, service, true)
			oldItem, oldDetail, err := service.GetPersonalApproval(ctx, "alice", old.RequestID)
			if err != nil || !oldItem.CanProcess || oldDetail.Versions[0].LocalApproval.AIReview != nil {
				t.Fatalf("旧轮次被回填: %v", err)
			}
			version, approval := aiTestUpload(t, service, "2")
			attempt := approval.AIReview.AttemptID
			aiTestEnable(t, service, false)
			item, _, err := service.GetPersonalApproval(ctx, "alice", approval.RequestID)
			if err != nil || !item.CanProcess {
				t.Fatalf("AI 阶段不得消除 fallback 权限: %+v %v", item, err)
			}
			if _, err := reviewVersionForTest(service, ctx, version.Skill.SkillID, version.Version.VersionID, "alice", true, ""); !errors.Is(err, ErrAIReviewRequired) {
				t.Fatalf("绕过前置: %v", err)
			}
			if _, err := service.SetCurrentVersion(ctx, version.Skill.SkillID, version.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
				t.Fatalf("直接发布: %v", err)
			}
			if tasks, err := service.ListAIReviewTasks(ctx, "other", "agent-review"); err != nil || len(tasks) != 0 {
				t.Fatalf("错误身份队列: %+v %v", tasks, err)
			}
			tasks, err := service.ListAIReviewTasks(ctx, "runner", "agent-review")
			if err != nil || len(tasks) != 1 || tasks[0].AttemptID != attempt {
				t.Fatalf("固定快照队列: %+v %v", tasks, err)
			}
			var lock sync.Mutex
			successes := 0
			var group sync.WaitGroup
			for range 2 {
				group.Add(1)
				go func() {
					defer group.Done()
					task, err := service.ClaimAIReview(ctx, approval.RequestID, attempt, "runner", "agent-review")
					lock.Lock()
					defer lock.Unlock()
					if err == nil {
						successes++
						if task.Materials == nil || len(task.Materials.Files) != 2 || task.Materials.Files[1].OmittedReason == "" {
							t.Error("材料清单未标明二进制")
						}
					} else if !errors.Is(err, ErrConflict) {
						t.Errorf("领取: %v", err)
					}
				}()
			}
			group.Wait()
			if successes != 1 {
				t.Fatalf("重复执行: %d", successes)
			}
			report := json.RawMessage(`{"conclusion":"recommend_reject","summary":"参考，不替代人工","findings":[{"severity":"warning","message":"需确认","path":"SKILL.md"}],"suggested_scores":{"scenario_value":1,"result_effectiveness":2,"ease_of_use":3,"reuse_value":4}}`)
			review, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", AIReviewResultInput{AttemptID: attempt, PackageSHA256: version.Version.PackageSHA256, Report: report})
			if err != nil || review.Status != "completed" {
				t.Fatalf("完成: %+v %v", review, err)
			}
			_, detail, err := service.GetPersonalApproval(ctx, "alice", approval.RequestID)
			if err != nil || detail.Versions[0].LocalApproval.ScoreSummary != nil || detail.Versions[0].ApprovalStatus != "pending" {
				t.Fatalf("AI 污染人工: %v", err)
			}
			if _, err := reviewVersionForTest(service, ctx, version.Skill.SkillID, version.Version.VersionID, "alice", true, ""); err != nil {
				t.Fatal(err)
			}
			if _, err := service.SetCurrentVersion(ctx, version.Skill.SkillID, version.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
				t.Fatalf("非全员发布: %v", err)
			}
			if _, err := reviewVersionForTest(service, ctx, version.Skill.SkillID, version.Version.VersionID, "bob", true, ""); err != nil {
				t.Fatal(err)
			}
			if _, err := service.SetCurrentVersion(ctx, version.Skill.SkillID, version.Version.VersionID); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAIReviewTimeoutRetryManualAndStaleResults(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		name := "memory"
		if postgres {
			name = "postgres"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			service, setTime, setAccount := aiTestService(t, postgres)
			aiTestEnable(t, service, true)
			version, approval := aiTestUpload(t, service, "1")
			attempt := approval.AIReview.AttemptID
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, attempt, "runner", "agent-review"); err != nil {
				t.Fatal(err)
			}
			setTime(approval.RequestID)
			item, detail, err := service.GetPersonalApproval(ctx, "alice", approval.RequestID)
			if err != nil || !item.CanProcess || detail.Versions[0].LocalApproval.AIReview.Status != "failed" {
				t.Fatalf("超时不开放 fallback: %v", err)
			}
			retried, err := service.ManageAIReview(ctx, approval.RequestID, attempt, "alice", "", false)
			if err != nil || retried.Status != "pending" || len(retried.Attempts) != 2 || retried.Attempts[0].Error != AIReviewTimeout {
				t.Fatalf("重试历史: %+v %v", retried, err)
			}
			failure := "包含凭据的原始故障"
			oldResult := AIReviewResultInput{AttemptID: attempt, PackageSHA256: version.Version.PackageSHA256, Error: &failure}
			if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", oldResult); !errors.Is(err, ErrConflict) {
				t.Fatalf("旧回写: %v", err)
			}
			setAccount("disabled")
			if tasks, err := service.ListAIReviewTasks(ctx, "runner", "agent-review"); err != nil || len(tasks) != 0 {
				t.Fatalf("失效账号: %v", err)
			}
			setAccount("active")
			if _, err := service.ManageAIReview(ctx, approval.RequestID, retried.AttemptID, "alice", "", true); !errors.Is(err, ErrInvalidRequest) {
				t.Fatal("缺少人工原因")
			}
			manual, err := service.ManageAIReview(ctx, approval.RequestID, retried.AttemptID, "alice", "执行端离线，明确转人工", true)
			if err != nil || manual.Status != "manual" || manual.ManualBy != "alice" || manual.ManualAt == nil {
				t.Fatalf("转人工: %+v %v", manual, err)
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, retried.AttemptID, "runner", "agent-review"); !errors.Is(err, ErrConflict) {
				t.Fatalf("转人工后领取: %v", err)
			}
			if _, err := reviewVersionForTest(service, ctx, version.Skill.SkillID, version.Version.VersionID, "alice", false, "人工驳回"); err != nil {
				t.Fatal(err)
			}
			resubmitted, err := service.ResubmitReview(ctx, version.Skill.SkillID, version.Version.VersionID, approval.RequestID, "writer")
			if err != nil || resubmitted.LocalApproval.AIReview.Status != "pending" || resubmitted.LocalApproval.RequestID == approval.RequestID {
				t.Fatalf("重提: %+v %v", resubmitted, err)
			}
			_, historical, err := service.GetPersonalApproval(ctx, "alice", approval.RequestID)
			if err != nil || historical.Versions[0].LocalApproval.AIReview.Status != "manual" {
				t.Fatalf("历史报告串轮次: %v", err)
			}
			if _, err := service.ManageAIReview(ctx, approval.RequestID, retried.AttemptID, "bob", "旧轮次", true); !errors.Is(err, ErrConflict) {
				t.Fatalf("旧轮次 fallback: %v", err)
			}
		})
	}
}

func TestAIReviewReportValidation(t *testing.T) {
	materials := &AIReviewMaterials{Files: []AIReviewMaterialFile{{Path: "SKILL.md"}}}
	for _, path := range []string{"/SKILL.md", "../SKILL.md", "a/../SKILL.md", `a\SKILL.md`, "./SKILL.md", "C:/SKILL.md", "missing.md"} {
		data, _ := json.Marshal(AIReviewReport{Conclusion: "recommend_approve", Summary: "摘要", Findings: []AIReviewFinding{{Severity: "info", Message: "证据", Path: path}}})
		if _, err := validateAIReport(data, materials); err == nil {
			t.Fatalf("越界证据: %q", path)
		}
	}
	for _, data := range []string{`{"conclusion":"approved","summary":"摘要","findings":[]}`, `{"conclusion":"recommend_approve","summary":"摘要","findings":[],"extra":true}`, `{"conclusion":"recommend_approve","summary":"摘要","findings":[],"suggested_scores":{"scenario_value":3}}`, `{"conclusion":"recommend_approve","summary":"摘要","findings":[],"suggested_scores":null}`, `{"conclusion":"recommend_approve","summary":"摘要","findings":[{"severity":"info","message":"证据","path":""}]}`} {
		if _, err := validateAIReport([]byte(data), materials); err == nil {
			t.Fatalf("无效结构: %s", data)
		}
	}
}

func TestAIReviewMaterialsLimitsAndChangedDigest(t *testing.T) {
	service, _, _ := aiTestService(t, false)
	aiTestEnable(t, service, true)
	version, approval := aiTestUpload(t, service, "1")
	if err := os.WriteFile(filepath.Join(service.packageRoot, version.Version.PackagePath), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ClaimAIReview(context.Background(), approval.RequestID, approval.AIReview.AttemptID, "runner", "agent-review"); !errors.Is(err, ErrConflict) {
		t.Fatalf("材料变化未拒绝: %v", err)
	}
	for _, size := range []int{128 * 1024, 128*1024 + 1} {
		service, _, _ := aiTestService(t, false)
		aiTestEnable(t, service, true)
		result, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("limits")}, {name: "large.txt", body: strings.Repeat("x", size)}}))})
		if err != nil {
			t.Fatal(err)
		}
		detail, err := service.GetAdmin(context.Background(), result.Skill.SkillID)
		if err != nil {
			t.Fatal(err)
		}
		approval := detail.Versions[0].LocalApproval
		_, err = service.ClaimAIReview(context.Background(), approval.RequestID, approval.AIReview.AttemptID, "runner", "agent-review")
		if size == 128*1024 && err != nil {
			t.Fatal(err)
		}
		if size > 128*1024 {
			if !errors.Is(err, ErrAIReviewFailed) {
				t.Fatalf("超限: %v", err)
			}
			item, detail, err := service.GetPersonalApproval(context.Background(), "alice", approval.RequestID)
			if err != nil || !item.CanProcess || detail.Versions[0].LocalApproval.AIReview.Status != "failed" {
				t.Fatalf("超限永久 running: %v", err)
			}
		}
	}
}

func TestAIReviewMaterialsTotalIncludesMetadata(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		name := "memory"
		if postgres {
			name = "postgres"
		}
		t.Run(name, func(t *testing.T) {
			for _, extra := range []int{0, 1} {
				service, _, _ := aiTestService(t, postgres)
				aiTestEnable(t, service, true)
				manifest := validSkillMD("total-limits")
				metadata, err := parseSkillMD([]byte(manifest))
				if err != nil {
					t.Fatal(err)
				}
				remaining := 512*1024 - len(metadata.Name) - len(metadata.Description) - len(manifest) - 3*128*1024 + extra
				entries := []testZIPEntry{{name: "SKILL.md", body: manifest}, {name: "first.txt", body: strings.Repeat("x", 128*1024)}, {name: "second.txt", body: strings.Repeat("x", 128*1024)}, {name: "third.txt", body: strings.Repeat("x", 128*1024)}, {name: "last.txt", body: strings.Repeat("x", remaining)}}
				result, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, entries))})
				if err != nil {
					t.Fatal(err)
				}
				detail, err := service.GetAdmin(context.Background(), result.Skill.SkillID)
				if err != nil {
					t.Fatal(err)
				}
				approval := detail.Versions[0].LocalApproval
				task, err := service.ClaimAIReview(context.Background(), approval.RequestID, approval.AIReview.AttemptID, "runner", "agent-review")
				if extra == 0 {
					if err != nil {
						t.Fatalf("精确512KiB不应失败: %v", err)
					}
					total := len(task.Materials.Name) + len(task.Materials.Description)
					for _, file := range task.Materials.Files {
						if file.Content != nil {
							total += len(*file.Content)
						}
					}
					if total != 512*1024 {
						t.Fatalf("总量定义不一致: %d", total)
					}
				} else if !errors.Is(err, ErrAIReviewFailed) {
					t.Fatalf("元数据参与总量超限: %v", err)
				}
			}
		})
	}
}

func TestAIReviewReportsExactBounds(t *testing.T) {
	materials := &AIReviewMaterials{Files: []AIReviewMaterialFile{{Path: "SKILL.md"}}}
	for _, dimension := range []string{"summary", "message", "findings"} {
		for _, extra := range []int{0, 1} {
			report := AIReviewReport{Conclusion: "needs_attention", Summary: "摘要", Findings: []AIReviewFinding{}}
			switch dimension {
			case "summary":
				report.Summary = strings.Repeat("中", 2730) + strings.Repeat("x", 2+extra)
			case "message":
				report.Findings = []AIReviewFinding{{Severity: "warning", Message: strings.Repeat("中", 1365) + strings.Repeat("x", 1+extra)}}
			case "findings":
				for range 100 + extra {
					report.Findings = append(report.Findings, AIReviewFinding{Severity: "info", Message: "说明"})
				}
			}
			data, _ := json.Marshal(report)
			_, err := validateAIReport(data, materials)
			if extra == 0 && err != nil || extra == 1 && err == nil {
				t.Fatalf("%s 精确边界 extra=%d: %v", dimension, extra, err)
			}
		}
	}
}

func TestAIReviewRevocationDigestAndSpaceInvalidation(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		name := "memory"
		if postgres {
			name = "postgres"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			service, _, _ := aiTestService(t, postgres)
			aiTestEnable(t, service, true)
			result, approval := aiTestUpload(t, service, "1")
			if err := service.RemoveSpaceMember(ctx, DefaultSpaceID, "runner"); err != nil {
				t.Fatal(err)
			}
			if tasks, err := service.ListAIReviewTasks(ctx, "runner", "agent-review"); err != nil || len(tasks) != 0 {
				t.Fatalf("撤权队列: %v", err)
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "runner", "agent-review"); !errors.Is(err, ErrReviewForbidden) {
				t.Fatalf("撤权领取: %v", err)
			}
			if _, err := service.SetSpaceMember(ctx, DefaultSpaceID, "runner", []string{SpaceActionRead}, "writer", false); err != nil {
				t.Fatal(err)
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "runner", "agent-review"); err != nil {
				t.Fatal(err)
			}
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"alice"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			failure := "原始失败"
			input := AIReviewResultInput{AttemptID: approval.AIReview.AttemptID, PackageSHA256: result.Version.PackageSHA256, Error: &failure}
			if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", input); !errors.Is(err, ErrConflict) {
				t.Fatalf("名单变化旧回写: %v", err)
			}
			detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
			if err != nil {
				t.Fatal(err)
			}
			current := detail.Versions[0].LocalApproval
			if current.RequestID == approval.RequestID || current.AIReview.Status != "pending" {
				t.Fatal("名单变化未按新配置创建轮次")
			}
			space, err := service.CreateSpace(ctx, "新空间", "", "writer")
			if err != nil {
				t.Fatal(err)
			}
			for _, user := range []string{"alice", "runner"} {
				if _, err := service.SetSpaceMember(ctx, space.SpaceID, user, []string{SpaceActionRead}, "writer", false); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := service.SetSpaceApprovers(ctx, space.SpaceID, "local", "", []string{"alice"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			if _, err := service.SetAIReviewConfig(ctx, space.SpaceID, AIReviewConfig{Enabled: true, AgentID: "agent-review"}, "writer"); err != nil {
				t.Fatal(err)
			}
			if _, err := service.MoveSkillsToSpace(ctx, []string{result.Skill.SkillID}, space.SpaceID); err != nil {
				t.Fatal(err)
			}
			if _, err := service.ManageAIReview(ctx, current.RequestID, current.AIReview.AttemptID, "alice", "旧空间", true); !errors.Is(err, ErrConflict) {
				t.Fatalf("移空间旧轮次: %v", err)
			}
			moved, err := service.GetAdmin(ctx, result.Skill.SkillID)
			if err != nil || moved.Versions[0].LocalApproval.AIReview.Status != "pending" || moved.Versions[0].LocalApproval.RequestID == current.RequestID {
				t.Fatalf("移空间快照: %v", err)
			}
		})
	}
}

func TestAIReviewGitSourceExcluded(t *testing.T) {
	service, _, _ := aiTestService(t, false)
	aiTestEnable(t, service, true)
	ctx := context.Background()
	now := time.Now().UTC()
	_, version, err := service.store.CreateVersion(ctx, Skill{SkillID: "git-skill", SpaceID: DefaultSpaceID, Name: "git-skill", CreatedAt: now, UpdatedAt: now}, Version{VersionID: "git-version", Version: "1", PackageSHA256: "digest", CreatedAt: now, Source: &VersionSourceEvidence{SourceID: "git-source"}}, CreateVersionOptions{Resolution: VersionResolutionCreateOnly})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := service.GetAdmin(ctx, "git-skill")
	if err != nil || detail.Versions[0].LocalApproval == nil || detail.Versions[0].LocalApproval.AIReview != nil || version.VersionID != "git-version" {
		t.Fatalf("Git被AI接管: %v", err)
	}
}

func TestAIReviewInvalidReportAndErrorAreSanitized(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		name := "memory"
		if postgres {
			name = "postgres"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			service, _, _ := aiTestService(t, postgres)
			aiTestEnable(t, service, true)
			result, approval := aiTestUpload(t, service, "1")
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "runner", "agent-review"); err != nil {
				t.Fatal(err)
			}
			review, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", AIReviewResultInput{AttemptID: approval.AIReview.AttemptID, PackageSHA256: result.Version.PackageSHA256, Report: json.RawMessage(`{"conclusion":"recommend_approve","summary":"secret","findings":[],"tool":"exec"}`)})
			if err != nil || review.Status != "failed" || review.Error != AIReviewReportFailure || review.Report != nil {
				t.Fatalf("无效报告脱敏: %+v %v", review, err)
			}
			retry, err := service.ManageAIReview(ctx, approval.RequestID, review.AttemptID, "alice", "", false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, retry.AttemptID, "runner", "agent-review"); err != nil {
				t.Fatal(err)
			}
			failure := "secret credential path /private/credential"
			review, err = service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", AIReviewResultInput{AttemptID: retry.AttemptID, PackageSHA256: result.Version.PackageSHA256, Error: &failure})
			if err != nil || review.Status != "failed" || review.Error != AIReviewFailure || len(review.Attempts) != 2 || review.Attempts[0].Error != AIReviewReportFailure {
				t.Fatalf("故障脱敏历史: %+v %v", review, err)
			}
		})
	}
}

func TestAIReviewChangedBindingAndLateTimeoutRejected(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		name := "memory"
		if postgres {
			name = "postgres"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			service, setTime, _ := aiTestService(t, postgres)
			aiTestEnable(t, service, true)
			result, approval := aiTestUpload(t, service, "1")
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "runner", "agent-review"); err != nil {
				t.Fatal(err)
			}
			setTime(approval.RequestID)
			failure := "failure"
			input := AIReviewResultInput{AttemptID: approval.AIReview.AttemptID, PackageSHA256: result.Version.PackageSHA256, Error: &failure}
			if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", input); !errors.Is(err, ErrConflict) {
				t.Fatalf("超时迟到回写: %v", err)
			}
			retry, err := service.ManageAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "alice", "", false)
			if err != nil {
				t.Fatal(err)
			}
			switch store := service.store.(type) {
			case *MemoryStore:
				store.mu.Lock()
				store.versions[result.Skill.SkillID][0].PackageSHA256 = "changed"
				store.mu.Unlock()
			case *PostgresStore:
				if _, err := store.pool.Exec(ctx, `UPDATE skill_versions SET package_sha256='changed' WHERE version_id=$1`, result.Version.VersionID); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, retry.AttemptID, "runner", "agent-review"); !errors.Is(err, ErrConflict) {
				t.Fatalf("DB摘要变化领取: %v", err)
			}
			if _, err := service.ManageAIReview(ctx, approval.RequestID, retry.AttemptID, "alice", "变化", true); !errors.Is(err, ErrConflict) {
				t.Fatalf("DB摘要变化fallback: %v", err)
			}
			if _, _, err := service.GetPersonalApproval(ctx, "alice", approval.RequestID); !errors.Is(err, ErrConflict) {
				t.Fatalf("DB摘要变化详情: %v", err)
			}
		})
	}
}
