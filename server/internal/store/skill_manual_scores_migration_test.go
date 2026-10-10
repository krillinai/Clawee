package store

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func manualScoresForTest(scenario, result, ease, reuse int) *skillhub.ReviewScores {
	return &skillhub.ReviewScores{ScenarioValue: &scenario, ResultEffectiveness: &result, EaseOfUse: &ease, ReuseValue: &reuse}
}

func reviewInputForTest(ctx context.Context, service *skillhub.Service, skillID, versionID string) skillhub.ReviewInput {
	input := skillhub.ReviewInput{RequestID: "missing", Scores: manualScoresForTest(3, 3, 3, 3)}
	if detail, err := service.GetAdmin(ctx, skillID); err == nil {
		for _, version := range detail.Versions {
			if version.VersionID == versionID && version.LocalApproval != nil {
				input.RequestID = version.LocalApproval.RequestID
			}
		}
	}
	return input
}

func reviewVersionForTest(service *skillhub.Service, ctx context.Context, skillID, versionID, reviewer string, approve bool, comment string) (skillhub.Version, error) {
	return service.ReviewVersion(ctx, skillID, versionID, reviewer, approve, comment, reviewInputForTest(ctx, service, skillID, versionID))
}

func manualPostgresFixture(t *testing.T) (*pgxpool.Pool, *skillhub.Service, skillhub.MutationResult, skillhub.ReviewInput) {
	t.Helper()
	ctx := context.Background()
	pool, _ := skillRoleTestDatabase(t, 70)
	seedSkillRoleAccounts(t, pool)
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewPostgresStore(pool), PackageRoot: t.TempDir()})
	space, err := service.CreateSpace(ctx, "人工评分", "", "writer")
	if err != nil {
		t.Fatal(err)
	}
	grantSkillRole(t, pool, "read-only", space.SpaceID, "read")
	if _, err := service.SetSpaceApprovalSubjects(ctx, space.SpaceID, "local", "", []string{"alice", "carol"}, []string{"review-one", "review-two"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	result, err := service.UploadVersionForUser(ctx, "writer", "", skillhub.UploadVersionInput{SpaceID: space.SpaceID, Version: "1", CreatedBy: "writer", Origin: "app_upload", Package: bytes.NewReader(skillRolePackage(t))})
	if err != nil {
		t.Fatal(err)
	}
	return pool, service, result, reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
}

func TestSkillManualScoresSummaryOnPostgres(t *testing.T) {
	ctx := context.Background()
	_, service, result, input := manualPostgresFixture(t)
	for index, userID := range []string{"alice", "bob", "carol"} {
		value := 1
		if index == 2 {
			value = 2
		}
		input.Scores = manualScoresForTest(value, value, value, value)
		version, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, userID, true, "", input)
		if err != nil {
			t.Fatal(err)
		}
		if version.LocalApproval.Total != 3 {
			t.Fatal("角色重叠未去重")
		}
		if index < 2 && version.LocalApproval.ScoreSummary != nil {
			t.Fatal("pending 有汇总")
		}
		if index == 2 && (version.LocalApproval.ScoreSummary == nil || version.LocalApproval.ScoreSummary.Total != float64(16)/3) {
			t.Fatalf("总分精度: %#v", version.LocalApproval.ScoreSummary)
		}
		*input.Scores.ScenarioValue = 5
		for _, person := range version.LocalApproval.Approvers {
			if person.UserID == userID {
				*person.Scores.ScenarioValue = 5
			}
		}
	}
	detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	items, err := service.ListAdmin(ctx)
	if err != nil || !reflect.DeepEqual(items[0].LatestVersion.LocalApproval, detail.Versions[0].LocalApproval) {
		t.Fatalf("读取映射或存储被篡改: %v", err)
	}
	for _, person := range detail.Versions[0].LocalApproval.Approvers {
		if person.UserID == "alice" && *person.Scores.ScenarioValue != 1 {
			t.Fatal("输入或返回指针污染存储")
		}
	}
}

