package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
)

const testJWTKey = "01234567890123456789012345678901"

func TestWebLoginIssuesAudienceCookiesWithoutReturningJWT(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, registration.Account.UserID); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		SessionCookieName: "claw_front_token", AdminSessionCookieName: "claw_admin_token", SessionCookieSecure: true,
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"admin@example.com","password":"passw0rd!"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	data, ok := body["data"].(map[string]any)
	if !ok || data["redirect_to"] != "/admin" {
		t.Fatalf("login body = %#v", body)
	}
	if strings.Contains(rec.Body.String(), "eyJ") || data["access_token"] != nil {
		t.Fatalf("web login returned JWT: %s", rec.Body.String())
	}
	applications, _ := data["applications"].(map[string]any)
	if applications["frontend"] != true || applications["admin"] != true {
		t.Fatalf("applications = %#v", applications)
	}
	cookies := cookieMap(rec.Result().Cookies())
	for _, name := range []string{"claw_front_token", "claw_admin_token"} {
		cookie := cookies[name]
		if cookie == nil || cookie.Value == "" || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
			t.Fatalf("cookie %s = %#v", name, cookie)
		}
	}
	if _, err := accountSvc.AuthenticateToken(ctx, cookies["claw_front_token"].Value, accounts.AudienceFrontend); err != nil {
		t.Fatalf("frontend cookie token: %v", err)
	}
	if _, err := accountSvc.AuthenticateToken(ctx, cookies["claw_admin_token"].Value, accounts.AudienceAdmin); err != nil {
		t.Fatalf("admin cookie token: %v", err)
	}
}

func TestWebLoginClearsPreviousAdminCookieForNormalAccount(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	admin, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, admin.Account.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "user@example.com", Name: "User", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		SessionCookieName: "claw_front_token", AdminSessionCookieName: "claw_admin_token", SessionCookieSecure: true,
	})

	adminLogin := httptest.NewRecorder()
	adminRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"admin@example.com","password":"passw0rd!"}`))
	adminRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(adminLogin, adminRequest)
	if adminLogin.Code != http.StatusOK {
		t.Fatalf("admin login status = %d body=%s", adminLogin.Code, adminLogin.Body.String())
	}
	oldAdminCookie := cookieMap(adminLogin.Result().Cookies())["claw_admin_token"]
	if oldAdminCookie == nil || oldAdminCookie.Value == "" {
		t.Fatalf("admin login cookie = %#v", oldAdminCookie)
	}

	userLogin := httptest.NewRecorder()
	userRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"user@example.com","password":"passw0rd!"}`))
	userRequest.Header.Set("Content-Type", "application/json")
	userRequest.AddCookie(oldAdminCookie)
	router.ServeHTTP(userLogin, userRequest)
	if userLogin.Code != http.StatusOK {
		t.Fatalf("user login status = %d body=%s", userLogin.Code, userLogin.Body.String())
	}
	clearedAdminCookie := cookieMap(userLogin.Result().Cookies())["claw_admin_token"]
	if clearedAdminCookie == nil || clearedAdminCookie.Value != "" || clearedAdminCookie.MaxAge != -1 ||
		!clearedAdminCookie.HttpOnly || !clearedAdminCookie.Secure || clearedAdminCookie.SameSite != http.SameSiteLaxMode || clearedAdminCookie.Path != "/" {
		t.Fatalf("cleared admin cookie = %#v", clearedAdminCookie)
	}
}

