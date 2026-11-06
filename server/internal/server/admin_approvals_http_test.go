package server_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
	"github.com/krillinai/Clawee/server/internal/workflow"
)

func TestAdminApprovalHTTPAIRetryCapabilities(t *testing.T) {
	ctx := context.Background()
	accountsService, rbacService := newJWTAccountAndRBAC(t)
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir(), ReviewAgentID: "test-review-agent"})
	router := newTestRouter(t, server.Options{AccountService: accountsService, RBACService: rbacService, SkillHubService: service})
	admin := register(t, router, `{"email":"retry-admin@test.invalid","password":"passw0rd!"}`)
	adminID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", admin, http.StatusOK), "data", "account", "user_id")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"retry_reader","name":"审批查看","permission_codes":["console:skill:read"]}`, admin, http.StatusCreated)
	type actor struct {
		name     string
		id       string
		cookies  []*http.Cookie
		canRetry bool
	}
	actors := []actor{{name: "admin", id: adminID, cookies: admin, canRetry: true}}
	for _, name := range []string{"uploader", "reader"} {
		body := `{"email":"retry-` + name + `@test.invalid","password":"passw0rd!"}`
		cookies := register(t, router, body)
		id := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", cookies, http.StatusOK), "data", "account", "user_id")
		doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+id+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, admin, http.StatusCreated)
		actors = append(actors, actor{name, id, loginCookies(t, router, body), name == "uploader"})
	}
	for _, actor := range actors {
		if _, err := service.SetSpaceMember(ctx, skillhub.DefaultSpaceID, actor.id, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, adminID, false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{adminID}, true, adminID); err != nil {
		t.Fatal(err)
	}
	result, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", CreatedBy: actors[1].id, UploadedByUserID: actors[1].id, Origin: "admin_upload", Package: bytes.NewReader(skillPackageNamed(t, "retry-capabilities"))})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	progress := detail.Versions[0].LocalApproval
	service.SetAIReviewIdentityLookup(func(context.Context, string, string) error { return nil })
	if _, err := service.ClaimAIReview(ctx, progress.RequestID, adminID, "test-review-agent", skillhub.AIReviewClaimInput{AttemptID: progress.AIReview.AttemptID, ReviewSkillVersion: "1.0.0", ReviewSkillSHA256: strings.Repeat("a", 64)}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SubmitAIReviewResult(ctx, progress.RequestID, adminID, "test-review-agent", skillhub.AIReviewResultInput{AttemptID: progress.AIReview.AttemptID, PackageSHA256: result.Version.PackageSHA256, Report: json.RawMessage(`{"conclusion":"invalid"}`)}); err != nil {
		t.Fatal(err)
	}
	check := func(failed bool) {
		t.Helper()
		for _, actor := range actors {
			page := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?type=skill", "", actor.cookies, http.StatusOK)
			items := page["data"].([]any)
			if len(items) != 1 {
				t.Fatal(page)
			}
			data := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals/skill/"+progress.RequestID, "", actor.cookies, http.StatusOK)["data"].(map[string]any)
			local := data["skill"].(map[string]any)["versions"].([]any)[0].(map[string]any)["local_approval"].(map[string]any)
			for _, item := range []map[string]any{items[0].(map[string]any), data["item"].(map[string]any), local} {
				if item["can_retry_ai"] != (failed && actor.canRetry) {
					t.Fatalf("%s 列表和详情的重试权限应一致: %+v", actor.name, item)
				}
			}
		}
	}
	check(true)
	doJSON(t, router, http.MethodPost, "/api/v1/app/approvals/skill/"+progress.RequestID+"/ai-review/retry", `{"attempt_id":"`+progress.AIReview.AttemptID+`"}`, actors[1].cookies, http.StatusOK)
	check(false)
}

func TestAdminApprovalHTTPAuthorizationValidationAndEmpty(t *testing.T) {
	accountsService, rbacService := newJWTAccountAndRBAC(t)
	router := newTestRouter(t, server.Options{AccountService: accountsService, RBACService: rbacService})
	admin := register(t, router, `{"email":"approval-admin@test.invalid","password":"passw0rd!"}`)
	user := register(t, router, `{"email":"approval-user@test.invalid","password":"passw0rd!"}`)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals", "", nil, http.StatusUnauthorized)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals", "", user, http.StatusUnauthorized)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals/summary", "", user, http.StatusUnauthorized)
	page := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals", "", admin, http.StatusOK)
	if len(page["data"].([]any)) != 0 {
		t.Fatal(page)
	}
	summary := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals/summary", "", admin, http.StatusOK)
	if summary["data"].(map[string]any)["total"] != float64(0) {
		t.Fatal(summary)
	}
	for _, query := range []string{"view=todo", "type=agent", "status=completed", "channel=unknown", "limit=51", "cursor=broken", "from=2026-10-10", "from=2026-10-11T00:00:00Z&until=2026-10-10T00:00:00Z"} {
		doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?"+query, "", admin, http.StatusBadRequest)
	}
	doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals/unknown/id", "", admin, http.StatusBadRequest)
}

