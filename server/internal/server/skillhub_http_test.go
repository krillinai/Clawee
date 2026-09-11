package server_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestLegacySkillHubRoutesAreRemoved(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{AccountService: accountService, SkillHubService: skillService})

	for _, path := range []string{
		"/api/v1/skills",
		"/api/v1/skills/skill_1",
		"/api/v1/skills/skill_1/package",
	} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want %d", path, recorder.Code, http.StatusNotFound)
		}
	}
}

func TestAdminStatusReportsSkillSourceAvailability(t *testing.T) {
	router := newTestRouter(t, server.Options{SkillSourceService: &skillhub.GitHubSourceService{}})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil)
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Data struct {
			Service            string `json:"service"`
			SkillSourceEnabled bool   `json:"skill_source_enabled"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.Data.SkillSourceEnabled {
		t.Fatalf("skill_source_enabled = false, body=%s", recorder.Body.String())
	}
	if response.Data.Service != "clawee-gateway" {
		t.Fatalf("service = %q, want clawee-gateway", response.Data.Service)
	}
}

func TestSkillSourceRoutesEnforcePermissionsAndSupportLifecycle(t *testing.T) {
	core, observed := observer.New(zap.InfoLevel)
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	skillStore := skillhub.NewMemoryStore()
	sourceStore := skillhub.NewMemorySourceStore(skillStore)
	skillService := skillhub.NewService(skillhub.Config{Store: skillStore, PackageRoot: t.TempDir()})
	sourceService := skillhub.NewGitHubSourceService(skillhub.GitHubSourceServiceConfig{
		Store: sourceStore, TokenCipher: sourceHTTPTestCipher{},
	})
	router := newTestRouter(t, server.Options{
		ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, RBACService: rbacService,
		SkillHubService: skillService, SkillSourceService: sourceService, Logger: zap.New(core),
	})

	routes := []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/admin/skill-sources", ""},
		{http.MethodPost, "/api/v1/admin/skill-sources", `{}`},
		{http.MethodGet, "/api/v1/admin/skill-sources/detail?source_id=source_1", ""},
		{http.MethodGet, "/api/v1/admin/skill-sources/token?source_id=source_1", ""},
		{http.MethodPut, "/api/v1/admin/skill-sources", `{}`},
		{http.MethodPost, "/api/v1/admin/skill-sources/sync", `{}`},
		{http.MethodPost, "/api/v1/admin/skill-sources/scan-local", `{}`},
		{http.MethodPost, "/api/v1/admin/skill-sources/disable", `{}`},
		{http.MethodPost, "/api/v1/admin/skill-sources/enable", `{}`},
		{http.MethodPost, "/api/v1/admin/skill-sources/token/remove", `{}`},
		{http.MethodPost, "/api/v1/admin/skill-sources/items/bind", `{}`},
		{http.MethodPost, "/api/v1/admin/skill-sources/items/unbind", `{}`},
		{http.MethodGet, "/api/v1/admin/skill-sources/sync-runs?source_id=source_1", ""},
	}
	for _, route := range routes {
		recorder := sourceJSONRequest(t, router, route.method, route.path, route.body, nil)
		assertSkillError(t, recorder, http.StatusUnauthorized, "unauthorized")
	}

	adminCookies := register(t, router, `{"email":"source-admin@example.com","name":"来源管理员","password":"passw0rd!"}`)
	readerCookies := register(t, router, `{"email":"source-reader@example.com","name":"来源查看员","password":"passw0rd!"}`)
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"skill_source_reader","name":"来源查看员","permission_codes":["console:skill:read"]}`, adminCookies, http.StatusCreated)
	readerMe := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", readerCookies, http.StatusOK)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+nestedString(t, readerMe, "data", "account", "user_id")+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, adminCookies, http.StatusCreated)
	readerCookies = loginCookies(t, router, `{"email":"source-reader@example.com","password":"passw0rd!"}`)

	createBody := `{"repository_owner":"Acme","repository_name":"Skills","branch":"main","scan_root":".","exclude_paths":[],"token":"github_pat_http_secret","auto_publish":false,"schedule":"manual"}`
	createdRecorder := sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources", createBody, adminCookies)
	if createdRecorder.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", createdRecorder.Code, createdRecorder.Body.String())
	}
	if bytes.Contains(createdRecorder.Body.Bytes(), []byte("github_pat_http_secret")) || bytes.Contains(createdRecorder.Body.Bytes(), []byte("cipher:")) || bytes.Contains(createdRecorder.Body.Bytes(), []byte("token_ciphertext")) {
		t.Fatalf("create response leaked token: %s", createdRecorder.Body.String())
	}
	created := decodeAPIJSONResource[skillhub.GitHubSource](t, createdRecorder.Body.Bytes())
	if created.SourceID == "" || !created.HasToken || created.CreatedBy != "来源管理员" {
		t.Fatalf("created source = %#v", created)
	}
	publicRecorder := sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources", `{"repository_owner":"acme","repository_name":"public-skills","branch":"main","scan_root":".","exclude_paths":[],"auto_publish":false,"schedule":"manual"}`, adminCookies)
	if publicRecorder.Code != http.StatusCreated || decodeAPIJSONResource[skillhub.GitHubSource](t, publicRecorder.Body.Bytes()).HasToken {
		t.Fatalf("public create status=%d body=%s", publicRecorder.Code, publicRecorder.Body.String())
	}
	conflictRecorder := sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources", createBody, adminCookies)
	assertSkillError(t, conflictRecorder, http.StatusConflict, "conflict")
	unknownRecorder := sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources", `{"repository_owner":"x","repository_name":"y","unknown":true}`, adminCookies)
	assertSkillError(t, unknownRecorder, http.StatusBadRequest, "invalid_request")

	var recorder *httptest.ResponseRecorder
	for _, path := range []string{
		"/api/v1/admin/skill-sources",
		"/api/v1/admin/skill-sources/detail?source_id=" + created.SourceID,
		"/api/v1/admin/skill-sources/sync-runs?source_id=" + created.SourceID,
	} {
		recorder = sourceJSONRequest(t, router, http.MethodGet, path, "", readerCookies)
		if recorder.Code != http.StatusOK || bytes.Contains(recorder.Body.Bytes(), []byte("cipher:")) || bytes.Contains(recorder.Body.Bytes(), []byte("token_ciphertext")) {
			t.Fatalf("reader GET %s status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
	}
	detailRecorder := sourceJSONRequest(t, router, http.MethodGet, "/api/v1/admin/skill-sources/detail?source_id="+created.SourceID, "", readerCookies)
	var detailResponse struct {
		Data struct {
			Source      skillhub.GitHubSource             `json:"source"`
			Items       []skillhub.SourceItem             `json:"items"`
			ManualClone *skillhub.ManualCloneInstructions `json:"manual_clone"`
		} `json:"data"`
	}
	if err := json.Unmarshal(detailRecorder.Body.Bytes(), &detailResponse); err != nil {
		t.Fatalf("decode source detail response: %v, body=%s", err, detailRecorder.Body.String())
	}
	if detailResponse.Data.Source.SourceID != created.SourceID || detailResponse.Data.Items == nil {
		t.Fatalf("source detail response lost source or items: %s", detailRecorder.Body.String())
	}
	tokenRecorder := sourceJSONRequest(t, router, http.MethodGet, "/api/v1/admin/skill-sources/token?source_id="+created.SourceID, "", readerCookies)
	assertSkillError(t, tokenRecorder, http.StatusForbidden, "forbidden")
	recorder = sourceJSONRequest(t, router, http.MethodGet, "/api/v1/admin/skill-sources/detail?source_id="+created.SourceID+"&unexpected=true", "", readerCookies)
	assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")
	for _, route := range routes {
		if route.method == http.MethodGet {
			continue
		}
		recorder := sourceJSONRequest(t, router, route.method, route.path, route.body, readerCookies)
		assertSkillError(t, recorder, http.StatusForbidden, "forbidden")
	}

	updateBody := `{"source_id":"` + created.SourceID + `","branch":"main","scan_root":".","exclude_paths":[],"auto_publish":true,"schedule":"hourly"}`
	recorder = sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-sources", updateBody, adminCookies)
	if recorder.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	tokenRecorder = sourceJSONRequest(t, router, http.MethodGet, "/api/v1/admin/skill-sources/token?source_id="+created.SourceID, "", adminCookies)
	if tokenRecorder.Code != http.StatusOK || !bytes.Contains(tokenRecorder.Body.Bytes(), []byte("github_pat_http_secret")) {
		t.Fatalf("token edit response status=%d body=%s", tokenRecorder.Code, tokenRecorder.Body.String())
	}
	clearTokenBody := `{"source_id":"` + created.SourceID + `","branch":"main","scan_root":".","exclude_paths":[],"token":"","auto_publish":true,"schedule":"hourly"}`
	recorder = sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-sources", clearTokenBody, adminCookies)
	if recorder.Code != http.StatusOK || decodeAPIJSONResource[skillhub.GitHubSource](t, recorder.Body.Bytes()).HasToken {
		t.Fatalf("clear token update status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	for _, path := range []string{"disable", "enable", "token/remove"} {
		recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources/"+path, `{"source_id":"`+created.SourceID+`"}`, adminCookies)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
	}

	skill, err := skillService.UploadVersion(context.Background(), skillhub.UploadVersionInput{Version: "1.0", Package: bytes.NewReader(skillPackage(t)), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	item, err := sourceStore.UpsertSourceItem(context.Background(), skillhub.SourceItem{
		SourceItemID: "sourceitem_1", SourceID: created.SourceID, SkillPath: "skills/code-review", DiscoveredName: skill.Skill.Name,
		Status: skillhub.SourceItemStatusNameConflict, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources/items/bind", `{"source_item_id":"`+item.SourceItemID+`","skill_id":"`+skill.Skill.SkillID+`"}`, adminCookies)
	if recorder.Code != http.StatusOK {
		t.Fatalf("bind status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	conflictRecorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources/items/bind", `{"source_item_id":"`+item.SourceItemID+`","skill_id":"`+skill.Skill.SkillID+`"}`, adminCookies)
	assertSkillError(t, conflictRecorder, http.StatusConflict, "conflict")
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources/items/unbind", `{"source_item_id":"`+item.SourceItemID+`"}`, adminCookies)
	if recorder.Code != http.StatusOK {
		t.Fatalf("unbind status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources/sync", `{"source_id":"`+created.SourceID+`"}`, adminCookies)
	if recorder.Code != http.StatusAccepted || !bytes.Contains(recorder.Body.Bytes(), []byte(`"run_id"`)) {
		t.Fatalf("sync status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	runs, err := sourceService.ListSyncRuns(context.Background(), created.SourceID, 10)
	if err != nil || len(runs) != 1 || runs[0].RequestedBy != "来源管理员" || runs[0].Status != skillhub.SourceSyncRunStatusQueued {
		t.Fatalf("queued runs = %#v, error = %v", runs, err)
	}
	entries := observed.FilterMessage("skill source operation").All()
	if len(entries) == 0 {
		t.Fatal("skill source operation log missing")
	}
	fields := entries[len(entries)-1].ContextMap()
	for _, key := range []string{"request_id", "actor_id", "source_id", "run_id", "commit_sha", "result"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("source operation log missing %s: %#v", key, fields)
		}
	}
	if fields["action"] != "skill_source_sync" || fields["result"] != "success" || fields["request_id"] == "" || fields["actor_id"] == "" || fields["source_id"] != created.SourceID || fields["run_id"] == "" {
		t.Fatalf("sync log fields = %#v", fields)
	}
	claimed, ok, err := sourceStore.ClaimNextSyncRun(context.Background(), time.Now().UTC())
	if err != nil || !ok {
		t.Fatalf("claim remote run = %#v, %v, %v", claimed, ok, err)
	}
	claimed.Status = skillhub.SourceSyncRunStatusFailed
	finished := time.Now().UTC()
	claimed.FinishedAt = &finished
	if _, err := sourceStore.CompleteSyncRun(context.Background(), claimed, created); err != nil {
		t.Fatal(err)
	}
	recorder = sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skill-sources/scan-local", `{"source_id":"`+created.SourceID+`"}`, adminCookies)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("local scan status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	runs, err = sourceService.ListSyncRuns(context.Background(), created.SourceID, 10)
	if err != nil || len(runs) != 2 || runs[0].RepositoryMode != skillhub.SourceRepositoryModeLocal {
		t.Fatalf("local scan runs = %#v, error = %v", runs, err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Message+fmt.Sprint(entry.ContextMap()), "github_pat_http_secret") || strings.Contains(fmt.Sprint(entry.ContextMap()), "cipher:") {
			t.Fatalf("source log leaked token: %#v", entry)
		}
	}
}

type sourceHTTPTestCipher struct{}

func (sourceHTTPTestCipher) Encrypt(value []byte) ([]byte, error) {
	return append([]byte("cipher:"), value...), nil
}
func (sourceHTTPTestCipher) Decrypt(value []byte) ([]byte, error) {
	return bytes.TrimPrefix(value, []byte("cipher:")), nil
}

func sourceJSONRequest(t *testing.T, router http.Handler, method, path, body string, cookies []*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("X-Request-ID", "request-source-test")
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestSkillHubUploadStoresCreatorNameSnapshot(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{
		ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","name":"平台管理员","password":"passw0rd!"}`)

	first := uploadSkillVersion(t, router, adminCookie(t, adminCookies), "1.0", skillPackage(t))
	second := uploadSkillVersion(t, router, adminCookie(t, adminCookies), "2.0", skillPackage(t))
	if first.Skill.CreatedBy != "平台管理员" || second.Skill.CreatedBy != "平台管理员" {
		t.Fatalf("creator snapshots: first=%q second=%q", first.Skill.CreatedBy, second.Skill.CreatedBy)
	}
}

func TestLegacySkillHubDynamicRoutesNotFound(t *testing.T) {
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	created, err := skillService.UploadVersion(context.Background(), skillhub.UploadVersionInput{Version: "1.0.0", Package: bytes.NewReader(skillPackage(t)), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway:    testProxyGateway(mcpgateway.NewMemoryStore()),
		SkillHubService: skillService,
	})
	base := "/api/v1/admin/skills/" + created.Skill.SkillID

	assertLegacyRoutesNotFound(t, router, []legacyRoute{
		{method: http.MethodGet, path: base},
		{method: http.MethodGet, path: base + "/versions/" + created.Version.VersionID + "/files"},
		{method: http.MethodGet, path: base + "/versions/" + created.Version.VersionID + "/file?path=SKILL.md"},
		{method: http.MethodGet, path: base + "/versions/" + created.Version.VersionID + "/package"},
		{method: http.MethodPut, path: base + "/current-version", body: `{"version_id":"` + created.Version.VersionID + `"}`},
		{method: http.MethodDelete, path: base + "/current-version"},
	})
}

func TestSkillHubCurrentVersionMutationsRejectQueryOnlySkillID(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	created, err := skillService.UploadVersion(context.Background(), skillhub.UploadVersionInput{Version: "1.0.0", Package: bytes.NewReader(skillPackage(t)), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	for _, test := range []struct {
		method string
		path   string
		body   string
	}{
		{method: http.MethodPut, path: "/api/v1/admin/skills/current-version?skill_id=" + created.Skill.SkillID, body: `{"version_id":"` + created.Version.VersionID + `"}`},
		{method: http.MethodPost, path: "/api/v1/admin/skills/current-version/remove?skill_id=" + created.Skill.SkillID, body: `{}`},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(test.method, test.path, bytes.NewBufferString(test.body))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(adminCookie(t, adminCookies))
		router.ServeHTTP(recorder, request)
		assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")
	}
}

func TestSkillHubRoutesEnforceAuthenticationAndSupportPublishFlow(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/app/skills", nil))
	assertSkillError(t, recorder, http.StatusUnauthorized, "unauthorized")

	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)

	recorder = httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/skills", nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusUnauthorized, "unauthorized")

	body, contentType := skillUploadBody(t, map[string]string{"version": "1.2.0", "changelog": "修复安装说明"}, true)
	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	created := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
	if created.Skill.CurrentVersionID == nil || *created.Skill.CurrentVersionID != created.Version.VersionID {
		t.Fatalf("uploaded version was not published: %#v", created)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills", nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"version":"1.2.0"`)) {
		t.Fatalf("auto-published list status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/package?skill_id="+created.Skill.SkillID+"&version_id=missing", nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusConflict, "version_changed")

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/package?skill_id="+created.Skill.SkillID+"&version_id="+created.Version.VersionID, nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("version-locked download status = %d content-type=%q body=%s", recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/version-files?skill_id="+created.Skill.SkillID+"&version_id="+created.Version.VersionID, nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"path":"SKILL.md"`)) {
		t.Fatalf("published files status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/version-file?skill_id="+created.Skill.SkillID+"&version_id="+created.Version.VersionID+"&path=SKILL.md", nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"content"`)) {
		t.Fatalf("published file status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/version-files?skill_id="+created.Skill.SkillID+"&version_id=missing", nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusConflict, "version_changed")

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPut, "/api/v1/admin/skills/current-version", bytes.NewBufferString(`{"skill_id":"`+created.Skill.SkillID+`","version_id":"`+created.Version.VersionID+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("publish status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPut, "/api/v1/admin/skills/current-version", bytes.NewBufferString(`{"skill_id":"`+created.Skill.SkillID+`","version_id":"missing"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusNotFound, "not_found")

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills", nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"version":"1.2.0"`)) {
		t.Fatalf("published list status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/package?skill_id="+created.Skill.SkillID, nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("download status = %d content-type=%q body=%s", recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body.String())
	}
	if recorder.Header().Get("Content-Disposition") != `attachment; filename="code-review-1.2.0.zip"` {
		t.Fatalf("content disposition = %q", recorder.Header().Get("Content-Disposition"))
	}

	for range 2 {
		recorder = httptest.NewRecorder()
		request = httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/current-version/remove", bytes.NewBufferString(`{"skill_id":"`+created.Skill.SkillID+`"}`))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(adminCookie(t, adminCookies))
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("clear current status = %d body=%s", recorder.Code, recorder.Body.String())
		}
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/detail?skill_id="+created.Skill.SkillID, nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusNotFound, "not_found")
}

func TestSkillHubAdminVersionFilesPreviewAndPackageRoutes(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	var packageBody bytes.Buffer
	zipWriter := zip.NewWriter(&packageBody)
	for name, content := range map[string][]byte{
		"wrapper/SKILL.md":      []byte("---\nname: code-review\ndescription: 企业代码审查规范\n---\n# 概述\n"),
		"wrapper/docs/guide.md": []byte("安装说明"),
		"wrapper/logo.bin":      {0, 1, 2},
	} {
		part, err := zipWriter.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	created, err := skillService.UploadVersion(context.Background(), skillhub.UploadVersionInput{Version: "1.0", Package: bytes.NewReader(packageBody.Bytes()), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	query := "?skill_id=" + created.Skill.SkillID + "&version_id=" + created.Version.VersionID

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/skills/version-files"+query, nil)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("files status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	files := decodeAPIJSONResource[[]skillhub.PackageFile](t, recorder.Body.Bytes())
	if len(files) != 3 || files[0].Path != "SKILL.md" {
		t.Fatalf("files = %#v", files)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/skills/version-file"+query+"&path=docs%2Fguide.md", nil)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("file status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	preview := decodeAPIJSONResource[skillhub.PackageFileContent](t, recorder.Body.Bytes())
	if preview.Path != "docs/guide.md" || preview.Content != "安装说明" || preview.Size == 0 {
		t.Fatalf("preview = %#v", preview)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/skills/version-file"+query+"&path=logo.bin", nil)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusUnprocessableEntity, "file_not_previewable")

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/skills/version-file"+query+"&path=..%2FSKILL.md", nil)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/skills/version-package"+query, nil)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	packageSHA256 := sha256.Sum256(recorder.Body.Bytes())
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "application/zip" || created.Version.PackageSHA256 != hex.EncodeToString(packageSHA256[:]) {
		t.Fatalf("package status = %d content-type=%q", recorder.Code, recorder.Header().Get("Content-Type"))
	}
	if recorder.Header().Get("Content-Disposition") != `attachment; filename="code-review-1.0.zip"` {
		t.Fatalf("content disposition = %q", recorder.Header().Get("Content-Disposition"))
	}
}

func TestSkillHubAdminVersionRoutesRejectForeignVersion(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	firstData := skillPackageNamed(t, "first")
	first, err := skillService.UploadVersion(context.Background(), skillhub.UploadVersionInput{Version: "1", Package: bytes.NewReader(firstData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	secondData := skillPackageNamed(t, "second")
	second, err := skillService.UploadVersion(context.Background(), skillhub.UploadVersionInput{Version: "1", Package: bytes.NewReader(secondData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/skills/version-files?skill_id="+first.Skill.SkillID+"&version_id="+second.Version.VersionID, nil)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusNotFound, "not_found")
}

func TestSkillHubStoredPackageCorruptionReturnsInternalError(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	packageRoot := t.TempDir()
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: packageRoot})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	created, err := skillService.UploadVersion(context.Background(), skillhub.UploadVersionInput{Version: "1", Package: bytes.NewReader(skillPackage(t)), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, created.Version.VersionID+".zip"), []byte("not a zip"), 0o600); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/skills/version-files?skill_id="+created.Skill.SkillID+"&version_id="+created.Version.VersionID, nil)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusInternalServerError, "internal_error")
}

func TestSkillHubLaterLowerVersionUploadBecomesPublishedDefault(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)

	firstPackage := skillPackageWithDescription(t, "code-review", "first")
	first := uploadSkillVersion(t, router, adminCookie(t, adminCookies), "2.0", firstPackage)
	secondPackage := skillPackageWithDescription(t, "code-review", "second")
	second := uploadSkillVersion(t, router, adminCookie(t, adminCookies), "1.0", secondPackage)
	if second.Skill.SkillID != first.Skill.SkillID || second.Skill.CurrentVersionID == nil || *second.Skill.CurrentVersionID != second.Version.VersionID {
		t.Fatalf("second upload did not become current: first=%#v second=%#v", first, second)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/app/skills", nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.Contains(recorder.Body.Bytes(), []byte(`"version":"1.0"`)) || !bytes.Contains(recorder.Body.Bytes(), []byte(`"description":"second"`)) {
		t.Fatalf("published list status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/package?skill_id="+first.Skill.SkillID, nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	packageSHA256 := sha256.Sum256(recorder.Body.Bytes())
	if recorder.Code != http.StatusOK || second.Version.PackageSHA256 != hex.EncodeToString(packageSHA256[:]) {
		t.Fatalf("default package status = %d sha256=%x", recorder.Code, packageSHA256)
	}
	if recorder.Header().Get("Content-Disposition") != `attachment; filename="code-review-1.0.zip"` {
		t.Fatalf("content disposition = %q", recorder.Header().Get("Content-Disposition"))
	}
}

func TestSkillHubUploadRejectsUnexpectedMultipartFields(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	body, contentType := skillUploadBody(t, map[string]string{"version": "1.0", "unexpected": "value"}, true)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusBadRequest, "invalid_request")
}

func TestSkillHubUploadAcceptsSingleWrapperDirectory(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	var wrappedPackage bytes.Buffer
	zipWriter := zip.NewWriter(&wrappedPackage)
	part, err := zipWriter.Create("wrapper/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("---\nname: wrapped\ndescription: test\n---\n")); err != nil {
		t.Fatal(err)
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}

	body, contentType := skillUploadBodyWithPackage(t, map[string]string{"version": "1.0"}, wrappedPackage.Bytes())
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	created := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
	if created.Skill.Name != "wrapped" {
		t.Fatalf("created skill = %#v", created.Skill)
	}
}

func TestSkillHubUploadNormalizesMacOSMetadata(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	admin := adminCookie(t, adminCookies)
	frontend := frontendCookie(t, adminCookies)

	var uploaded bytes.Buffer
	zipWriter := zip.NewWriter(&uploaded)
	for name, content := range map[string]string{
		"wrapper/SKILL.md":            "---\nname: normalized\ndescription: test\n---\n",
		"wrapper/scripts/run.sh":      "#!/bin/sh\n",
		"__MACOSX/wrapper/._SKILL.md": "metadata",
		"wrapper/.DS_Store":           "metadata",
		"wrapper/scripts/._run.sh":    "metadata",
	} {
		part, err := zipWriter.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}

	created := uploadSkillVersion(t, router, admin, "1.0", uploaded.Bytes())
	downloadRecorder := httptest.NewRecorder()
	downloadRequest := httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/package?skill_id="+created.Skill.SkillID, nil)
	downloadRequest.AddCookie(frontend)
	router.ServeHTTP(downloadRecorder, downloadRequest)
	if downloadRecorder.Code != http.StatusOK {
		t.Fatalf("download status = %d body=%s", downloadRecorder.Code, downloadRecorder.Body.String())
	}
	downloaded := downloadRecorder.Body.Bytes()
	digest := sha256.Sum256(downloaded)
	if created.Version.PackageSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("package_sha256 = %q, want %x", created.Version.PackageSHA256, digest)
	}

	archive, err := zip.NewReader(bytes.NewReader(downloaded), int64(len(downloaded)))
	if err != nil {
		t.Fatal(err)
	}
	wantNames := map[string]bool{"wrapper/SKILL.md": true, "wrapper/scripts/run.sh": true}
	if len(archive.File) != len(wantNames) {
		t.Fatalf("download entries = %d, want %d", len(archive.File), len(wantNames))
	}
	for _, file := range archive.File {
		if !wantNames[file.Name] {
			t.Fatalf("unexpected normalized entry %q", file.Name)
		}
	}
}

func TestSkillHubUploadReturnsDetailedPackageValidationError(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	var invalidPackage bytes.Buffer
	zipWriter := zip.NewWriter(&invalidPackage)
	part, err := zipWriter.Create("outer/wrapper/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("---\nname: wrapped\ndescription: test\n---\n")); err != nil {
		t.Fatal(err)
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}

	body, contentType := skillUploadBodyWithPackage(t, map[string]string{"version": "1.0"}, invalidPackage.Bytes())
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)

	assertSkillErrorMessage(t, recorder, http.StatusBadRequest, "package_invalid", "Skill 包格式不合法：ZIP 仅支持一层顶层包装目录，且 SKILL.md 必须直接位于该目录下")
}

func TestSkillHubOperationLogRecordsDownloadFailure(t *testing.T) {
	core, observed := observer.New(zap.InfoLevel)
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{
		ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService,
		SkillHubService: skillService, Logger: zap.New(core),
	})
	userCookies := register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/app/skills/package?skill_id=skill-missing", nil)
	request.AddCookie(userCookies[0])
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusNotFound, "not_found")

	entries := observed.FilterMessage("skill operation").All()
	if len(entries) != 1 {
		t.Fatalf("skill operation logs = %d", len(entries))
	}
	fields := entries[0].ContextMap()
	if fields["action"] != "skill_package_download" || fields["result"] != "failure" || fields["actor_id"] == "" || fields["skill_id"] != "skill-missing" || fields["package_sha256"] != "" {
		t.Fatalf("skill operation fields = %#v", fields)
	}
}

func TestSkillHubOperationLogRecordsSuccessfulUploadIdentifiers(t *testing.T) {
	core, observed := observer.New(zap.InfoLevel)
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{
		ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService,
		SkillHubService: skillService, Logger: zap.New(core),
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	body, contentType := skillUploadBody(t, map[string]string{"version": "1.0"}, true)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	entries := observed.FilterMessage("skill operation").All()
	if len(entries) != 1 {
		t.Fatalf("skill operation logs = %d", len(entries))
	}
	fields := entries[0].ContextMap()
	for _, key := range []string{"actor_id", "skill_id", "version_id", "package_sha256"} {
		if fields[key] == "" {
			t.Fatalf("skill operation missing %s: %#v", key, fields)
		}
	}
	if fields["action"] != "skill_version_upload" || fields["result"] != "success" {
		t.Fatalf("skill operation fields = %#v", fields)
	}
}

func TestSkillHubOperationLogRecordsClearedVersionIdentifiers(t *testing.T) {
	core, observed := observer.New(zap.InfoLevel)
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{
		ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService,
		SkillHubService: skillService, Logger: zap.New(core),
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	body, contentType := skillUploadBody(t, map[string]string{"version": "1.0"}, true)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	created := decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPut, "/api/v1/admin/skills/current-version", bytes.NewBufferString(`{"skill_id":"`+created.Skill.SkillID+`","version_id":"`+created.Version.VersionID+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("publish status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/current-version/remove", bytes.NewBufferString(`{"skill_id":"`+created.Skill.SkillID+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("clear status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	for _, entry := range observed.FilterMessage("skill operation").All() {
		fields := entry.ContextMap()
		if fields["action"] != "skill_current_version_clear" {
			continue
		}
		if fields["result"] != "success" || fields["actor_id"] == "" || fields["skill_id"] != created.Skill.SkillID ||
			fields["version_id"] != created.Version.VersionID || fields["package_sha256"] != created.Version.PackageSHA256 {
			t.Fatalf("clear operation fields = %#v", fields)
		}
		return
	}
	t.Fatal("clear operation log not found")
}

func TestSkillHubAuthenticationStoreFailureReturnsInternalError(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{
		ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, SkillHubService: skillService,
	})
	registration, err := accountService.Register(context.Background(), accounts.RegisterRequest{Email: "failure@example.com", Name: "Failure User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(context.Background(), registration.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/app/skills", nil).WithContext(ctx)
	request.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	assertSkillError(t, recorder, http.StatusInternalServerError, "internal_error")
}

func skillUploadBody(t *testing.T, fields map[string]string, includePackage bool) (*bytes.Buffer, string) {
	t.Helper()
	var packageData []byte
	if includePackage {
		packageData = skillPackage(t)
	}
	return skillUploadBodyWithPackage(t, fields, packageData)
}

func skillUploadBodyWithPackage(t *testing.T, fields map[string]string, packageData []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if packageData != nil {
		part, err := writer.CreateFormFile("package", "code-review.zip")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(packageData); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}

func skillPackage(t *testing.T) []byte {
	return skillPackageNamed(t, "code-review")
}

func skillPackageNamed(t *testing.T, name string) []byte {
	return skillPackageWithDescription(t, name, "企业代码审查规范")
}

func skillPackageWithDescription(t *testing.T, name, description string) []byte {
	t.Helper()
	var body bytes.Buffer
	writer := zip.NewWriter(&body)
	part, err := writer.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("---\nname: " + name + "\ndescription: " + description + "\n---\n")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func uploadSkillVersion(t *testing.T, router http.Handler, adminCookie *http.Cookie, version string, packageData []byte) skillhub.MutationResult {
	t.Helper()
	body, contentType := skillUploadBodyWithPackage(t, map[string]string{"version": version}, packageData)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	request.Header.Set("Content-Type", contentType)
	request.AddCookie(adminCookie)
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	return decodeAPIJSONResource[skillhub.MutationResult](t, recorder.Body.Bytes())
}

func assertSkillError(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d body=%s, want %d", recorder.Code, recorder.Body.String(), status)
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	actualCode, _ := response["code"].(string)
	message, _ := response["error"].(string)
	if nested, ok := response["error"].(map[string]any); ok {
		actualCode, _ = nested["code"].(string)
		message, _ = nested["message"].(string)
	}
	if actualCode != code || message == "" {
		t.Fatalf("response = %#v", response)
	}
}

func assertSkillErrorMessage(t *testing.T, recorder *httptest.ResponseRecorder, status int, code, message string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d body=%s, want %d", recorder.Code, recorder.Body.String(), status)
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	actualCode, _ := response["code"].(string)
	actualMessage, _ := response["error"].(string)
	if nested, ok := response["error"].(map[string]any); ok {
		actualCode, _ = nested["code"].(string)
		actualMessage, _ = nested["message"].(string)
	}
	if actualCode != code || actualMessage != message {
		t.Fatalf("response = %#v", response)
	}
}
