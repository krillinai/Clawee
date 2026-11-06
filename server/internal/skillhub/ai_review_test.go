package skillhub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/approvals"
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
	service := NewService(Config{ReviewAgentID: "agent-review", Store: store, PackageRoot: t.TempDir()})
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

func TestAIReviewLegacyApprovalStage(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(map[bool]string{false: "memory", true: "postgres"}[postgres], func(t *testing.T) {
			ctx := context.Background()
			service, _, _ := aiTestService(t, postgres)
			result, approval := aiTestUpload(t, service, "1")
			for _, status := range []string{"pending", "approved", "rejected"} {
				switch store := service.store.(type) {
				case *MemoryStore:
					request := &store.localApprovals[result.Version.VersionID][0]
					request.AIAttempts, request.Status = nil, status
					store.versions[result.Skill.SkillID][0].ApprovalStatus = status
				case *PostgresStore:
					if _, err := store.pool.Exec(ctx, `DELETE FROM skill_ai_review_attempts WHERE request_id=$1`, approval.RequestID); err != nil {
						t.Fatal(err)
					}
					if _, err := store.pool.Exec(ctx, `UPDATE approval_requests SET status=$1 WHERE id=$2`, status, approval.RequestID); err != nil {
						t.Fatal(err)
					}
					if _, err := store.pool.Exec(ctx, `UPDATE skill_versions SET approval_status=$1 WHERE version_id=$2`, status, result.Version.VersionID); err != nil {
						t.Fatal(err)
					}
				}
				item, detail, err := service.GetPersonalApproval(ctx, "writer", approval.RequestID)
				if err != nil {
					t.Fatal(err)
				}
				if item.Status != status || item.WorkflowStage != "" || detail.Versions[0].LocalApproval.WorkflowStage != "" || item.CanProcess || item.CanRetryAI {
					t.Fatalf("历史 %s 申请应沿用审批状态且不放行门禁: %+v", status, item)
				}
				items, err := service.ListAdminApprovals(ctx, "writer", approvals.Filter{View: "all", Status: "all", Channel: "all"}, 20, false)
				if err != nil || len(items) != 1 || items[0].WorkflowStage != "" || items[0].CanRetryAI {
					t.Fatalf("历史 %s 管理列表阶段: %+v %v", status, items, err)
				}
			}
		})
	}
}

