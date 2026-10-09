package server_test

import (
	"bytes"
	"context"
	"encoding/json"
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

func TestSkillApprovalRoleConfigurationHTTP(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	store := skillhub.NewMemoryStore()
	store.SetApprovalRoleLookup(func(ctx context.Context, roleID string) (skillhub.ApprovalRole, []skillhub.Approver, error) {
		role, err := rbacService.GetRole(ctx, roleID)
		if err != nil {
			return skillhub.ApprovalRole{}, nil, err
		}
		people, err := accountService.ListAccounts(ctx)
		if err != nil {
			return skillhub.ApprovalRole{}, nil, err
		}
		resolved := []skillhub.Approver{}
		for _, person := range people {
			if person.Status != accounts.StatusActive {
				continue
			}
			roles, err := rbacService.ListAccountRoles(ctx, person.UserID)
			if err != nil {
				return skillhub.ApprovalRole{}, nil, err
			}
			for _, assigned := range roles {
				if assigned.RoleID == roleID {
					resolved = append(resolved, skillhub.Approver{UserID: person.UserID, Name: person.DisplayName()})
				}
			}
		}
		return skillhub.ApprovalRole{RoleID: role.RoleID, Name: role.Name}, resolved, nil
	})
	service := skillhub.NewService(skillhub.Config{Store: store, PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, RBACService: rbacService, SkillHubService: service})
	admin := register(t, router, `{"email":"role-approval-admin@example.com","password":"passw0rd!"}`)
	reviewer := register(t, router, `{"email":"role-approval-reviewer@example.com","password":"passw0rd!"}`)
	adminID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", admin, http.StatusOK), "data", "account", "user_id")
	reviewerID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", reviewer, http.StatusOK), "data", "account", "user_id")
	for _, id := range []string{adminID, reviewerID} {
		if _, err := service.SetSpaceMember(ctx, skillhub.DefaultSpaceID, id, []string{skillhub.SpaceActionRead}, adminID, false); err != nil {
			t.Fatal(err)
		}
	}
	roleResponse := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"role_skill_review","name":"角色审核候选","permission_codes":["console:skill:read"]}`, admin, http.StatusCreated)
	roleID := nestedString(t, roleResponse, "data", "role_id")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+reviewerID+`","role_id":"`+roleID+`"}`, admin, http.StatusCreated)
	reviewer = loginCookies(t, router, `{"email":"role-approval-reviewer@example.com","password":"passw0rd!"}`)
	candidates := doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/approver-role-candidates?space_id=skillspace_default&query=role_skill_review", "", admin, http.StatusOK)
	items := candidates["data"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["role_id"] != roleID || items[0].(map[string]any)["name"] != "角色审核候选" {
		t.Fatalf("角色候选契约: %#v", candidates)
	}
	configBody := func(userIDs, roleIDs []string, confirmed bool) string {
		t.Helper()
		body, err := json.Marshal(map[string]any{"space_id": skillhub.DefaultSpaceID, "approval_provider": "local", "approver_user_ids": userIDs, "approver_role_ids": roleIDs, "confirm_reset": confirmed})
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	put := func(path, body string, cookies []*http.Cookie, want int) {
		t.Helper()
		response := sourceJSONRequest(t, router, http.MethodPut, path, body, cookies)
		if response.Code != want {
			t.Fatalf("PUT %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approval", configBody(nil, []string{"missing"}, true), admin), http.StatusBadRequest, "invalid_request")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approval", configBody(nil, []string{roleID, roleID}, true), admin), http.StatusBadRequest, "invalid_request")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approval", configBody(nil, []string{roleID}, true), reviewer), http.StatusForbidden, "forbidden")
	put("/api/v1/admin/skill-spaces/approval", configBody([]string{reviewerID}, []string{roleID}, true), admin, http.StatusNoContent)
	configured := doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/detail?space_id=skillspace_default", "", admin, http.StatusOK)["data"].(map[string]any)
	if len(configured["approvers"].([]any)) != 1 || len(configured["approver_role_ids"].([]any)) != 1 || configured["approver_roles"].([]any)[0].(map[string]any)["role_id"] != roleID {
		t.Fatalf("配置回显契约: %#v", configured)
	}
	result, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", CreatedBy: adminID, UploadedByUserID: adminID, Origin: "admin_upload", Package: bytes.NewReader(skillPackage(t))})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
	if err != nil || detail.Versions[0].LocalApproval.Total != 1 {
		t.Fatalf("重叠配置未去重: %#v %v", detail, err)
	}
	put("/api/v1/admin/skill-spaces/approval", configBody(nil, []string{roleID}, false), admin, http.StatusConflict)
	put("/api/v1/admin/skill-spaces/approval", configBody(nil, []string{roleID}, true), admin, http.StatusNoContent)
	configured = doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/detail?space_id=skillspace_default", "", admin, http.StatusOK)["data"].(map[string]any)
	if len(configured["approvers"].([]any)) != 0 || len(configured["approver_role_ids"].([]any)) != 1 {
		t.Fatalf("纯角色回显: %#v", configured)
	}
	put("/api/v1/admin/skill-spaces/approver", `{"space_id":"skillspace_default","approver_user_ids":["`+reviewerID+`"],"approver_role_ids":["`+roleID+`"],"confirm_reset":true}`, admin, http.StatusNoContent)
	put("/api/v1/admin/skill-spaces/approver", `{"space_id":"skillspace_default","approver_user_ids":["`+reviewerID+`"],"confirm_reset":true}`, admin, http.StatusNoContent)
	space, err := service.GetSpace(ctx, skillhub.DefaultSpaceID)
	if err != nil || len(space.Approvers) != 1 || len(space.ApproverRoleIDs) != 0 {
		t.Fatalf("旧账户契约兼容性: %#v %v", space, err)
	}
}

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
	adminMe := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", adminCookies, http.StatusOK)
	adminID := nestedString(t, adminMe, "data", "account", "user_id")
	if _, err := service.SetSpaceMember(ctx, skillhub.DefaultSpaceID, adminID, []string{skillhub.SpaceActionRead}, "admin", false); err != nil {
		t.Fatal(err)
	}
	reviewerMe := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", reviewerCookies, http.StatusOK)
	reviewerID := nestedString(t, reviewerMe, "data", "account", "user_id")
	configBody := `{"space_id":"skillspace_default","approver_user_ids":["` + reviewerID + `"],"confirm_reset":true}`
	candidates := doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/approver-candidates?space_id=skillspace_default", "", adminCookies, http.StatusOK)
	for _, item := range candidates["data"].([]any) {
		if item.(map[string]any)["user_id"] == reviewerID {
			t.Fatal("没有技能查看权限的账号出现在审批人候选中")
		}
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", configBody, adminCookies), http.StatusBadRequest, "invalid_request")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"skill_reviewer","name":"技能审核员","permission_codes":["console:skill:read"]}`, adminCookies, http.StatusCreated)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+reviewerID+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, adminCookies, http.StatusCreated)
	candidates = doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/approver-candidates?space_id=skillspace_default", "", adminCookies, http.StatusOK)
	for _, item := range candidates["data"].([]any) {
		if item.(map[string]any)["user_id"] == reviewerID {
			t.Fatal("没有空间查看权限的账号出现在审批人候选中")
		}
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", configBody, adminCookies), http.StatusNotFound, "skill_space_member_not_found")
	if _, err := service.SetSpaceMember(ctx, skillhub.DefaultSpaceID, reviewerID, []string{skillhub.SpaceActionRead}, "admin", false); err != nil {
		t.Fatal(err)
	}
	reviewerCookies = loginCookies(t, router, `{"email":"approval-reviewer@example.com","password":"passw0rd!"}`)
	candidates = doJSON(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/approver-candidates?space_id=skillspace_default", "", adminCookies, http.StatusOK)
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
	reviewBody := skillReviewBodyForTest(t, service, created, "approved", "")
	publishBody := `{"skill_id":"` + created.Skill.SkillID + `","version_id":"` + created.Version.VersionID + `"}`
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", reviewBody, nil), http.StatusUnauthorized, "unauthorized")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", reviewBody, adminCookies), http.StatusForbidden, "skill_review_forbidden")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", publishBody, adminCookies), http.StatusConflict, "skill_approval_required")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", configBody, reviewerCookies), http.StatusForbidden, "forbidden")
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", configBody, adminCookies, http.StatusNoContent)
	reviewBody = skillReviewBodyForTest(t, service, created, "approved", "")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", reviewBody, adminCookies), http.StatusForbidden, "skill_review_forbidden")
	detail := doJSON(t, router, http.MethodGet, "/api/v1/admin/skills/detail?skill_id="+created.Skill.SkillID, "", reviewerCookies, http.StatusOK)
	if detail["data"].(map[string]any)["can_review"] != true {
		t.Fatalf("reviewer detail: %#v", detail)
	}
	rejectBody := skillReviewBodyForTest(t, service, created, "rejected", "需要修订")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", reviewBody, reviewerCookies, http.StatusOK)
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", rejectBody, reviewerCookies), http.StatusConflict, "conflict")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", publishBody, reviewerCookies), http.StatusForbidden, "forbidden")
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", publishBody, adminCookies, http.StatusOK)
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", `{"space_id":"skillspace_default","approver_user_ids":[]}`, adminCookies, http.StatusNoContent)
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", publishBody, adminCookies), http.StatusConflict, "skill_approval_required")
	entries := observed.FilterMessage("skill operation").FilterField(zap.String("result", "success"))
	configs := entries.FilterField(zap.String("action", "skill_space_approver_update")).All()
	if len(configs) != 2 || configs[0].ContextMap()["space_id"] != skillhub.DefaultSpaceID {
		t.Fatalf("审批人配置日志缺少目标信息：%#v", configs)
	}
	reviews := entries.FilterField(zap.String("action", "skill_review")).All()
	if len(reviews) != 1 {
		t.Fatalf("审批日志数量：%d", len(reviews))
	}
	for i, decision := range []string{"approved"} {
		fields := reviews[i].ContextMap()
		if fields["space_id"] != skillhub.DefaultSpaceID || fields["review_decision"] != decision || fields["actor_id"] != reviewerID || fields["skill_id"] != created.Skill.SkillID || fields["version_id"] != created.Version.VersionID {
			t.Fatalf("审批日志缺少决定或身份：%#v", fields)
		}
		if _, ok := fields["review_comment"]; ok {
			t.Fatal("审批意见不应写入操作日志")
		}
	}
}

