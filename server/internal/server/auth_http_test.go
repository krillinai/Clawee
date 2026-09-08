package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestFirstRegisterIsAdminAndCanAccessAdminAPI(t *testing.T) {
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	router := newTestRouter(t, server.Options{
		ProxyGateway:             testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:           accountSvc,
		ActivityReportingEnabled: true,
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"admin@example.com","name":"Admin","password":"passw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("register status = %d body=%s", rec.Code, rec.Body.String())
	}
	var registerResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &registerResp); err != nil {
		t.Fatalf("decode register response: %v", err)
	}
	if nestedString(t, registerResp, "data", "redirect_to") != "/admin" {
		t.Fatalf("redirect_to = %#v, want /admin", registerResp)
	}
	if nestedString(t, registerResp, "data", "account", "user_id") == "" {
		t.Fatalf("missing account response: %#v", registerResp)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatalf("missing session cookie")
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil)
	req.AddCookie(adminCookie(t, cookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(frontendCookie(t, cookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("me status = %d body=%s", rec.Code, rec.Body.String())
	}
	var meResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &meResp); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	if nestedString(t, meResp, "data", "account", "user_id") == "" {
		t.Fatalf("missing account in me response: %#v", meResp)
	}
	if enabled, ok := meResp["data"].(map[string]any)["agent_activity_reporting_enabled"].(bool); !ok || !enabled {
		t.Fatalf("agent_activity_reporting_enabled = %#v, want true", meResp)
	}
}

func TestRegisterRejectsBlankAndAllowsDuplicateNames(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})

	blank := performRegister(router, `{"email":"blank@example.com","name":"   ","password":"passw0rd!"}`)
	if blank.Code != http.StatusBadRequest || !strings.Contains(blank.Body.String(), `"code":"invalid_request"`) {
		t.Fatalf("blank name status=%d body=%s", blank.Code, blank.Body.String())
	}

	first := performRegister(router, `{"email":"one@example.com","name":"Alice","password":"passw0rd!"}`)
	if first.Code != http.StatusOK {
		t.Fatalf("first register status=%d body=%s", first.Code, first.Body.String())
	}
	duplicate := performRegister(router, `{"email":"two@example.com","name":"alice","password":"passw0rd!"}`)
	if duplicate.Code != http.StatusOK {
		t.Fatalf("duplicate name status=%d body=%s", duplicate.Code, duplicate.Body.String())
	}
}

func TestRegisterRejectsDuplicateEmailWithClearMessage(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})

	first := performRegister(router, `{"email":"user@example.com","name":"First","password":"passw0rd!"}`)
	if first.Code != http.StatusOK {
		t.Fatalf("first register status=%d body=%s", first.Code, first.Body.String())
	}
	duplicate := performRegister(router, `{"email":" USER@example.com ","name":"Second","password":"passw0rd!"}`)
	if duplicate.Code != http.StatusConflict || !strings.Contains(duplicate.Body.String(), `"code":"email_exists"`) || !strings.Contains(duplicate.Body.String(), `"message":"该邮箱已注册"`) {
		t.Fatalf("duplicate email status=%d body=%s", duplicate.Code, duplicate.Body.String())
	}
}

