package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestRBACAdminAPIAppliesPermissionsOnNextRequest(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountService,
		RBACService:    rbacService,
	})

	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"auditor@example.com","password":"passw0rd!"}`)

	roleBody := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{
		"code":"security_auditor",
		"name":"安全审计员",
		"permission_codes":["console:mcp:audit:read"]
	}`, adminCookies, http.StatusCreated)
	roleID := nestedString(t, roleBody, "data", "role_id")

	userMe := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", userCookies, http.StatusOK)
	userID := nestedString(t, userMe, "data", "account", "user_id")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+userID+`","role_id":"`+roleID+`"}`, adminCookies, http.StatusCreated)
	userCookies = loginCookies(t, router, `{"email":"auditor@example.com","password":"passw0rd!"}`)

	doJSON(t, router, http.MethodGet, "/api/v1/admin/mcp/audits", "", userCookies, http.StatusOK)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/accounts", "", userCookies, http.StatusForbidden)

	doJSON(t, router, http.MethodPut, "/api/v1/admin/rbac/roles", `{
		"role_id":"`+roleID+`",
		"name":"安全审计员",
		"permission_codes":[]
	}`, adminCookies, http.StatusOK)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/mcp/audits", "", userCookies, http.StatusForbidden)
}

func TestMCPGrantCanTargetRoleAndIsListedByRole(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	proxyStore := mcpgateway.NewMemoryStore()
	if err := proxyStore.SaveCapability(ctx, mcpgateway.Capability{
		ID: "cap_role_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway: testMCPGatewayService(proxyStore, fakeAdminUpstreamClient{}), AccountService: accountService, RBACService: rbacService,
	})
	adminCookies := register(t, router, `{"email":"role-grant-admin@example.com","password":"passw0rd!"}`)
	roleBody := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"sales_mcp","name":"销售 MCP","permission_codes":[]}`, adminCookies, http.StatusCreated)
	roleID := nestedString(t, roleBody, "data", "role_id")

	grantBody := doJSON(t, router, http.MethodPost, "/api/v1/admin/mcp/grants", `{"role_id":"`+roleID+`","capability_id":"cap_role_search","grant_type":"tool"}`, adminCookies, http.StatusCreated)
	if nestedString(t, grantBody, "data", "role_id") != roleID {
		t.Fatalf("role grant response = %#v", grantBody)
	}
	listBody := doJSON(t, router, http.MethodGet, "/api/v1/admin/mcp/grants?role_id="+roleID, "", adminCookies, http.StatusOK)
	items, ok := listBody["data"].([]any)
	if !ok {
		t.Fatalf("role grant list = %#v", listBody)
	}
	if len(items) != 1 {
		t.Fatalf("role grant list items = %#v", items)
	}
	item, ok := items[0].(map[string]any)
	if !ok || item["role_id"] != roleID {
		t.Fatalf("role grant list item = %#v", items[0])
	}

	doJSON(t, router, http.MethodPost, "/api/v1/admin/mcp/grants", `{"user_id":"user","role_id":"`+roleID+`","capability_id":"cap_role_search","grant_type":"tool"}`, adminCookies, http.StatusBadRequest)
}

func TestRBACGeneratedCodeAndCurrentRoleNames(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, RBACService: rbacService,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"auditor@example.com","password":"passw0rd!"}`)
	assertMeRoles := func(cookies []*http.Cookie, codes, names []string) {
		t.Helper()
		body := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", cookies, http.StatusOK)
		data := body["data"].(map[string]any)
		for field, expected := range map[string][]string{"admin_roles": codes, "admin_role_names": names} {
			encoded, err := json.Marshal(expected)
			if err != nil {
				t.Fatal(err)
			}
			actual, err := json.Marshal(data[field])
			if err != nil || string(actual) != string(encoded) {
				t.Fatalf("%s = %s, want %s, error = %v", field, actual, encoded, err)
			}
		}
	}
	assertMeRoles(adminCookies, []string{"admin"}, []string{"系统管理员"})
	assertMeRoles(userCookies, []string{}, []string{})
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"name":"安全审计员","permission_codes":["console:mcp:audit:read"]}`, adminCookies, http.StatusCreated)
	roleID := nestedString(t, role, "data", "role_id")
	code := nestedString(t, role, "data", "code")
	if !strings.HasPrefix(code, "role_") || code == "admin" {
		t.Fatalf("generated role code = %q", code)
	}
	user := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", userCookies, http.StatusOK)
	userID := nestedString(t, user, "data", "account", "user_id")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+userID+`","role_id":"`+roleID+`"}`, adminCookies, http.StatusCreated)
	assertMeRoles(userCookies, []string{code}, []string{"安全审计员"})
	doJSON(t, router, http.MethodPut, "/api/v1/admin/rbac/roles", `{"role_id":"`+roleID+`","name":"审计查看员","permission_codes":[]}`, adminCookies, http.StatusOK)
	assertMeRoles(userCookies, []string{code}, []string{"审计查看员"})
}