func TestAdminApprovalsAIRetryCapability(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(map[bool]string{false: "memory", true: "postgres"}[postgres], func(t *testing.T) {
			ctx := context.Background()
			service, timeout, _ := aiTestService(t, postgres)
			result, approval := aiTestUpload(t, service, "1")
			check := func(want bool) {
				t.Helper()
				for _, actor := range []struct {
					user  string
					admin bool
				}{{"writer", false}, {"bob", false}, {"other", true}} {
					items, err := service.ListAdminApprovals(ctx, actor.user, approvals.Filter{View: "all", Status: "all", Channel: "all"}, 20, actor.admin)
					if err != nil {
						t.Fatal(err)
					}
					found := false
					for _, item := range items {
						if item.ID == approval.RequestID {
							found = true
							if item.CanRetryAI != (want && (actor.user == "writer" || actor.admin)) {
								t.Fatalf("%s 管理列表重试能力: %+v", actor.user, item)
							}
						}
					}
					if !found {
						t.Fatal("缺少原审批记录")
					}
				}
			}
			check(false)
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)}); err != nil {
				t.Fatal(err)
			}
			check(false)
			timeout(approval.RequestID)
			check(true)
			retry, err := service.ManageAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "writer", "", false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: retry.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)}); err != nil {
				t.Fatal(err)
			}
			if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", AIReviewResultInput{AttemptID: retry.AttemptID, PackageSHA256: result.Version.PackageSHA256, Report: json.RawMessage(`{"conclusion":"invalid"}`)}); err != nil {
				t.Fatal(err)
			}
			check(true)
			for _, code := range []string{"materials_unsupported", "execution_failed"} {
				if err := service.store.(aiReviewStore).withAIReview(ctx, approval.RequestID, "runner", "agent-review", false, time.Now().UTC(), func(state *aiReviewState) error {
					state.Request.AIAttempts[len(state.Request.AIAttempts)-1].ErrorCode = code
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				check(code != "materials_unsupported")
			}
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"alice"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			check(false)
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

func TestAIReviewReportConclusionMatchesFindings(t *testing.T) {
	materials := &AIReviewMaterials{Files: []AIReviewMaterialFile{{Path: "SKILL.md"}}}
	for _, conclusion := range []string{"recommend_approve", "needs_attention", "recommend_reject"} {
		for _, severity := range []string{"", "info", "warning", "error"} {
			t.Run(conclusion+"/"+severity, func(t *testing.T) {
				report := AIReviewReport{Conclusion: conclusion, Summary: "静态审核", Findings: []AIReviewFinding{}}
				if severity != "" {
					report.Findings = append(report.Findings, AIReviewFinding{Severity: severity, Message: "审核依据", Path: "SKILL.md"})
				}
				data, err := json.Marshal(report)
				if err != nil {
					t.Fatal(err)
				}
				_, err = validateAIReport(data, materials)
				valid := conclusion == "recommend_approve" && severity != "error" || conclusion != "recommend_approve" && severity == "error"
				if (err == nil) != valid {
					t.Fatalf("结论与问题级别不一致: %s/%s: %v", conclusion, severity, err)
				}
			})
		}
	}
}

func TestAIReviewNonblockingRejectionIsRetryable(t *testing.T) {
	for _, conclusion := range []string{"needs_attention", "recommend_reject"} {
		t.Run(conclusion, func(t *testing.T) {
			ctx := context.Background()
			service, _, _ := aiTestService(t, false)
			result, approval := aiTestUpload(t, service, "1")
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.1.2", ReviewSkillSHA256: strings.Repeat("a", 64)}); err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(AIReviewReport{Conclusion: conclusion, Summary: "建议补充说明", Findings: []AIReviewFinding{{Severity: "warning", Message: "【结构审核】建议补充示例"}}})
			if err != nil {
				t.Fatal(err)
			}
			saved, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", AIReviewResultInput{AttemptID: approval.AIReview.AttemptID, PackageSHA256: result.Version.PackageSHA256, Report: data})
			if err != nil || saved.Status != "failed" || saved.ErrorCode != "report_invalid" || saved.Report != nil {
				t.Fatalf("矛盾报告应为执行异常: %+v %v", saved, err)
			}
			item, _, err := service.GetPersonalApproval(ctx, "writer", approval.RequestID)
			if err != nil || !item.CanRetryAI || item.WorkflowStage != "ai_failed" {
				t.Fatalf("矛盾报告应允许原版本重试: %+v %v", item, err)
			}
			if _, err := service.ManageAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "writer", "", false); err != nil {
				t.Fatalf("原版本重试失败: %v", err)
			}
		})
	}
}

func TestAIReviewMaterialsLimitsAndChangedDigest(t *testing.T) {
	service, _, _ := aiTestService(t, false)

	version, approval := aiTestUpload(t, service, "1")
	if err := os.WriteFile(filepath.Join(service.packageRoot, version.Version.PackagePath), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ClaimAIReview(context.Background(), approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)}); !errors.Is(err, ErrConflict) {
		t.Fatalf("材料变化未拒绝: %v", err)
	}
	for _, size := range []int{128 * 1024, 128*1024 + 1} {
		service, _, _ := aiTestService(t, false)

		result, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("limits")}, {name: "large.txt", body: strings.Repeat("x", size)}}))})
		if err != nil {
			t.Fatal(err)
		}
		detail, err := service.GetAdmin(context.Background(), result.Skill.SkillID)
		if err != nil {
			t.Fatal(err)
		}
		approval := detail.Versions[0].LocalApproval
		_, err = service.ClaimAIReview(context.Background(), approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)})
		if size == 128*1024 && err != nil {
			t.Fatal(err)
		}
		if size > 128*1024 {
			if !errors.Is(err, ErrAIReviewFailed) {
				t.Fatalf("超限: %v", err)
			}
			item, detail, err := service.GetPersonalApproval(context.Background(), "alice", approval.RequestID)
			if err != nil || item.CanProcess || item.WorkflowStage != "revision_required" || detail.Versions[0].LocalApproval.AIReview.ErrorCode != "materials_unsupported" {
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
				task, err := service.ClaimAIReview(context.Background(), approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)})
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
			report := AIReviewReport{Conclusion: "recommend_approve", Summary: "摘要", Findings: []AIReviewFinding{}}
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