func TestAdminCreateAccountRejectsBlankAndAllowsDuplicateNames(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","name":"Admin","password":"passw0rd!"}`)

	for _, test := range []struct {
		name       string
		body       string
		wantStatus int
		wantError  string
	}{
		{name: "blank", body: `{"email":"blank@example.com","name":"   ","password":"passw0rd!"}`, wantStatus: http.StatusBadRequest, wantError: accounts.ErrInvalidAccountRequest.Error()},
		{name: "duplicate", body: `{"email":"duplicate@example.com","name":"admin","password":"passw0rd!"}`, wantStatus: http.StatusCreated},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.AddCookie(adminCookie(t, adminCookies))
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.wantStatus || (test.wantError != "" && !strings.Contains(recorder.Body.String(), test.wantError)) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestWebRegisterCreatesAccountWithoutAgent(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(proxyStore), AccountService: accountSvc})

	cookies := register(t, router, `{"email":"empty@example.com","name":"Empty","password":"passw0rd!"}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/agents", nil)
	req.AddCookie(frontendCookie(t, cookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("agents status=%d body=%s", rec.Code, rec.Body.String())
	}
	var items []json.RawMessage
	if err := json.Unmarshal(unwrapAPIRawData(t, rec.Body.Bytes()), &items); err != nil {
		t.Fatalf("decode agents list: %v body=%s", err, rec.Body.String())
	}
	if items == nil || len(items) != 0 {
		t.Fatalf("agents = %s, want non-null empty array", rec.Body.String())
	}
	agents, err := proxyStore.ListAgents(context.Background(), mcpgateway.AgentFilter{})
	if err != nil || len(agents) != 0 {
		t.Fatalf("stored agents = %#v, %v", agents, err)
	}
}

func TestFirstRegisteredAdminCanAccessOwnAgentTokenAndTools(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	proxyGateway := testProxyGateway(proxyStore)
	router := newTestRouter(t, server.Options{
		ProxyGateway:   proxyGateway,
		AccountService: accountSvc,
	})

	adminCookies := register(t, router, `{"email":"admin@example.com","name":"Admin","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/app/agents", strings.NewReader(`{"agent_id":"admin-agent","name":"Admin Agent"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(frontendCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create admin agent status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/app/mcp/token/rotate", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(frontendCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create admin account token status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/app/agents/detail", nil)
	req.AddCookie(frontendCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin agent me status = %d body=%s", rec.Code, rec.Body.String())
	}
	var meResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &meResp); err != nil {
		t.Fatalf("decode admin agent me response: %v", err)
	}
	adminID := nestedString(t, meResp, "data", "account", "user_id")
	agentID := nestedString(t, meResp, "data", "agent", "agent_id")
	if agentID != "admin-agent" {
		t.Fatalf("admin agent id = %q, want explicit agent", agentID)
	}
	data := meResp["data"].(map[string]any)
	account := data["account"].(map[string]any)
	agent := data["agent"].(map[string]any)
	if _, exists := account["role"]; exists {
		t.Fatalf("account response still contains legacy role: %#v", account)
	}
	if agent["actor_id"] != adminID {
		t.Fatalf("admin agent actor = %#v, want %q", agent["actor_id"], adminID)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/app/mcp/token", nil)
	req.AddCookie(frontendCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin agent token status = %d body=%s", rec.Code, rec.Body.String())
	}
	var tokenResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &tokenResp); err != nil {
		t.Fatalf("decode admin token response: %v", err)
	}
	tokenData, ok := tokenResp["data"].(map[string]any)
	if !ok {
		t.Fatalf("missing admin token data: %#v", tokenResp)
	}
	token, ok := tokenData["token"].(map[string]any)
	if !ok {
		t.Fatalf("missing admin token response: %#v", tokenResp)
	}
	if token["user_id"] != adminID {
		t.Fatalf("admin token user = %#v, want %q", token["user_id"], adminID)
	}
	if token["token_status"] != mcpgateway.StatusActive {
		t.Fatalf("admin token status = %#v, want active", token["token_status"])
	}
	assertNoSensitiveTokenFields(t, token)

	if err := proxyStore.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{ID: "admin-crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save admin upstream server: %v", err)
	}
	granted := mcpgateway.Capability{
		ID:               "cap_admin_search",
		UpstreamServerID: "admin-crm",
		Type:             mcpgateway.CapabilityTool,
		ExposedName:      "admin.customer.search",
		UpstreamName:     "customer.search",
		Status:           mcpgateway.StatusActive,
	}
	ungranted := mcpgateway.Capability{
		ID:               "cap_admin_delete",
		UpstreamServerID: "admin-crm",
		Type:             mcpgateway.CapabilityTool,
		ExposedName:      "admin.customer.delete",
		UpstreamName:     "customer.delete",
		Status:           mcpgateway.StatusActive,
	}
	if err := proxyStore.SaveCapability(ctx, granted); err != nil {
		t.Fatalf("save admin capability: %v", err)
	}
	if err := proxyStore.SaveCapability(ctx, ungranted); err != nil {
		t.Fatalf("save ungranted admin capability: %v", err)
	}
	if err := proxyStore.SaveGrant(ctx, mcpgateway.AccountGrant{
		ID:           "grant_admin_tool",
		UserID:       adminID,
		CapabilityID: granted.ID,
		GrantType:    mcpgateway.GrantTool,
	}); err != nil {
		t.Fatalf("save admin grant: %v", err)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/app/agents/tools", nil)
	req.AddCookie(frontendCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin tools status = %d body=%s", rec.Code, rec.Body.String())
	}
	tools := unwrapAPIListMaps(t, rec.Body.Bytes())
	if len(tools) != 1 || tools[0]["exposed_name"] != "admin.customer.search" {
		t.Fatalf("admin tools = %#v, want only granted admin tool", tools)
	}
}

func TestEmptyAccountAgentDetailTokenAndToolsReturnNotFound(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(proxyStore),
		AccountService: accountSvc,
	})
	cookies := register(t, router, `{"email":"empty-detail@example.com","name":"Empty Detail","password":"passw0rd!"}`)

	for _, path := range []string{
		"/api/v1/app/agents/detail",
		"/api/v1/app/mcp/token",
		"/api/v1/app/agents/tools",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(frontendCookie(t, cookies))
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}
	agents, err := proxyStore.ListAgents(context.Background(), mcpgateway.AgentFilter{})
	if err != nil || len(agents) != 0 {
		t.Fatalf("stored agents = %#v, %v", agents, err)
	}
}

func TestExistingAccountWithoutBindingUsesExistingAgentTokenWithoutCipher(t *testing.T) {
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	proxyStore := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{
		ProxyGateway:   mcpgateway.NewService(mcpgateway.Config{Store: proxyStore}),
		AccountService: accountSvc,
	})

	adminAccount, err := accountSvc.CreateAccount(context.Background(), accounts.CreateAccountRequest{
		Email:    "legacy-admin@example.com",
		Name:     "Legacy Admin",
		Password: "passw0rd!",
		Status:   accounts.StatusActive,
	})
	if err != nil {
		t.Fatalf("create legacy admin account: %v", err)
	}
	agentID := "user_" + adminAccount.UserID + "_agent"
	if err := proxyStore.SaveAgent(context.Background(), mcpgateway.AgentRegistration{
		AgentID:  agentID,
		ClientID: "user_" + adminAccount.UserID,
		Name:     adminAccount.Name,
		ActorID:  adminAccount.UserID,
		Status:   mcpgateway.StatusActive,
	}); err != nil {
		t.Fatalf("save existing admin agent: %v", err)
	}
	if err := proxyStore.RotateAccountToken(context.Background(), adminAccount.UserID, mcpgateway.AccountToken{
		ID:     "token_existing_admin",
		UserID: adminAccount.UserID,
		Status: mcpgateway.StatusActive,
		Scopes: []string{"mcp:call"},
	}); err != nil {
		t.Fatalf("save existing admin token: %v", err)
	}
	if err := accountSvc.BindAgent(context.Background(), adminAccount.UserID, agentID); err != nil {
		t.Fatalf("bind existing admin agent: %v", err)
	}
	login, err := accountSvc.AuthenticateCredentials(context.Background(), accounts.LoginRequest{
		Email:    "legacy-admin@example.com",
		Password: "passw0rd!",
	})
	if err != nil {
		t.Fatalf("login legacy admin: %v", err)
	}
	tokens, err := accountSvc.IssueTokens(context.Background(), login, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/agents/detail", nil)
	req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy admin existing token agent me status = %d body=%s", rec.Code, rec.Body.String())
	}
	boundAgentID, err := accountSvc.PrimaryAgentID(context.Background(), adminAccount.UserID)
	if err != nil {
		t.Fatalf("load legacy admin bound agent: %v", err)
	}
	if boundAgentID != agentID {
		t.Fatalf("legacy admin bound agent = %q, want %q", boundAgentID, agentID)
	}
}

func TestRegisterWithShortPasswordReturnsInvalidRequest(t *testing.T) {
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"admin@example.com","password":"admin"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("register status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode register response: %v", err)
	}
	errorBody, ok := resp["error"].(map[string]any)
	if !ok || errorBody["code"] != "invalid_request" || errorBody["message"] != "请求无效" {
		t.Fatalf("error = %#v, want invalid_request", resp["error"])
	}
}

func TestNormalUserCannotAccessAdminAPI(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil)
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("admin status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminAPIFailsClosedWithoutRBACService(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	auth, err := accountSvc.Register(context.Background(), accounts.RegisterRequest{
		Email: "admin@example.com", Name: "Admin", Password: "passw0rd!",
	})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(context.Background(), auth.Account, []accounts.TokenRequest{{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil)
	req.AddCookie(&http.Cookie{Name: "claw_admin_token", Value: tokens.Token(accounts.AudienceAdmin).Token})
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("admin status without RBAC = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminCanCreateAndManageUser(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(`{"email":"user@example.com","name":"User","password":"passw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create account status = %d body=%s", rec.Code, rec.Body.String())
	}
	created := decodeUserResponse(t, rec.Body.Bytes())
	userID, ok := created["user_id"].(string)
	if !ok || userID == "" {
		t.Fatalf("missing user_id in create response: %#v", created)
	}
	if _, exists := created["role"]; exists {
		t.Fatalf("created account still contains legacy role: %#v", created)
	}
	if created["status"] != accounts.StatusActive {
		t.Fatalf("created status = %#v, want active", created["status"])
	}
	if _, ok := created["PasswordHash"]; ok {
		t.Fatalf("create response leaked PasswordHash: %#v", created)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/accounts", strings.NewReader(`{"user_id":"`+userID+`","name":"  新昵称  "}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update name status = %d body=%s", rec.Code, rec.Body.String())
	}
	renamed := decodeUserResponse(t, rec.Body.Bytes())
	if renamed["name"] != "新昵称" {
		t.Fatalf("updated name = %#v, want 新昵称", renamed["name"])
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/accounts", strings.NewReader(`{"user_id":"`+userID+`","name":"   "}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "账户昵称不能为空") {
		t.Fatalf("blank name status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/accounts", strings.NewReader(`{"user_id":"`+userID+`","status":"disabled"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status status = %d body=%s", rec.Code, rec.Body.String())
	}
	disabled := decodeUserResponse(t, rec.Body.Bytes())
	if disabled["status"] != accounts.StatusDisabled {
		t.Fatalf("updated status = %#v, want disabled", disabled["status"])
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/accounts", nil)
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list accounts status = %d body=%s", rec.Code, rec.Body.String())
	}
	items := unwrapAPIListMaps(t, rec.Body.Bytes())
	if len(items) != 2 {
		t.Fatalf("listed accounts = %d, want 2: %#v", len(items), items)
	}
	for _, item := range items {
		if _, ok := item["PasswordHash"]; ok {
			t.Fatalf("list response leaked PasswordHash: %#v", item)
		}
		if _, ok := item["password_hash"]; ok {
			t.Fatalf("list response leaked password_hash: %#v", item)
		}
	}
}

func TestAdminCanResetAccountPasswordAndInvalidateSessions(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(`{"email":"user@example.com","name":"User","password":"oldpassw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create account status = %d body=%s", rec.Code, rec.Body.String())
	}
	created := decodeUserResponse(t, rec.Body.Bytes())
	userID := created["user_id"].(string)

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"user@example.com","password":"oldpassw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("old password login status = %d body=%s", rec.Code, rec.Body.String())
	}
	userCookie := rec.Result().Cookies()[0]

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/password/reset", strings.NewReader(`{"user_id":"`+userID+`","password":"newpassw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reset password status = %d body=%s", rec.Code, rec.Body.String())
	}
	reset := decodeUserResponse(t, rec.Body.Bytes())
	if reset["user_id"] != userID {
		t.Fatalf("reset user_id = %#v, want %q", reset["user_id"], userID)
	}
	for _, secretKey := range []string{"PasswordHash", "password_hash", "password"} {
		if _, ok := reset[secretKey]; ok {
			t.Fatalf("reset response leaked %s: %#v", secretKey, reset)
		}
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(userCookie)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("old session me status = %d body=%s, want 401", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"user@example.com","password":"oldpassw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("old password login after reset status = %d body=%s, want 401", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"user@example.com","password":"newpassw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("new password login status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminResetAccountPasswordValidatesRequest(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/password/reset", strings.NewReader(`{"user_id":"missing","password":"newpassw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing reset status = %d body=%s, want 404", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/password/reset", strings.NewReader(`{"user_id":"missing","password":"short"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("short password reset status = %d body=%s, want 400", rec.Code, rec.Body.String())
	}
}

func TestAdminAccountWriteRoutesRejectAccountID(t *testing.T) {
	for _, tc := range []struct {
		name   string
		method string
		path   string
		status int
		body   func(string) string
	}{
		{
			name:   "update status",
			method: http.MethodPatch,
			path:   "/api/v1/admin/accounts",
			status: http.StatusBadRequest,
			body:   func(userID string) string { return `{"account_id":"` + userID + `","status":"disabled"}` },
		},
		{
			name:   "reset password",
			method: http.MethodPost,
			path:   "/api/v1/admin/accounts/password/reset",
			status: http.StatusBadRequest,
			body:   func(userID string) string { return `{"account_id":"` + userID + `","password":"newpassw0rd!"}` },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			accountSvc := newTestAccountService(accounts.NewMemoryStore())
			router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountSvc})
			adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(`{"email":"user@example.com","name":"User","password":"oldpassw0rd!"}`))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(adminCookie(t, adminCookies))
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusCreated {
				t.Fatalf("create account status = %d body=%s", rec.Code, rec.Body.String())
			}
			userID := decodeUserResponse(t, rec.Body.Bytes())["user_id"].(string)

			rec = httptest.NewRecorder()
			req = httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body(userID)))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(adminCookie(t, adminCookies))
			router.ServeHTTP(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("legacy account_id status = %d body=%s, want %d", rec.Code, rec.Body.String(), tc.status)
			}
		})
	}
}