func TestAppClientLoginReturnsOnlyFrontendBearer(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "app-client@example.com", Name: "App Client", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, registration.Account.UserID); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc})

	for _, clientID := range []string{accounts.ClientElectron} {
		t.Run(clientID, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"app-client@example.com","password":"passw0rd!","client_id":"`+clientID+`"}`))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("login status = %d body=%s", rec.Code, rec.Body.String())
			}
			if len(rec.Result().Cookies()) != 0 {
				t.Fatalf("cookies = %#v, want none", rec.Result().Cookies())
			}
			var body struct {
				Data struct {
					AccessToken string    `json:"access_token"`
					TokenType   string    `json:"token_type"`
					ExpiresAt   time.Time `json:"expires_at"`
				} `json:"data"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Data.AccessToken == "" || body.Data.TokenType != "Bearer" || body.Data.ExpiresAt.IsZero() {
				t.Fatalf("response = %#v", body.Data)
			}
			identity, err := accountSvc.AuthenticateToken(ctx, body.Data.AccessToken, accounts.AudienceFrontend)
			if err != nil {
				t.Fatal(err)
			}
			if identity.Principal.ClientID != clientID {
				t.Fatalf("client_id = %q, want %q", identity.Principal.ClientID, clientID)
			}

			rec = httptest.NewRecorder()
			req = httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
			req.Header.Set("Authorization", "Bearer "+body.Data.AccessToken)
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("me status = %d body=%s", rec.Code, rec.Body.String())
			}

			rec = httptest.NewRecorder()
			req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil)
			req.Header.Set("Authorization", "Bearer "+body.Data.AccessToken)
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("admin status = %d, want 401; body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestClaweeRegisterAndLoginBindStableAgent(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	proxyGateway := testProxyGateway(proxyStore)
	collectorStore := &captureManagementStoreForRouteTest{}
	router := newTestRouter(t, server.Options{
		AccountService:      accountSvc,
		RBACService:         rbacSvc,
		ProxyGateway:        proxyGateway,
		OfficeManagementAPI: httpapi.NewManagementAPIWithOptions(collectorStore, nil, httpapi.ManagementAPIOptions{PublicBaseURL: "https://collectors.example.com"}),
	})
	agentID := "local-agent-1"

	register := httptest.NewRecorder()
	registerReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"clawee@example.com","name":"Clawee User","password":"passw0rd!","client_id":"clawee-agent","agent_id":"`+agentID+`"}`))
	registerReq.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(register, registerReq)
	if register.Code != http.StatusOK {
		t.Fatalf("register status = %d body=%s", register.Code, register.Body.String())
	}
	if len(register.Result().Cookies()) != 0 || strings.Contains(register.Body.String(), "access_token") {
		t.Fatalf("clawee register issued login state: cookies=%#v body=%s", register.Result().Cookies(), register.Body.String())
	}
	if !strings.Contains(register.Body.String(), `"agent_id":"`+agentID+`"`) {
		t.Fatalf("register body missing agent: %s", register.Body.String())
	}
	account, err := accountSvc.AuthenticateCredentials(ctx, accounts.LoginRequest{Email: "clawee@example.com", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := accountSvc.AccountForAgent(ctx, agentID)
	if err != nil || owner.UserID != account.UserID {
		t.Fatalf("agent owner = %#v err=%v", owner, err)
	}
	if _, err := proxyStore.GetActiveAccountToken(ctx, account.UserID); !errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
		t.Fatalf("clawee registration changed account token: %v", err)
	}

	login := loginClawee(t, router, "clawee@example.com", "passw0rd!", agentID)
	if login.Status != http.StatusOK || login.AccessToken == "" || login.AgentID != agentID {
		t.Fatalf("login = %#v", login)
	}
	identity, err := accountSvc.AuthenticateToken(ctx, login.AccessToken, accounts.AudienceFrontend)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Principal.AgentID != agentID || identity.Session.AgentID != agentID {
		t.Fatalf("identity = %#v", identity)
	}

	second := loginClawee(t, router, "clawee@example.com", "passw0rd!", agentID)
	if second.Status != http.StatusOK {
		t.Fatalf("second login = %#v", second)
	}
	if _, err := proxyStore.GetActiveAccountToken(ctx, account.UserID); !errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
		t.Fatalf("clawee login changed account token: %v", err)
	}

	me := httptest.NewRecorder()
	meReq := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+login.AccessToken)
	router.ServeHTTP(me, meReq)
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"agent_id":"`+agentID+`"`) {
		t.Fatalf("me status = %d body=%s", me.Code, me.Body.String())
	}
	if strings.Contains(me.Body.String(), "collector_registration") {
		t.Fatalf("me body exposed collector registration: %s", me.Body.String())
	}
	if collectorStore.ensureCalls != 0 {
		t.Fatalf("unexpected collector ensure call: %#v", collectorStore)
	}
}

