package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestSkillApprovalHTTPRequiresConfiguredReviewer(t *testing.T) {
	ctx := context.Background()
	core, observed := observer.New(zap.InfoLevel)
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, RBACService: rbacService, SkillHubService: service, Logger: zap.New(core)})
	adminCookies := register(t, router, `{"email":"approval-admin@example.com","password":"passw0rd!"}`)
	reviewerCookies := register(t, router, `{"email":"approval-reviewer@example.com","password":"passw0rd!"}`)
	reviewerMe := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", reviewerCookies, http.StatusOK)
	reviewerID := nestedString(t, reviewerMe, "data", "account", "user_id")
	configBody := `{"space_id":"skillspace_default","user_id":"` + reviewerID + `"}`
	candidates := doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/approver-candidates", "", adminCookies, http.StatusOK)
	for _, item := range candidates["data"].([]any) {
		if item.(map[string]any)["user_id"] == reviewerID {
			t.Fatal("没有技能查看权限的账号出现在审批人候选中")
		}
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", configBody, adminCookies), http.StatusBadRequest, "invalid_request")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"skill_reviewer","name":"技能审核员","permission_codes":["console:skill:read"]}`, adminCookies, http.StatusCreated)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+reviewerID+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, adminCookies, http.StatusCreated)
	reviewerCookies = loginCookies(t, router, `{"email":"approval-reviewer@example.com","password":"passw0rd!"}`)
	candidates = doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/approver-candidates", "", adminCookies, http.StatusOK)
	foundReviewer := false
	for _, item := range candidates["data"].([]any) {
		if item.(map[string]any)["user_id"] == reviewerID {
			foundReviewer = true
		}
	}
	if !foundReviewer {
		t.Fatal("有技能查看权限的账号未出现在审批人候选中")
	}
	body, contentType := skillUploadBody(t, map[string]string{"version": "1"}, true)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie(t, adminCookies))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("upload: %s", recorder.Body.String())
	}
	created := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
	reviewBody := `{"skill_id":"` + created.Skill.SkillID + `","version_id":"` + created.Version.VersionID + `","decision":"approved"}`
	publishBody := `{"skill_id":"` + created.Skill.SkillID + `","version_id":"` + created.Version.VersionID + `"}`
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", reviewBody, nil), http.StatusUnauthorized, "unauthorized")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", reviewBody, adminCookies), http.StatusForbidden, "skill_review_forbidden")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", publishBody, adminCookies), http.StatusConflict, "skill_approval_required")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", configBody, reviewerCookies), http.StatusForbidden, "forbidden")
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", configBody, adminCookies, http.StatusNoContent)
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", reviewBody, adminCookies), http.StatusForbidden, "skill_review_forbidden")
	detail := doJSON(t, router, http.MethodGet, "/api/v1/admin/skills/detail?skill_id="+created.Skill.SkillID, "", reviewerCookies, http.StatusOK)
	if detail["data"].(map[string]any)["can_review"] != true {
		t.Fatalf("reviewer detail: %#v", detail)
	}
	rejectBody := `{"skill_id":"` + created.Skill.SkillID + `","version_id":"` + created.Version.VersionID + `","decision":"rejected","comment":"需要修订"}`
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", rejectBody, reviewerCookies, http.StatusOK)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", reviewBody, reviewerCookies, http.StatusOK)
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", publishBody, reviewerCookies), http.StatusForbidden, "forbidden")
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", publishBody, adminCookies, http.StatusOK)
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", `{"space_id":"skillspace_default","user_id":""}`, adminCookies, http.StatusNoContent)
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", publishBody, adminCookies), http.StatusConflict, "skill_approval_required")
	entries := observed.FilterMessage("skill operation").FilterField(zap.String("result", "success"))
	configs := entries.FilterField(zap.String("action", "skill_space_approver_update")).All()
	if len(configs) != 2 || configs[0].ContextMap()["space_id"] != skillhub.DefaultSpaceID || configs[0].ContextMap()["approver_user_id"] != reviewerID || configs[1].ContextMap()["approver_user_id"] != "" {
		t.Fatalf("审批人配置日志缺少目标信息：%#v", configs)
	}
	reviews := entries.FilterField(zap.String("action", "skill_review")).All()
	if len(reviews) != 2 {
		t.Fatalf("审批日志数量：%d", len(reviews))
	}
	for i, decision := range []string{"rejected", "approved"} {
		fields := reviews[i].ContextMap()
		if fields["space_id"] != skillhub.DefaultSpaceID || fields["review_decision"] != decision || fields["actor_id"] != reviewerID || fields["skill_id"] != created.Skill.SkillID || fields["version_id"] != created.Version.VersionID {
			t.Fatalf("审批日志缺少决定或身份：%#v", fields)
		}
		if _, ok := fields["review_comment"]; ok {
			t.Fatal("审批意见不应写入操作日志")
		}
	}
}

func uploadApprovedVersionForTest(service *skillhub.Service, ctx context.Context, input skillhub.UploadVersionInput) (skillhub.MutationResult, error) {
	result, err := service.UploadVersion(ctx, input)
	if err != nil {
		return result, err
	}
	if err := service.SetSpaceApprover(ctx, result.Skill.SpaceID, "test-reviewer", "test-admin"); err != nil {
		return skillhub.MutationResult{}, err
	}
	if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "test-reviewer", true, "测试发布前审批"); err != nil {
		return skillhub.MutationResult{}, err
	}
	return service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID)
}

func approveAndPublishSkillHTTP(t *testing.T, router http.Handler, cookie *http.Cookie, result skillhub.MutationResult) skillhub.MutationResult {
	t.Helper()
	cookies := []*http.Cookie{cookie}
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", `{"space_id":"`+result.Skill.SpaceID+`","user_id":"`+result.Version.UploadedByUserID+`"}`, cookies, http.StatusNoContent)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", `{"skill_id":"`+result.Skill.SkillID+`","version_id":"`+result.Version.VersionID+`","decision":"approved","comment":"审核通过"}`, cookies, http.StatusOK)
	recorder := sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", `{"skill_id":"`+result.Skill.SkillID+`","version_id":"`+result.Version.VersionID+`"}`, cookies)
	if recorder.Code != http.StatusOK {
		t.Fatalf("publish after approval: %d %s", recorder.Code, recorder.Body.String())
	}
	return decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
}