func TestAdminListAccountsIncludesBoundAgentSummary(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	proxyGateway := testProxyGateway(proxyStore)
	router := newTestRouter(t, server.Options{
		ProxyGateway:   proxyGateway,
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","name":"Admin","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(`{"email":"user@example.com","name":"User","password":"passw0rd!","status":"active"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create account status = %d body=%s", rec.Code, rec.Body.String())
	}
	created := decodeUserResponse(t, rec.Body.Bytes())
	userID := created["user_id"].(string)
	if err := proxyGateway.CreateOwnedAgent(context.Background(), userID, mcpgateway.AgentRegistration{
		AgentID: "user-list-agent", ClientID: "user-list-client", Name: "User", ActorID: userID, Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatalf("create explicit agent: %v", err)
	}
	if err := accountSvc.BindAgent(context.Background(), userID, "user-list-agent"); err != nil {
		t.Fatalf("bind explicit agent: %v", err)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/accounts", nil)
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list accounts status = %d body=%s", rec.Code, rec.Body.String())
	}
	items := unwrapAPIListMaps(t, rec.Body.Bytes())
	for _, item := range items {
		if item["user_id"] != userID {
			continue
		}
		agent, ok := item["agent"].(map[string]any)
		if !ok {
			t.Fatalf("created account agent summary missing: %#v", item)
		}
		if agent["agent_id"] != "user-list-agent" {
			t.Fatalf("agent_id = %#v, want explicit account agent", agent["agent_id"])
		}
		if agent["client_id"] != "user-list-client" {
			t.Fatalf("client_id = %#v, want explicit client", agent["client_id"])
		}
		if agent["name"] != "User" {
			t.Fatalf("agent name = %#v, want User", agent["name"])
		}
		if agent["actor_id"] != userID {
			t.Fatalf("agent actor_id = %#v, want %q", agent["actor_id"], userID)
		}
		if agent["status"] != mcpgateway.StatusActive {
			t.Fatalf("agent status = %#v, want active", agent["status"])
		}
		for _, secretKey := range []string{"password_hash", "PasswordHash", "token", "plaintext", "TokenCiphertext", "token_ciphertext"} {
			if _, ok := item[secretKey]; ok {
				t.Fatalf("account response leaked %s: %#v", secretKey, item)
			}
			if _, ok := agent[secretKey]; ok {
				t.Fatalf("agent summary leaked %s: %#v", secretKey, agent)
			}
		}
		return
	}
	t.Fatalf("missing created account %q in %#v", userID, items)
}

func TestAdminListAccountsShowsNullAgentForUnboundAccounts(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	userIDs := make(map[string]bool)
	for _, body := range []string{
		`{"email":"active@example.com","name":"Active","password":"passw0rd!","status":"active"}`,
		`{"email":"disabled@example.com","name":"Disabled","password":"passw0rd!","status":"disabled"}`,
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(adminCookie(t, adminCookies))
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create unbound account status = %d body=%s", rec.Code, rec.Body.String())
		}
		userIDs[decodeUserResponse(t, rec.Body.Bytes())["user_id"].(string)] = true
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/accounts", nil)
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list accounts status = %d body=%s", rec.Code, rec.Body.String())
	}
	items := unwrapAPIListMaps(t, rec.Body.Bytes())
	for _, item := range items {
		userID, _ := item["user_id"].(string)
		if !userIDs[userID] {
			continue
		}
		if item["agent"] != nil {
			t.Fatalf("unbound account %q agent = %#v, want nil", userID, item["agent"])
		}
		delete(userIDs, userID)
	}
	if len(userIDs) != 0 {
		t.Fatalf("missing unbound accounts %#v in %#v", userIDs, items)
	}
}

func TestAdminCreateActiveAccountLeavesAgentNull(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(proxyStore),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(`{"email":"admin2@example.com","name":"Admin Two","password":"passw0rd!","status":"active"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create admin account status = %d body=%s", rec.Code, rec.Body.String())
	}
	created := decodeUserResponse(t, rec.Body.Bytes())
	userID, ok := created["user_id"].(string)
	if !ok || userID == "" {
		t.Fatalf("missing created admin user_id: %#v", created)
	}
	if created["agent"] != nil {
		t.Fatalf("created active account agent = %#v, want nil", created["agent"])
	}
	agents, err := proxyStore.ListAgents(context.Background(), mcpgateway.AgentFilter{})
	if err != nil || len(agents) != 0 {
		t.Fatalf("stored agents = %#v, %v", agents, err)
	}
}

func TestAdminCreateDisabledAccountDoesNotCreatePersonalAgent(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(proxyStore),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(`{"email":"disabled@example.com","name":"Disabled User","password":"passw0rd!","status":"disabled"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create disabled account status = %d body=%s", rec.Code, rec.Body.String())
	}
	created := decodeUserResponse(t, rec.Body.Bytes())
	userID, ok := created["user_id"].(string)
	if !ok || userID == "" {
		t.Fatalf("missing disabled user_id: %#v", created)
	}
	agentID := "user_" + userID + "_agent"
	if agent, err := proxyStore.GetAgent(context.Background(), agentID); err == nil {
		t.Fatalf("disabled account agent = %#v, want none", agent)
	} else if !errors.Is(err, mcpgateway.ErrAgentNotFound) {
		t.Fatalf("load disabled account agent: %v", err)
	}
	if boundAgentID, err := accountSvc.PrimaryAgentID(context.Background(), userID); err == nil {
		t.Fatalf("disabled account bound agent = %q, want none", boundAgentID)
	} else if !errors.Is(err, accounts.ErrAccountAgentNotFound) {
		t.Fatalf("load disabled account bound agent: %v", err)
	}
}

func TestAdminEnableDisabledAccountDoesNotCreateAgent(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(proxyStore),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(`{"email":"disabled@example.com","name":"Disabled User","password":"passw0rd!","status":"disabled"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create disabled account status = %d body=%s", rec.Code, rec.Body.String())
	}
	created := decodeUserResponse(t, rec.Body.Bytes())
	userID := created["user_id"].(string)

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/accounts", strings.NewReader(`{"user_id":"`+userID+`","status":"active"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("enable account status = %d body=%s", rec.Code, rec.Body.String())
	}
	enabled := decodeUserResponse(t, rec.Body.Bytes())
	if enabled["status"] != accounts.StatusActive {
		t.Fatalf("enabled status = %#v, want active", enabled["status"])
	}
	if enabled["agent"] != nil {
		t.Fatalf("enabled account agent = %#v, want nil", enabled["agent"])
	}
	agents, err := proxyStore.ListAgents(context.Background(), mcpgateway.AgentFilter{})
	if err != nil || len(agents) != 0 {
		t.Fatalf("stored agents = %#v, %v", agents, err)
	}
	if boundAgentID, err := accountSvc.PrimaryAgentID(context.Background(), userID); err == nil {
		t.Fatalf("enabled account bound agent = %q, want none", boundAgentID)
	} else if !errors.Is(err, accounts.ErrAccountAgentNotFound) {
		t.Fatalf("load enabled account bound agent: %v", err)
	}
}

func TestDisabledAccountCannotLogin(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts", strings.NewReader(`{"email":"disabled@example.com","name":"Disabled User","password":"passw0rd!","status":"disabled"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create disabled account status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"disabled@example.com","password":"passw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled login status = %d body=%s, want 401", rec.Code, rec.Body.String())
	}
}

func TestAdminCannotDisableLastAdmin(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(frontendCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("me status = %d body=%s", rec.Code, rec.Body.String())
	}
	var meResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &meResp); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	adminID := nestedString(t, meResp, "data", "account", "user_id")

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/accounts", strings.NewReader(`{"user_id":"`+adminID+`","status":"disabled"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("disable last admin status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestNormalUserCannotListAccounts(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/accounts", nil)
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("list accounts status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminAgentListIncludesBoundUserFields(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(proxyStore),
		AccountService: accountSvc,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","name":"User","password":"passw0rd!"}`)
	createWebAgent(t, router, userCookies, "user-admin-list-agent")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("user me status = %d body=%s", rec.Code, rec.Body.String())
	}
	var meResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &meResp); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	userID := nestedString(t, meResp, "data", "account", "user_id")
	agentID := "user-admin-list-agent"

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/agents", nil)
	req.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list agents status = %d body=%s", rec.Code, rec.Body.String())
	}
	items := unwrapAPIListMaps(t, rec.Body.Bytes())
	for _, item := range items {
		if item["agent_id"] != agentID {
			continue
		}
		if item["bound_user_id"] != userID {
			t.Fatalf("bound_user_id = %#v, want %q in %#v", item["bound_user_id"], userID, item)
		}
		if item["bound_user_name"] != "User" {
			t.Fatalf("bound_user_name = %#v, want User in %#v", item["bound_user_name"], item)
		}
		if item["bound_user_email"] != "user@example.com" {
			t.Fatalf("bound_user_email = %#v, want user@example.com in %#v", item["bound_user_email"], item)
		}
		return
	}
	t.Fatalf("missing bound user agent %q in %#v", agentID, items)
}