func TestWebMeDoesNotEnsureCollectorRegistrationCode(t *testing.T) {
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	collectorStore := &captureManagementStoreForRouteTest{}
	router := newTestRouter(t, server.Options{
		AccountService:      accountSvc,
		RBACService:         rbacSvc,
		ProxyGateway:        testProxyGateway(mcpgateway.NewMemoryStore()),
		OfficeManagementAPI: httpapi.NewManagementAPI(collectorStore, nil),
	})
	cookies := register(t, router, `{"email":"web@example.com","name":"Web User","password":"passw0rd!"}`)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(frontendCookie(t, cookies))
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("me status = %d body=%s", rec.Code, rec.Body.String())
	}
	if collectorStore.ensureCalls != 0 || strings.Contains(rec.Body.String(), "collector_registration") {
		t.Fatalf("web me exposed collector registration: calls=%d body=%s", collectorStore.ensureCalls, rec.Body.String())
	}
}

func TestClaweeAuthRejectsInvalidAgentIDBeforePersistence(t *testing.T) {
	for _, agentField := range []string{"", `,"agent_id":"   "`, `,"agent_id":"` + strings.Repeat("a", 65) + `"`} {
		t.Run(agentField, func(t *testing.T) {
			store := &countingAuthStore{MemoryStore: accounts.NewMemoryStore()}
			accountSvc := accounts.NewService(accounts.Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey)})
			rbacStore := rbac.NewMemoryStore()
			rbacSvc := rbac.NewService(rbac.Config{Store: rbacStore, Accounts: accountSvc})
			if err := rbacSvc.Initialize(context.Background()); err != nil {
				t.Fatal(err)
			}
			proxyStore := mcpgateway.NewMemoryStore()
			router := newTestRouter(t, server.Options{AccountService: accountSvc, RBACService: rbacSvc, ProxyGateway: testProxyGateway(proxyStore)})

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"invalid@example.com","name":"Invalid","password":"passw0rd!","client_id":"clawee-agent"`+agentField+`}`))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(rec, req)
			var response struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode registration response: %v body=%s", err, rec.Body.String())
			}
			if rec.Code != http.StatusBadRequest || response.Error.Code != "invalid_agent_id" {
				t.Fatalf("register status=%d body=%s", rec.Code, rec.Body.String())
			}
			accountsAfter, err := accountSvc.ListAccounts(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if len(accountsAfter) != 0 {
				t.Fatalf("accounts after invalid registration = %#v, want none", accountsAfter)
			}
			if agents, err := proxyStore.ListAgents(context.Background(), mcpgateway.AgentFilter{}); err != nil || len(agents) != 0 {
				t.Fatalf("agents after invalid registration = %#v err=%v, want none", agents, err)
			}
			adminCount, err := rbacStore.CountRoleAccounts(context.Background(), rbac.AdminRoleID)
			if err != nil {
				t.Fatal(err)
			}
			if adminCount != 0 {
				t.Fatalf("admin bindings after invalid registration = %d, want 0", adminCount)
			}
		})
	}

	store := &countingAuthStore{MemoryStore: accounts.NewMemoryStore()}
	accountSvc := accounts.NewService(accounts.Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey)})
	if _, err := accountSvc.Register(context.Background(), accounts.RegisterRequest{Email: "existing@example.com", Name: "Existing", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}
	store.sessionSaves = 0
	router := newTestRouter(t, server.Options{AccountService: accountSvc, ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore())})
	for _, agentID := range []string{"", "   ", strings.Repeat("a", 65)} {
		login := loginClawee(t, router, "existing@example.com", "passw0rd!", agentID)
		if login.Status != http.StatusBadRequest || login.ErrorCode != "invalid_agent_id" || store.sessionSaves != 0 {
			t.Fatalf("agent_id=%q login=%#v session saves=%d", agentID, login, store.sessionSaves)
		}
	}
}

func TestClaweeAuthRequiresProvisioningService(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	proxyGateway := testProxyGateway(proxyStore)
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc, ProxyGateway: proxyGateway})

	register := httptest.NewRecorder()
	registerReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"missing-provisioner@example.com","name":"Missing Provisioner","password":"passw0rd!","client_id":"clawee-agent","agent_id":"missing-provisioner-agent"}`))
	registerReq.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(register, registerReq)
	if register.Code != http.StatusInternalServerError || !strings.Contains(register.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("register status=%d body=%s", register.Code, register.Body.String())
	}
	accountsAfterRegister, err := accountSvc.ListAccounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(accountsAfterRegister) != 0 {
		t.Fatalf("accounts after registration failure = %#v, want none", accountsAfterRegister)
	}

	account, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "existing@example.com", Name: "Existing", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	login := loginClawee(t, router, account.Account.Email, "passw0rd!", "missing-provisioner-agent")
	if login.Status != http.StatusInternalServerError || login.ErrorCode != "internal_error" {
		t.Fatalf("login = %#v", login)
	}
	if _, err := proxyStore.GetAgent(ctx, "missing-provisioner-agent"); !errors.Is(err, mcpgateway.ErrAgentNotFound) {
		t.Fatalf("agent after login failure error = %v, want ErrAgentNotFound", err)
	}
}

