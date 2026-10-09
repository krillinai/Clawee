package skillhub

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
)

func TestApprovalLegacyFilesRejectCrossSpaceRequest(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"reviewer"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	result, err := service.UploadVersion(ctx, UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("cross-space")}}))})
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	skill := store.skills[result.Skill.SkillID]
	skill.SpaceID = "target"
	store.skills[skill.SkillID] = skill
	store.spaces["target"] = Space{SpaceID: "target", Name: "目标空间", ApprovalProvider: "local"}
	store.grants["reader"] = map[string]map[string]bool{"target": {SpaceActionRead: true}}
	store.mu.Unlock()
	if _, err := service.GetApprovalDetailForUser(ctx, "reader", skill.SkillID); err != nil {
		t.Fatalf("复现前提：目标空间本身可读: %v", err)
	}
	if _, err := service.ListVersionFiles(ctx, skill.SkillID, result.Version.VersionID); err != nil {
		t.Fatalf("复现前提：旧实现接续读取内容可成功: %v", err)
	}
	if _, err := service.ListApprovalVersionFilesForUser(ctx, "reader", skill.SkillID, result.Version.VersionID); err == nil {
		t.Fatal("旧文件接口不应只凭目标空间读取权限暴露原审批内容")
	}
}

func personalApprovalFixture(t *testing.T, backend string) (*Service, *MemoryStore, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	var store Store
	var memory *MemoryStore
	var pool *pgxpool.Pool
	if backend == "memory" {
		memory = NewMemoryStore()
		store = memory
	} else {
		var err error
		pool, err = pgxpool.New(ctx, testpostgres.New(t))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		for _, user := range []string{"writer", "alice", "bob", "other"} {
			if _, err := pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES($1,$1||'@approvals.test',$1,'test','active',now(),now())`, user); err != nil {
				t.Fatal(err)
			}
		}
		store = NewPostgresStore(pool)
	}
	now := time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)
	service := NewService(Config{Store: store, PackageRoot: t.TempDir(), Clock: func() time.Time { return now }})
	for _, user := range []string{"writer", "alice", "bob", "other"} {
		if _, err := service.SetSpaceMember(ctx, DefaultSpaceID, user, []string{SpaceActionRead}, "writer", false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"alice", "bob"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	return service, memory, pool
}

func personalUpload(t *testing.T, service *Service, name, number string) MutationResult {
	t.Helper()
	result, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: number, CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD(name)}}))})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestPersonalApprovalStoreHistoryAndPermissions(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, memory, pool := personalApprovalFixture(t, backend)
			ctx := context.Background()
			result := personalUpload(t, service, "history-rounds", "1")
			input := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
			list := func(user, view string) []PersonalApproval {
				t.Helper()
				items, err := service.ListPersonalApprovals(ctx, user, PersonalApprovalQuery{View: view, Status: "all", Limit: 20})
				if err != nil {
					t.Fatal(err)
				}
				return items
			}
			if items := list("alice", "todo"); len(items) != 1 || !items[0].CanProcess || items[0].RequestID != input.RequestID {
				t.Fatalf("初始待办: %#v", items)
			}
			if len(list("other", "todo")) != 0 || len(list("other", "initiated")) != 0 {
				t.Fatal("无关账户不应有本人归属")
			}
			if _, _, err := service.GetPersonalApproval(ctx, "other", input.RequestID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("无关详情: %v", err)
			}
			if _, err := service.ListApprovalRequestFiles(ctx, "alice", input.RequestID); err != nil {
				t.Fatal(err)
			}
			if _, err := service.ReadApprovalRequestFile(ctx, "alice", input.RequestID, "../SKILL.md"); !errors.Is(err, ErrInvalidRequest) {
				t.Fatal(err)
			}
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", true, "首轮已评分", input); err != nil {
				t.Fatal(err)
			}
			if items := list("alice", "done"); len(items) != 1 || items[0].Status != "pending" || items[0].MyStatus != "approved" || items[0].ActedAt == nil || items[0].CanProcess {
				t.Fatalf("个人完成与整单状态必须分开: %#v", items)
			}
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "bob", false, "首轮驳回", input); err != nil {
				t.Fatal(err)
			}
			service.clock = func() time.Time { return time.Date(2026, 10, 9, 8, 0, 1, 0, time.UTC) }
			if _, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, input.RequestID, "writer"); err != nil {
				t.Fatal(err)
			}
			newInput := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
			if input.RequestID == newInput.RequestID {
				t.Fatal("重提必须是新轮次")
			}
			personalUpload(t, service, "history-rounds", "2")
			item, detail, err := service.GetPersonalApproval(ctx, "alice", input.RequestID)
			if err != nil || item.Status != "rejected" || len(detail.Versions) != 1 || detail.Versions[0].VersionID != result.Version.VersionID || detail.Versions[0].LocalApproval.RequestID != input.RequestID || detail.Versions[0].LocalApproval.ScoreSummary != nil || detail.Skill.LatestVersion != nil {
				t.Fatalf("精确旧轮次不得取最新版本冒充: %#v %#v %v", item, detail, err)
			}
			if items := list("alice", "done"); len(items) != 1 || items[0].RequestID != input.RequestID {
				t.Fatalf("失效轮次应留在已办: %#v", items)
			}
			if len(list("writer", "initiated")) != 3 {
				t.Fatal("我发起按审核轮次列出")
			}
			if _, err := service.ListApprovalRequestFiles(ctx, "alice", input.RequestID); err != nil {
				t.Fatalf("同摘要的驳回历史仍可读取: %v", err)
			}
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", true, "迟到", input); !errors.Is(err, ErrConflict) {
				t.Fatalf("迟到轮次: %v", err)
			}
			if err := service.RemoveSpaceMember(ctx, DefaultSpaceID, "alice"); err != nil {
				t.Fatal(err)
			}
			if len(list("alice", "done")) != 0 || len(list("alice", "todo")) != 0 {
				t.Fatal("撤权先于分页过滤")
			}
			if _, _, err := service.GetPersonalApproval(ctx, "alice", input.RequestID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("撤权详情: %v", err)
			}
			if _, err := service.ListApprovalRequestFiles(ctx, "alice", newInput.RequestID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("撤权文件: %v", err)
			}
			if _, err := service.SetSpaceMember(ctx, DefaultSpaceID, "alice", []string{SpaceActionRead}, "writer", false); err != nil {
				t.Fatal(err)
			}
			if memory != nil {
				memory.mu.Lock()
				for index := range memory.versions[result.Skill.SkillID] {
					memory.versions[result.Skill.SkillID][index].PackageSHA256 = "changed"
				}
				memory.mu.Unlock()
			} else if _, err := pool.Exec(ctx, `UPDATE skill_versions SET package_sha256='changed' WHERE skill_id=$1`, result.Skill.SkillID); err != nil {
				t.Fatal(err)
			}
			_, detail, err = service.GetPersonalApproval(ctx, "alice", newInput.RequestID)
			if err != nil || detail.Versions[0].Description != "" || detail.Versions[0].PackagePath != "" || detail.CanReview {
				t.Fatalf("摘要变更只保留审核元数据: %#v %v", detail, err)
			}
			if len(list("alice", "todo")) != 0 {
				t.Fatal("摘要变更不能仍列为待办")
			}
			if _, err := service.ListApprovalRequestFiles(ctx, "alice", newInput.RequestID); !errors.Is(err, ErrConflict) {
				t.Fatalf("新文件摘要冲突: %v", err)
			}
			if _, err := service.ListApprovalVersionFilesForUser(ctx, "alice", result.Skill.SkillID, result.Version.VersionID); !errors.Is(err, ErrConflict) {
				t.Fatalf("旧文件摘要冲突: %v", err)
			}
		})
	}
}

func TestPersonalApprovalStablePagingAndPackageDigest(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, _, _ := personalApprovalFixture(t, backend)
			ctx := context.Background()
			var first MutationResult
			for index := range 7 {
				first = personalUpload(t, service, fmt.Sprintf("stable-%d", index), "1")
			}
			query := PersonalApprovalQuery{View: "todo", Status: "all", Limit: 2}
			seen := map[string]bool{}
			for {
				items, err := service.ListPersonalApprovals(ctx, "alice", query)
				if err != nil {
					t.Fatal(err)
				}
				if len(items) == 0 {
					break
				}
				for _, item := range items {
					if seen[item.RequestID] {
						t.Fatal("同时间分页重复")
					}
					seen[item.RequestID] = true
				}
				last := items[len(items)-1]
				query.BeforeTime, query.BeforeKind, query.BeforeID = last.CreatedAt, "skill", last.RequestID
			}
			if len(seen) != 7 {
				t.Fatalf("同时间分页遗漏: %d", len(seen))
			}
			input := reviewInputForTest(ctx, service, first.Skill.SkillID, first.Version.VersionID)
			if err := os.WriteFile(filepath.Join(service.packageRoot, first.Version.PackagePath), []byte("替换内容"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := service.OpenApprovalRequestPackage(ctx, "alice", input.RequestID); !errors.Is(err, ErrConflict) {
				t.Fatalf("磁盘包内容摘要必须匹配: %v", err)
			}
		})
	}
}

func TestPersonalApprovalOriginalSpaceAndLegacyNull(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, memory, pool := personalApprovalFixture(t, backend)
			ctx := context.Background()
			result := personalUpload(t, service, "original-space", "1")
			input := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", true, "历史评分", input); err != nil {
				t.Fatal(err)
			}
			if memory != nil {
				memory.mu.Lock()
				request := &memory.localApprovals[result.Version.VersionID][0]
				request.ScoringStandardVersion, request.Status = "", "invalidated"
				decision := request.Decisions["alice"]
				decision.Scores = nil
				request.Decisions["alice"] = decision
				memory.mu.Unlock()
			} else {
				if _, err := pool.Exec(ctx, `UPDATE approval_requests SET scoring_standard_version=NULL,status='invalidated' WHERE id=$1`, input.RequestID); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(ctx, `UPDATE approval_request_approvers SET scenario_value=NULL,result_effectiveness=NULL,ease_of_use=NULL,reuse_value=NULL WHERE request_id=$1`, input.RequestID); err != nil {
					t.Fatal(err)
				}
			}
			item, detail, err := service.GetPersonalApproval(ctx, "alice", input.RequestID)
			if err != nil || item.Status != "invalidated" || detail.Versions[0].LocalApproval.ScoringStandardVersion != "" || detail.Versions[0].LocalApproval.ScoreSummary != nil {
				t.Fatalf("失效与历史 NULL 不得补造: %#v %v", detail, err)
			}
			for _, decision := range detail.Versions[0].LocalApproval.Approvers {
				if decision.Scores != nil {
					t.Fatal("历史评分 NULL 被补造")
				}
			}
			items, err := service.ListPersonalApprovals(ctx, "alice", PersonalApprovalQuery{View: "done", Status: "invalidated", Limit: 1})
			if err != nil || len(items) != 1 {
				t.Fatalf("失效轮次已办: %#v %v", items, err)
			}
			if _, err := service.ListApprovalRequestFiles(ctx, "alice", input.RequestID); !errors.Is(err, ErrConflict) {
				t.Fatal("失效文件绑定应冲突", err)
			}
			target, err := service.CreateSpace(ctx, "目标审批空间", "", "writer")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.SetSpaceMember(ctx, target.SpaceID, "alice", []string{SpaceActionRead}, "writer", false); err != nil {
				t.Fatal(err)
			}
			if memory != nil {
				memory.mu.Lock()
				skill := memory.skills[result.Skill.SkillID]
				skill.SpaceID = target.SpaceID
				memory.skills[skill.SkillID] = skill
				memory.mu.Unlock()
			} else if _, err := pool.Exec(ctx, `UPDATE skills SET space_id=$1 WHERE skill_id=$2`, target.SpaceID, result.Skill.SkillID); err != nil {
				t.Fatal(err)
			}
			_, detail, err = service.GetPersonalApproval(ctx, "alice", input.RequestID)
			if err != nil || detail.Versions[0].Description != "" || detail.Skill.Description != "" || detail.CanReview {
				t.Fatalf("跨空间仅有双空间权限时保留审核元数据: %#v %v", detail, err)
			}
			if err := service.RemoveSpaceMember(ctx, DefaultSpaceID, "alice"); err != nil {
				t.Fatal(err)
			}
			if _, _, err := service.GetPersonalApproval(ctx, "alice", input.RequestID); !errors.Is(err, ErrNotFound) {
				t.Fatal("只读目标空间不能读原轮次", err)
			}
			if _, err := service.ListApprovalVersionFilesForUser(ctx, "alice", result.Skill.SkillID, result.Version.VersionID); !errors.Is(err, ErrConflict) {
				t.Fatal("旧文件入口不得绕过原空间绑定", err)
			}
		})
	}
}

func TestPersonalApprovalFilterBeforeLimitAndMissingUploader(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, memory, pool := personalApprovalFixture(t, backend)
			ctx := context.Background()
			visible := personalUpload(t, service, "visible", "1")
			hidden, err := service.CreateSpace(ctx, "不可读空间", "", "writer")
			if err != nil {
				t.Fatal(err)
			}
			service.clock = func() time.Time { return time.Date(2026, 10, 9, 8, 0, 2, 0, time.UTC) }
			for index := range 5 {
				result := personalUpload(t, service, fmt.Sprintf("hidden-%d", index), "1")
				if memory != nil {
					memory.mu.Lock()
					skill := memory.skills[result.Skill.SkillID]
					skill.SpaceID = hidden.SpaceID
					memory.skills[skill.SkillID] = skill
					memory.mu.Unlock()
				} else if _, err := pool.Exec(ctx, `UPDATE skills SET space_id=$1 WHERE skill_id=$2`, hidden.SpaceID, result.Skill.SkillID); err != nil {
					t.Fatal(err)
				}
			}
			items, err := service.ListPersonalApprovals(ctx, "alice", PersonalApprovalQuery{View: "todo", Status: "pending", Limit: 1})
			if err != nil || len(items) != 1 || items[0].VersionID != visible.Version.VersionID {
				t.Fatalf("不能先取 limit 再过滤不可读资源: %#v %v", items, err)
			}
			if memory != nil {
				memory.mu.Lock()
				for skillID, versions := range memory.versions {
					for index := range versions {
						versions[index].UploadedByUserID = ""
					}
					memory.versions[skillID] = versions
				}
				memory.mu.Unlock()
			} else if _, err := pool.Exec(ctx, `UPDATE skill_versions SET uploaded_by_user_id=NULL`); err != nil {
				t.Fatal(err)
			}
			items, err = service.ListPersonalApprovals(ctx, "writer", PersonalApprovalQuery{View: "initiated", Status: "all", Limit: 20})
			if err != nil || len(items) != 0 {
				t.Fatalf("上传人 NULL 不能拿 created_by 冒充: %#v %v", items, err)
			}
		})
	}
}

func TestApprovalLegacyFilesKeepCurrentProviderBinding(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, _, _ := personalApprovalFixture(t, backend)
			ctx := context.Background()
			result := personalUpload(t, service, "provider-binding", "1")
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "dingtalk", "PROC", nil, true, "writer"); err != nil {
				t.Fatal(err)
			}
			approval, _, _, err := service.BeginApproval(ctx, result.Skill.SkillID, result.Version.VersionID, "writer", "external-writer", false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.ListApprovalVersionFilesForUser(ctx, "writer", result.Skill.SkillID, result.Version.VersionID); err != nil {
				t.Fatalf("本地旧轮失效不能阻断有效钉钉申请的既有文件入口: %v", err)
			}
			if _, err := service.FinishSubmission(ctx, approval.ID, "remote", "running"); err != nil {
				t.Fatal(err)
			}
			if err := service.ApplyApprovalResult(ctx, "remote", "PROC", "finish", "refuse"); err != nil {
				t.Fatal(err)
			}
			service.clock = func() time.Time { return time.Date(2026, 10, 9, 8, 0, 3, 0, time.UTC) }
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"alice", "bob"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			if _, err := service.ListApprovalVersionFilesForUser(ctx, "alice", result.Skill.SkillID, result.Version.VersionID); err != nil {
				t.Fatalf("钉钉旧轮失效不能阻断有效本地轮次的既有文件入口: %v", err)
			}
		})
	}
}