func TestNormalUserCanViewOwnAgentTokenAndTools(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	proxyGateway := testProxyGateway(proxyStore)
	router := newTestRouter(t, server.Options{
		ProxyGateway:   proxyGateway,
		AccountService: accountSvc,
	})
	register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)
	createWebAgent(t, router, userCookies, "user-tools-agent")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/agents/detail", nil)
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("agent me status = %d body=%s", rec.Code, rec.Body.String())
	}
	var meResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &meResp); err != nil {
		t.Fatalf("decode agent me response: %v", err)
	}
	agentID := nestedString(t, meResp, "data", "agent", "agent_id")
	userID := nestedString(t, meResp, "data", "account", "user_id")
	if agentID != "user-tools-agent" {
		t.Fatalf("agent id = %q, want explicit user agent", agentID)
	}
	if status := nestedString(t, meResp, "data", "agent", "status"); status != mcpgateway.StatusActive {
		t.Fatalf("agent status = %q, want active", status)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/app/mcp/token", nil)
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("agent token status = %d body=%s", rec.Code, rec.Body.String())
	}
	var tokenResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &tokenResp); err != nil {
		t.Fatalf("decode token response: %v", err)
	}
	data, ok := tokenResp["data"].(map[string]any)
	if !ok {
		t.Fatalf("missing token data: %#v", tokenResp)
	}
	token, ok := data["token"].(map[string]any)
	if !ok {
		t.Fatalf("missing token response: %#v", tokenResp)
	}
	if token["user_id"] != userID {
		t.Fatalf("token user = %#v, want %q", token["user_id"], userID)
	}
	if _, ok := data["plaintext"]; ok {
		t.Fatalf("metadata response leaked plaintext: %#v", tokenResp)
	}
	assertNoSensitiveTokenFields(t, token)

	if err := proxyStore.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{ID: "user-crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save upstream server: %v", err)
	}
	granted := mcpgateway.Capability{ID: "cap_granted", UpstreamServerID: "user-crm", Type: mcpgateway.CapabilityTool, ExposedName: "crm.customer.search", UpstreamName: "customer.search", Status: mcpgateway.StatusActive}
	ungranted := mcpgateway.Capability{ID: "cap_ungranted", UpstreamServerID: "user-crm", Type: mcpgateway.CapabilityTool, ExposedName: "crm.customer.delete", UpstreamName: "customer.delete", Status: mcpgateway.StatusActive}
	if err := proxyStore.SaveCapability(ctx, granted); err != nil {
		t.Fatalf("save granted capability: %v", err)
	}
	if err := proxyStore.SaveCapability(ctx, ungranted); err != nil {
		t.Fatalf("save ungranted capability: %v", err)
	}
	if err := proxyStore.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_user_tool", UserID: userID, CapabilityID: granted.ID, GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatalf("save grant: %v", err)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/app/agents/tools?agent_id="+agentID, nil)
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("agent tools status = %d body=%s", rec.Code, rec.Body.String())
	}
	tools := unwrapAPIListMaps(t, rec.Body.Bytes())
	if len(tools) != 1 || tools[0]["exposed_name"] != "crm.customer.search" {
		t.Fatalf("tools = %#v, want only granted tool", tools)
	}
}