func TestClaweeRegistrationConflictRollsBackAccountAndRBAC(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "owner@example.com", Name: "Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, owner.Account.UserID); err != nil {
		t.Fatal(err)
	}
	proxyGateway := testProxyGateway(newClaweeOwnedAgentStore(accountSvc))
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "existing-agent")
	router := newTestRouter(t, server.Options{AccountService: accountSvc, RBACService: rbacSvc, ProxyGateway: proxyGateway})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"new@example.com","name":"New User","password":"passw0rd!","client_id":"clawee-agent","agent_id":"existing-agent"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"agent_id_conflict"`) {
		t.Fatalf("register status=%d body=%s", rec.Code, rec.Body.String())
	}
	accountsAfter, err := accountSvc.ListAccounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(accountsAfter) != 1 || accountsAfter[0].UserID != owner.Account.UserID {
		t.Fatalf("accounts after rollback = %#v", accountsAfter)
	}
}

func TestClaweeRegistrationAccountRollbackFailureReturnsInternalError(t *testing.T) {
	ctx := context.Background()
	accountStore := &registrationDeleteFailureStore{MemoryStore: accounts.NewMemoryStore()}
	accountSvc := accounts.NewService(accounts.Config{Store: accountStore, SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey)})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "owner@example.com", Name: "Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	proxyGateway := testProxyGateway(proxyStore)
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "existing-agent")
	rollbackErr := errors.New("delete account rollback failed")
	accountStore.deleteErr = rollbackErr
	core, logs := observer.New(zap.ErrorLevel)
	router := newTestRouter(t, server.Options{
		AccountService: accountSvc, RBACService: rbacSvc, ProxyGateway: proxyGateway, Logger: zap.New(core),
	})

	rec := performRegister(router, `{"email":"new@example.com","name":"New User","password":"passw0rd!","client_id":"clawee-agent","agent_id":"existing-agent"}`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("register status=%d body=%s", rec.Code, rec.Body.String())
	}
	if accountStore.deleteCalls != 1 {
		t.Fatalf("delete account calls = %d, want 1", accountStore.deleteCalls)
	}
	accountsAfter, err := accountSvc.ListAccounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(accountsAfter) != 2 {
		t.Fatalf("accounts after failed rollback = %#v, want 2", accountsAfter)
	}
	assertInternalErrorLogContains(t, logs, agentprovisioning.ErrAgentIDConflict.Error(), rollbackErr.Error())
}

func TestClaweeRegistrationRBACRollbackFailureReturnsInternalError(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey)})
	rollbackErr := errors.New("remove admin role rollback failed")
	baseRBACStore := rbac.NewMemoryStore()
	rbacStore := &registrationRollbackFailureRBACStore{Store: baseRBACStore, removeErr: rollbackErr}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbacStore, Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	proxyStore := mcpgateway.NewMemoryStore()
	if err := proxyStore.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "orphan-agent", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	core, logs := observer.New(zap.ErrorLevel)
	router := newTestRouter(t, server.Options{
		AccountService: accountSvc, RBACService: rbacSvc, ProxyGateway: testProxyGateway(proxyStore), Logger: zap.New(core),
	})

	rec := performRegister(router, `{"email":"first@example.com","name":"First User","password":"passw0rd!","client_id":"clawee-agent","agent_id":"orphan-agent"}`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("register status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rbacStore.removeCalls != 1 {
		t.Fatalf("RBAC rollback calls = %d, want 1", rbacStore.removeCalls)
	}
	accountsAfter, err := accountSvc.ListAccounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(accountsAfter) != 0 {
		t.Fatalf("accounts after rollback = %#v, want none", accountsAfter)
	}
	adminCount, err := baseRBACStore.CountRoleAccounts(ctx, rbac.AdminRoleID)
	if err != nil {
		t.Fatal(err)
	}
	if adminCount != 1 {
		t.Fatalf("admin bindings after failed rollback = %d, want 1", adminCount)
	}
	assertInternalErrorLogContains(t, logs, agentprovisioning.ErrAgentIDConflict.Error(), rollbackErr.Error())
}

func TestClaweeLoginRejectsConflictingAndDisabledAgent(t *testing.T) {
	ctx := context.Background()
	accountSvc, _ := newJWTAccountAndRBAC(t)
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "owner@example.com", Name: "Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "other@example.com", Name: "Other", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	proxyGateway := testProxyGateway(proxyStore)
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "shared-agent")
	router := newTestRouter(t, server.Options{AccountService: accountSvc, ProxyGateway: proxyGateway})

	conflict := loginClawee(t, router, other.Account.Email, "passw0rd!", "shared-agent")
	if conflict.Status != http.StatusConflict || conflict.ErrorCode != "agent_id_conflict" {
		t.Fatalf("conflict login = %#v", conflict)
	}
	agent, err := proxyStore.GetAgent(ctx, "shared-agent")
	if err != nil {
		t.Fatal(err)
	}
	agent.Status = mcpgateway.StatusDisabled
	if err := proxyStore.SaveAgent(ctx, agent); err != nil {
		t.Fatal(err)
	}
	disabled := loginClawee(t, router, owner.Account.Email, "passw0rd!", "shared-agent")
	if disabled.Status != http.StatusForbidden || disabled.ErrorCode != "agent_forbidden" {
		t.Fatalf("disabled login = %#v", disabled)
	}
}

func TestExistingWebAccountFirstClaweeLoginCreatesBoundAgent(t *testing.T) {
	ctx := context.Background()
	accountSvc, _ := newJWTAccountAndRBAC(t)
	account, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "web-existing@example.com", Name: "Existing", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	router := newTestRouter(t, server.Options{AccountService: accountSvc, ProxyGateway: testProxyGateway(proxyStore)})

	login := loginClawee(t, router, account.Account.Email, "passw0rd!", "new-clawee-agent")
	if login.Status != http.StatusOK || login.AgentID != "new-clawee-agent" {
		t.Fatalf("login = %#v", login)
	}
	owner, err := accountSvc.AccountForAgent(ctx, "new-clawee-agent")
	if err != nil || owner.UserID != account.Account.UserID {
		t.Fatalf("owner = %#v err=%v", owner, err)
	}
	if _, err := proxyStore.GetActiveAccountToken(ctx, account.Account.UserID); !errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
		t.Fatalf("clawee login changed account token: %v", err)
	}
}

func TestClaweeLoginRetriesAfterSessionPersistenceFailure(t *testing.T) {
	ctx := context.Background()
	store := &sessionFailureStore{Store: accounts.NewMemoryStore(), failAt: 1}
	accountSvc := accounts.NewService(accounts.Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey)})
	account, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "retry@example.com", Name: "Retry", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	router := newTestRouter(t, server.Options{AccountService: accountSvc, ProxyGateway: testProxyGateway(proxyStore)})

	first := loginClawee(t, router, account.Account.Email, "passw0rd!", "retry-agent")
	if first.Status != http.StatusInternalServerError {
		t.Fatalf("first login = %#v", first)
	}
	if _, err := proxyStore.GetActiveAccountToken(ctx, account.Account.UserID); !errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
		t.Fatalf("failed login changed account token: %v", err)
	}
	store.failAt = 0
	second := loginClawee(t, router, account.Account.Email, "passw0rd!", "retry-agent")
	if second.Status != http.StatusOK || second.AgentID != "retry-agent" {
		t.Fatalf("second login = %#v", second)
	}
	if _, err := proxyStore.GetActiveAccountToken(ctx, account.Account.UserID); !errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
		t.Fatalf("successful login changed account token: %v", err)
	}
}

func TestConcurrentFirstClaweeLoginReusesOneAgent(t *testing.T) {
	ctx := context.Background()
	accountSvc, _ := newJWTAccountAndRBAC(t)
	account, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "concurrent@example.com", Name: "Concurrent", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	router := newTestRouter(t, server.Options{AccountService: accountSvc, ProxyGateway: testProxyGateway(proxyStore)})

	type result struct {
		status int
		body   string
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"`+account.Account.Email+`","password":"passw0rd!","client_id":"clawee-agent","agent_id":"concurrent-agent"}`))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(rec, req)
			results <- result{status: rec.Code, body: rec.Body.String()}
		}()
	}
	wg.Wait()
	close(results)
	for got := range results {
		if got.status != http.StatusOK {
			t.Fatalf("concurrent login status=%d body=%s", got.status, got.body)
		}
	}
	owner, err := accountSvc.AccountForAgent(ctx, "concurrent-agent")
	if err != nil || owner.UserID != account.Account.UserID {
		t.Fatalf("owner = %#v err=%v", owner, err)
	}
	if _, err := proxyStore.GetActiveAccountToken(ctx, account.Account.UserID); !errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
		t.Fatalf("concurrent login changed account token: %v", err)
	}
}

