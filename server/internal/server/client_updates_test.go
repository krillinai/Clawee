package server_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/server"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func customerUpdateBody(version string, revision any) string {
	input := map[string]any{"kind": "customer-desktop-update", "gateway_url": "https://gateway.example.com", "version": version, "notes": "更新说明\nversion: false", "packages": []map[string]any{
		{"platform": "macos", "arch": "arm64", "url": "https://cdn.example.com/" + version + "/arm64.zip", "sha512": base64.StdEncoding.EncodeToString(make([]byte, 64)), "size": 123},
		{"platform": "macos", "arch": "x64", "url": "https://cdn.example.com/" + version + "/x64.zip", "sha512": base64.StdEncoding.EncodeToString(make([]byte, 64)), "size": 456},
		{"platform": "windows", "arch": "x64", "url": "https://cdn.example.com/" + version + "/x64.exe", "sha512": base64.StdEncoding.EncodeToString(make([]byte, 64)), "size": 789},
	}}
	if revision != nil {
		input["expected_revision"] = revision
	}
	encoded, _ := json.Marshal(input)
	return string(encoded)
}

func TestClientUpdatesContractFeedsAndAudit(t *testing.T) {
	core, logs := observer.New(zap.InfoLevel)
	service := clientDownloadsService(catalogJSON)
	router := newTestRouter(t, server.Options{ClientDownloadsService: service, Logger: zap.New(core)})
	public := doJSON(t, router, http.MethodGet, "/api/v1/public/client-updates", "", nil, http.StatusOK)
	if len(public) != 1 || public["update"] != nil {
		t.Fatalf("unpublished: %#v", public)
	}
	admin := doJSON(t, router, http.MethodGet, "/api/v1/admin/client-downloads/update", "", nil, http.StatusOK)
	if admin["data"].(map[string]any)["revision"] != float64(0) {
		t.Fatalf("initial admin=%#v", admin)
	}
	input := strings.TrimSuffix(customerUpdateBody("1.2.3", 0), "}") + `,"published_by":"spoofed","revision":99,"published_at":"2000-01-01T00:00:00Z"}`
	doJSON(t, router, http.MethodPut, "/api/v1/admin/client-downloads/update", input, nil, http.StatusOK)
	admin = doJSON(t, router, http.MethodGet, "/api/v1/admin/client-downloads/update", "", nil, http.StatusOK)
	if nestedString(t, admin, "data", "update", "published_by") != testAdminUserID(t, router) {
		t.Fatalf("actor=%#v", admin)
	}
	response := doRequest(t, router, http.MethodGet, "/api/v1/public/client-updates", nil, "", nil, http.StatusOK)
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope) != 1 || strings.Contains(response.Body.String(), "published_by") || strings.Contains(response.Body.String(), testAdminUserID(t, router)) {
		t.Fatalf("public identity/shape: %s", response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("public cache headers=%v", response.Header())
	}
	entries := logs.FilterMessage("admin client update action").All()
	if len(entries) != 1 || entries[0].ContextMap()["operator_user_id"] != testAdminUserID(t, router) || entries[0].ContextMap()["action"] != "publish" {
		t.Fatalf("audits=%#v", entries)
	}
	for _, item := range []struct {
		path, url string
		size      int64
	}{
		{"macos/arm64/latest-mac.yml", "https://cdn.example.com/1.2.3/arm64.zip", 123},
		{"macos/arm64/latest-arm64-mac.yml", "https://cdn.example.com/1.2.3/arm64.zip", 123},
		{"macos/x64/latest-mac.yml", "https://cdn.example.com/1.2.3/x64.zip", 456},
		{"windows/x64/latest.yml", "https://cdn.example.com/1.2.3/x64.exe", 789},
	} {
		feed := doRequest(t, router, http.MethodGet, "/api/v1/public/client-updates/1/"+item.path, nil, "", nil, http.StatusOK)
		var data struct {
			Version string `json:"version"`
			Notes   string `json:"releaseNotes"`
			Files   []struct {
				URL    string `json:"url"`
				SHA512 string `json:"sha512"`
				Size   int64  `json:"size"`
			} `json:"files"`
		}
		if err := json.Unmarshal(feed.Body.Bytes(), &data); err != nil {
			t.Fatalf("not safe YAML/JSON: %s %v", feed.Body.String(), err)
		}
		if data.Version != "1.2.3" || data.Notes != "更新说明\nversion: false" || len(data.Files) != 1 || data.Files[0].URL != item.url || data.Files[0].Size != item.size || data.Files[0].SHA512 == "" {
			t.Fatalf("feed=%s", feed.Body.String())
		}
		if feed.Header().Get("Cache-Control") != "no-store" || !strings.Contains(feed.Header().Get("Content-Type"), "yaml") {
			t.Fatalf("feed headers=%v", feed.Header())
		}
	}
	for _, path := range []string{"0/macos/arm64/latest-mac.yml", "2/macos/arm64/latest-mac.yml", "01/macos/arm64/latest-mac.yml", "unknown/macos/arm64/latest-mac.yml", "1/linux/x64/latest.yml", "1/windows/arm64/latest.yml", "1/macos/x64/latest-arm64-mac.yml", "1/macos/arm64/latest.yml", "1/windows/x64/a.exe", "1/macos/arm64/arbitrary.yml"} {
		recorder := doRequest(t, router, http.MethodGet, "/api/v1/public/client-updates/"+path, nil, "", nil, http.StatusNotFound)
		if recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("404 cache: %s", path)
		}
	}
	doJSON(t, router, http.MethodPut, "/api/v1/admin/client-downloads/update", customerUpdateBody("1.2.4", 0), nil, http.StatusConflict)
	doJSON(t, router, http.MethodPut, "/api/v1/admin/client-downloads/update", customerUpdateBody("1.2.3", 1), nil, http.StatusBadRequest)
	doJSON(t, router, http.MethodPut, "/api/v1/admin/client-downloads/update", customerUpdateBody("1.2.4", 1), nil, http.StatusOK)
	doRequest(t, router, http.MethodGet, "/api/v1/public/client-updates/1/macos/arm64/latest-mac.yml", nil, "", nil, http.StatusNotFound)
}

