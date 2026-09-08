package server_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestClaweeSkillSpaceAccessAndUpload(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := newClaweeOwnedAgentStore(accountService)
	store := skillhub.NewMemoryStore()
	service := skillhub.NewService(skillhub.Config{Store: store, PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{
		AccountService:  accountService,
		ProxyGateway:    testProxyGateway(proxyStore),
		SkillHubService: service,
	})
	adminCookies := register(t, router, `{"email":"skill-admin@example.com","name":"技能管理员","password":"passw0rd!"}`)
	user, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "clawee-skill@example.com", Name: "Clawee 技能用户", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	primary, err := service.CreateSpace(ctx, "研发技能", "研发团队使用", "技能管理员")
	if err != nil {
		t.Fatal(err)
	}
	secondary, err := service.CreateSpace(ctx, "运营技能", "运营团队使用", "技能管理员")
	if err != nil {
		t.Fatal(err)
	}
	seeded, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{
		SpaceID: primary.SpaceID, Version: "1.0.0", Package: bytes.NewReader(skillPackageNamed(t, "space-demo")), CreatedBy: "技能管理员",
	})
	if err != nil {
		t.Fatal(err)
	}
	login := loginClawee(t, router, user.Account.Email, "passw0rd!", "clawee-skill-agent")
	if login.Status != http.StatusOK {
		t.Fatalf("clawee login status=%d code=%s", login.Status, login.ErrorCode)
	}

	request := func(method, path, token string, body *bytes.Buffer, contentType string) *httptest.ResponseRecorder {
		t.Helper()
		var reader = strings.NewReader("")
		if body != nil {
			reader = strings.NewReader(body.String())
		}
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, reader)
		req.Header.Set("Authorization", "Bearer "+token)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}

	recorder := request(http.MethodGet, "/api/v1/app/skills", login.AccessToken, nil, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"data":[]`) {
		t.Fatalf("ungranted list status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = request(http.MethodGet, "/api/v1/app/skills/detail?skill_id="+seeded.Skill.SkillID, login.AccessToken, nil, "")
	assertSkillError(t, recorder, http.StatusNotFound, "not_found")

	if _, err := service.SetSpaceMember(ctx, primary.SpaceID, user.Account.UserID, []string{skillhub.SpaceActionRead}, "技能管理员", false); err != nil {
		t.Fatal(err)
	}
	recorder = request(http.MethodGet, "/api/v1/app/skill-spaces", login.AccessToken, nil, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), primary.SpaceID) || strings.Contains(recorder.Body.String(), secondary.SpaceID) || !strings.Contains(recorder.Body.String(), `"actions":["read"]`) || strings.Contains(recorder.Body.String(), "created_by") {
		t.Fatalf("read-only spaces status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	for _, path := range []string{
		"/api/v1/app/skills",
		"/api/v1/app/skills/detail?skill_id=" + seeded.Skill.SkillID,
		"/api/v1/app/skills/version-files?skill_id=" + seeded.Skill.SkillID + "&version_id=" + seeded.Version.VersionID,
		"/api/v1/app/skills/version-file?skill_id=" + seeded.Skill.SkillID + "&version_id=" + seeded.Version.VersionID + "&path=SKILL.md",
		"/api/v1/app/skills/package?skill_id=" + seeded.Skill.SkillID + "&version_id=" + seeded.Version.VersionID,
	} {
		recorder = request(http.MethodGet, path, login.AccessToken, nil, "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("read-only GET %s status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
	}
	body, contentType := skillUploadBodyWithPackage(t, map[string]string{"space_id": primary.SpaceID, "version": "1.1.0"}, skillPackageNamed(t, "space-demo"))
	recorder = request(http.MethodPost, "/api/v1/app/skills/versions", login.AccessToken, body, contentType)
	assertSkillError(t, recorder, http.StatusNotFound, "skill_space_not_found")

	if _, err := service.SetSpaceMember(ctx, primary.SpaceID, user.Account.UserID, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, "技能管理员", true); err != nil {
		t.Fatal(err)
	}
	body, contentType = skillUploadBodyWithPackage(t, map[string]string{"space_id": primary.SpaceID, "version": "1.1.0", "changelog": "客户端上传"}, skillPackageNamed(t, "space-demo"))
	recorder = request(http.MethodPost, "/api/v1/app/skills/versions", login.AccessToken, body, contentType)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("authorized upload status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	uploaded := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
	if uploaded.Skill.CurrentVersionID == nil || *uploaded.Skill.CurrentVersionID != uploaded.Version.VersionID || uploaded.Version.UploadedByUserID != user.Account.UserID || uploaded.Version.UploadedByAgentID != login.AgentID {
		t.Fatalf("uploaded result=%#v", uploaded)
	}
	if uploaded.Skill.SpaceName != primary.Name {
		t.Fatalf("uploaded skill space name=%q, want %q", uploaded.Skill.SpaceName, primary.Name)
	}

	if _, err := service.SetSpaceMember(ctx, secondary.SpaceID, user.Account.UserID, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, "技能管理员", false); err != nil {
		t.Fatal(err)
	}
	body, contentType = skillUploadBodyWithPackage(t, map[string]string{"space_id": secondary.SpaceID, "version": "2.0.0"}, skillPackageNamed(t, "space-demo"))
	recorder = request(http.MethodPost, "/api/v1/app/skills/versions", login.AccessToken, body, contentType)
	assertSkillError(t, recorder, http.StatusConflict, "conflict")
	detail, err := service.GetAdmin(ctx, seeded.Skill.SkillID)
	if err != nil || detail.Skill.SpaceID != primary.SpaceID || detail.Skill.CurrentVersionID == nil || *detail.Skill.CurrentVersionID != uploaded.Version.VersionID {
		t.Fatalf("original skill changed after cross-space conflict: %#v, %v", detail, err)
	}

	webTokens, err := accountService.IssueTokens(ctx, user.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	body, contentType = skillUploadBodyWithPackage(t, map[string]string{"space_id": secondary.SpaceID, "version": "1.0.0"}, skillPackageNamed(t, "web-upload"))
	recorder = httptest.NewRecorder()
	webRequest := httptest.NewRequest(http.MethodPost, "/api/v1/app/skills/versions", bytes.NewReader(body.Bytes()))
	webRequest.Header.Set("Content-Type", contentType)
	webRequest.AddCookie(&http.Cookie{Name: "claw_front_token", Value: webTokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, webRequest)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("web upload status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	webUploaded := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
	if webUploaded.Skill.SpaceID != secondary.SpaceID || webUploaded.Version.UploadedByUserID != user.Account.UserID || webUploaded.Version.UploadedByAgentID != "" {
		t.Fatalf("web uploaded result=%#v", webUploaded)
	}

	body, contentType = skillUploadBodyWithPackage(t, map[string]string{"space_id": secondary.SpaceID, "version": "1.0.0"}, skillPackageNamed(t, "admin-upload"))
	recorder = httptest.NewRecorder()
	adminRequest := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	adminRequest.Header.Set("Content-Type", contentType)
	adminRequest.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, adminRequest)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("admin upload status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	adminCreated := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
	if adminCreated.Skill.SpaceID != secondary.SpaceID {
		t.Fatalf("admin upload space=%q, want %q", adminCreated.Skill.SpaceID, secondary.SpaceID)
	}
	recorder = sourceJSONRequest(t, router, http.MethodGet, "/api/v1/admin/skills", "", adminCookies)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), seeded.Skill.SkillID) || !strings.Contains(recorder.Body.String(), adminCreated.Skill.SkillID) {
		t.Fatalf("admin list status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSkillSpaceAdminMemberLifecycleAndStrictJSON(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{
		AccountService:  accountService,
		ProxyGateway:    testProxyGateway(mcpgateway.NewMemoryStore()),
		SkillHubService: service,
	})
	adminCookies := register(t, router, `{"email":"space-admin@example.com","name":"空间管理员","password":"passw0rd!"}`)
	target, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "space-user@example.com", Name: "空间用户", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}

	recorder := sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces", `{"name":"非法空间","unknown":true}`, adminCookies)
	assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces", `{"name":"产品技能","description":"产品团队使用"}`, adminCookies)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create space status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	space := decodeAPIJSONResource[skillhub.SpaceSummary](t, recorder.Body.Bytes())
	prefix := `{"space_id":"` + space.SpaceID + `","user_id":"` + target.Account.UserID + `","actions":`

	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", prefix+`["write"]}`, adminCookies)
	assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", prefix+`["read"],"unknown":true}`, adminCookies)
	assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", prefix+`["read"]}`, adminCookies)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("add member status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", prefix+`["read"]}`, adminCookies)
	assertSkillError(t, recorder, http.StatusConflict, "skill_space_member_exists")
	recorder = sourceJSONRequest(t, router, http.MethodPatch, "/api/v1/admin/skill-spaces/account-grants", prefix+`["read","write"]}`, adminCookies)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"actions":["read","write"]`) {
		t.Fatalf("update member status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = sourceJSONRequest(t, router, http.MethodGet, "/api/v1/admin/skill-spaces/account-grants?space_id="+space.SpaceID, "", adminCookies)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), target.Account.UserID) || !strings.Contains(recorder.Body.String(), target.Account.Email) {
		t.Fatalf("list members status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants/remove", `{"space_id":"`+space.SpaceID+`","user_id":"`+target.Account.UserID+`"}`, adminCookies)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("remove member status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = sourceJSONRequest(t, router, http.MethodPatch, "/api/v1/admin/skill-spaces/account-grants", prefix+`["read"]}`, adminCookies)
	assertSkillError(t, recorder, http.StatusNotFound, "skill_space_member_not_found")
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", `{"space_id":"`+space.SpaceID+`","user_id":"missing","actions":["read"]}`, adminCookies)
	assertSkillError(t, recorder, http.StatusNotFound, "skill_space_member_not_found")
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", `{"space_id":"missing","user_id":"`+target.Account.UserID+`","actions":["read"]}`, adminCookies)
	assertSkillError(t, recorder, http.StatusNotFound, "skill_space_not_found")
}

func TestAdminBatchMovesSkillsToSpaceAtomically(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{
		AccountService: accountService, ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), SkillHubService: service,
	})
	adminCookies := register(t, router, `{"email":"move-admin@example.com","name":"空间管理员","password":"passw0rd!"}`)
	target, err := service.CreateSpace(ctx, "产品技能", "", "空间管理员")
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", Package: bytes.NewReader(skillPackageNamed(t, "move-first")), CreatedBy: "空间管理员"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{SpaceID: target.SpaceID, Version: "1", Package: bytes.NewReader(skillPackageNamed(t, "move-second")), CreatedBy: "空间管理员"})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"skill_ids":["` + first.Skill.SkillID + `","` + second.Skill.SkillID + `"],"target_space_id":"` + target.SpaceID + `"}`
	recorder := sourceJSONRequest(t, router, http.MethodPatch, "/api/v1/admin/skills/space", body, adminCookies)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"moved_count":1`) || !strings.Contains(recorder.Body.String(), `"unchanged_count":1`) {
		t.Fatalf("batch move status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	detail, err := service.GetAdmin(ctx, first.Skill.SkillID)
	if err != nil || detail.Skill.SpaceID != target.SpaceID || detail.Skill.CurrentVersionID == nil {
		t.Fatalf("moved skill=%#v, %v", detail, err)
	}

	recorder = sourceJSONRequest(t, router, http.MethodPatch, "/api/v1/admin/skills/space", `{"skill_ids":["`+first.Skill.SkillID+`","missing"],"target_space_id":"skillspace_default"}`, adminCookies)
	assertSkillError(t, recorder, http.StatusNotFound, "not_found")
	detail, _ = service.GetAdmin(ctx, first.Skill.SkillID)
	if detail.Skill.SpaceID != target.SpaceID {
		t.Fatalf("skill changed after failed batch: %#v", detail.Skill)
	}
	recorder = sourceJSONRequest(t, router, http.MethodPatch, "/api/v1/admin/skills/space", `{"skill_ids":["`+first.Skill.SkillID+`"],"target_space_id":"`+target.SpaceID+`","unknown":true}`, adminCookies)
	assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")
}