func TestAudienceCannotCrossFrontendAndAdminAPIs(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, registration.Account.UserID); err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, registration.Account, []accounts.TokenRequest{
		{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb},
		{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb},
	})
	if err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil)
	req.AddCookie(&http.Cookie{Name: "claw_admin_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("frontend JWT on admin API status = %d, want 401", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceAdmin).Token})
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("admin JWT on frontend API status = %d, want 401", rec.Code)
	}
}

func TestWebLogoutRevokesBothSessionsAndClearsCookies(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, registration.Account.UserID); err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, registration.Account, []accounts.TokenRequest{
		{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb},
		{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb},
	})
	if err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc, SessionCookieSecure: true})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	req.AddCookie(&http.Cookie{Name: "claw_admin_token", Value: tokens.Token(accounts.AudienceAdmin).Token})
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d body=%s", rec.Code, rec.Body.String())
	}
	for _, cookie := range rec.Result().Cookies() {
		if cookie.MaxAge != -1 || !cookie.Secure || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("cleared cookie = %#v", cookie)
		}
	}
	if _, err := accountSvc.AuthenticateToken(ctx, tokens.Token(accounts.AudienceFrontend).Token, accounts.AudienceFrontend); err == nil {
		t.Fatal("frontend token remained valid after logout")
	}
	if _, err := accountSvc.AuthenticateToken(ctx, tokens.Token(accounts.AudienceAdmin).Token, accounts.AudienceAdmin); err == nil {
		t.Fatal("admin token remained valid after logout")
	}
}

