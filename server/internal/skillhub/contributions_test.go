package skillhub

import (
	"context"
	"encoding/csv"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestContributionsFirstApprovalSnapshotsAndDeletion(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, memory, pool := personalApprovalFixture(t, backend)
			ctx := context.Background()
			now := time.Date(2026, 1, 31, 16, 0, 0, 0, time.UTC)
			service.clock = func() time.Time { return now }
			coverage := now.AddDate(0, -1, 0)
			if memory != nil {
				memory.contributionStartedAt = coverage
			} else if _, err := pool.Exec(ctx, `UPDATE skill_contribution_coverage SET started_at=$1`, coverage); err != nil {
				t.Fatal(err)
			}
			first := personalUpload(t, service, "contribution-test", "1")
			if pool != nil {
				if _, err := pool.Exec(ctx, `UPDATE employee_ai_activity_facts SET occurred_at=$1 WHERE source_event_key=$2`, now.Add(-time.Second), first.Version.VersionID); err != nil {
					t.Fatal(err)
				}
			} else {
				memory.contributionUploads[0].OccurredAt = now.Add(-time.Second)
			}
			input := reviewInputForTest(ctx, service, first.Skill.SkillID, first.Version.VersionID)
			input.Scores = manualTestScores(5, 5, 5, 5)
			if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "alice", true, "=SUM(A1)", input); err != nil {
				t.Fatal(err)
			}
			partial, err := service.Contributions(ctx, ContributionQuery{StartDate: "2026-02-01", EndDate: "2026-02-28"}, true, false)
			if err != nil || partial.Summary.FirstApprovals != 0 {
				t.Fatalf("部分通过不计入: %#v %v", partial, err)
			}
			input.Scores = manualTestScores(3, 3, 3, 3)
			if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "bob", true, "同意", input); err != nil {
				t.Fatal(err)
			}
			row, _, err := service.store.(ContributionStore).ContributionDetail(ctx, first.Skill.SkillID, "")
			if err != nil || row.Scores == nil || row.Scores.Total != 16 || row.EmployeeID != "writer" || row.VersionID != first.Version.VersionID {
				t.Fatalf("首次通过快照: %#v %v", row, err)
			}
			row.Scores.Total = 1
			now = now.AddDate(0, 1, 0)
			second := personalUpload(t, service, "contribution-test", "2")
			input = reviewInputForTest(ctx, service, second.Skill.SkillID, second.Version.VersionID)
			input.Scores = manualTestScores(5, 5, 5, 5)
			for _, user := range []string{"alice", "bob"} {
				if _, err := service.ReviewVersion(ctx, second.Skill.SkillID, second.Version.VersionID, user, true, "", input); err != nil {
					t.Fatal(err)
				}
			}
			february := ContributionQuery{StartDate: "2026-02-01", EndDate: "2026-02-28", Report: "first_approvals", PageSize: 1}
			result, err := service.Contributions(ctx, february, false, false)
			if err != nil || result.Total != 1 || result.Items.([]ContributionRecord)[0].Scores.Total != 16 {
				t.Fatalf("版本更新不能覆盖快照: %#v %v", result, err)
			}
			threshold := 16.0001
			february.MinTotalScore = &threshold
			filtered, err := service.Contributions(ctx, february, false, false)
			if err != nil || filtered.Total != 0 {
				t.Fatal("阈值必须使用未舍入分数", err)
			}
			original := result.Items.([]ContributionRecord)[0]
			assertSnapshotUnchanged := func(stage string) {
				t.Helper()
				current, _, err := service.store.(ContributionStore).ContributionDetail(ctx, first.Skill.SkillID, "")
				if err != nil || !reflect.DeepEqual(current, original) {
					t.Fatalf("%s改变首次通过快照: got=%#v want=%#v err=%v", stage, current, original, err)
				}
			}
			target, err := service.CreateSpace(ctx, "贡献移空间测试", "", "writer")
			if err != nil {
				t.Fatal(err)
			}
			for _, user := range []string{"alice", "bob"} {
				if _, err := service.SetSpaceMember(ctx, target.SpaceID, user, []string{SpaceActionRead}, "writer", false); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := service.SetSpaceApprovers(ctx, target.SpaceID, "local", "", []string{"alice"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			moved, err := service.MoveSkillsToSpace(ctx, []string{first.Skill.SkillID}, target.SpaceID)
			if err != nil || moved.MovedCount != 1 {
				t.Fatalf("移空间失败: %#v %v", moved, err)
			}
			assertSnapshotUnchanged("移空间")
			previous := reviewInputForTest(ctx, service, first.Skill.SkillID, first.Version.VersionID)
			affected, err := service.SetSpaceApprovers(ctx, target.SpaceID, "local", "", []string{"bob"}, true, "writer")
			if err != nil || affected == 0 {
				t.Fatalf("审核设置未重置版本: affected=%d err=%v", affected, err)
			}
			assertSnapshotUnchanged("变更审核设置")
			input = reviewInputForTest(ctx, service, first.Skill.SkillID, first.Version.VersionID)
			if input.RequestID == previous.RequestID {
				t.Fatal("变更审核设置后未创建新审核")
			}
			input.Scores = manualTestScores(1, 1, 1, 1)
			if _, err := service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "bob", true, "重新审核", input); err != nil {
				t.Fatal(err)
			}
			assertSnapshotUnchanged("目标空间重新通过")
			march, err := service.Contributions(ctx, ContributionQuery{StartDate: "2026-03-01", EndDate: "2026-03-31"}, true, false)
			if err != nil || march.Summary.FirstApprovals != 0 {
				t.Fatalf("再次通过不能成为新贡献: %#v %v", march, err)
			}
			january, err := service.Contributions(ctx, ContributionQuery{StartDate: "2026-01-01", EndDate: "2026-01-31"}, true, false)
			if err != nil || january.Summary.Uploads != 1 || january.Summary.FirstApprovals != 0 {
				t.Fatalf("上传/通过跨月: %#v %v", january, err)
			}
			if _, err := service.store.DeleteUnpublished(ctx, first.Skill.SkillID); err != nil {
				t.Fatal(err)
			}
			after, err := service.ContributionDetail(ctx, first.Skill.SkillID, "")
			if err != nil || after.Items.([]ContributionRecord)[0].EntityAvailable || after.Items.([]ContributionRecord)[0].Scores.Total != 16 {
				t.Fatalf("删除后保留快照: %#v %v", after, err)
			}
			upload, err := service.ContributionDetail(ctx, "", first.Version.VersionID)
			if err != nil || upload.Items.([]ContributionRecord)[0].Status != nil || upload.Items.([]ContributionRecord)[0].Scores != nil || upload.Items.([]ContributionRecord)[0].Version == nil {
				t.Fatalf("删除后上传事实保留: %#v %v", upload, err)
			}
		})
	}
}