func TestNormalUserCanRotateAndCopyOwnAgentToken(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	proxyGateway := testProxyGateway(proxyStore)
	router := newTestRouter(t, server.Options{
		ProxyGateway:   proxyGateway,
		AccountService: accountSvc,
	})
	register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)
	createWebAgent(t, router, userCookies, "user-token-agent")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/agents/detail", nil)
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("agent me status = %d body=%s", rec.Code, rec.Body.String())
	}
	var meResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &meResp); err != nil {
		t.Fatalf("decode agent me response: %v", err)
	}
	userID := nestedString(t, meResp, "data", "account", "user_id")

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/app/mcp/token/reveal", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("copy token status = %d body=%s", rec.Code, rec.Body.String())
	}
	copyResp := decodeUserResponse(t, rec.Body.Bytes())
	oldPlaintext, _ := copyResp["token"].(string)
	if oldPlaintext == "" || copyResp["authorization_header"] != "Authorization: Bearer "+oldPlaintext {
		t.Fatalf("copy response = %#v", copyResp)
	}
	for _, removed := range []string{"plaintext", "mcp_config", "agent_id"} {
		if _, ok := copyResp[removed]; ok {
			t.Fatalf("copy response retains %s: %#v", removed, copyResp)
		}
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/app/mcp/token/rotate", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate token status = %d body=%s", rec.Code, rec.Body.String())
	}
	rotateResp := decodeTokenSecretResponse(t, rec.Body.Bytes())
	newPlaintext := rotateResp["plaintext"].(string)
	if newPlaintext == "" || newPlaintext == oldPlaintext {
		t.Fatalf("new plaintext = %q, old = %q", newPlaintext, oldPlaintext)
	}
	if rotateResp["authorization_header"] != "Authorization: Bearer "+newPlaintext {
		t.Fatalf("rotate authorization_header = %#v", rotateResp["authorization_header"])
	}
	assertNoSensitiveTokenFields(t, rotateResp["token"].(map[string]any))
	if _, err := proxyStore.GetAccountTokenByHash(ctx, mcpgateway.HashToken(oldPlaintext)); err == nil {
		oldToken, getErr := proxyStore.GetAccountTokenByHash(ctx, mcpgateway.HashToken(oldPlaintext))
		if getErr != nil {
			t.Fatalf("reload old token: %v", getErr)
		}
		if oldToken.Status != mcpgateway.StatusRevoked {
			t.Fatalf("old token status = %q, want revoked", oldToken.Status)
		}
	} else {
		t.Fatalf("old token missing after rotate: %v", err)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/app/mcp/token/revoke", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke token status = %d body=%s", rec.Code, rec.Body.String())
	}
	var revokeResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &revokeResp); err != nil {
		t.Fatalf("decode revoke response: %v", err)
	}
	if nestedString(t, revokeResp, "data", "token_status") != mcpgateway.StatusRevoked {
		t.Fatalf("revoke token status field = %#v, want revoked", revokeResp)
	}
	if active, err := proxyStore.GetActiveAccountToken(ctx, userID); err == nil {
		t.Fatalf("active token after revoke = %#v, want none", active)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/app/mcp/token", nil)
	req.AddCookie(userCookies[0])
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("token metadata after revoke status = %d body=%s", rec.Code, rec.Body.String())
	}
	var metadataAfterRevoke map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &metadataAfterRevoke); err != nil {
		t.Fatalf("decode token metadata after revoke: %v", err)
	}
	if nestedString(t, metadataAfterRevoke, "data", "token", "token_status") != mcpgateway.StatusRevoked {
		t.Fatalf("metadata token status after revoke = %#v, want revoked", metadataAfterRevoke)
	}
}