func TestSkillManualScoresLegacyOnPostgres(t *testing.T) {
	ctx := context.Background()
	for _, mode := range []string{"approved_missing", "approved_complete", "reject_empty", "reject_partial", "unsupported"} {
		t.Run(mode, func(t *testing.T) {
			pool, service, result, input := manualPostgresFixture(t)
			execSkillRoleSQL(t, pool, `UPDATE approval_requests SET scoring_standard_version=NULL WHERE id=$1`, input.RequestID)
			if mode == "unsupported" {
				execSkillRoleSQL(t, pool, `UPDATE approval_requests SET scoring_standard_version='future-v2' WHERE id=$1`, input.RequestID)
			}
			before, err := service.GetAdmin(ctx, result.Skill.SkillID)
			if err != nil || before.Versions[0].LocalApproval.ScoringStandardVersion != map[bool]string{true: "future-v2", false: ""}[mode == "unsupported"] {
				t.Fatalf("读取绑定标准: %v", err)
			}
			if mode == "approved_missing" {
				execSkillRoleSQL(t, pool, `UPDATE approval_request_approvers SET status='approved',decided_at=now() WHERE request_id=$1 AND user_id='alice'`, input.RequestID)
			}
			if mode == "reject_empty" || mode == "reject_partial" {
				input.Scores = nil
				if mode == "reject_partial" {
					input.Scores = &skillhub.ReviewScores{EaseOfUse: manualScoresForTest(1, 1, 1, 1).EaseOfUse}
				}
				version, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "bob", false, "修订", input)
				if err != nil || version.LocalApproval.ScoreSummary != nil || (version.LocalApproval.ScoringStandardVersion == "manual-v1") != (mode == "reject_partial") {
					t.Fatalf("旧驳回标准: %#v %v", version.LocalApproval, err)
				}
				return
			}
			if mode == "unsupported" {
				if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "bob", true, "", input); !errors.Is(err, skillhub.ErrConflict) {
					t.Fatalf("未知标准: %v", err)
				}
				var std string
				if err := pool.QueryRow(ctx, `SELECT scoring_standard_version FROM approval_requests WHERE id=$1`, input.RequestID).Scan(&std); err != nil || std != "future-v2" {
					t.Fatalf("标准覆盖: %s %v", std, err)
				}
				return
			}
			users := []string{"alice", "bob", "carol"}
			if mode == "approved_missing" {
				users = users[1:]
			}
			var version skillhub.Version
			for _, id := range users {
				version, err = service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, id, true, "", input)
				if err != nil {
					t.Fatal(err)
				}
			}
			if version.LocalApproval.ScoringStandardVersion != "manual-v1" || (version.LocalApproval.ScoreSummary == nil) != (mode == "approved_missing") {
				t.Fatalf("旧分值汇总: %#v", version.LocalApproval)
			}
		})
	}
}

func TestSkillManualScoresResubmitConcurrencyOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool, service, result, input := manualPostgresFixture(t)
	input.Scores = &skillhub.ReviewScores{ReuseValue: manualScoresForTest(1, 1, 1, 5).ReuseValue}
	if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", false, "需修订", input); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, input.RequestID, "alice"); !errors.Is(err, skillhub.ErrReviewForbidden) {
		t.Fatalf("非作者重提: %v", err)
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
		} else if !errors.Is(err, skillhub.ErrConflict) {
			t.Fatal(err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("并发重提成功 %d", succeeded)
	}
	var status, comment string
	var score int
	if err := pool.QueryRow(ctx, `SELECT r.status,a.comment,a.reuse_value FROM approval_requests r JOIN approval_request_approvers a ON a.request_id=r.id WHERE r.id=$1 AND a.user_id='alice'`, input.RequestID).Scan(&status, &comment, &score); err != nil || status != "rejected" || comment != "需修订" || score != 5 {
		t.Fatalf("历史保留: %s %s %d %v", status, comment, score, err)
	}
	input.Scores = manualScoresForTest(5, 5, 5, 5)
	if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "bob", true, "", input); !errors.Is(err, skillhub.ErrConflict) {
		t.Fatalf("迟到旧决策: %v", err)
	}
	current := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
	detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
	if err != nil || current.RequestID == input.RequestID || detail.Versions[0].LocalApproval.ScoringStandardVersion != "manual-v1" {
		t.Fatalf("新轮绑定: %v", err)
	}
	for _, person := range detail.Versions[0].LocalApproval.Approvers {
		if person.Scores != nil || person.Status != "pending" {
			t.Fatal("新轮复制分值")
		}
	}
}

func TestSkillManualScoresMigrationAndRollbackOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool, provider := skillRoleTestDatabase(t, 68)
	seedSkillRoleAccounts(t, pool)
	execSkillRoleSQL(t, pool, `INSERT INTO approval_requests(id,business_type,business_id,action,scope_type,scope_id,content_digest,status,created_at,finished_at) VALUES('old','skill_version','old-v','publish','skill_space','skillspace_default','digest','approved',now(),now()); INSERT INTO approval_request_approvers(request_id,user_id,status,comment,decided_at) VALUES('old','alice','approved','历史意见',now())`)
	var original string
	var originalRequest string
	if err := pool.QueryRow(ctx, `SELECT row_to_json(r)::text FROM approval_requests r WHERE id='old'`).Scan(&originalRequest); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT row_to_json(a)::text FROM approval_request_approvers a WHERE request_id='old'`).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 69); err != nil {
		t.Fatal(err)
	}
	var untouched bool
	if err := pool.QueryRow(ctx, `SELECT r.scoring_standard_version IS NULL AND a.scenario_value IS NULL AND a.result_effectiveness IS NULL AND a.ease_of_use IS NULL AND a.reuse_value IS NULL FROM approval_requests r JOIN approval_request_approvers a ON a.request_id=r.id WHERE r.id='old'`).Scan(&untouched); err != nil || !untouched {
		t.Fatalf("迁移回填历史: %v", err)
	}
	for _, column := range []string{"scenario_value", "result_effectiveness", "ease_of_use", "reuse_value"} {
		for _, value := range []int{0, 6} {
			if _, err := pool.Exec(ctx, `UPDATE approval_request_approvers SET `+column+`=$1 WHERE request_id='old'`, value); err == nil {
				t.Fatalf("约束缺失: %s %d", column, value)
			}
		}
	}
	if _, err := provider.DownTo(ctx, 68); err != nil {
		t.Fatal(err)
	}
	var restored string
	if err := pool.QueryRow(ctx, `SELECT row_to_json(a)::text FROM approval_request_approvers a WHERE request_id='old'`).Scan(&restored); err != nil || restored != original {
		t.Fatalf("回退改变历史: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT row_to_json(r)::text FROM approval_requests r WHERE id='old'`).Scan(&restored); err != nil || restored != originalRequest {
		t.Fatalf("回退改变历史请求: %v", err)
	}
	if _, err := provider.UpTo(ctx, 69); err != nil {
		t.Fatal(err)
	}
}

func TestSkillManualScoresRequestAndPermissionBindingOnPostgres(t *testing.T) {
	ctx := context.Background()
	for _, mode := range []string{"missing_request", "other_version", "digest", "space", "outsider", "disabled", "read_revoked", "invalidated", "approve_missing"} {
		t.Run(mode, func(t *testing.T) {
			pool, service, result, input := manualPostgresFixture(t)
			reviewer := "bob"
			originalRequestID := input.RequestID
			want := skillhub.ErrConflict
			switch mode {
			case "missing_request":
				input.RequestID = ""
				want = skillhub.ErrInvalidRequest
			case "other_version":
				input.RequestID = "other-version-request"
			case "digest":
				execSkillRoleSQL(t, pool, `UPDATE skill_versions SET package_sha256=repeat('e',64) WHERE version_id=$1`, result.Version.VersionID)
			case "space":
				execSkillRoleSQL(t, pool, `UPDATE approval_requests SET scope_id='other-space' WHERE id=$1`, input.RequestID)
			case "outsider":
				reviewer = "writer"
				want = skillhub.ErrReviewForbidden
			case "disabled":
				execSkillRoleSQL(t, pool, `UPDATE accounts SET status='disabled' WHERE user_id='bob'`)
				want = skillhub.ErrReviewForbidden
			case "read_revoked":
				execSkillRoleSQL(t, pool, `DELETE FROM data_resource_role_grants WHERE role_id='read-only' AND resource_id=$1`, result.Skill.SpaceID)
				want = skillhub.ErrReviewForbidden
			case "invalidated":
				execSkillRoleSQL(t, pool, `UPDATE approval_requests SET status='invalidated' WHERE id=$1`, input.RequestID)
			case "approve_missing":
				input.Scores = nil
				want = skillhub.ErrInvalidRequest
			}
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, reviewer, true, "", input); !errors.Is(err, want) {
				t.Fatalf("绑定边界错误: %v，预期 %v", err, want)
			}
			var status string
			var value *int
			if err := pool.QueryRow(ctx, `SELECT status,scenario_value FROM approval_request_approvers WHERE request_id=$1 AND user_id='bob'`, originalRequestID).Scan(&status, &value); err != nil || status != "pending" || value != nil {
				t.Fatalf("拒绝后污染评分: %v", err)
			}
		})
	}
}