func TestContributionsHistoryAndExternalApproval(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, memory, pool := personalApprovalFixture(t, backend)
			ctx := context.Background()
			now := time.Now().UTC().Add(time.Minute)
			service.clock = func() time.Time { return now }
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "dingtalk", "template", nil, true, "writer"); err != nil {
				t.Fatal(err)
			}
			result := personalUpload(t, service, "external-contribution", "1")
			instance, _, _, err := service.store.(ExternalApprovalStore).BeginApproval(ctx, result.Skill.SkillID, result.Version.VersionID, "writer", "external-writer", now)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = service.store.(ExternalApprovalStore).FinishSubmission(ctx, instance.ID, "provider", "running", now); err != nil {
				t.Fatal(err)
			}
			for count := 0; count < 2; count++ {
				if err = service.store.(ExternalApprovalStore).ApplyApprovalResult(ctx, "provider", "template", "finish", "agree", now); err != nil {
					t.Fatal(err)
				}
			}
			detail, err := service.ContributionDetail(ctx, result.Skill.SkillID, "")
			if err != nil || detail.Items.([]ContributionRecord)[0].Scores != nil || detail.Items.([]ContributionRecord)[0].Source != "dingtalk" {
				t.Fatalf("外部通过及幂等: %#v %v", detail, err)
			}
			old := personalUpload(t, service, "old-contribution", "1")
			if memory != nil {
				skill := memory.skills[old.Skill.SkillID]
				skill.CreatedAt = memory.contributionStartedAt.Add(-time.Hour)
				memory.skills[skill.SkillID] = skill
			} else if _, err = pool.Exec(ctx, `UPDATE skills SET created_at=(SELECT started_at-interval '1 hour' FROM skill_contribution_coverage) WHERE skill_id=$1`, old.Skill.SkillID); err != nil {
				t.Fatal(err)
			}
			instance, _, _, err = service.store.(ExternalApprovalStore).BeginApproval(ctx, old.Skill.SkillID, old.Version.VersionID, "writer", "external-writer", now)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = service.store.(ExternalApprovalStore).FinishSubmission(ctx, instance.ID, "old-provider", "running", now); err != nil {
				t.Fatal(err)
			}
			if err = service.store.(ExternalApprovalStore).ApplyApprovalResult(ctx, "old-provider", "template", "finish", "agree", now); err != nil {
				t.Fatal(err)
			}
			if _, err = service.ContributionDetail(ctx, old.Skill.SkillID, ""); !errors.Is(err, ErrNotFound) {
				t.Fatal("历史不确定不能作为新贡献", err)
			}
			upload, err := service.ContributionDetail(ctx, "", old.Version.VersionID)
			if err != nil || upload.Items.([]ContributionRecord)[0].HistoryStatus != "unknown" {
				t.Fatal("旧记录仍需显示历史不确定", err)
			}
		})
	}
}

