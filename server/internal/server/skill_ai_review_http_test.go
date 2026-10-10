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

func TestSkillAIReviewHTTPBoundSessionAndOriginalGates(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
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
	doJSON(t, router, http.MethodPut, configPath, `{"enabled":true,"agent_id":"`+login.AgentID+`"}`, writer, http.StatusBadRequest)
	if _, err := service.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{writerID}, true, writerID); err != nil {
		t.Fatal(err)
	}
	doJSON(t, router, http.MethodPut, configPath, `{"enabled":true,"agent_id":"missing-agent"}`, writer, http.StatusBadRequest)
	doJSON(t, router, http.MethodPut, configPath, `{"enabled":true,"agent_id":"`+login.AgentID+`"}`, runnerCookies, http.StatusUnauthorized)
	doJSON(t, router, http.MethodPut, configPath, `{"enabled":true,"agent_id":"`+login.AgentID+`"}`, writer, http.StatusOK)
	configured := doJSON(t, router, http.MethodGet, configPath, "", writer, http.StatusOK)
	if nestedString(t, configured, "data", "agent_id") != login.AgentID {
		t.Fatal("空间配置契约")
	}
	result, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", CreatedBy: writerID, UploadedByUserID: writerID, Origin: "admin_upload", Package: bytes.NewReader(skillPackageNamed(t, "ai-http"))})
	if err != nil {
		t.Fatal(err)
	}
	input := skillReviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
	detail := doJSON(t, router, http.MethodGet, "/api/v1/app/approvals/skill/"+input.RequestID, "", writer, http.StatusOK)
	data := detail["data"].(map[string]any)
	if !data["item"].(map[string]any)["can_process"].(bool) {
		t.Fatal("前置阶段丢失 fallback 权限")
	}
	approval := data["skill"].(map[string]any)["versions"].([]any)[0].(map[string]any)["local_approval"].(map[string]any)
	ai := approval["ai_review"].(map[string]any)
	attempt := ai["attempt_id"].(string)
	if ai["status"] != "pending" || ai["agent_id"] != login.AgentID {
		t.Fatal("详情 AI 契约")
	}
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", skillReviewBodyForTest(t, service, result, "approved", ""), writer, http.StatusConflict)
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
	for _, token := range []string{otherLogin.AccessToken} {
		response := call(http.MethodGet, queue, token, login.AgentID, "", http.StatusOK)
		if len(response["data"].(map[string]any)["tasks"].([]any)) != 0 {
			t.Fatal("任意 header 可冒充执行 Agent")
		}
	}
	response := call(http.MethodGet, queue, login.AccessToken, otherLogin.AgentID, "", http.StatusOK)
	if len(response["data"].(map[string]any)["tasks"].([]any)) != 1 {
		t.Fatal("绑定身份队列")
	}
	claimPath := queue + "/" + input.RequestID + "/claim"
	claimBody := `{"attempt_id":"` + attempt + `"}`
	call(http.MethodPost, claimPath, otherLogin.AccessToken, login.AgentID, claimBody, http.StatusConflict)
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
	retry := doJSON(t, router, http.MethodPost, "/api/v1/app/approvals/skill/"+input.RequestID+"/ai-review/retry", claimBody, writer, http.StatusOK)
	newAttempt := nestedString(t, retry, "data", "attempt_id")
	call(http.MethodPost, resultPath, login.AccessToken, "", invalid, http.StatusConflict)
	manualPath := "/api/v1/app/approvals/skill/" + input.RequestID + "/ai-review/manual"
	doJSON(t, router, http.MethodPost, manualPath, `{"attempt_id":"`+newAttempt+`","comment":""}`, writer, http.StatusBadRequest)
	doJSON(t, router, http.MethodPost, manualPath, `{"attempt_id":"`+newAttempt+`","comment":"明确转人工"}`, writer, http.StatusOK)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", skillReviewBodyForTest(t, service, result, "approved", ""), writer, http.StatusOK)
}