func TestAdminApprovalHTTPMixedPagingAndDomainPermissions(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testpostgres.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	accountsService, rbacService := newJWTAccountAndRBAC(t)
	at := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
	skills := newTestSkillHubService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir(), Clock: func() time.Time { return at }})
	flows := testWorkflowService(t, pool)
	router := newTestRouter(t, server.Options{AccountService: accountsService, RBACService: rbacService, SkillHubService: skills, WorkflowService: flows})
	admin := register(t, router, `{"email":"mixed-admin@test.invalid","password":"passw0rd!"}`)
	adminID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", admin, http.StatusOK), "data", "account", "user_id")
	if _, err = pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES($1,'mixed@test.invalid','混合管理员','test','active',now(),now())`, adminID); err != nil {
		t.Fatal(err)
	}
	if _, err = skills.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{adminID}, true, adminID); err != nil {
		t.Fatal(err)
	}
	template, err := flows.Save(ctx, adminID, "", "混合审批", "", 0, []workflow.Node{{ID: "review", Type: "approval", Title: "人工审批", Assignee: adminID, Instruction: "核对"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = flows.SetStatus(ctx, template.ID, adminID, true); err != nil {
		t.Fatal(err)
	}
	var started workflow.Result
	for index := range 3 {
		if _, err = skills.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", CreatedBy: adminID, UploadedByUserID: adminID, Origin: "admin_upload", Package: bytes.NewReader(skillPackageNamed(t, fmt.Sprintf("mixed-%d", index)))}); err != nil {
			t.Fatal(err)
		}
		started, err = flows.Start(ctx, template.ID, adminID, fmt.Sprintf("start-%d", index), nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `UPDATE workflow_instances SET started_at=$1`, at); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?limit=2&cursor="+url.QueryEscape(cursor), "", admin, http.StatusOK)
		for _, raw := range page["data"].([]any) {
			item := raw.(map[string]any)
			id := item["kind"].(string) + ":" + item["id"].(string)
			if seen[id] {
				t.Fatal("混合分页重复", id)
			}
			seen[id] = true
		}
		meta := page["meta"].(map[string]any)
		if !meta["has_next"].(bool) {
			break
		}
		cursor = meta["next_cursor"].(string)
	}
	if len(seen) != 6 {
		t.Fatal("混合分页遗漏", len(seen))
	}
	summary := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals/summary", "", admin, http.StatusOK)["data"].(map[string]any)
	if summary["total"] != float64(6) || summary["pending"] != float64(6) {
		t.Fatal(summary)
	}
	detailPath := "/api/v1/admin/approvals/workflow_instance/" + started.InstanceID
	detail := doJSON(t, router, http.MethodGet, detailPath, "", admin, http.StatusOK)["data"].(map[string]any)
	if detail["actions"].(map[string]any)["terminate"] != true || detail["item"].(map[string]any)["can_process"] != true {
		t.Fatal(detail)
	}
	reader := register(t, router, `{"email":"mixed-reader@test.invalid","password":"passw0rd!"}`)
	readerID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", reader, http.StatusOK), "data", "account", "user_id")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"mixed_skill_reader","name":"技能查看","permission_codes":["console:skill:read"]}`, admin, http.StatusCreated)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+readerID+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, admin, http.StatusCreated)
	reader = loginCookies(t, router, `{"email":"mixed-reader@test.invalid","password":"passw0rd!"}`)
	page := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?limit=2", "", reader, http.StatusOK)
	if len(page["data"].([]any)) != 2 || !page["meta"].(map[string]any)["has_next"].(bool) {
		t.Fatal("先过滤领域再分页", page)
	}
	summary = doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals/summary", "", reader, http.StatusOK)["data"].(map[string]any)
	if summary["total"] != float64(3) {
		t.Fatal("统计不能泄露工作流记录", summary)
	}
	doJSON(t, router, http.MethodGet, detailPath, "", reader, http.StatusForbidden)
}