func TestSkillManualScoresResubmitGuardsOnPostgres(t *testing.T) {
	ctx := context.Background()
	for _, mode := range []string{"pending", "approved", "invalidated", "old_request", "published", "source", "disabled", "read_revoked", "empty_role"} {
		t.Run(mode, func(t *testing.T) {
			pool, service, result, input := manualPostgresFixture(t)
			if mode != "pending" {
				if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", false, "需修订", input); err != nil {
					t.Fatal(err)
				}
			}
			want := skillhub.ErrConflict
			switch mode {
			case "approved":
				execSkillRoleSQL(t, pool, `UPDATE approval_requests SET status='approved' WHERE id=$1`, input.RequestID)
			case "invalidated":
				execSkillRoleSQL(t, pool, `UPDATE approval_requests SET status='invalidated' WHERE id=$1`, input.RequestID)
			case "old_request":
				input.RequestID = "old-request"
			case "published":
				execSkillRoleSQL(t, pool, `UPDATE skills SET current_version_id=$2 WHERE skill_id=$1`, result.Skill.SkillID, result.Version.VersionID)
			case "source":
				execSkillRoleSQL(t, pool, `INSERT INTO skill_sources(source_id,provider,repository_owner,repository_name,branch,schedule,status,created_by,created_at,updated_at) VALUES('source','github','owner','repo','main','manual','active','writer',now(),now())`)
				execSkillRoleSQL(t, pool, `UPDATE skill_versions SET source_id='source',source_path='skills/example',source_commit_sha=repeat('a',40),source_content_sha256=repeat('b',64) WHERE version_id=$1`, result.Version.VersionID)
				want = skillhub.ErrReviewForbidden
			case "disabled":
				execSkillRoleSQL(t, pool, `UPDATE accounts SET status='disabled' WHERE user_id='writer'`)
				want = skillhub.ErrReviewForbidden
			case "read_revoked":
				execSkillRoleSQL(t, pool, `DELETE FROM data_resource_grants WHERE user_id='writer' AND resource_type='skill_space' AND resource_id=$1 AND action='read'`, result.Skill.SpaceID)
				want = skillhub.ErrReviewForbidden
			case "empty_role":
				execSkillRoleSQL(t, pool, `DELETE FROM approval_config_approvers WHERE scope_type='skill_space' AND scope_id=$1`, result.Skill.SpaceID)
				execSkillRoleSQL(t, pool, `DELETE FROM account_roles WHERE role_id IN ('review-one','review-two')`)
				want = skillhub.ErrMemberNotFound
			}
			if _, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, input.RequestID, "writer"); !errors.Is(err, want) {
				t.Fatalf("重提边界: %v，预期 %v", err, want)
			}
			var count int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_requests WHERE business_type='skill_version' AND business_id=$1`, result.Version.VersionID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("失败创建新请求: %d %v", count, err)
			}
		})
	}
}

func TestSkillManualScoresConcurrentVotesOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool, service, result, input := manualPostgresFixture(t)
	var wait sync.WaitGroup
	errorsCh := make(chan error, 12)
	for _, userID := range []string{"alice", "bob", "carol"} {
		for index := 0; index < 4; index++ {
			wait.Add(1)
			go func(id string) {
				defer wait.Done()
				_, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, id, true, "", input)
				errorsCh <- err
			}(userID)
		}
	}
	wait.Wait()
	close(errorsCh)
	succeeded := 0
	for err := range errorsCh {
		if err == nil {
			succeeded++
		} else if !errors.Is(err, skillhub.ErrConflict) {
			t.Fatal(err)
		}
	}
	if succeeded != 3 {
		t.Fatalf("并发审批成功 %d", succeeded)
	}
	var approved int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_requests WHERE business_id=$1 AND status='approved' AND finished_at IS NOT NULL`, result.Version.VersionID).Scan(&approved); err != nil || approved != 1 {
		t.Fatalf("请求完成次数 %d %v", approved, err)
	}
	detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
	if err != nil || detail.Versions[0].LocalApproval.ScoreSummary == nil || detail.Versions[0].LocalApproval.ScoreSummary.Total != 12 {
		t.Fatalf("并发汇总: %v", err)
	}
}

func TestSkillManualScoresResubmitUsesCurrentRoleMembersOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool, service, result, input := manualPostgresFixture(t)
	if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "alice", false, "需要修订", input); err != nil {
		t.Fatal(err)
	}
	execSkillRoleSQL(t, pool, `DELETE FROM account_roles WHERE user_id='bob' AND role_id IN ('review-one','review-two');
INSERT INTO account_roles(user_id,role_id,created_at) VALUES('carol','review-one',now()),('carol','review-two',now())`)
	version, err := service.ResubmitReview(ctx, result.Skill.SkillID, result.Version.VersionID, input.RequestID, "writer")
	if err != nil || version.LocalApproval.Total != 2 || version.LocalApproval.ScoringStandardVersion != "manual-v1" {
		t.Fatalf("重提未重新展开去重角色: %#v %v", version.LocalApproval, err)
	}
	for _, person := range version.LocalApproval.Approvers {
		if person.UserID == "bob" || person.Scores != nil || person.Status != "pending" {
			t.Fatal("新名单借用旧记录")
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM approval_request_approvers WHERE request_id=$1`, input.RequestID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("旧名单被覆盖: %d %v", count, err)
	}
}
