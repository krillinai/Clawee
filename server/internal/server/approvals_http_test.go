package server_test

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
	"github.com/krillinai/Clawee/server/internal/workflow"
)

func TestApprovalCenterHTTPEmptyAndValidation(t *testing.T) {
	accountsService, rbacService := newJWTAccountAndRBAC(t)
	router := newTestRouter(t, server.Options{AccountService: accountsService, RBACService: rbacService})
	cookies := register(t, router, `{"email":"approvals@example.com","password":"passw0rd!"}`)
	response := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=todo", "", cookies, http.StatusOK)
	if len(response["data"].([]any)) != 0 || response["meta"].(map[string]any)["has_next"] != false {
		t.Fatalf("未配置业务应为空页: %#v", response)
	}
	for _, query := range []string{"view=unknown", "view=todo&type=agent", "view=todo&status=completed", "view=todo&limit=0", "view=todo&limit=51", "view=todo&cursor=broken"} {
		doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?"+query, "", cookies, http.StatusBadRequest)
	}
	doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=todo", "", nil, http.StatusUnauthorized)
}

func TestApprovalCenterHTTPMixedPagingPermissionsAndDecisions(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testpostgres.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	accountsService, rbacService := newJWTAccountAndRBAC(t)
	now := time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)
	skills := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir(), Clock: func() time.Time { return now }})
	flows := &workflow.Service{DB: pool}
	router := newTestRouter(t, server.Options{AccountService: accountsService, RBACService: rbacService, SkillHubService: skills, WorkflowService: flows, ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore())})
	cookies := make(map[string][]*http.Cookie)
	ids := make(map[string]string)
	for _, user := range []string{"writer", "reviewer", "outsider"} {
		cookies[user] = register(t, router, `{"email":"`+user+`@center.test","password":"passw0rd!"}`)
		ids[user] = nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", cookies[user], http.StatusOK), "data", "account", "user_id")
		if _, err := pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES($1,$2,$3,'test','active',now(),now())`, ids[user], user+"@center.test", user); err != nil {
			t.Fatal(err)
		}
		if _, err := skills.SetSpaceMember(ctx, skillhub.DefaultSpaceID, ids[user], []string{skillhub.SpaceActionRead}, ids["writer"], false); err != nil {
			t.Fatal(err)
		}
	}
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"approval_center_reader","name":"审批评分","permission_codes":["console:skill:read"]}`, cookies["writer"], http.StatusCreated)
	roleID := nestedString(t, role, "data", "role_id")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+ids["reviewer"]+`","role_id":"`+roleID+`"}`, cookies["writer"], http.StatusCreated)
	cookies["reviewer"] = loginCookies(t, router, `{"email":"reviewer@center.test","password":"passw0rd!"}`)
	if _, err := skills.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{ids["writer"], ids["reviewer"]}, true, ids["writer"]); err != nil {
		t.Fatal(err)
	}
	var version skillhub.MutationResult
	for index := range 6 {
		version, err = skills.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", CreatedBy: ids["writer"], UploadedByUserID: ids["writer"], Origin: "admin_upload", Package: bytes.NewReader(skillPackageNamed(t, fmt.Sprintf("center-%d", index)))})
		if err != nil {
			t.Fatal(err)
		}
	}
	template, err := flows.Save(ctx, ids["writer"], "", "人工流程", "", 0, []workflow.Node{{ID: "approval", Type: "approval", Title: "共同审批", AssigneeUsers: []string{ids["writer"], ids["reviewer"], ids["outsider"]}, Instruction: "审批"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := flows.SetStatus(ctx, template.ID, ids["writer"], true); err != nil {
		t.Fatal(err)
	}
	var started workflow.Result
	for index := range 4 {
		started, err = flows.Start(ctx, template.ID, ids["writer"], fmt.Sprintf("start-%d", index), nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []string{`UPDATE workflow_node_tasks SET created_at=$1`, `UPDATE workflow_instances SET started_at=$1`} {
		if _, err := pool.Exec(ctx, statement, now); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	cursor, firstCursor := "", ""
	previousKind, previousID := "", ""
	for {
		response := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=todo&limit=3&cursor="+url.QueryEscape(cursor), "", cookies["reviewer"], http.StatusOK)
		items := response["data"].([]any)
		for _, raw := range items {
			item := raw.(map[string]any)
			kind, id := item["kind"].(string), item["id"].(string)
			if seen[id] || (previousKind != "" && (kind > previousKind || (kind == previousKind && id >= previousID))) {
				t.Fatal("混合同时间分页不稳定或重复", item)
			}
			seen[id], previousKind, previousID = true, kind, id
		}
		meta := response["meta"].(map[string]any)
		cursor = meta["next_cursor"].(string)
		if firstCursor == "" {
			firstCursor = cursor
		}
		if !meta["has_next"].(bool) {
			break
		}
		if len(items) != 3 || cursor == "" {
			t.Fatal("有后页时不能因过滤缺页", response)
		}
	}
	if len(seen) != 10 {
		t.Fatalf("混合分页遗漏: %d", len(seen))
	}
	for _, suffix := range []string{"view=done", "view=todo&type=skill", "view=todo&status=running"} {
		doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?"+suffix+"&cursor="+url.QueryEscape(firstCursor), "", cookies["reviewer"], http.StatusBadRequest)
	}
	doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=todo&cursor="+url.QueryEscape(firstCursor), "", cookies["outsider"], http.StatusBadRequest)
	for _, user := range []string{"reviewer", "outsider"} {
		response := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=todo&type=workflow", "", cookies[user], http.StatusOK)
		if len(response["data"].([]any)) != 4 {
			t.Fatal("workflow 本人查询不能要求管理员读权限", response)
		}
	}
	input := skillReviewInputForTest(ctx, skills, version.Skill.SkillID, version.Version.VersionID)
	skillPath := "/api/v1/app/approvals/skill/" + input.RequestID
	detail := doJSON(t, router, http.MethodGet, skillPath, "", cookies["reviewer"], http.StatusOK)
	if len(detail["data"].(map[string]any)["skill"].(map[string]any)["versions"].([]any)) != 1 {
		t.Fatal("详情只能包含目标版本")
	}
	doJSON(t, router, http.MethodGet, skillPath, "", cookies["outsider"], http.StatusForbidden)
	doJSON(t, router, http.MethodGet, skillPath+"/files", "", cookies["reviewer"], http.StatusOK)
	doJSON(t, router, http.MethodGet, skillPath+"/file?path=SKILL.md", "", cookies["reviewer"], http.StatusOK)
	for _, body := range []string{`{"decision":"approved"}`, `{"decision":"approve"}`, `{"decision":"rejected","comment":" "}`, `{"decision":"approved","user_id":"forged"}`, `{"decision":"approved","scores":{"scenario_value":1,"result_effectiveness":2,"ease_of_use":3,"reuse_value":6}}`} {
		doJSON(t, router, http.MethodPost, skillPath+"/decision", body, cookies["reviewer"], http.StatusBadRequest)
	}
	body := `{"decision":"approved","comment":"有效评分","scores":{"scenario_value":1,"result_effectiveness":2,"ease_of_use":3,"reuse_value":4}}`
	doJSON(t, router, http.MethodPost, skillPath+"/decision", body, cookies["outsider"], http.StatusForbidden)
	doJSON(t, router, http.MethodPost, skillPath+"/decision", body, cookies["reviewer"], http.StatusOK)
	doJSON(t, router, http.MethodPost, skillPath+"/decision", body, cookies["reviewer"], http.StatusConflict)
	done := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=done&type=skill", "", cookies["reviewer"], http.StatusOK)["data"].([]any)
	if len(done) != 1 || done[0].(map[string]any)["business_status"] != "pending" || done[0].(map[string]any)["my_status"] != "approved" {
		t.Fatal("本人已评分不能冒充整单完成", done)
	}
	doJSON(t, router, http.MethodGet, "/api/v1/app/approvals/workflow/"+started.TaskID, "", cookies["outsider"], http.StatusOK)
	doJSON(t, router, http.MethodPost, "/api/v1/app/workflow-tasks/"+started.TaskID+"/decision", `{"decision":"approve","comment":"通过","idempotency_key":"center"}`, cookies["outsider"], http.StatusOK)
	doJSON(t, router, http.MethodPost, "/api/v1/app/workflow-tasks/"+started.TaskID+"/decision", `{"decision":"approve","comment":"通过","idempotency_key":"center"}`, cookies["outsider"], http.StatusOK)
	if response := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=done&type=workflow", "", cookies["reviewer"], http.StatusOK); len(response["data"].([]any)) != 0 {
		t.Fatal("共享候选不能冒领别人已办")
	}
	if response := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=done&type=workflow", "", cookies["outsider"], http.StatusOK); len(response["data"].([]any)) != 1 {
		t.Fatal("已办真实处理人")
	}
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles/remove", `{"user_id":"`+ids["reviewer"]+`","role_id":"`+roleID+`"}`, cookies["writer"], http.StatusNoContent)
	doJSON(t, router, http.MethodGet, skillPath, "", cookies["reviewer"], http.StatusForbidden)
	doJSON(t, router, http.MethodGet, skillPath+"/files", "", cookies["reviewer"], http.StatusForbidden)
	doJSON(t, router, http.MethodPost, skillPath+"/decision", body, cookies["reviewer"], http.StatusForbidden)
	response := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals?view=todo&limit=3", "", cookies["reviewer"], http.StatusOK)
	if len(response["data"].([]any)) != 3 || response["meta"].(map[string]any)["has_next"] != false {
		t.Fatal("功能撤权后先过滤再分页", response)
	}
	for _, raw := range response["data"].([]any) {
		if raw.(map[string]any)["type"] != "workflow" {
			t.Fatal("撤权 Skill 应完全消失")
		}
	}
}