func TestLogoutRevokesBearerAndCookieSessionsTogether(t *testing.T) {
	ctx := context.Background()
	accountSvc, _ := newJWTAccountAndRBAC(t)
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "user@example.com", Name: "User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	webTokens, err := accountSvc.IssueTokens(ctx, registration.Account, []accounts.TokenRequest{
		{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb},
		{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb},
	})
	if err != nil {
		t.Fatal(err)
	}
	electronTokens, err := accountSvc.IssueTokens(ctx, registration.Account, []accounts.TokenRequest{{
		Audience: accounts.AudienceFrontend, ClientID: accounts.ClientElectron,
	}})
	if err != nil {
		t.Fatal(err)
	}

	router := server.NewRouter(server.Options{AccountService: accountSvc})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	request.Header.Set("Authorization", "Bearer "+electronTokens.Token(accounts.AudienceFrontend).Token)
	request.AddCookie(&http.Cookie{Name: "claw_front_token", Value: webTokens.Token(accounts.AudienceFrontend).Token})
	request.AddCookie(&http.Cookie{Name: "claw_admin_token", Value: webTokens.Token(accounts.AudienceAdmin).Token})
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d body=%s, want 204", recorder.Code, recorder.Body.String())
	}
	for _, test := range []struct {
		token    string
		audience string
	}{
		{electronTokens.Token(accounts.AudienceFrontend).Token, accounts.AudienceFrontend},
		{webTokens.Token(accounts.AudienceFrontend).Token, accounts.AudienceFrontend},
		{webTokens.Token(accounts.AudienceAdmin).Token, accounts.AudienceAdmin},
	} {
		if _, err := accountSvc.AuthenticateToken(ctx, test.token, test.audience); err == nil {
			t.Fatalf("token for %s remained valid after logout", test.audience)
		}
	}
}