func TestRBACReadOnlyRoleCannotMutateRoles(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountService,
		RBACService:    rbacService,
	})
	unauthenticated := doJSON(t, router, http.MethodGet, "/api/v1/admin/rbac/permissions", "", nil, http.StatusUnauthorized)
	unauthenticatedError, ok := unauthenticated["error"].(map[string]any)
	if !ok || unauthenticatedError["code"] != "unauthorized" {
		t.Fatalf("unauthenticated error = %#v", unauthenticated["error"])
	}
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	readerCookies := register(t, router, `{"email":"reader@example.com","password":"passw0rd!"}`)

	roleBody := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{
		"code":"rbac_reader",
		"name":"RBAC 查看员",
		"permission_codes":["console:rbac:read"]
	}`, adminCookies, http.StatusCreated)
	readerMe := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", readerCookies, http.StatusOK)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+nestedString(t, readerMe, "data", "account", "user_id")+`","role_id":"`+nestedString(t, roleBody, "data", "role_id")+`"}`, adminCookies, http.StatusCreated)
	readerCookies = loginCookies(t, router, `{"email":"reader@example.com","password":"passw0rd!"}`)

	doJSON(t, router, http.MethodGet, "/api/v1/admin/rbac/permissions", "", readerCookies, http.StatusOK)
	forbidden := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"forbidden","name":"禁止","permission_codes":[]}`, readerCookies, http.StatusForbidden)
	errorBody, ok := forbidden["error"].(map[string]any)
	if !ok {
		t.Fatalf("forbidden error = %#v, want structured error", forbidden["error"])
	}
	if errorBody["code"] != "forbidden" || errorBody["message"] != "无权访问" {
		t.Fatalf("forbidden error = %#v", errorBody)
	}
	if _, ok := errorBody["details"].([]any); !ok {
		t.Fatalf("forbidden details = %#v, want array", errorBody["details"])
	}
}

func TestLoginRedirectUsesCurrentRBACPermissions(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountService,
		RBACService:    rbacService,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	register(t, router, `{"email":"auditor@example.com","password":"passw0rd!"}`)

	roleBody := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{
		"code":"security_auditor",
		"name":"安全审计员",
		"permission_codes":["console:mcp:audit:read"]
	}`, adminCookies, http.StatusCreated)
	auditorLogin := doJSON(t, router, http.MethodPost, "/api/v1/auth/login", `{"email":"auditor@example.com","password":"passw0rd!"}`, nil, http.StatusOK)
	auditorID := nestedString(t, auditorLogin, "data", "account", "user_id")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+auditorID+`","role_id":"`+nestedString(t, roleBody, "data", "role_id")+`"}`, adminCookies, http.StatusCreated)

	auditorLogin = doJSON(t, router, http.MethodPost, "/api/v1/auth/login", `{"email":"auditor@example.com","password":"passw0rd!"}`, nil, http.StatusOK)
	if nestedString(t, auditorLogin, "data", "redirect_to") != "/admin" {
		t.Fatalf("auditor redirect_to = %#v, want /admin", auditorLogin)
	}

	register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)
	userLogin := doJSON(t, router, http.MethodPost, "/api/v1/auth/login", `{"email":"user@example.com","password":"passw0rd!"}`, nil, http.StatusOK)
	if nestedString(t, userLogin, "data", "redirect_to") != "/app" {
		t.Fatalf("user redirect_to = %#v, want /app", userLogin)
	}
}

func doJSON(t *testing.T, handler http.Handler, method, path, body string, cookies []*http.Cookie, wantStatus int) map[string]any {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	handler.ServeHTTP(recorder, request)
	if recorder.Code != wantStatus {
		t.Fatalf("%s %s status = %d body=%s, want %d", method, path, recorder.Code, recorder.Body.String(), wantStatus)
	}
	if recorder.Body.Len() == 0 {
		return nil
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode %s %s response: %v body=%s", method, path, err, recorder.Body.String())
	}
	return response
}

func nestedString(t *testing.T, value map[string]any, keys ...string) string {
	t.Helper()
	var current any = value
	for _, key := range keys {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("%v is not an object while reading %v", current, keys)
		}
		current = object[key]
	}
	text, ok := current.(string)
	if !ok || text == "" {
		t.Fatalf("value at %v = %#v, want non-empty string", keys, current)
	}
	return text
}