func TestSkillSelfPublishHTTPChecksUploader(t *testing.T) {
	ctx := context.Background()
	accountsService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountsService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountsService, RBACService: rbacService, SkillHubService: service})
	uploader := register(t, router, `{"email":"self-publish-admin@example.com","password":"passw0rd!"}`)
	reader := register(t, router, `{"email":"self-publish-reader@example.com","password":"passw0rd!"}`)
	readerID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", reader, http.StatusOK), "data", "account", "user_id")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"self_publish_reader","name":"技能只读","permission_codes":["console:skill:read"]}`, uploader, http.StatusCreated)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+readerID+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, uploader, http.StatusCreated)
	reader = loginCookies(t, router, `{"email":"self-publish-reader@example.com","password":"passw0rd!"}`)
	body, contentType := skillUploadBody(t, map[string]string{"version": "1"}, true)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie(t, uploader))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("upload: %s", recorder.Body.String())
	}
	created := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
	payload := `{"skill_id":"` + created.Skill.SkillID + `","version_id":"` + created.Version.VersionID + `"}`
	endpoint := "/api/v1/admin/skills/current-version/own"
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, endpoint, payload, nil), http.StatusUnauthorized, "unauthorized")
	if _, err := service.SetSpaceMember(ctx, created.Skill.SpaceID, readerID, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, "admin", false); err != nil {
		t.Fatal(err)
	}
	uploaderID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", uploader, http.StatusOK), "data", "account", "user_id")
	if _, err := service.SetSpaceMember(ctx, created.Skill.SpaceID, uploaderID, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, "admin", false); err != nil {
		t.Fatal(err)
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, endpoint, payload, reader), http.StatusForbidden, "skill_self_publish_forbidden")
	doJSON(t, router, http.MethodPost, endpoint, payload, uploader, http.StatusOK)
}