func TestAIReviewGitSourceExcluded(t *testing.T) {
	service, _, _ := aiTestService(t, false)

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

func TestP9ReviewWorkflow(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(map[bool]string{false: "memory", true: "postgres"}[postgres], func(t *testing.T) {
			ctx := context.Background()
			service, timeout, _ := aiTestService(t, postgres)
			result, approval := aiTestUpload(t, service, "1")
			if approval.AIReview == nil || approval.AIReview.AgentID != "" || approval.WorkflowStage != "ai_pending" || result.ApprovalRequestID != approval.RequestID {
				t.Fatal("上传必须原子创建未分配的AI轮次")
			}
			input := ReviewInput{RequestID: approval.RequestID, Scores: manualTestScores(5, 5, 5, 5)}
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", true, "", input); !errors.Is(err, ErrAIReviewRequired) {
				t.Fatalf("人工绕过:%v", err)
			}
			if todo, err := service.ListPersonalApprovals(ctx, "alice", PersonalApprovalQuery{View: "todo", Limit: 20}); err != nil || len(todo) != 0 {
				t.Fatal("AI阶段不产生人工待办")
			}
			if item, _, err := service.GetPersonalApproval(ctx, "writer", approval.RequestID); err != nil || item.CanProcess || item.CanRetryAI || item.WorkflowStage != "ai_pending" {
				t.Fatalf("上传者查看:%+v %v", item, err)
			}
			if _, _, err := service.GetPersonalApproval(ctx, "other", approval.RequestID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("无关账号看报告:%v", err)
			}
			if _, err := service.ListAIReviewTasks(ctx, "runner", "another-agent"); !errors.Is(err, ErrReviewForbidden) {
				t.Fatal("非全局Agent领取")
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID}); !errors.Is(err, ErrInvalidRequest) {
				t.Fatal("旧Worker缺少规则信息")
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)}); err != nil {
				t.Fatal(err)
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)}); !errors.Is(err, ErrConflict) {
				t.Fatal("重复领取")
			}
			timeout(approval.RequestID)
			if _, err := service.ManageAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "alice", "", false); !errors.Is(err, ErrReviewForbidden) {
				t.Fatal("审核人不能技术重试")
			}
			item, _, err := service.GetPersonalApproval(ctx, "writer", approval.RequestID)
			if err != nil || !item.CanRetryAI || item.CanProcess || item.WorkflowStage != "ai_failed" {
				t.Fatalf("超时上传者能力:%+v %v", item, err)
			}
			failedRuns, err := service.ListReviewWorkflowRuns(ctx, "writer", ReviewWorkflowQuery{Status: "error", Limit: 20})
			if err != nil || len(failedRuns) != 1 || failedRuns[0].RequestID != approval.RequestID {
				t.Fatalf("异常流程任务筛选:%+v %v", failedRuns, err)
			}
			retry, err := service.ManageAIReview(ctx, approval.RequestID, approval.AIReview.AttemptID, "writer", "", false)
			if err != nil || len(retry.Attempts) != 2 || retry.AgentID != "" {
				t.Fatalf("重试:%+v %v", retry, err)
			}
			if _, err := service.ManageAIReview(ctx, approval.RequestID, retry.AttemptID, "writer", "转人工", true); !errors.Is(err, ErrReviewForbidden) {
				t.Fatal("转人工必须关闭")
			}
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: retry.AttemptID, ReviewSkillVersion: "1.1.0", ReviewSkillSHA256: strings.Repeat("b", 64)}); err != nil {
				t.Fatal(err)
			}
			report := json.RawMessage(`{"conclusion":"recommend_approve","summary":"静态分析通过，二进制未读取","findings":[{"severity":"warning","message":"【结构审核】非阻断改善建议","path":"SKILL.md"}]}`)
			payload := AIReviewResultInput{AttemptID: retry.AttemptID, PackageSHA256: result.Version.PackageSHA256, Report: report}
			saved, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", payload)
			if err != nil || saved.Status != "completed" || saved.ReviewSkillVersion != "1.1.0" {
				t.Fatalf("完成:%+v %v", saved, err)
			}
			if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", payload); err != nil {
				t.Fatalf("结果幂等:%v", err)
			}
			changed := payload
			changed.Report = json.RawMessage(`{"conclusion":"needs_attention","summary":"需修改","findings":[]}`)
			if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", changed); !errors.Is(err, ErrConflict) {
				t.Fatal("不同结果不得覆写")
			}
			todo, err := service.ListPersonalApprovals(ctx, "alice", PersonalApprovalQuery{View: "todo", Limit: 20})
			if err != nil || len(todo) != 1 || !todo[0].CanProcess || todo[0].WorkflowStage != "human_pending" {
				t.Fatalf("通过后待办:%+v %v", todo, err)
			}
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", true, "", input); err != nil {
				t.Fatal(err)
			}
			if _, err := service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
				t.Fatal("部分通过不能发布")
			}
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "bob", true, "", input); err != nil {
				t.Fatal(err)
			}
			runs, err := service.ListReviewWorkflowRuns(ctx, "writer", ReviewWorkflowQuery{Stage: "approved", Status: "succeeded", Limit: 20})
			if err != nil || len(runs) != 1 || runs[0].ScoreTotal == nil || *runs[0].ScoreTotal != 20 {
				t.Fatalf("真实汇总:%+v %v", runs, err)
			}
			if _, err := service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); err != nil {
				t.Fatal(err)
			}
			next, nextApproval := aiTestUpload(t, service, "2")
			if next.Version.VersionID == result.Version.VersionID || nextApproval.AIReview.Status != "pending" {
				t.Fatal("新版本不复用旧报告")
			}
			if _, err := service.ClaimAIReview(ctx, nextApproval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: nextApproval.AIReview.AttemptID, ReviewSkillVersion: "1.1.0", ReviewSkillSHA256: strings.Repeat("b", 64)}); err != nil {
				t.Fatal(err)
			}
			bad := AIReviewResultInput{AttemptID: nextApproval.AIReview.AttemptID, PackageSHA256: next.Version.PackageSHA256, Report: json.RawMessage(`{"conclusion":"needs_attention","summary":"需要补充输入输出说明，静态分析","findings":[{"severity":"error","message":"【结构审核】缺少输入说明，请补充","path":"SKILL.md"}]}`)}
			if _, err := service.SubmitAIReviewResult(ctx, nextApproval.RequestID, "runner", "agent-review", bad); err != nil {
				t.Fatal(err)
			}
			item, _, err = service.GetPersonalApproval(ctx, "writer", nextApproval.RequestID)
			if err != nil || item.WorkflowStage != "revision_required" || item.CanProcess || item.CanRetryAI {
				t.Fatalf("需修改不得重跑:%+v %v", item, err)
			}
			revisionRuns, err := service.ListReviewWorkflowRuns(ctx, "writer", ReviewWorkflowQuery{Status: "revision_required", Limit: 20})
			if err != nil || len(revisionRuns) != 1 || revisionRuns[0].RequestID != nextApproval.RequestID {
				t.Fatalf("需修改流程任务筛选:%+v %v", revisionRuns, err)
			}
			if _, err := service.ManageAIReview(ctx, nextApproval.RequestID, bad.AttemptID, "writer", "", false); !errors.Is(err, ErrConflict) {
				t.Fatal("需修改不得刷结论")
			}
			if _, err := service.SetCurrentVersion(ctx, next.Skill.SkillID, next.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
				t.Fatal("需修改不可发布")
			}
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"alice"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			if _, err := service.SubmitAIReviewResult(ctx, nextApproval.RequestID, "runner", "agent-review", bad); !errors.Is(err, ErrConflict) {
				t.Fatal("失效轮次不得回传")
			}
		})
	}
}