func TestClientUpdatesBadRequestsAndUnavailable(t *testing.T) {
	router := newTestRouter(t, server.Options{ClientDownloadsService: clientDownloadsService(catalogJSON)})
	for _, body := range []string{customerUpdateBody("1.2.3", nil), customerUpdateBody("1.2.3", -1), customerUpdateBody("1.2.3", "0"), customerUpdateBody("1.2.3", 0.5), `{"expected_revision":0}`, `null`, customerUpdateBody("1.2.3", 0) + `{}`, strings.Replace(customerUpdateBody("1.2.3", 0), "https://gateway.example.com", "https://other.example.com", 1)} {
		doJSON(t, router, http.MethodPut, "/api/v1/admin/client-downloads/update", body, nil, http.StatusBadRequest)
	}
	doRequest(t, router, http.MethodPut, "/api/v1/admin/client-downloads/update", bytes.NewBufferString(strings.Repeat(" ", 128*1024+1)), "application/json", nil, http.StatusBadRequest)
	unavailable := newTestRouter(t, server.Options{})
	for _, path := range []string{"/api/v1/public/client-updates", "/api/v1/public/client-updates/1/macos/arm64/latest-mac.yml", "/api/v1/admin/client-downloads/update"} {
		doRequest(t, unavailable, http.MethodGet, path, nil, "", nil, http.StatusServiceUnavailable)
	}
}