func TestAdminApprovalHTTPScopeDetailFilesAndCursor(t *testing.T) {
	ctx := context.Background()
	accountsService, rbacService := newJWTAccountAndRBAC(t)
	skills := newTestSkillHubService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{AccountService: accountsService, RBACService: rbacService, SkillHubService: skills})
	admin := register(t, router, `{"email":"approval-owner@test.invalid","password":"passw0rd!"}`)
	adminID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", admin, http.StatusOK), "data", "account", "user_id")
	reader := register(t, router, `{"email":"approval-reader@test.invalid","password":"passw0rd!"}`)
	readerID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", reader, http.StatusOK), "data", "account", "user_id")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"approval_reader","name":"审批查看","permission_codes":["console:skill:read"]}`, admin, http.StatusCreated)
	roleID := nestedString(t, role, "data", "role_id")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+readerID+`","role_id":"`+roleID+`"}`, admin, http.StatusCreated)
	reader = loginCookies(t, router, `{"email":"approval-reader@test.invalid","password":"passw0rd!"}`)
	if _, err := skills.SetSpaceMember(ctx, skillhub.DefaultSpaceID, adminID, []string{skillhub.SpaceActionRead}, adminID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := skills.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{adminID}, true, adminID); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"approval-admin-first", "approval-admin-second"} {
		if _, err := skills.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", CreatedBy: adminID, UploadedByUserID: adminID, Origin: "admin_upload", Package: bytes.NewReader(skillPackageNamed(t, name))}); err != nil {
			t.Fatal(err)
		}
	}
	if page := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals", "", reader, http.StatusOK); len(page["data"].([]any)) != 0 {
		t.Fatal("功能权限不能代替空间权限", page)
	}
	if _, err := skills.SetSpaceMember(ctx, skillhub.DefaultSpaceID, readerID, []string{skillhub.SpaceActionRead}, adminID, false); err != nil {
		t.Fatal(err)
	}
	page := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?limit=1", "", reader, http.StatusOK)
	item := page["data"].([]any)[0].(map[string]any)
	path := "/api/v1/admin/approvals/skill/" + item["id"].(string)
	detail := doJSON(t, router, http.MethodGet, path, "", reader, http.StatusOK)["data"].(map[string]any)
	if detail["item"].(map[string]any)["can_process"] != false || len(detail["skill"].(map[string]any)["versions"].([]any)) != 1 {
		t.Fatal("管理员只获得查看资格", detail)
	}
	doJSON(t, router, http.MethodGet, path+"/files", "", reader, http.StatusOK)
	doJSON(t, router, http.MethodGet, path+"/file?path=SKILL.md", "", reader, http.StatusOK)
	doJSON(t, router, http.MethodGet, path+"/file?path=../SKILL.md", "", reader, http.StatusBadRequest)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals/workflow_instance/private", "", reader, http.StatusForbidden)
	cursor := page["meta"].(map[string]any)["next_cursor"].(string)
	if cursor == "" {
		t.Fatal("应有下一页")
	}
	second := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?limit=1&cursor="+url.QueryEscape(cursor), "", reader, http.StatusOK)
	if len(second["data"].([]any)) != 1 || second["data"].([]any)[0].(map[string]any)["id"] == item["id"] {
		t.Fatal(second)
	}
	for _, query := range []string{"view=closed", "type=skill", "q=changed", "channel=local", "status=pending", "space_id=other"} {
		doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?"+query+"&cursor="+url.QueryEscape(cursor), "", reader, http.StatusBadRequest)
	}
	doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?cursor="+url.QueryEscape(cursor), "", admin, http.StatusBadRequest)
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err = json.Unmarshal(decoded, &raw); err != nil {
		t.Fatal(err)
	}
	raw["extra"] = "forged"
	encoded, _ := json.Marshal(raw)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals?cursor="+url.QueryEscape(base64.RawURLEncoding.EncodeToString(encoded)), "", reader, http.StatusBadRequest)
	if err = skills.RemoveSpaceMember(ctx, skillhub.DefaultSpaceID, readerID); err != nil {
		t.Fatal(err)
	}
	doJSON(t, router, http.MethodGet, path, "", reader, http.StatusNotFound)
	doJSON(t, router, http.MethodGet, path+"/files", "", reader, http.StatusNotFound)
	doJSON(t, router, http.MethodGet, path+"/package", "", reader, http.StatusNotFound)
	summary := doJSON(t, router, http.MethodGet, "/api/v1/admin/approvals/summary", "", reader, http.StatusOK)
	if summary["data"].(map[string]any)["total"] != float64(0) {
		t.Fatal("统计不能泄露撤权数据", summary)
	}
}