func TestP9PublishedLegacyVersionReentersWorkflow(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, action := range []string{"unpublish", "replace"} {
			t.Run(fmt.Sprintf("postgres=%t/%s", postgres, action), func(t *testing.T) {
				ctx := context.Background()
				service, _, _ := aiTestService(t, postgres)
				result, approval := aiTestUpload(t, service, "1")
				// 模拟升级时保留的已发布旧轮次：人工已批准，旧 manual 不具备 P9 规则证据。
				switch store := service.store.(type) {
				case *MemoryStore:
					request := &store.localApprovals[result.Version.VersionID][0]
					request.Status = "approved"
					request.AIAttempts[0].Status = "manual"
					for id, decision := range request.Decisions {
						decision.Status, decision.Scores = "approved", manualTestScores(4, 4, 4, 4)
						request.Decisions[id] = decision
					}
					version := &store.versions[result.Skill.SkillID][0]
					version.ApprovalStatus, version.ApprovedSpaceID = "approved", DefaultSpaceID
					skill := store.skills[result.Skill.SkillID]
					skill.CurrentVersionID = &result.Version.VersionID
					store.skills[result.Skill.SkillID] = skill
				case *PostgresStore:
					for _, query := range []string{
						`UPDATE approval_requests SET status='approved' WHERE business_id=$1`,
						`UPDATE skill_ai_review_attempts SET status='manual' WHERE request_id=(SELECT id FROM approval_requests WHERE business_id=$1)`,
						`UPDATE approval_request_approvers SET status='approved',scenario_value=4,result_effectiveness=4,ease_of_use=4,reuse_value=4 WHERE request_id=(SELECT id FROM approval_requests WHERE business_id=$1)`,
						`UPDATE skill_versions SET approval_status='approved',approved_space_id='skillspace_default' WHERE version_id=$1`,
						`UPDATE skills SET current_version_id=$1 WHERE skill_id=(SELECT skill_id FROM skill_versions WHERE version_id=$1)`,
					} {
						if _, err := store.pool.Exec(ctx, query, result.Version.VersionID); err != nil {
							t.Fatal(err)
						}
					}
				}
				if _, err := service.GetPublished(ctx, result.Skill.SkillID); err != nil {
					t.Fatalf("历史已发布仍可用: %v", err)
				}
				if action == "replace" {
					next, _ := aiTestUpload(t, service, "2")
					input := reviewInputForTest(ctx, service, next.Skill.SkillID, next.Version.VersionID)
					for _, reviewer := range []string{"alice", "bob"} {
						if _, err := service.ReviewVersion(ctx, next.Skill.SkillID, next.Version.VersionID, reviewer, true, "", input); err != nil {
							t.Fatal(err)
						}
					}
					if _, err := service.SetCurrentVersion(ctx, next.Skill.SkillID, next.Version.VersionID); err != nil {
						t.Fatal(err)
					}
				} else if _, err := service.ClearCurrentVersion(ctx, result.Skill.SkillID); err != nil {
					t.Fatal(err)
				}
				detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
				if err != nil {
					t.Fatal(err)
				}
				for _, version := range detail.Versions {
					if version.VersionID == result.Version.VersionID && (version.ApprovalStatus != "pending" || version.LocalApproval == nil || version.LocalApproval.RequestID == approval.RequestID || version.LocalApproval.WorkflowStage != "ai_pending") {
						t.Fatalf("旧发布退出后应开启新AI轮次: %+v", version)
					}
				}
				if _, err := service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); !errors.Is(err, ErrApprovalRequired) {
					t.Fatalf("旧批准不能复用: %v", err)
				}
			})
		}
	}
}