func uploadApprovedVersionForTest(service *skillhub.Service, ctx context.Context, input skillhub.UploadVersionInput) (skillhub.MutationResult, error) {
	input.Origin = "admin_upload"
	if input.UploadedByUserID == "" {
		input.UploadedByUserID = "test-admin"
	}
	result, err := service.UploadVersion(ctx, input)
	if err != nil {
		return result, err
	}
	if _, err := service.SetSpaceMember(ctx, result.Skill.SpaceID, "test-reviewer", []string{skillhub.SpaceActionRead}, "test-admin", false); err != nil {
		return skillhub.MutationResult{}, err
	}
	if err := service.SetSpaceApprover(ctx, result.Skill.SpaceID, "test-reviewer", "test-admin"); err != nil {
		return skillhub.MutationResult{}, err
	}
	if _, err := reviewVersionForTest(service, ctx, result.Skill.SkillID, result.Version.VersionID, "test-reviewer", true, "测试发布前审批"); err != nil {
		return skillhub.MutationResult{}, err
	}
	if err := service.RemoveSpaceMember(ctx, result.Skill.SpaceID, "test-reviewer"); err != nil {
		return skillhub.MutationResult{}, err
	}
	return service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID)
}

func approveAndPublishSkillHTTP(t *testing.T, router http.Handler, cookie *http.Cookie, result skillhub.MutationResult) skillhub.MutationResult {
	t.Helper()
	cookies := []*http.Cookie{cookie}
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approver", `{"space_id":"`+result.Skill.SpaceID+`","approver_user_ids":["`+result.Version.UploadedByUserID+`"],"confirm_reset":true}`, cookies, http.StatusNoContent)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", skillReviewBodyForTest(t, nil, result, "approved", "审核通过", doJSON(t, router, http.MethodGet, "/api/v1/admin/skills/detail?skill_id="+result.Skill.SkillID, "", cookies, http.StatusOK)), cookies, http.StatusOK)
	recorder := sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", `{"skill_id":"`+result.Skill.SkillID+`","version_id":"`+result.Version.VersionID+`"}`, cookies)
	if recorder.Code != http.StatusOK {
		t.Fatalf("publish after approval: %d %s", recorder.Code, recorder.Body.String())
	}
	return decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
}
