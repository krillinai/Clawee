package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestSkillAIReviewHTTPBoundSessionAndP9Gates(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir(), ReviewAgentID: "ai-review-agent"})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(newClaweeOwnedAgentStore(accountService)), AccountService: accountService, RBACService: rbacService, SkillHubService: service})
	writer := register(t, router, `{"email":"ai-writer@example.com","password":"passw0rd!"}`)
	writerID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", writer, http.StatusOK), "data", "account", "user_id")
	runnerCookies := register(t, router, `{"email":"ai-runner@example.com","password":"passw0rd!"}`)
	runnerID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", runnerCookies, http.StatusOK), "data", "account", "user_id")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"ai_runner","name":"AI执行者","permission_codes":["console:skill:read"]}`, writer, http.StatusCreated)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+runnerID+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, writer, http.StatusCreated)
	login := loginClawee(t, router, "ai-runner@example.com", "passw0rd!", "ai-review-agent")
	otherLogin := loginClawee(t, router, "ai-runner@example.com", "passw0rd!", "other-review-agent")
	if login.Status != http.StatusOK || otherLogin.Status != http.StatusOK || login.AgentID == "" || otherLogin.AgentID == "" {
		t.Fatal("执行端登录失败")
	}
	for _, id := range []string{writerID, runnerID} {
		if _, err := service.SetSpaceMember(ctx, skillhub.DefaultSpaceID, id, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, writerID, false); err != nil {
			t.Fatal(err)
		}
	}
	configPath := "/api/v1/admin/skill-spaces/" + skillhub.DefaultSpaceID + "/ai-review"
	doJSON(t, router, http.MethodPut, configPath, `{"enabled":true,"agent_id":"`+login.AgentID+`"}`, writer, http.StatusForbidden)
	if _, err := service.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{writerID}, true, writerID); err != nil {
		t.Fatal(err)
	}
	doJSON(t, router, http.MethodPut, configPath, `{"enabled":true,"agent_id":"missing-agent"}`, writer, http.StatusForbidden)
	doJSON(t, router, http.MethodPut, configPath, `{"enabled":true,"agent_id":"`+login.AgentID+`"}`, runnerCookies, http.StatusUnauthorized)

	result, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", CreatedBy: writerID, UploadedByUserID: writerID, Origin: "admin_upload", Package: bytes.NewReader(skillPackageNamed(t, "ai-http"))})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := service.GetAdmin(ctx, result.Skill.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	input := skillhub.ReviewInput{RequestID: stored.Versions[0].LocalApproval.RequestID}
	detail := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals/skill/"+input.RequestID, "", writer, http.StatusOK)
	data := detail["data"].(map[string]any)
	if data["item"].(map[string]any)["can_process"].(bool) {
		t.Fatal("AI未通过时不可人工处理")
	}
	approval := data["skill"].(map[string]any)["versions"].([]any)[0].(map[string]any)["local_approval"].(map[string]any)
	ai := approval["ai_review"].(map[string]any)
	attempt := ai["attempt_id"].(string)
	if ai["status"] != "pending" || ai["agent_id"] != "" {
		t.Fatal("详情 AI 契约")
	}
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", `{"skill_id":"`+result.Skill.SkillID+`","version_id":"`+result.Version.VersionID+`","request_id":"`+input.RequestID+`","decision":"approved","scores":{"scenario_value":3,"result_effectiveness":3,"ease_of_use":3,"reuse_value":3}}`, writer, http.StatusConflict)
	doJSON(t, router, http.MethodPost, "/api/v1/app/approvals/skill/"+input.RequestID+"/decision", `{"decision":"approved","scores":{"scenario_value":3,"result_effectiveness":3,"ease_of_use":3,"reuse_value":3}}`, writer, http.StatusConflict)
	call := func(method, path, token, header, body string, status int) map[string]any {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		if header != "" {
			request.Header.Set("X-Claw-Agent-ID", header)
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, recorder.Code, recorder.Body.String())
		}
		var response map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	queue := "/api/v1/app/skill-ai-review-tasks"
	rulePath := "/api/v1/app/skill-ai-review-rule"
	call(http.MethodGet, rulePath, otherLogin.AccessToken, login.AgentID, "", http.StatusForbidden)
	if result := call(http.MethodGet, rulePath, login.AccessToken, otherLogin.AgentID, "", http.StatusOK); result["data"] != nil {
		t.Fatal("无已发布规则时须明确返回null")
	}
	doJSON(t, router, http.MethodGet, rulePath, "", writer, http.StatusForbidden)
	call(http.MethodGet, queue, otherLogin.AccessToken, login.AgentID, "", http.StatusForbidden)
	response := call(http.MethodGet, queue, login.AccessToken, otherLogin.AgentID, "", http.StatusOK)
	if len(response["data"].(map[string]any)["tasks"].([]any)) != 1 {
		t.Fatal("绑定身份队列")
	}
	claimPath := queue + "/" + input.RequestID + "/claim"
	claimBody := `{"attempt_id":"` + attempt + `","review_skill_version":"1.0.0","review_skill_sha256":"` + strings.Repeat("a", 64) + `"}`
	call(http.MethodPost, claimPath, otherLogin.AccessToken, login.AgentID, claimBody, http.StatusForbidden)
	call(http.MethodPost, claimPath, login.AccessToken, "", `{"attempt_id":"`+attempt+`"}`, http.StatusBadRequest)
	claimed := call(http.MethodPost, claimPath, login.AccessToken, "", claimBody, http.StatusOK)
	if claimed["data"].(map[string]any)["materials"] == nil {
		t.Fatal("领取材料缺失")
	}
	call(http.MethodPost, claimPath, login.AccessToken, "", claimBody, http.StatusConflict)
	resultPath := queue + "/" + input.RequestID + "/result"
	invalid := `{"attempt_id":"` + attempt + `","package_sha256":"` + result.Version.PackageSHA256 + `","report":{"conclusion":"recommend_approve","summary":"摘要","findings":[{"severity":"info","message":"越界","path":"../SKILL.md"}]}}`
	failed := call(http.MethodPost, resultPath, login.AccessToken, "", invalid, http.StatusOK)
	if failed["data"].(map[string]any)["status"] != "failed" {
		t.Fatal("无效报告未进入失败")
	}
	retry := doJSON(t, router, http.MethodPost, "/api/v1/app/approvals/skill/"+input.RequestID+"/ai-review/retry", `{"attempt_id":"`+attempt+`"}`, writer, http.StatusOK)
	newAttempt := nestedString(t, retry, "data", "attempt_id")
	call(http.MethodPost, resultPath, login.AccessToken, "", invalid, http.StatusConflict)
	manualPath := "/api/v1/app/approvals/skill/" + input.RequestID + "/ai-review/manual"
	doJSON(t, router, http.MethodPost, manualPath, `{"attempt_id":"`+newAttempt+`","comment":"明确转人工"}`, writer, http.StatusForbidden)
	claimBody = `{"attempt_id":"` + newAttempt + `","review_skill_version":"1.0.0","review_skill_sha256":"` + strings.Repeat("a", 64) + `"}`
	call(http.MethodPost, claimPath, login.AccessToken, "", claimBody, http.StatusOK)
	valid := `{"attempt_id":"` + newAttempt + `","package_sha256":"` + result.Version.PackageSHA256 + `","report":{"conclusion":"recommend_approve","summary":"静态分析通过","findings":[]}}`
	call(http.MethodPost, resultPath, otherLogin.AccessToken, "", valid, http.StatusForbidden)
	call(http.MethodPost, resultPath, login.AccessToken, "", valid, http.StatusOK)
	call(http.MethodPost, resultPath, login.AccessToken, "", valid, http.StatusOK)
	doJSON(t, router, http.MethodPost, "/api/v1/app/approvals/skill/"+input.RequestID+"/decision", `{"decision":"approved","scores":{"scenario_value":3,"result_effectiveness":3,"ease_of_use":3,"reuse_value":3}}`, writer, http.StatusOK)
	definition := doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow", "", writer, http.StatusOK)["data"].(map[string]any)
	if definition["id"] != "builtin:skill-review" || definition["read_only"] != true {
		t.Fatal("内置流程必须只读")
	}
	if _, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "2", CreatedBy: writerID, UploadedByUserID: writerID, Origin: "admin_upload", Package: bytes.NewReader(skillPackageNamed(t, "ai-http"))}); err != nil {
		t.Fatal(err)
	}
	runs := doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow/runs?limit=1", "", writer, http.StatusOK)
	if len(runs["data"].([]any)) != 1 || runs["meta"].(map[string]any)["has_next"] != true {
		t.Fatal("分页真实记录")
	}
	cursor := runs["meta"].(map[string]any)["next_cursor"].(string)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow/runs?limit=1&cursor="+cursor, "", writer, http.StatusOK)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow/runs?stage=ai_failed&cursor="+cursor, "", writer, http.StatusBadRequest)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow/runs?stage=unknown", "", writer, http.StatusBadRequest)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow/runs?status=unknown", "", writer, http.StatusBadRequest)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow/runs?status=running&cursor="+cursor, "", writer, http.StatusBadRequest)
	for status, stage := range map[string]string{"running": "ai_pending", "succeeded": "approved"} {
		filtered := doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow/runs?status="+status, "", writer, http.StatusOK)["data"].([]any)
		if len(filtered) != 1 || filtered[0].(map[string]any)["workflow_stage"] != stage {
			t.Fatalf("流程任务状态筛选 %s: %#v", status, filtered)
		}
	}
	runnerCookies = loginCookies(t, router, `{"email":"ai-runner@example.com","password":"passw0rd!"}`)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow", "", runnerCookies, http.StatusForbidden)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-review-workflow/runs", "", runnerCookies, http.StatusForbidden)

}