func TestP9RejectedVersionRequiresNewUpload(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(fmt.Sprintf("postgres=%t", postgres), func(t *testing.T) {
			ctx := context.Background()
			service, _, _ := aiTestService(t, postgres)
			result, approval := aiTestUpload(t, service, "1")
			input := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", false, "修改后上传新版本", input); err != nil {
				t.Fatal(err)
			}
			for _, legacy := range []bool{false, true} {
				if legacy {
					switch store := service.store.(type) {
					case *MemoryStore:
						store.localApprovals[result.Version.VersionID][0].AIAttempts = nil
					case *PostgresStore:
						if _, err := store.pool.Exec(ctx, `DELETE FROM skill_ai_review_attempts WHERE request_id=$1`, approval.RequestID); err != nil {
							t.Fatal(err)
						}
					}
				}
				if _, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, approval.RequestID, "writer"); !errors.Is(err, ErrReviewForbidden) {
					t.Fatalf("原版本不可重提 legacy=%t: %v", legacy, err)
				}
				item, detail, err := service.GetPersonalApproval(ctx, "writer", approval.RequestID)
				if err != nil || item.Status != "rejected" || detail.Versions[0].LocalApproval.RequestID != approval.RequestID || detail.Versions[0].LocalApproval.Approvers[0].Comment != "修改后上传新版本" {
					t.Fatalf("保留驳回历史: %+v %v", item, err)
				}
			}
			_, next := aiTestUpload(t, service, "2")
			if next.RequestID == approval.RequestID || next.WorkflowStage != "ai_pending" {
				t.Fatal("修订上传必须创建新AI轮次")
			}
		})
	}
}