func TestContributionsConcurrentVersions(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			service, memory, pool := personalApprovalFixture(t, backend)
			ctx := context.Background()
			now := time.Now().UTC().Add(time.Minute)
			service.clock = func() time.Time { return now }
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"alice"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			first := personalUpload(t, service, "concurrent-contribution", "1")
			second := personalUpload(t, service, "concurrent-contribution", "2")
			var group sync.WaitGroup
			for _, result := range []MutationResult{first, second} {
				input := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
				group.Add(1)
				go func() {
					defer group.Done()
					if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", true, "", input); err != nil {
						t.Error(err)
					}
				}()
			}
			group.Wait()
			if memory != nil {
				if len(memory.firstApprovals) != 1 {
					t.Fatal("并发版本重复记录")
				}
			} else {
				var count int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM skill_first_approvals`).Scan(&count); err != nil || count != 1 {
					t.Fatal("并发版本重复记录", err)
				}
			}
		})
	}
}

func TestContributionsFullAggregationAndCSV(t *testing.T) {
	store := NewMemoryStore()
	stamp := time.Now().UTC()
	for index := 0; index < 101; index++ {
		id := newID("version")
		store.contributionUploads = append(store.contributionUploads, ContributionRecord{ID: id, EmployeeID: "same-id", EmployeeName: "=SUM(A1)", SkillID: id, SkillName: " +CMD()", VersionID: id, OccurredAt: stamp})
	}
	store.contributionUploads = append(store.contributionUploads, ContributionRecord{ID: "other", EmployeeID: "different-id", EmployeeName: "=SUM(A1)", SkillID: "other", VersionID: "other", OccurredAt: stamp})
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	date := stamp.In(mustContributionLocation()).Format(time.DateOnly)
	query := ContributionQuery{StartDate: date, EndDate: date, Report: "uploads", PageSize: 1}
	list, err := service.Contributions(context.Background(), query, false, false)
	if err != nil || list.Total != 102 || len(list.Items.([]ContributionRecord)) != 1 {
		t.Fatal("分页与全量不一致", err)
	}
	employeeQuery := query
	employeeQuery.Report = "employees"
	employeeQuery.PageSize = 0
	employees, err := service.Contributions(context.Background(), employeeQuery, false, true)
	if err != nil || employees.Total != 2 {
		t.Fatal("同名员工合并", err)
	}
	query.PageSize = 0
	all, err := service.Contributions(context.Background(), query, false, true)
	if err != nil {
		t.Fatal(err)
	}
	body, err := ContributionCSV(all)
	if err != nil || !strings.HasPrefix(string(body), "\xef\xbb\xbf") {
		t.Fatal("CSV必须UTF8 BOM", err)
	}
	rows, err := csv.NewReader(strings.NewReader(string(body[3:]))).ReadAll()
	if err != nil || len(rows) != 103 || rows[1][1] != "'=SUM(A1)" {
		t.Fatal("CSV全量或公式防护失败", err)
	}
	for len(store.contributionUploads) < 10001 {
		store.contributionUploads = append(store.contributionUploads, store.contributionUploads[0])
	}
	if _, err = service.Contributions(context.Background(), query, false, true); !errors.Is(err, ErrContributionLimit) {
		t.Fatal("不得静默截断", err)
	}
}

func mustContributionLocation() *time.Location {
	location, _ := time.LoadLocation(ContributionTimezone)
	return location
}

func TestContributionConditions(t *testing.T) {
	score := 16.0
	for _, query := range []ContributionQuery{
		{StartDate: "2026-02-30", EndDate: "2026-03-01"},
		{StartDate: "2026-02-01", EndDate: "2026-01-01"},
		{Report: "employees", MinTotalScore: &score},
		{Report: "employees", Status: "approved"},
		{Report: "rankings"}, {PageSize: 101}, {Page: -1},
	} {
		if _, err := NormalizeContributionQuery(query, false); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("非法参数未拒绝: %#v", query)
		}
	}
	if _, err := NormalizeContributionQuery(ContributionQuery{MinTotalScore: &score}, true); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("概览不接受分数")
	}
}