func register(t *testing.T, router http.Handler, body string) []*http.Cookie {
	t.Helper()
	body = registrationBodyWithDefaultName(t, body)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("register status = %d body=%s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatalf("missing session cookie")
	}
	return cookies
}

func createWebAgent(t *testing.T, router http.Handler, cookies []*http.Cookie, agentID string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/app/agents", strings.NewReader(`{"agent_id":"`+agentID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(frontendCookie(t, cookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create agent status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/app/mcp/token/rotate", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(frontendCookie(t, cookies))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create account token status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func registrationBodyWithDefaultName(t *testing.T, body string) string {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("decode registration body: %v", err)
	}
	name, _ := payload["name"].(string)
	if strings.TrimSpace(name) == "" {
		email, _ := payload["email"].(string)
		payload["name"] = strings.TrimSpace(email)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode registration body: %v", err)
	}
	return string(raw)
}

func performRegister(router http.Handler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	return rec
}

func testProxyGateway(store mcpgateway.Store) *mcpgateway.Service {
	return configureTestIdentityResolvers(mcpgateway.NewService(mcpgateway.Config{
		Store:       store,
		TokenCipher: mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef")),
	}))
}

func decodeUserResponse(t *testing.T, body []byte) map[string]any {
	t.Helper()

	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode user response: %v", err)
	}
	if data, ok := resp["data"].(map[string]any); ok {
		return data
	}
	return resp
}

func decodeTokenSecretResponse(t *testing.T, body []byte) map[string]any {
	t.Helper()

	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode token secret response: %v", err)
	}
	if data, ok := resp["data"].(map[string]any); ok {
		resp = data
	}
	plaintext, ok := resp["token"].(string)
	if !ok || plaintext == "" {
		t.Fatalf("missing plaintext in response: %#v", resp)
	}
	header, ok := resp["authorization_header"].(string)
	if !ok || header == "" {
		t.Fatalf("missing authorization_header in response: %#v", resp)
	}
	metadata, ok := resp["token_info"].(map[string]any)
	if !ok {
		t.Fatalf("missing token metadata in response: %#v", resp)
	}
	resp["plaintext"] = plaintext
	resp["token"] = metadata
	return resp
}

func assertNoSensitiveTokenFields(t *testing.T, token map[string]any) {
	t.Helper()
	for _, key := range []string{"TokenHash", "token_hash", "tokenHash", "TokenCiphertext", "token_ciphertext", "tokenCiphertext"} {
		if _, ok := token[key]; ok {
			t.Fatalf("token metadata leaked %s: %#v", key, token)
		}
	}
}