func TestP9ReportBlocksErrorsAndMissingRule(t *testing.T) {
	material := &AIReviewMaterials{Files: []AIReviewMaterialFile{{Path: "SKILL.md"}}}
	if _, err := validateAIReport([]byte(`{"conclusion":"recommend_approve","summary":"通过","findings":[{"severity":"error","message":"【基础安全】危险删除"}]}`), material); err == nil {
		t.Fatal("error不得通过")
	}
	if aiAllowsHuman(nil, time.Now()) || aiAllowsHuman([]AIReviewAttempt{{Status: "manual"}}, time.Now()) || aiAllowsHuman([]AIReviewAttempt{{Status: "completed", Report: &AIReviewReport{Conclusion: "recommend_approve"}}}, time.Now()) {
		t.Fatal("历史无规则报告不得通过")
	}
	service, _, _ := aiTestService(t, false)
	_, approval := aiTestUpload(t, service, "1")
	if _, err := service.ClaimAIReview(context.Background(), approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ErrorCode: "execution_failed"}); !errors.Is(err, ErrAIReviewFailed) {
		t.Fatal(err)
	}
	item, _, err := service.GetPersonalApproval(context.Background(), "writer", approval.RequestID)
	if err != nil || !item.CanRetryAI || item.WorkflowStage != "ai_failed" {
		t.Fatal("规则文件异常可重试")
	}
}

func TestP9FailureReplayAndLateResult(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(map[bool]string{false: "memory", true: "postgres"}[postgres], func(t *testing.T) {
			ctx := context.Background()
			service, expire, setAccount := aiTestService(t, postgres)
			for index, code := range []string{"execution_failed", "report_invalid", "timeout"} {
				result, approval := aiTestUpload(t, service, fmt.Sprint(index+1))
				_, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)})
				if err != nil {
					t.Fatal(err)
				}
				failure := AIReviewFailure
				payload := AIReviewResultInput{AttemptID: approval.AIReview.AttemptID, PackageSHA256: result.Version.PackageSHA256, Error: &failure, ErrorCode: code}
				if code == "report_invalid" {
					payload.Error = nil
					payload.Report = json.RawMessage(`{"conclusion":"recommend_approve","summary":"通过","findings":[{"severity":"error","message":"阻断"}]}`)
				}
				setAccount("disabled")
				if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", payload); !errors.Is(err, ErrReviewForbidden) {
					t.Fatalf("停用身份: %v", err)
				}
				setAccount("active")
				for range 2 {
					if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", payload); err != nil {
						t.Fatalf("%s 重传:%v", code, err)
					}
				}
				changed := payload
				changed.ErrorCode = "changed"
				if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", changed); !errors.Is(err, ErrConflict) {
					t.Fatalf("不同失败不得覆盖: %v", err)
				}
			}
			result, approval := aiTestUpload(t, service, "late")
			if _, err := service.ClaimAIReview(ctx, approval.RequestID, "runner", "agent-review", AIReviewClaimInput{AttemptID: approval.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)}); err != nil {
				t.Fatal(err)
			}
			expire(approval.RequestID)
			failure := AIReviewFailure
			if _, err := service.SubmitAIReviewResult(ctx, approval.RequestID, "runner", "agent-review", AIReviewResultInput{AttemptID: approval.AIReview.AttemptID, PackageSHA256: result.Version.PackageSHA256, Error: &failure, ErrorCode: "timeout"}); !errors.Is(err, ErrConflict) {
				t.Fatalf("兜底超时后的首次迟到回传: %v", err)
			}
		})
	}
}