func TestAuthClientIDValidation(t *testing.T) {
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	if _, err := accountSvc.Register(context.Background(), accounts.RegisterRequest{Email: "user@example.com", Name: "User", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc, ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore())})
	for _, test := range []struct {
		path string
		body string
	}{
		{"/api/v1/auth/login", `{"email":"user@example.com","password":"passw0rd!","client_id":"unknown"}`},
		{"/api/v1/auth/register", `{"email":"electron-new@example.com","password":"passw0rd!","client_id":"electron"}`},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("POST %s status = %d, want 400; body=%s", test.path, rec.Code, rec.Body.String())
		}
	}
}

func TestWebLoginDoesNotWriteCookiesWhenSecondSessionFails(t *testing.T) {
	ctx := context.Background()
	base := accounts.NewMemoryStore()
	store := &sessionFailureStore{Store: base, failAt: 2}
	accountSvc := accounts.NewService(accounts.Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey)})
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, registration.Account.UserID); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"admin@example.com","password":"passw0rd!"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("login status = %d body=%s, want 500", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "save session failed") {
		t.Fatalf("login response leaked storage error: %s", recorder.Body.String())
	}
	if len(recorder.Result().Cookies()) != 0 {
		t.Fatalf("cookies = %#v, want none", recorder.Result().Cookies())
	}
	if store.saved != 1 || store.deleted != 1 {
		t.Fatalf("session compensation saved=%d deleted=%d, want 1/1", store.saved, store.deleted)
	}
}