func TestClientUpdatesReadOnlyPermissionAndAnonymous(t *testing.T) {
	router := newTestRouter(t, server.Options{ClientDownloadsService: clientDownloadsService(catalogJSON)})
	authenticated := router.(authenticatedTestHandler)
	doRequest(t, authenticated.next, http.MethodGet, "/api/v1/admin/client-downloads/update", nil, "", nil, http.StatusUnauthorized)
	doRequest(t, authenticated.next, http.MethodPut, "/api/v1/admin/client-downloads/update", bytes.NewBufferString(customerUpdateBody("1.2.3", 0)), "application/json", nil, http.StatusUnauthorized)
	accountService := newTestAccountService(accounts.NewMemoryStore())
	permissionRouter := newTestRouter(t, server.Options{AccountService: accountService, ClientDownloadsService: clientDownloadsService(catalogJSON)})
	adminCookies := register(t, permissionRouter, `{"email":"update-admin@example.com","password":"passw0rd!"}`)
	readerCookies := register(t, permissionRouter, `{"email":"update-reader@example.com","password":"passw0rd!"}`)
	userID := nestedString(t, doJSON(t, permissionRouter, http.MethodGet, "/api/v1/auth/me", "", readerCookies, http.StatusOK), "data", "account", "user_id")
	doJSON(t, permissionRouter, http.MethodGet, "/api/v1/admin/client-downloads/update", "", readerCookies, http.StatusUnauthorized)
	role := doJSON(t, permissionRouter, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"downloads_reader","name":"下载查看","permission_codes":["console:client_downloads:read"]}`, adminCookies, http.StatusCreated)
	roleID := nestedString(t, role, "data", "role_id")
	doJSON(t, permissionRouter, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+userID+`","role_id":"`+roleID+`"}`, adminCookies, http.StatusCreated)
	readerCookies = loginCookies(t, permissionRouter, `{"email":"update-reader@example.com","password":"passw0rd!"}`)
	doJSON(t, permissionRouter, http.MethodGet, "/api/v1/admin/client-downloads/update", "", readerCookies, http.StatusOK)
	doJSON(t, permissionRouter, http.MethodPut, "/api/v1/admin/client-downloads/update", customerUpdateBody("1.2.3", 0), readerCookies, http.StatusForbidden)
	current := doJSON(t, permissionRouter, http.MethodGet, "/api/v1/public/client-updates", "", nil, http.StatusOK)
	if current["update"] != nil {
		t.Fatal("forbidden publish changed snapshot")
	}
}

func TestClientUpdatesTwoAdminsFirstPublishCAS(t *testing.T) {
	router := newTestRouter(t, server.Options{AccountService: newTestAccountService(accounts.NewMemoryStore()), ClientDownloadsService: clientDownloadsService(catalogJSON)})
	firstCookies := register(t, router, `{"email":"first-update-admin@example.com","password":"passw0rd!"}`)
	secondCookies := register(t, router, `{"email":"second-update-admin@example.com","password":"passw0rd!"}`)
	userID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", secondCookies, http.StatusOK), "data", "account", "user_id")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"downloads_publisher","name":"客户更新发布","permission_codes":["console:client_downloads:update"]}`, firstCookies, http.StatusCreated)
	roleID := nestedString(t, role, "data", "role_id")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+userID+`","role_id":"`+roleID+`"}`, firstCookies, http.StatusCreated)
	secondCookies = loginCookies(t, router, `{"email":"second-update-admin@example.com","password":"passw0rd!"}`)
	start := make(chan struct{})
	statuses := make(chan int, 2)
	for _, cookies := range [][]*http.Cookie{firstCookies, secondCookies} {
		go func(cookies []*http.Cookie) {
			request := httptest.NewRequest(http.MethodPut, "/api/v1/admin/client-downloads/update", strings.NewReader(customerUpdateBody("1.2.3", 0)))
			request.Header.Set("Content-Type", "application/json")
			for _, cookie := range cookies {
				request.AddCookie(cookie)
			}
			recorder := httptest.NewRecorder()
			<-start
			router.ServeHTTP(recorder, request)
			statuses <- recorder.Code
		}(cookies)
	}
	close(start)
	first, second := <-statuses, <-statuses
	if !(first == http.StatusOK && second == http.StatusConflict || first == http.StatusConflict && second == http.StatusOK) {
		t.Fatalf("first publish statuses=%d,%d", first, second)
	}
	current := doJSON(t, router, http.MethodGet, "/api/v1/admin/client-downloads/update", "", firstCookies, http.StatusOK)
	if current["data"].(map[string]any)["revision"] != float64(1) {
		t.Fatalf("first publish revision=%#v", current)
	}
}
