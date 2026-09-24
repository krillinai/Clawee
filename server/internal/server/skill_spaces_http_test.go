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
	adminID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", adminCookies, http.StatusOK), "data", "account", "user_id")
	for _, spaceID := range []string{primary.SpaceID, secondary.SpaceID} {
		if _, err := service.SetSpaceMember(ctx, spaceID, adminID, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, adminID, false); err != nil {
			t.Fatal(err)
		}
	}
	seeded, err := uploadApprovedVersionForTest(service, ctx, skillhub.UploadVersionInput{
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
	if uploaded.Skill.CurrentVersionID == nil || *uploaded.Skill.CurrentVersionID != seeded.Version.VersionID || uploaded.Version.ApprovalStatus != "pending" || uploaded.Version.UploadedByUserID != user.Account.UserID || uploaded.Version.UploadedByAgentID != login.AgentID {
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
	if err != nil || detail.Skill.SpaceID != primary.SpaceID || detail.Skill.CurrentVersionID == nil || *detail.Skill.CurrentVersionID != seeded.Version.VersionID {
		t.Fatalf("original skill changed after cross-space conflict: %#v, %v", detail, err)
	}

	body, contentType = skillUploadBodyWithPackage(t, map[string]string{"skill_id": seeded.Skill.SkillID, "space_id": secondary.SpaceID, "version": "3"}, skillPackageNamed(t, "cross-space-rename"))
	recorder = request(http.MethodPost, "/api/v1/app/skills/versions", login.AccessToken, body, contentType)
	assertSkillError(t, recorder, http.StatusConflict, "conflict")
	if _, err := service.SetSpaceMember(ctx, primary.SpaceID, user.Account.UserID, []string{skillhub.SpaceActionRead}, "技能管理员", true); err != nil {
		t.Fatal(err)
	}
	body, contentType = skillUploadBodyWithPackage(t, map[string]string{"skill_id": seeded.Skill.SkillID, "space_id": secondary.SpaceID, "version": "3"}, skillPackageNamed(t, "forbidden-rename"))
	recorder = request(http.MethodPost, "/api/v1/app/skills/versions", login.AccessToken, body, contentType)
	assertSkillError(t, recorder, http.StatusNotFound, "not_found")
	if _, err := service.SetSpaceMember(ctx, primary.SpaceID, user.Account.UserID, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, "技能管理员", true); err != nil {
		t.Fatal(err)
	}
	body, contentType = skillUploadBodyWithPackage(t, map[string]string{"skill_id": seeded.Skill.SkillID, "space_id": primary.SpaceID, "version": "3"}, skillPackageNamed(t, "client-renamed"))
	recorder = request(http.MethodPost, "/api/v1/app/skills/versions", login.AccessToken, body, contentType)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("client replacement: %d %s", recorder.Code, recorder.Body.String())
	}
	replacement := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
	if replacement.Skill.SkillID != seeded.Skill.SkillID || replacement.Skill.Name != "space-demo" || replacement.Version.SkillName != "client-renamed" || replacement.Version.ApprovalStatus != "pending" {
		t.Fatalf("replacement = %#v", replacement)
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
	webCookies := []*http.Cookie{{Name: "claw_front_token", Value: webTokens.Token(accounts.AudienceFrontend).Token}}
	pending := doJSON(t, router, http.MethodGet, "/api/v1/app/skills/own-pending-versions", "", webCookies, http.StatusOK)
	items := pending["data"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["version_id"] != webUploaded.Version.VersionID {
		t.Fatalf("own pending versions=%#v", items)
	}
	publishBody := `{"skill_id":"` + webUploaded.Skill.SkillID + `","version_id":"` + webUploaded.Version.VersionID + `"}`
	doJSON(t, router, http.MethodPost, "/api/v1/app/skills/current-version/own", publishBody, webCookies, http.StatusOK)
	pending = doJSON(t, router, http.MethodGet, "/api/v1/app/skills/own-pending-versions", "", webCookies, http.StatusOK)
	if len(pending["data"].([]any)) != 0 {
		t.Fatalf("published version remains pending: %#v", pending)
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
	recorder = sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/account-grants", prefix+`["read","write"]}`, adminCookies)
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
	recorder = sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/account-grants", prefix+`["read"]}`, adminCookies)
	assertSkillError(t, recorder, http.StatusNotFound, "skill_space_member_not_found")
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", `{"space_id":"`+space.SpaceID+`","user_id":"missing","actions":["read"]}`, adminCookies)
	assertSkillError(t, recorder, http.StatusNotFound, "skill_space_member_not_found")
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", `{"space_id":"missing","user_id":"`+target.Account.UserID+`","actions":["read"]}`, adminCookies)
	assertSkillError(t, recorder, http.StatusNotFound, "skill_space_not_found")
}

func TestAdminSkillSpaceVisibilityRequiresMembership(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	store := skillhub.NewMemoryStore()
	service := skillhub.NewService(skillhub.Config{Store: store, PackageRoot: t.TempDir()})
	sourceService := skillhub.NewGitHubSourceService(skillhub.GitHubSourceServiceConfig{
		Store: skillhub.NewMemorySourceStore(store), TokenCipher: sourceHTTPTestCipher{},
	})
	router := newTestRouter(t, server.Options{
		AccountService: accountService, ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), SkillHubService: service, SkillSourceService: sourceService,
	})
	adminCookies := register(t, router, `{"email":"visibility-admin@example.com","name":"后台管理员","password":"passw0rd!"}`)
	accountsList, err := accountService.ListAccounts(ctx)
	if err != nil || len(accountsList) != 1 {
		t.Fatalf("admin account: %v, %#v", err, accountsList)
	}
	adminID := accountsList[0].UserID
	owner, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "visibility-owner@example.com", Name: "空间所有者", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	space, err := service.CreateSpace(ctx, "私有技能空间", "仅成员可见", owner.Account.UserID)
	if err != nil {
		t.Fatal(err)
	}
	skill, err := uploadApprovedVersionForTest(service, ctx, skillhub.UploadVersionInput{
		SpaceID: space.SpaceID, Version: "1.0.0", Package: bytes.NewReader(skillPackageNamed(t, "private-skill")), CreatedBy: "空间所有者",
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := sourceService.Create(ctx, skillhub.CreateGitHubSourceInput{
		SpaceID: space.SpaceID, RepositoryOwner: "private", RepositoryName: "skills", Branch: "main", ScanRoot: ".", Schedule: "manual", CreatedBy: "空间所有者",
	})
	if err != nil {
		t.Fatal(err)
	}
	listPaths := []string{"/api/v1/admin/skill-spaces", "/api/v1/admin/skills", "/api/v1/admin/skill-sources"}
	detailPaths := []string{
		"/api/v1/admin/skill-spaces/detail?space_id=" + space.SpaceID,
		"/api/v1/admin/skill-spaces/account-grants?space_id=" + space.SpaceID,
		"/api/v1/admin/skill-spaces/member-candidates?space_id=" + space.SpaceID,
		"/api/v1/admin/skills/detail?skill_id=" + skill.Skill.SkillID,
		"/api/v1/admin/skills/version-files?skill_id=" + skill.Skill.SkillID + "&version_id=" + skill.Version.VersionID,
		"/api/v1/admin/skills/version-file?skill_id=" + skill.Skill.SkillID + "&version_id=" + skill.Version.VersionID + "&path=SKILL.md",
		"/api/v1/admin/skills/version-package?skill_id=" + skill.Skill.SkillID + "&version_id=" + skill.Version.VersionID,
		"/api/v1/admin/skill-sources/detail?source_id=" + source.SourceID,
		"/api/v1/admin/skill-sources/token?source_id=" + source.SourceID,
		"/api/v1/admin/skill-sources/sync-runs?source_id=" + source.SourceID,
	}
	check := func(visible bool) {
		t.Helper()
		for _, path := range listPaths {
			response := sourceJSONRequest(t, router, http.MethodGet, path, "", adminCookies)
			if response.Code != http.StatusOK || strings.Contains(response.Body.String(), space.SpaceID) != visible {
				t.Fatalf("list %s visible=%t status=%d body=%s", path, visible, response.Code, response.Body.String())
			}
		}
		for _, path := range detailPaths {
			response := sourceJSONRequest(t, router, http.MethodGet, path, "", adminCookies)
			if visible {
				if response.Code != http.StatusOK {
					t.Fatalf("member GET %s status=%d body=%s", path, response.Code, response.Body.String())
				}
			} else if response.Code != http.StatusNotFound {
				t.Fatalf("nonmember GET %s status=%d body=%s", path, response.Code, response.Body.String())
			}
		}
	}
	check(false)
	for _, attempt := range []struct{ method, path, body, code string }{
		{http.MethodPut, "/api/v1/admin/skill-spaces", `{"space_id":"` + space.SpaceID + `","name":"私有技能空间","description":""}`, "skill_space_not_found"},
		{http.MethodPost, "/api/v1/admin/skill-spaces/account-grants", `{"space_id":"` + space.SpaceID + `","user_id":"` + adminID + `","actions":["read"]}`, "skill_space_not_found"},
		{http.MethodPut, "/api/v1/admin/skills/current-version", `{"skill_id":"` + skill.Skill.SkillID + `","version_id":"` + skill.Version.VersionID + `"}`, "not_found"},
		{http.MethodPost, "/api/v1/admin/skill-sources/disable", `{"source_id":"` + source.SourceID + `"}`, "skill_space_not_found"},
	} {
		assertSkillError(t, sourceJSONRequest(t, router, attempt.method, attempt.path, attempt.body, adminCookies), http.StatusNotFound, attempt.code)
	}
	if _, err := service.SetSpaceMember(ctx, space.SpaceID, adminID, []string{skillhub.SpaceActionRead}, owner.Account.UserID, false); err != nil {
		t.Fatal(err)
	}
	check(true)
	if err := service.RemoveSpaceMember(ctx, space.SpaceID, adminID); err != nil {
		t.Fatal(err)
	}
	check(false)
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
	adminID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", adminCookies, http.StatusOK), "data", "account", "user_id")
	for _, spaceID := range []string{target.SpaceID, skillhub.DefaultSpaceID} {
		if _, err := service.SetSpaceMember(ctx, spaceID, adminID, []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}, adminID, false); err != nil {
			t.Fatal(err)
		}
	}
	first, err := uploadApprovedVersionForTest(service, ctx, skillhub.UploadVersionInput{Version: "1", Package: bytes.NewReader(skillPackageNamed(t, "move-first")), CreatedBy: "空间管理员"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := uploadApprovedVersionForTest(service, ctx, skillhub.UploadVersionInput{SpaceID: target.SpaceID, Version: "1", Package: bytes.NewReader(skillPackageNamed(t, "move-second")), CreatedBy: "空间管理员"})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"skill_ids":["` + first.Skill.SkillID + `","` + second.Skill.SkillID + `"],"target_space_id":"` + target.SpaceID + `"}`
	recorder := sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/space", body, adminCookies)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"moved_count":1`) || !strings.Contains(recorder.Body.String(), `"unchanged_count":1`) {
		t.Fatalf("batch move status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	detail, err := service.GetAdmin(ctx, first.Skill.SkillID)
	if err != nil || detail.Skill.SpaceID != target.SpaceID || detail.Skill.CurrentVersionID != nil || detail.Versions[0].ApprovalStatus != "pending" {
		t.Fatalf("moved skill=%#v, %v", detail, err)
	}

	recorder = sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/space", `{"skill_ids":["`+first.Skill.SkillID+`","missing"],"target_space_id":"skillspace_default"}`, adminCookies)
	assertSkillError(t, recorder, http.StatusNotFound, "not_found")
	detail, _ = service.GetAdmin(ctx, first.Skill.SkillID)
	if detail.Skill.SpaceID != target.SpaceID {
		t.Fatalf("skill changed after failed batch: %#v", detail.Skill)
	}
	recorder = sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/space", `{"skill_ids":["`+first.Skill.SkillID+`"],"target_space_id":"`+target.SpaceID+`","unknown":true}`, adminCookies)
	assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")
}