func TestRegistrationRollbackContinuesAfterRequestCancellation(t *testing.T) {
	requestContext, cancelRequest := context.WithCancel(context.Background())
	base := accounts.NewMemoryStore()
	store := &sessionFailureStore{Store: base, failAt: 2, cancelOnFail: cancelRequest}
	accountSvc := accounts.NewService(accounts.Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey)})
	rbacStore := rbac.NewMemoryStore()
	rbacSvc := rbac.NewService(rbac.Config{Store: rbacStore, Accounts: accountSvc})
	if err := rbacSvc.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"admin@example.com","name":"Admin","password":"passw0rd!"}`)).WithContext(requestContext)
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("register status = %d body=%s, want 500", recorder.Code, recorder.Body.String())
	}
	accountsAfter, err := accountSvc.ListAccounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(accountsAfter) != 0 {
		t.Fatalf("accounts after rollback = %#v, want none", accountsAfter)
	}
	adminCount, err := rbacStore.CountRoleAccounts(context.Background(), rbac.AdminRoleID)
	if err != nil {
		t.Fatal(err)
	}
	if adminCount != 0 {
		t.Fatalf("admin bindings after rollback = %d, want 0", adminCount)
	}
}

func TestLogoutReportsSessionStoreFailure(t *testing.T) {
	ctx := context.Background()
	store := &sessionFailureStore{Store: accounts.NewMemoryStore()}
	accountSvc := accounts.NewService(accounts.Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey)})
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "user@example.com", Name: "User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, registration.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	store.deleteErr = errors.New("delete session failed")
	router := server.NewRouter(server.Options{AccountService: accountSvc})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	request.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("logout status = %d body=%s, want 500", recorder.Code, recorder.Body.String())
	}
	if cookies := recorder.Result().Cookies(); len(cookies) != 0 {
		t.Fatalf("logout failure cleared cookies = %#v, want none", cookies)
	}
}

func newJWTAccountAndRBAC(t *testing.T) (*accounts.Service, *rbac.Service) {
	t.Helper()
	accountSvc := accounts.NewService(accounts.Config{
		Store: accounts.NewMemoryStore(), SessionDuration: time.Hour, JWTSigningKey: []byte(testJWTKey),
	})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	return accountSvc, rbacSvc
}

func cookieMap(cookies []*http.Cookie) map[string]*http.Cookie {
	result := make(map[string]*http.Cookie, len(cookies))
	for _, cookie := range cookies {
		result[cookie.Name] = cookie
	}
	return result
}

type sessionFailureStore struct {
	accounts.Store
	saves        int
	failAt       int
	saved        int
	deleted      int
	deleteErr    error
	cancelOnFail context.CancelFunc
}

type countingAuthStore struct {
	*accounts.MemoryStore
	accountSaves int
	sessionSaves int
}

type registrationDeleteFailureStore struct {
	*accounts.MemoryStore
	deleteErr   error
	deleteCalls int
}

func (s *registrationDeleteFailureStore) DeleteAccount(ctx context.Context, userID string) error {
	s.deleteCalls++
	if s.deleteErr != nil {
		return s.deleteErr
	}
	return s.MemoryStore.DeleteAccount(ctx, userID)
}

type registrationRollbackFailureRBACStore struct {
	rbac.Store
	removeErr   error
	removeCalls int
}

func (s *registrationRollbackFailureRBACStore) RemoveAccountRole(context.Context, string, string, rbac.OperationAudit) error {
	s.removeCalls++
	return s.removeErr
}

func assertInternalErrorLogContains(t *testing.T, logs *observer.ObservedLogs, fragments ...string) {
	t.Helper()
	entries := logs.FilterMessage("internal server error").All()
	if len(entries) != 1 {
		t.Fatalf("internal error logs = %#v, want one", entries)
	}
	loggedErrors, _ := entries[0].ContextMap()["errors"].(string)
	for _, fragment := range fragments {
		if !strings.Contains(loggedErrors, fragment) {
			t.Fatalf("logged errors %q do not contain %q", loggedErrors, fragment)
		}
	}
}

func newClaweeOwnedAgentStore(accountSvc *accounts.Service) *mcpgateway.MemoryStore {
	store := mcpgateway.NewMemoryStore()
	store.SetOwnedAgentBinder(func(ctx context.Context, userID, agentID string, _ time.Time) error {
		return accountSvc.BindAgent(ctx, userID, agentID)
	})
	return store
}

func (s *countingAuthStore) SaveAccount(ctx context.Context, account accounts.Account) error {
	s.accountSaves++
	return s.MemoryStore.SaveAccount(ctx, account)
}

func (s *countingAuthStore) SaveSession(ctx context.Context, session accounts.Session) error {
	s.sessionSaves++
	return s.MemoryStore.SaveSession(ctx, session)
}

type claweeLoginResult struct {
	Status      int
	AccessToken string
	AgentID     string
	ErrorCode   string
}

func loginClawee(t *testing.T, router http.Handler, email, password, agentID string) claweeLoginResult {
	t.Helper()
	body := `{"email":"` + email + `","password":"` + password + `","client_id":"clawee-agent"`
	if agentID != "" {
		body += `,"agent_id":"` + agentID + `"`
	}
	body += `}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	var response struct {
		Data struct {
			AccessToken string `json:"access_token"`
			Agent       struct {
				AgentID string `json:"agent_id"`
			} `json:"agent"`
		} `json:"data"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil && rec.Code != http.StatusNoContent {
		t.Fatalf("decode login response: %v body=%s", err, rec.Body.String())
	}
	return claweeLoginResult{Status: rec.Code, AccessToken: response.Data.AccessToken, AgentID: response.Data.Agent.AgentID, ErrorCode: response.Error.Code}
}

func (s *sessionFailureStore) SaveSession(ctx context.Context, session accounts.Session) error {
	s.saves++
	if s.saves == s.failAt {
		if s.cancelOnFail != nil {
			s.cancelOnFail()
		}
		return errors.New("save session failed")
	}
	s.saved++
	return s.Store.SaveSession(ctx, session)
}

func (s *sessionFailureStore) DeleteSession(ctx context.Context, sessionID string) error {
	s.deleted++
	if s.deleteErr != nil {
		return s.deleteErr
	}
	return s.Store.DeleteSession(ctx, sessionID)
}
