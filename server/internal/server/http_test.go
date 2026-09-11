package server_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentactivitymcp"
	"github.com/krillinai/Clawee/server/internal/buildinfo"
	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/businessdatamcp"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/knowledge"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
)

type staticBearerTransport struct {
	token   string
	agentID string
	base    http.RoundTripper
}

func (t staticBearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+t.token)
	agentID := t.agentID
	if agentID == "" {
		agentID = "agent-1"
	}
	req.Header.Set("X-Claw-Agent-ID", agentID)
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(req)
}

type fakeAdminUpstreamClient struct{}

func (fakeAdminUpstreamClient) ListTools(ctx context.Context, server mcpgateway.UpstreamServer, bearerToken string) ([]mcpgateway.UpstreamTool, error) {
	return []mcpgateway.UpstreamTool{{Name: "customer.search", InputSchema: mcpgateway.JSONMap{"type": "object"}}}, nil
}

func (fakeAdminUpstreamClient) CallTool(ctx context.Context, req mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	return mcpgateway.UpstreamCallResult{}, nil
}

type failingAdminUpstreamClient struct {
	err error
}

type cancellableUpstreamClient struct {
	started   chan struct{}
	cancelled chan struct{}
}

func (c *cancellableUpstreamClient) ListTools(context.Context, mcpgateway.UpstreamServer, string) ([]mcpgateway.UpstreamTool, error) {
	return nil, nil
}

func (c *cancellableUpstreamClient) CallTool(ctx context.Context, req mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	close(c.started)
	<-ctx.Done()
	close(c.cancelled)
	return mcpgateway.UpstreamCallResult{}, ctx.Err()
}

func TestStaticBearerUpstreamSyncDoesNotRequireDelegatedAuthorizationHeader(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{ID: "secure-http", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://127.0.0.1:1905/mcp", AuthType: "static_bearer", CredentialRef: "SECURE_HTTP_TOKEN", Namespace: "secure", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	proxy := mcpgateway.NewService(mcpgateway.Config{
		Store: store, UpstreamClient: fakeAdminUpstreamClient{},
		ResolveCredential: func(string) (string, error) { return "service-token", nil },
	})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers/sync-tools", strings.NewReader(`{"server_id":"secure-http"}`))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
}

func (c failingAdminUpstreamClient) ListTools(ctx context.Context, server mcpgateway.UpstreamServer, bearerToken string) ([]mcpgateway.UpstreamTool, error) {
	return nil, c.err
}

func (c failingAdminUpstreamClient) CallTool(ctx context.Context, req mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	return mcpgateway.UpstreamCallResult{}, c.err
}

func testMCPGatewayService(store mcpgateway.Store, upstream mcpgateway.UpstreamClient) *mcpgateway.Service {
	return configureTestIdentityResolvers(mcpgateway.NewService(mcpgateway.Config{
		Store:          store,
		UpstreamClient: upstream,
		TokenCipher:    mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef")),
	}))
}

func configureTestIdentityResolvers(service *mcpgateway.Service) *mcpgateway.Service {
	var mu sync.Mutex
	currentUserID := ""
	service.SetIdentityResolvers(
		func(context.Context, string) (string, error) {
			defer mu.Unlock()
			return currentUserID, nil
		},
		func(_ context.Context, userID string) error {
			mu.Lock()
			currentUserID = userID
			return nil
		},
	)
	return service
}

func accountTokenMCPAuthFixture(t *testing.T, store mcpgateway.Store, userID, agentID, plaintext string) (*accounts.Service, server.MCPAuthOptions) {
	t.Helper()
	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: accountStore})
	if err := accountStore.SaveAccount(ctx, accounts.Account{UserID: userID, Email: userID + "@example.com", Status: accounts.StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := accountSvc.BindAgent(ctx, userID, agentID); err != nil {
		t.Fatal(err)
	}
	if err := store.RotateAccountToken(ctx, userID, mcpgateway.AccountToken{
		ID: "token_" + userID, UserID: userID, TokenHash: mcpgateway.HashToken(plaintext), Status: mcpgateway.StatusActive, Scopes: []string{"mcp:call"},
	}); err != nil {
		t.Fatal(err)
	}
	return accountSvc, server.MCPAuthOptions{Enabled: true, RequiredScopes: []string{"mcp:call"}, AccountTokenStore: store, AccountService: accountSvc}
}

func TestMCPGrantStoresAuthenticatedCreatorName(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "agent-creator", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCapability(ctx, mcpgateway.Capability{
		ID: "cap-creator", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway: testMCPGatewayService(store, fakeAdminUpstreamClient{}), AccountService: accountService,
	})
	adminCookies := register(t, router, `{"email":"grant-admin@example.com","name":"授权管理员","password":"passw0rd!"}`)
	adminLogin, err := accountService.AuthenticateCredentials(ctx, accounts.LoginRequest{Email: "grant-admin@example.com", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	adminUserID := adminLogin.UserID

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/grants", strings.NewReader(`{"user_id":"`+adminUserID+`","capability_id":"cap-creator","grant_type":"tool","created_by":"伪造用户"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	response := unwrapAPIDataMap(t, recorder.Body.Bytes())
	if response["created_by"] != "授权管理员" {
		t.Fatalf("response created_by = %q, want 授权管理员", response["created_by"])
	}
	grants, err := store.ListGrants(ctx, mcpgateway.GrantFilter{UserID: adminUserID})
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 1 || grants[0].CreatedBy != "授权管理员" {
		t.Fatalf("stored grants = %#v", grants)
	}
}

func TestAdminMCPGatewayRoutesRegisterServerAndGrantTool(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
		MCPAuth:      server.MCPAuthOptions{Resource: "https://gateway.example.com/mcp"},
	})

	body := strings.NewReader(`{
		"server_id":"crm-main",
		"name":"CRM Main",
		"domain":"crm",
		"transport":"streamable_http",
		"endpoint":"http://crm.example/mcp",
		"namespace":"crm",
		"environment":"prod",
		"owner_team":"sales-platform",
		"routing_description":"负责客户查询和销售流程"
	}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers", body)
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status = %d body=%s", rec.Code, rec.Body.String())
	}
	serverResp := unwrapAPIDataMap(t, rec.Body.Bytes())
	if serverResp["owner_team"] != "sales-platform" {
		t.Fatalf("server response missing owner: %#v", serverResp)
	}
	if serverResp["routing_description"] != "负责客户查询和销售流程" {
		t.Fatalf("server response missing routing description: %#v", serverResp)
	}
	if _, ok := serverResp["environment"]; ok {
		t.Fatalf("server response still contains removed Environment field: %#v", serverResp)
	}
	if serverResp["created_at"] == "" || serverResp["updated_at"] == "" {
		t.Fatalf("server response missing persisted timestamps: %#v", serverResp)
	}
	if serverResp["mcp_endpoint"] != "https://gateway.example.com/mcp/servers/crm-main" {
		t.Fatalf("server response mcp_endpoint = %#v", serverResp["mcp_endpoint"])
	}

	adminUserID := testAdminUserID(t, router)
	agentBody := strings.NewReader(`{"user_id":"` + adminUserID + `","agent_id":"sales_zhang_agent","client_id":"agent_client_openclaw","name":"Sales Zhang Agent","status":"active"}`)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/agents", agentBody)
	req.Host = "gateway.example.com"
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("agent status = %d body=%s", rec.Code, rec.Body.String())
	}
	agentResp := unwrapAPIDataMap(t, rec.Body.Bytes())
	if _, ok := agentResp["token"]; ok {
		t.Fatalf("agent creation returned account token: %#v", agentResp)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/accounts/token/rotate", strings.NewReader(`{"user_id":"`+adminUserID+`","scopes":["mcp:call"]}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate account token status = %d body=%s", rec.Code, rec.Body.String())
	}
	tokenResponse := unwrapAPIDataMap(t, rec.Body.Bytes())
	token, _ := tokenResponse["token"].(string)
	if len(token) != 32 || !strings.HasPrefix(token, "agt_") {
		t.Fatalf("token = %q, want 32-character agt_ token", token)
	}
	tokenInfo, _ := tokenResponse["token_info"].(map[string]any)
	assertNoSensitiveTokenFields(t, tokenInfo)

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/accounts/token/reveal", strings.NewReader(`{"user_id":"`+adminUserID+`"}`))
	req.Host = "gateway.example.com"
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("copy token status = %d body=%s", rec.Code, rec.Body.String())
	}
	copyResp := unwrapAPIDataMap(t, rec.Body.Bytes())
	copyToken, _ := copyResp["token"].(string)
	if copyToken != token {
		t.Fatalf("copy token = %q, want original token", copyToken)
	}
	if copyResp["authorization_header"] != "Authorization: Bearer "+token {
		t.Fatalf("copy authorization_header = %#v, want full Authorization header", copyResp["authorization_header"])
	}
	copyTokenInfo, _ := copyResp["token_info"].(map[string]any)
	assertNoSensitiveTokenFields(t, copyTokenInfo)

	if err := store.SaveCapability(context.Background(), mcpgateway.Capability{
		ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search",
		InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusPending,
		LastSyncedAt: time.Date(2026, 5, 27, 10, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	statusBody := strings.NewReader(`{"capability_id":"crm.customer.search","status":"active"}`)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/capabilities", statusBody)
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("activate capability status = %d body=%s", rec.Code, rec.Body.String())
	}

	renameBody := strings.NewReader(`{"capability_id":"crm.customer.search","exposed_name":"crm.customer.lookup"}`)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/capabilities", renameBody)
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rename capability status = %d body=%s", rec.Code, rec.Body.String())
	}

	gatesBody := strings.NewReader(`{"capability_id":"cap_search","approval_required":true,"confirm_required":true}`)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/v1/admin/mcp/capabilities/gate-policy", gatesBody)
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update capability gates status = %d body=%s", rec.Code, rec.Body.String())
	}
	capability, err := store.GetCapabilityByExposedName(context.Background(), "crm.customer.lookup")
	if err != nil {
		t.Fatalf("get capability after gates update: %v", err)
	}
	if !capability.ApprovalRequired || !capability.ConfirmRequired {
		t.Fatalf("capability gates not updated: approval=%v confirm=%v", capability.ApprovalRequired, capability.ConfirmRequired)
	}

	grantBody := strings.NewReader(`{"user_id":"` + adminUserID + `","capability_id":"cap_search","grant_type":"tool","created_by":"admin","data_scope":{"regions":["north"]},"expires_at":"2030-01-01T00:00:00Z"}`)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/grants", grantBody)
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("grant status = %d body=%s", rec.Code, rec.Body.String())
	}
	grantResponse := unwrapAPIDataMap(t, rec.Body.Bytes())
	grantID, _ := grantResponse["id"].(string)
	if !regexp.MustCompile(`^grt_[0-9a-f]{24}$`).MatchString(grantID) {
		t.Fatalf("grant_id = %q, want short opaque ID", grantID)
	}

	grants, err := store.ListGrants(context.Background(), mcpgateway.GrantFilter{UserID: adminUserID})
	if err != nil {
		t.Fatalf("list grants: %v", err)
	}
	if len(grants) != 1 {
		t.Fatalf("grants length = %d, want 1", len(grants))
	}
	if grants[0].DataScope["regions"] == nil || grants[0].ExpiresAt == nil {
		t.Fatalf("grant missing data scope or expires_at: %#v", grants[0])
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/capabilities", strings.NewReader(`{"capability_id":"crm.customer.lookup","exposed_name":"crm.customer.find"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("rename granted capability status = %d body=%s", rec.Code, rec.Body.String())
	}

	if err := store.SaveUpstreamServer(context.Background(), mcpgateway.UpstreamServer{
		ID: "erp-main", Name: "ERP Main", Domain: "erp", Transport: mcpgateway.TransportStreamableHTTP,
		Endpoint: "http://erp.example/mcp", Namespace: "erp", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatalf("save erp server: %v", err)
	}
	if err := store.SaveCapability(context.Background(), mcpgateway.Capability{
		ID: "cap_inventory", UpstreamServerID: "erp-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "inventory.query", ExposedName: "erp.inventory.query",
		InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatalf("save erp capability: %v", err)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/upstream-servers/detail?server_id=crm-main", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("server detail status = %d body=%s", rec.Code, rec.Body.String())
	}
	serverDetail := unwrapAPIDataMap(t, rec.Body.Bytes())
	if serverDetail["capabilities_count"] != float64(1) || serverDetail["last_synced_at"] == "" {
		t.Fatalf("server detail missing capability aggregate fields: %#v", serverDetail)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/capabilities?server_id=crm-main", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("filtered capabilities status = %d body=%s", rec.Code, rec.Body.String())
	}
	capabilities := decodeAPIResources[mcpgateway.Capability](t, rec.Body.Bytes())
	if len(capabilities) != 1 || capabilities[0].UpstreamServerID != "crm-main" {
		t.Fatalf("filtered capabilities = %#v, want only crm-main", capabilities)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/upstream-servers", strings.NewReader(`{"server_id":"crm-main","status":"disabled"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("server status update = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/agents", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list agents status = %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), token) {
		t.Fatal("agent list leaked plaintext token")
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/accounts/token/rotate", strings.NewReader(`{"user_id":"`+adminUserID+`","scopes":["mcp:call"]}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate token status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/accounts/token/revoke", strings.NewReader(`{"user_id":"`+adminUserID+`"}`))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke token status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/grants/remove", strings.NewReader(fmt.Sprintf(`{"grant_id":%q}`, grantID)))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete grant status = %d body=%s", rec.Code, rec.Body.String())
	}
	grants, err = store.ListGrants(context.Background(), mcpgateway.GrantFilter{UserID: adminUserID})
	if err != nil {
		t.Fatalf("list grants after delete: %v", err)
	}
	if len(grants) != 0 {
		t.Fatalf("grants length after delete = %d, want 0", len(grants))
	}

	now := time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC)
	for _, record := range []mcpgateway.ProxyAuditRecord{
		{ID: "audit_crm_allowed", AgentID: "sales_zhang_agent", UpstreamServerID: "crm-main", CapabilityID: "cap_search", ExposedName: "crm.customer.lookup", UpstreamName: "customer.search", Decision: mcpgateway.DecisionAllowed, CreatedAt: now},
		{ID: "audit_erp_error", AgentID: "erp_agent", UpstreamServerID: "erp-main", CapabilityID: "cap_inventory", ExposedName: "erp.inventory.query", UpstreamName: "inventory.query", Decision: mcpgateway.DecisionUpstreamError, Error: "upstream failed", CreatedAt: now.Add(time.Minute)},
	} {
		if err := store.SaveProxyAuditRecord(context.Background(), record); err != nil {
			t.Fatalf("save audit %s: %v", record.ID, err)
		}
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/audits?decision=allowed&agent_id=sales_zhang_agent&upstream_server_id=crm-main&tool=crm.customer.lookup&created_from=2026-05-27T11:00:00Z&created_to=2026-05-27T13:00:00Z", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("filtered audits status = %d body=%s", rec.Code, rec.Body.String())
	}
	audits := decodeAPIResources[mcpgateway.ProxyAuditRecord](t, rec.Body.Bytes())
	if len(audits) != 1 || audits[0].ID != "audit_crm_allowed" {
		t.Fatalf("filtered audits = %#v, want audit_crm_allowed", audits)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/audits?error_only=true", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("error audits status = %d body=%s", rec.Code, rec.Body.String())
	}
	audits = decodeAPIResources[mcpgateway.ProxyAuditRecord](t, rec.Body.Bytes())
	if len(audits) != 1 || audits[0].ID != "audit_erp_error" {
		t.Fatalf("error audits = %#v, want audit_erp_error", audits)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/grants/remove", strings.NewReader(`{"grant_id":"grant_missing"}`))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing grant status = %d body=%s", rec.Code, rec.Body.String())
	}

	for _, path := range []string{
		"/api/v1/admin/mcp/upstream-servers",
		"/api/v1/admin/mcp/capabilities",
		"/api/v1/admin/mcp/agents",
		"/api/v1/admin/mcp/grants?user_id=" + adminUserID,
		"/api/v1/admin/mcp/audits",
	} {
		rec = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodGet, path, nil)
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestAdminMCPGatewayRoutesRegisterCollectorPullUpstream(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{ProxyGateway: testMCPGatewayService(store, fakeAdminUpstreamClient{})})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers", strings.NewReader(`{
		"server_id":"codexb-dev",
		"name":"研发 Codex B",
		"domain":"development",
		"transport":"collector_pull",
		"collector_id":"collector-dev",
		"namespace":"codexb.dev"
	}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status = %d body=%s", rec.Code, rec.Body.String())
	}
	upstream, err := store.GetUpstreamServer(context.Background(), "codexb-dev")
	if err != nil {
		t.Fatal(err)
	}
	if upstream.Transport != mcpgateway.TransportCollectorPull || upstream.CollectorID != "collector-dev" || upstream.Endpoint != "" || upstream.AuthType != "" {
		t.Fatalf("upstream = %#v", upstream)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers", strings.NewReader(`{
		"server_id":"invalid-pull",
		"name":"Invalid",
		"transport":"collector_pull",
		"endpoint":"http://collector.local/mcp",
		"collector_id":"collector-dev",
		"namespace":"invalid"
	}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid register status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers", strings.NewReader(`{
		"server_id":"invalid-pull-stdio",
		"name":"Invalid",
		"transport":"collector_pull",
		"collector_id":"collector-dev",
		"namespace":"invalid",
		"stdio":{"args":["hidden-arg"]}
	}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid stdio register status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminMCPGatewayRoutesUpdateStreamableHTTPTokenWithoutReturningPlaintext(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{ProxyGateway: proxy})
	if err := store.SaveUpstreamServer(context.Background(), mcpgateway.UpstreamServer{
		ID:            "secure-http",
		Name:          "Secure HTTP",
		Transport:     mcpgateway.TransportStreamableHTTP,
		Endpoint:      "http://127.0.0.1:1905/mcp",
		AuthType:      "static_bearer",
		CredentialRef: "SECURE_HTTP_TOKEN",
		Namespace:     "secure",
		Status:        mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}

	body := strings.NewReader(`{
		"server_id":"secure-http",
		"name":"Secure HTTP",
		"transport":"streamable_http",
		"endpoint":"http://127.0.0.1:1905/mcp",
		"namespace":"secure",
		"token":"configured-token"
	}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/upstream-servers", body)
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "configured-token") {
		t.Fatalf("response leaked token: %s", rec.Body.String())
	}
	got, err := store.GetUpstreamServer(context.Background(), "secure-http")
	if err != nil {
		t.Fatal(err)
	}
	if got.AuthType != "static_bearer" || len(got.TokenCiphertext) == 0 {
		t.Fatalf("stored upstream auth = %#v", got)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/upstream-servers", strings.NewReader(`{
		"server_id":"secure-http",
		"transport":"collector_pull",
		"collector_id":"collector-dev"
	}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch to collector_pull status = %d body=%s", rec.Code, rec.Body.String())
	}
	got, err = store.GetUpstreamServer(context.Background(), "secure-http")
	if err != nil {
		t.Fatal(err)
	}
	if got.Transport != mcpgateway.TransportCollectorPull || got.CollectorID != "collector-dev" || got.Endpoint != "" || hasStdioFields(got.Stdio) || got.AuthType != "" || got.CredentialRef != "" || len(got.TokenCiphertext) != 0 {
		t.Fatalf("collector_pull retained direct credentials = %#v", got)
	}
}

func hasStdioFields(stdio mcpgateway.StdioConfig) bool {
	return stdio.Command != "" || len(stdio.Args) > 0 || stdio.CWD != "" || len(stdio.Env) > 0
}

func TestAdminMCPGatewayRejectsApplicationManagedBuiltinChanges(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
		MCPAuth:      server.MCPAuthOptions{PublicBaseURL: "https://gateway.example.com"},
	})
	for _, serverID := range []string{mcpgateway.KnowledgeAdapterServerID, "agent-activity", "business-data"} {
		if err := store.SaveUpstreamServer(context.Background(), mcpgateway.UpstreamServer{
			ID: serverID, Transport: mcpgateway.TransportBuiltin, Status: mcpgateway.StatusActive,
		}); err != nil {
			t.Fatal(err)
		}
		for _, request := range []struct {
			method string
			path   string
			body   string
		}{
			{method: http.MethodPost, path: "/api/v1/admin/mcp/upstream-servers", body: fmt.Sprintf(`{"server_id":%q,"transport":"builtin"}`, serverID)},
			{method: http.MethodPatch, path: "/api/v1/admin/mcp/upstream-servers", body: fmt.Sprintf(`{"server_id":%q,"status":"disabled"}`, serverID)},
			{method: http.MethodPost, path: "/api/v1/admin/mcp/upstream-servers/remove", body: fmt.Sprintf(`{"server_id":%q}`, serverID)},
		} {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(request.method, request.path, strings.NewReader(request.body))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s %s for %s status = %d body=%s", request.method, request.path, serverID, rec.Code, rec.Body.String())
			}
		}
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/upstream-servers/detail?server_id=knowledge-adapter", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("detail status = %d body=%s", rec.Code, rec.Body.String())
	}
	detail := unwrapAPIDataMap(t, rec.Body.Bytes())
	if detail["mcp_endpoint"] != "https://gateway.example.com/mcp/knowledge" {
		t.Fatalf("knowledge mcp endpoint = %#v", detail["mcp_endpoint"])
	}
	if detail["mcp_canonical_endpoint"] != "https://gateway.example.com/mcp/servers/knowledge-adapter" {
		t.Fatalf("knowledge canonical endpoint = %#v", detail["mcp_canonical_endpoint"])
	}
}

func TestAdminMCPUpstreamServerUpdateAndSoftDeleteRoutes(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})

	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{
		ID:        "crm-main",
		Name:      "CRM Main",
		Domain:    "crm",
		Transport: mcpgateway.TransportStreamableHTTP,
		Endpoint:  "https://crm.example/mcp",
		Namespace: "crm",
		OwnerTeam: "sales-platform",
		Status:    mcpgateway.StatusActive,
	}); err != nil {
		t.Fatalf("save server: %v", err)
	}

	updateBody := strings.NewReader(`{
		"server_id":"crm-main",
		"name":"CRM Updated",
		"domain":"crm-core",
		"transport":"stdio",
		"endpoint":"",
		"stdio":{"command":"go","args":["run","./internal/teststdio"],"cwd":"/repo","env":{"CRM_TOKEN":"from-config"}},
		"namespace":"crm2",
		"environment":"staging",
		"owner_team":"platform",
		"routing_description":"负责研发任务"
	}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/upstream-servers", updateBody)
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d body=%s", rec.Code, rec.Body.String())
	}
	got, err := store.GetUpstreamServer(ctx, "crm-main")
	if err != nil {
		t.Fatalf("get updated server: %v", err)
	}
	if got.ID != "crm-main" {
		t.Fatalf("server id = %q, want crm-main", got.ID)
	}
	if got.Name != "CRM Updated" || got.Domain != "crm-core" || got.Namespace != "crm2" || got.OwnerTeam != "platform" || got.RoutingDescription != "负责研发任务" {
		t.Fatalf("server fields not updated: %#v", got)
	}
	if got.Transport != mcpgateway.TransportStdio || got.Stdio.Command != "go" || len(got.Stdio.Args) != 2 || got.Stdio.Env["CRM_TOKEN"] != "from-config" {
		t.Fatalf("stdio fields not updated: %#v", got.Stdio)
	}
	if got.Status != mcpgateway.StatusActive {
		t.Fatalf("status changed = %q, want active", got.Status)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers/remove", strings.NewReader(`{"server_id":"crm-main"}`))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("delete active status = %d body=%s, want 400", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "disable upstream server before delete") {
		t.Fatalf("delete active body = %s, want disable guidance", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/upstream-servers", strings.NewReader(`{"server_id":"crm-main","status":"disabled"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("disable status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers/remove", strings.NewReader(`{"server_id":"crm-main"}`))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete disabled status = %d body=%s, want 204", rec.Code, rec.Body.String())
	}
	if _, err := store.GetUpstreamServer(ctx, "crm-main"); !errors.Is(err, mcpgateway.ErrUpstreamServerNotFound) {
		t.Fatalf("get deleted server error = %v, want not found", err)
	}
}

func TestAdminMCPGatewayRoutesRegisterStdioServer(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})

	body := strings.NewReader(`{
		"server_id":"local-crm",
		"name":"Local CRM",
		"domain":"crm",
		"transport":"stdio",
		"stdio":{"command":"go","args":["run","./internal/teststdio"],"cwd":"/repo","env":{"UPSTREAM_TOKEN":"from-config"}},
		"namespace":"crm"
	}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers", body)
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register stdio status = %d body=%s", rec.Code, rec.Body.String())
	}
	got, err := store.GetUpstreamServer(context.Background(), "local-crm")
	if err != nil {
		t.Fatalf("get stdio server: %v", err)
	}
	if got.Transport != mcpgateway.TransportStdio || got.Stdio.Command != "go" {
		t.Fatalf("server stdio config = %#v, want transport stdio with command go", got)
	}
	if len(got.Stdio.Args) != 2 || got.Stdio.Args[0] != "run" {
		t.Fatalf("stdio args = %#v, want go run args", got.Stdio.Args)
	}
	if got.Stdio.Env["UPSTREAM_TOKEN"] != "from-config" {
		t.Fatalf("stdio env = %#v, want UPSTREAM_TOKEN", got.Stdio.Env)
	}
}

func TestAdminMCPGatewayRoutesRejectInvalidUpstreamTransports(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})

	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "invalid server id", body: `{"server_id":"bad/id","transport":"streamable_http","endpoint":"http://crm.example/mcp"}`},
		{name: "stdio without command", body: `{"server_id":"bad-stdio","transport":"stdio","stdio":{"args":["run"]}}`},
		{name: "sse unsupported", body: `{"server_id":"bad-sse","transport":"sse","endpoint":"http://crm.example/sse"}`},
		{name: "http without endpoint", body: `{"server_id":"bad-http","transport":"streamable_http"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body=%s, want 400", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestAdminMCPGatewayRoutesRecordSyncToolFailure(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := mcpgateway.NewService(mcpgateway.Config{
		Store:          store,
		UpstreamClient: failingAdminUpstreamClient{err: errors.New("spawn stdio: permission denied")},
	})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	if err := store.SaveUpstreamServer(context.Background(), mcpgateway.UpstreamServer{
		ID:        "local-crm",
		Name:      "Local CRM",
		Transport: mcpgateway.TransportStdio,
		Stdio:     mcpgateway.StdioConfig{Command: "node", Args: []string{"/srv/index.js"}},
		Status:    mcpgateway.StatusActive,
	}); err != nil {
		t.Fatalf("save upstream: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/upstream-servers/sync-tools", strings.NewReader(`{"server_id":"local-crm"}`))
	req.Header.Set("Authorization", "Bearer delegated")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("sync status = %d body=%s, want 502", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/upstream-servers/detail?server_id=local-crm", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("detail status = %d body=%s", rec.Code, rec.Body.String())
	}
	detail := unwrapAPIDataMap(t, rec.Body.Bytes())
	if detail["last_sync_result"] != "sync_failed: spawn stdio: permission denied" {
		t.Fatalf("last_sync_result = %#v, want sync_failed error", detail["last_sync_result"])
	}
}

func TestAdminMCPGateRoutesListDetailAcceptReject(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	gate := mcpgateway.GateRequest{
		ID:           "gate_1",
		Type:         mcpgateway.GateTypeUserConfirmation,
		Provider:     mcpgateway.GateProviderInternal,
		TenantID:     "tenant_1",
		AgentID:      "sales_zhang_agent",
		ActorID:      "sales_zhang",
		CapabilityID: "cap_search",
		ExposedName:  "crm.customer.search",
		RequestBody:  mcpgateway.JSONMap{"keyword": "acme"},
		Status:       mcpgateway.GatePending,
		CreatedAt:    time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC),
		UpdatedAt:    time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC),
	}
	if err := store.SaveGateRequest(context.Background(), gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/gates?status=pending&gate_type=user_confirmation", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list gates status = %d body=%s", rec.Code, rec.Body.String())
	}
	items := decodeAPIResources[mcpgateway.GateRequest](t, rec.Body.Bytes())
	if len(items) != 1 || items[0].ID != gate.ID {
		t.Fatalf("gate list = %#v, want gate_1", items)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/gates/detail?gate_id="+gate.ID, nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("gate detail status = %d body=%s", rec.Code, rec.Body.String())
	}
	detail := decodeAPIResource[mcpgateway.GateRequest](t, rec.Body.Bytes())
	if detail.ID != gate.ID || detail.Status != mcpgateway.GatePending {
		t.Fatalf("gate detail = %#v, want pending gate_1", detail)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/gates/decide", strings.NewReader(`{"gate_id":"`+gate.ID+`","decision":"rejected","reason":"wrong params"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject gate status = %d body=%s", rec.Code, rec.Body.String())
	}
	rejected := decodeAPIResource[mcpgateway.GateRequest](t, rec.Body.Bytes())
	if rejected.Status != mcpgateway.GateRejected || rejected.DecisionReason != "wrong params" {
		t.Fatalf("rejected gate = %#v, want rejected with reason", rejected)
	}
}

func TestAdminMCPGateRoutesListAndDetailAdminApproval(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	gate := mcpgateway.GateRequest{
		ID:           "mcp_approval_route_1",
		Type:         mcpgateway.GateTypeAdminApproval,
		Provider:     mcpgateway.GateProviderInternal,
		TenantID:     "tenant_1",
		AgentID:      "sales_zhang_agent",
		ActorID:      "sales_zhang",
		CapabilityID: "cap_search",
		ExposedName:  "crm.customer.search",
		RequestBody:  mcpgateway.JSONMap{"keyword": "acme"},
		Status:       mcpgateway.GatePending,
		CreatedAt:    time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC),
		UpdatedAt:    time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC),
	}
	if err := store.SaveGateRequest(context.Background(), gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/gates?status=pending&gate_type=admin_approval", nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list gates status = %d body=%s", rec.Code, rec.Body.String())
	}
	items := decodeAPIResources[mcpgateway.GateRequest](t, rec.Body.Bytes())
	if len(items) != 1 || items[0].ID != gate.ID || items[0].Type != mcpgateway.GateTypeAdminApproval {
		t.Fatalf("gate list = %#v, want admin approval gate", items)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/gates/detail?gate_id="+gate.ID, nil)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("gate detail status = %d body=%s", rec.Code, rec.Body.String())
	}
	detail := decodeAPIResource[mcpgateway.GateRequest](t, rec.Body.Bytes())
	if detail.ID != gate.ID || detail.Type != mcpgateway.GateTypeAdminApproval || detail.Status != mcpgateway.GatePending {
		t.Fatalf("gate detail = %#v, want pending admin approval", detail)
	}
}

func TestAdminMCPGateAcceptAdminApprovalExecutesSnapshot(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	upstream := fakeAdminUpstreamClient{}
	proxy := testMCPGatewayService(store, upstream)
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_1", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{ID: "crm-main", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save server: %v", err)
	}
	inputSchema := mcpgateway.JSONMap{"type": "object", "properties": mcpgateway.JSONMap{"keyword": mcpgateway.JSONMap{"type": "string"}}}
	schemaHash, err := mcpgateway.SchemaHash(inputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, mcpgateway.Capability{
		ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search",
		InputSchema: inputSchema, Status: mcpgateway.StatusActive, SchemaHash: schemaHash,
	}); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_search", UserID: "sales_zhang", CapabilityID: "cap_search", GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatalf("save grant: %v", err)
	}
	gate := mcpgateway.GateRequest{
		ID:               "mcp_approval_accept_route",
		Type:             mcpgateway.GateTypeAdminApproval,
		Provider:         mcpgateway.GateProviderInternal,
		TraceID:          "trace_approval_accept_route",
		TenantID:         "tenant_1",
		AgentID:          "sales_zhang_agent",
		UserID:           "sales_zhang",
		ActorID:          "sales_zhang",
		CapabilityID:     "cap_search",
		CapabilityType:   mcpgateway.CapabilityTool,
		UpstreamServerID: "crm-main",
		ExposedName:      "crm.customer.search",
		UpstreamName:     "customer.search",
		RequestBody:      mcpgateway.JSONMap{"keyword": "acme"},
		SchemaHash:       schemaHash,
		Status:           mcpgateway.GatePending,
		CreatedAt:        time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC),
		UpdatedAt:        time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC),
	}
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/gates/decide", strings.NewReader(`{"gate_id":"`+gate.ID+`","decision":"accepted"}`))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("accept gate status = %d body=%s", rec.Code, rec.Body.String())
	}
	completed := decodeAPIResource[mcpgateway.GateRequest](t, rec.Body.Bytes())
	if completed.Type != mcpgateway.GateTypeAdminApproval || completed.Status != mcpgateway.GateCompleted || completed.ExecutionAuditID == "" {
		t.Fatalf("completed gate = %#v, want completed admin approval", completed)
	}
}

func TestAdminMCPGateRejectAdminApproval(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	gate := mcpgateway.GateRequest{
		ID:        "mcp_approval_reject_route",
		Type:      mcpgateway.GateTypeAdminApproval,
		Provider:  mcpgateway.GateProviderInternal,
		ActorID:   "sales_zhang",
		Status:    mcpgateway.GatePending,
		CreatedAt: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC),
	}
	if err := store.SaveGateRequest(context.Background(), gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/gates/decide", strings.NewReader(`{"gate_id":"`+gate.ID+`","decision":"rejected","reason":"missing approval evidence"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject gate status = %d body=%s", rec.Code, rec.Body.String())
	}
	rejected := decodeAPIResource[mcpgateway.GateRequest](t, rec.Body.Bytes())
	if rejected.Type != mcpgateway.GateTypeAdminApproval || rejected.Status != mcpgateway.GateRejected || rejected.DecisionReason != "missing approval evidence" {
		t.Fatalf("rejected gate = %#v, want rejected admin approval", rejected)
	}
}

func TestAdminMCPGateAcceptConflictReturns409(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	gate := mcpgateway.GateRequest{
		ID:        "gate_completed",
		Type:      mcpgateway.GateTypeUserConfirmation,
		Provider:  mcpgateway.GateProviderInternal,
		Status:    mcpgateway.GateCompleted,
		CreatedAt: time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC),
	}
	if err := store.SaveGateRequest(context.Background(), gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/gates/decide", strings.NewReader(`{"gate_id":"`+gate.ID+`","decision":"accepted"}`))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("accept completed gate status = %d body=%s, want 409", rec.Code, rec.Body.String())
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode conflict response: %v", err)
	}
	if body.Error.Code != "conflict" || body.Error.Message == "" {
		t.Fatalf("conflict body = %#v, want conflict error", body)
	}
}

func TestAdminMCPGateDecisionUsesJSON(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	gate := mcpgateway.GateRequest{
		ID:        "gate_empty_reason",
		Type:      mcpgateway.GateTypeUserConfirmation,
		Provider:  mcpgateway.GateProviderInternal,
		ActorID:   "sales_zhang",
		Status:    mcpgateway.GatePending,
		CreatedAt: time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 5, 28, 10, 0, 0, 0, time.UTC),
	}
	if err := store.SaveGateRequest(context.Background(), gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/gates/decide", strings.NewReader(`{"gate_id":"`+gate.ID+`","decision":"rejected"}`))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject gate status = %d body=%s", rec.Code, rec.Body.String())
	}
	rejected := decodeAPIResource[mcpgateway.GateRequest](t, rec.Body.Bytes())
	if rejected.Status != mcpgateway.GateRejected || rejected.DecisionReason != "rejected" {
		t.Fatalf("rejected gate = %#v, want rejected with default reason", rejected)
	}
}

func TestAdminListRoutesReturnEmptyArrays(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})

	tests := []string{
		"/api/v1/admin/mcp/upstream-servers",
		"/api/v1/admin/mcp/capabilities",
		"/api/v1/admin/mcp/agents",
		"/api/v1/admin/mcp/grants",
		"/api/v1/admin/mcp/audits",
	}

	for _, path := range tests {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d body=%s", path, rec.Code, rec.Body.String())
		}
		var envelope struct {
			Data []json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode %s response: %v body=%s", path, err, rec.Body.String())
		}
		if envelope.Data == nil {
			t.Fatalf("GET %s returned nil items: %s", path, rec.Body.String())
		}
		if len(envelope.Data) != 0 {
			t.Fatalf("GET %s items length = %d, want 0", path, len(envelope.Data))
		}
	}
}

func TestAdminDeletesOnlyMissingMCPCapabilities(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	for _, capability := range []mcpgateway.Capability{
		{ID: "cap_missing", ExposedName: "crm.legacy", Status: mcpgateway.StatusMissing},
		{ID: "cap_active", ExposedName: "crm.search", Status: mcpgateway.StatusActive},
	} {
		if err := store.SaveCapability(ctx, capability); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_missing", CapabilityID: "cap_missing"}); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{ProxyGateway: testMCPGatewayService(store, fakeAdminUpstreamClient{})})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/capabilities/remove", strings.NewReader(`{"capability_id":"cap_active"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("delete active capability status = %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := store.GetCapabilityByExposedName(ctx, "crm.search"); err != nil {
		t.Fatalf("active capability was deleted: %v", err)
	}

	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/capabilities/remove", strings.NewReader(`{"capability_id":"cap_missing"}`)))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete missing capability status = %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := store.GetCapabilityByExposedName(ctx, "crm.legacy"); !errors.Is(err, mcpgateway.ErrCapabilityNotFound) {
		t.Fatalf("missing capability lookup error = %v, want ErrCapabilityNotFound", err)
	}
	grants, err := store.ListGrants(ctx, mcpgateway.GrantFilter{CapabilityID: "cap_missing"})
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 0 {
		t.Fatalf("grants after capability delete = %#v, want none", grants)
	}
}

func TestAdminDeleteMCPAgentPreservesAccountTokenAndGrants(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "agent_delete", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.RotateAccountToken(ctx, "user_delete", mcpgateway.AccountToken{
		ID: "token_delete", UserID: "user_delete", TokenHash: "hash_delete", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{
		ID: "grant_delete", UserID: "user_delete", CapabilityID: "cap_delete", GrantType: mcpgateway.GrantTool,
	}); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{ProxyGateway: testMCPGatewayService(store, fakeAdminUpstreamClient{})})

	request := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/agents/remove", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, req)
		return recorder
	}

	recorder := request(`{"agent_id":"agent_delete"}`)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("delete agent status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := store.GetAgent(ctx, "agent_delete"); !errors.Is(err, mcpgateway.ErrAgentNotFound) {
		t.Fatalf("deleted agent error = %v", err)
	}
	if _, err := store.GetAccountTokenByHash(ctx, "hash_delete"); err != nil {
		t.Fatalf("account token was deleted: %v", err)
	}
	if grants, err := store.ListGrants(ctx, mcpgateway.GrantFilter{UserID: "user_delete"}); err != nil || len(grants) != 1 {
		t.Fatalf("account grants = %#v error=%v", grants, err)
	}
	if recorder := request(`{"agent_id":"agent_delete"}`); recorder.Code != http.StatusNotFound {
		t.Fatalf("delete missing agent status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(`{"agent_id":""}`); recorder.Code != http.StatusBadRequest {
		t.Fatalf("delete empty agent status = %d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminMCPGatewayRoutesRejectInvalidInputs(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: proxy,
	})
	if err := store.SaveUpstreamServer(context.Background(), mcpgateway.UpstreamServer{
		ID:        "crm-main",
		Transport: mcpgateway.TransportStreamableHTTP,
		Endpoint:  "http://crm.example/mcp",
		Namespace: "crm",
		Status:    mcpgateway.StatusActive,
	}); err != nil {
		t.Fatalf("save upstream server: %v", err)
	}
	if err := store.SaveCapability(context.Background(), mcpgateway.Capability{
		ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search",
		InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusPending,
	}); err != nil {
		t.Fatalf("save capability: %v", err)
	}

	tests := []struct {
		name          string
		method        string
		path          string
		body          string
		authorization string
	}{
		{
			name:          "malformed sync authorization",
			method:        http.MethodPost,
			path:          "/api/v1/admin/mcp/upstream-servers/sync-tools",
			body:          `{"server_id":"crm-main"}`,
			authorization: "Basic abc",
		},
		{
			name:   "empty agent id",
			method: http.MethodPost,
			path:   "/api/v1/admin/mcp/agents",
			body:   `{"agent_id":"","name":"Sales Zhang Agent","status":"active"}`,
		},
		{
			name:   "empty capability status",
			method: http.MethodPatch,
			path:   "/api/v1/admin/mcp/capabilities",
			body:   `{"capability_id":"crm.customer.search","status":""}`,
		},
		{
			name:   "upstream status mixed with configuration",
			method: http.MethodPatch,
			path:   "/api/v1/admin/mcp/upstream-servers",
			body:   `{"server_id":"crm-main","status":"disabled","endpoint":"http://attacker.example/mcp"}`,
		},
		{
			name:   "empty grant agent id",
			method: http.MethodPost,
			path:   "/api/v1/admin/mcp/grants",
			body:   `{"agent_id":"","capability_id":"cap_search","grant_type":"tool","created_by":"admin"}`,
		},
		{
			name:   "empty grant capability id",
			method: http.MethodPost,
			path:   "/api/v1/admin/mcp/grants",
			body:   `{"agent_id":"sales_zhang_agent","capability_id":"","grant_type":"tool","created_by":"admin"}`,
		},
		{
			name:   "empty grant type",
			method: http.MethodPost,
			path:   "/api/v1/admin/mcp/grants",
			body:   `{"agent_id":"sales_zhang_agent","capability_id":"cap_search","grant_type":"","created_by":"admin"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body))
			if tt.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			if tt.authorization != "" {
				req.Header.Set("Authorization", tt.authorization)
			}
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
		})
	}
}

func TestAdminMCPWriteRoutesUseJSONIDs(t *testing.T) {
	newRouter := func(t *testing.T) (*mcpgateway.MemoryStore, http.Handler) {
		t.Helper()
		store := mcpgateway.NewMemoryStore()
		return store, newTestRouter(t, server.Options{ProxyGateway: testMCPGatewayService(store, fakeAdminUpstreamClient{})})
	}
	seedUpstreams := func(t *testing.T, store mcpgateway.Store) {
		t.Helper()
		for _, id := range []string{"server_query", "server_body"} {
			if err := store.SaveUpstreamServer(context.Background(), mcpgateway.UpstreamServer{ID: id, Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://" + id, Status: mcpgateway.StatusActive}); err != nil {
				t.Fatal(err)
			}
		}
	}
	seedAgents := func(t *testing.T, store mcpgateway.Store, proxy *mcpgateway.Service) {
		t.Helper()
		for _, id := range []string{"agent_query", "agent_body"} {
			if err := store.SaveAgent(context.Background(), mcpgateway.AgentRegistration{AgentID: id, Status: mcpgateway.StatusActive}); err != nil {
				t.Fatal(err)
			}
			if _, err := proxy.RotateAccountToken(context.Background(), mcpgateway.AccountTokenIssueRequest{UserID: id}); err != nil {
				t.Fatal(err)
			}
		}
	}
	seedCapabilities := func(t *testing.T, store mcpgateway.Store) {
		t.Helper()
		for _, id := range []string{"cap_query", "cap_body"} {
			if err := store.SaveCapability(context.Background(), mcpgateway.Capability{ID: id, Type: mcpgateway.CapabilityTool, UpstreamName: id, ExposedName: id, InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive}); err != nil {
				t.Fatal(err)
			}
		}
	}

	t.Run("upstream update", func(t *testing.T) {
		store, router := newRouter(t)
		seedUpstreams(t, store)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/upstream-servers?server_id=server_query", strings.NewReader(`{"status":"disabled"}`)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("query-only upstream update = %d body=%s, want 400", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/upstream-servers?server_id=server_query", strings.NewReader(`{"server_id":"server_body","status":"disabled"}`)))
		if rec.Code != http.StatusOK {
			t.Fatalf("conflicting upstream update = %d body=%s", rec.Code, rec.Body.String())
		}
		query, _ := store.GetUpstreamServer(context.Background(), "server_query")
		body, _ := store.GetUpstreamServer(context.Background(), "server_body")
		if query.Status != mcpgateway.StatusActive || body.Status != mcpgateway.StatusDisabled {
			t.Fatalf("upstream conflict targets query=%q body=%q, want active/disabled", query.Status, body.Status)
		}
	})

	t.Run("agent token rotate", func(t *testing.T) {
		store := mcpgateway.NewMemoryStore()
		proxy := testMCPGatewayService(store, fakeAdminUpstreamClient{})
		seedAgents(t, store, proxy)
		router := newTestRouter(t, server.Options{ProxyGateway: proxy})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/accounts/token/rotate?agent_id=agent_query", strings.NewReader(`{"scopes":["mcp:call"]}`)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("query-only agent rotate = %d body=%s, want 400", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/accounts/token/rotate?agent_id=agent_query", strings.NewReader(`{"user_id":"agent_body","scopes":["mcp:call"]}`)))
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_request") {
			t.Fatalf("conflicting agent rotate = %d body=%s, want invalid_request", rec.Code, rec.Body.String())
		}
	})

	t.Run("capability status", func(t *testing.T) {
		store, router := newRouter(t)
		seedCapabilities(t, store)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/capabilities?capability_id=cap_query", strings.NewReader(`{"status":"disabled"}`)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("query-only capability status = %d body=%s, want 400", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/v1/admin/mcp/capabilities?capability_id=cap_query", strings.NewReader(`{"capability_id":"cap_body","status":"disabled"}`)))
		if rec.Code != http.StatusOK {
			t.Fatalf("conflicting capability status = %d body=%s", rec.Code, rec.Body.String())
		}
		query, _ := store.GetCapabilityByExposedName(context.Background(), "cap_query")
		body, _ := store.GetCapabilityByExposedName(context.Background(), "cap_body")
		if query.Status != mcpgateway.StatusActive || body.Status != mcpgateway.StatusDisabled {
			t.Fatalf("capability conflict targets query=%q body=%q, want active/disabled", query.Status, body.Status)
		}
	})

	t.Run("capability gate policy", func(t *testing.T) {
		store, router := newRouter(t)
		seedCapabilities(t, store)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/v1/admin/mcp/capabilities/gate-policy?capability_id=cap_query", strings.NewReader(`{"approval_required":true}`)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("query-only gate policy = %d body=%s, want 400", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/v1/admin/mcp/capabilities/gate-policy?capability_id=cap_query", strings.NewReader(`{"capability_id":"cap_body","approval_required":true}`)))
		if rec.Code != http.StatusOK {
			t.Fatalf("conflicting gate policy = %d body=%s", rec.Code, rec.Body.String())
		}
		query, _ := store.GetCapabilityByExposedName(context.Background(), "cap_query")
		body, _ := store.GetCapabilityByExposedName(context.Background(), "cap_body")
		if query.ApprovalRequired || !body.ApprovalRequired {
			t.Fatalf("gate conflict targets query=%t body=%t, want false/true", query.ApprovalRequired, body.ApprovalRequired)
		}
	})
}

func TestAdminAccountTokenAndGrantRoutesRejectLegacyAgentID(t *testing.T) {
	router := newTestRouter(t, server.Options{ProxyGateway: testMCPGatewayService(mcpgateway.NewMemoryStore(), fakeAdminUpstreamClient{})})
	for _, test := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/v1/admin/mcp/accounts/token?user_id=user-a&agent_id=", ""},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/reveal", `{"user_id":"user-a","agent_id":""}`},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/rotate?agent_id=", `{"user_id":"user-a"}`},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/revoke", `{"user_id":"user-a","agent_id":"legacy"}`},
		{http.MethodGet, "/api/v1/admin/mcp/grants?agent_id=", ""},
		{http.MethodPost, "/api/v1/admin/mcp/grants", `{"agent_id":null,"user_id":"user-a","capability_id":"cap-a","grant_type":"tool"}`},
		{http.MethodPost, "/api/v1/admin/mcp/grants/remove", `{"agent_id":"legacy","grant_id":"grant-a"}`},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
		if test.body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_request") {
			t.Fatalf("%s %s status=%d body=%s, want invalid_request", test.method, test.path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestAdminAccountTokenRoutesValidateTargetAccount(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		AccountService: accountService,
		ProxyGateway:   testMCPGatewayService(mcpgateway.NewMemoryStore(), fakeAdminUpstreamClient{}),
	})
	adminCookies := register(t, router, `{"email":"token-admin@example.com","name":"Token Admin","password":"passw0rd!"}`)
	register(t, router, `{"email":"disabled-token@example.com","name":"Disabled Token","password":"passw0rd!"}`)
	disabledAccount, err := accountService.AuthenticateCredentials(ctx, accounts.LoginRequest{Email: "disabled-token@example.com", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := accountService.UpdateAccountStatus(ctx, disabledAccount.UserID, accounts.StatusDisabled); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		method string
		path   string
		body   string
		status int
		code   string
	}{
		{http.MethodGet, "/api/v1/admin/mcp/accounts/token?user_id=user-missing", "", http.StatusNotFound, "account_not_found"},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/reveal", `{"user_id":"user-missing"}`, http.StatusNotFound, "account_not_found"},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/revoke", `{"user_id":"user-missing"}`, http.StatusNotFound, "account_not_found"},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/rotate", `{"user_id":"` + disabledAccount.UserID + `"}`, http.StatusConflict, "account_not_active"},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(adminCookie(t, adminCookies))
		router.ServeHTTP(recorder, request)
		if recorder.Code != test.status || !strings.Contains(recorder.Body.String(), test.code) {
			t.Fatalf("%s %s status=%d body=%s, want %d %s", test.method, test.path, recorder.Code, recorder.Body.String(), test.status, test.code)
		}
	}
}

func TestHealthReadyMetricsRoutes(t *testing.T) {
	router := newTestRouter(t, server.Options{})

	for _, path := range []string{"/healthz", "/readyz"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want %d", path, rec.Code, http.StatusOK)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestSystemVersionRouteReturnsBuildInfo(t *testing.T) {
	oldVersion := buildinfo.Version
	oldBuildTime := buildinfo.BuildTime
	oldCommit := buildinfo.Commit
	t.Cleanup(func() {
		buildinfo.Version = oldVersion
		buildinfo.BuildTime = oldBuildTime
		buildinfo.Commit = oldCommit
	})
	buildinfo.Version = "0.1.1"
	buildinfo.BuildTime = "20260707T153015BJT"
	buildinfo.Commit = "abc1234"

	router := newTestRouter(t, server.Options{
		AccountService: newTestAccountService(accounts.NewMemoryStore()),
	})
	req := httptest.NewRequest(http.MethodGet, "/version", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("/version status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["name"] != "clawee-gateway" {
		t.Fatalf("name = %q", body["name"])
	}
	if body["version"] != "0.1.1" {
		t.Fatalf("version = %q", body["version"])
	}
	if body["build_time"] != "20260707T153015BJT" {
		t.Fatalf("build_time = %q", body["build_time"])
	}
	if body["commit"] != "abc1234" {
		t.Fatalf("commit = %q", body["commit"])
	}
	if body["full_version"] != "0.1.1+20260707T153015BJT.gabc1234" {
		t.Fatalf("full_version = %q", body["full_version"])
	}
}

func TestLegacyActionGatewayRoutesReturnNotFound(t *testing.T) {
	router := newTestRouter(t, server.Options{})

	tests := []struct {
		method                string
		path                  string
		body                  string
		forbiddenResponseBody string
	}{
		{
			method: http.MethodPost,
			path:   "/internal/actions",
			body:   `{"action":"customer.read","resource_type":"customer_profile","resource_id":"cust_001"}`,
		},
		{method: http.MethodGet, path: "/api/v1/admin/action-runs"},
		{method: http.MethodGet, path: "/api/v1/admin/audit-events"},
		{
			method:                http.MethodGet,
			path:                  "/api/v1/admin/audit-records/audit_001",
			forbiddenResponseBody: "audit record not found",
		},
	}

	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body))
			if tt.body != "" {
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-Debug-Actor-ID", "sales_zhang")
				req.Header.Set("X-Debug-Agent-ID", "sales_zhang_agent")
				req.Header.Set("X-Debug-Client-ID", "internal-debug-client")
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s status = %d, want %d; body=%s", tt.method, tt.path, rec.Code, http.StatusNotFound, rec.Body.String())
			}
			if tt.forbiddenResponseBody != "" && strings.Contains(rec.Body.String(), tt.forbiddenResponseBody) {
				t.Fatalf("%s %s body = %q, want route-level 404 without old handler message %q", tt.method, tt.path, rec.Body.String(), tt.forbiddenResponseBody)
			}
		})
	}
}

func TestAdminMCPAuditDetailFindsRecordsOutsideRecentPage(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	for index := 0; index < 201; index++ {
		id := fmt.Sprintf("audit_%03d", index)
		if err := store.SaveProxyAuditRecord(context.Background(), mcpgateway.ProxyAuditRecord{ID: id, CreatedAt: time.Unix(int64(index), 0)}); err != nil {
			t.Fatalf("save audit %s: %v", id, err)
		}
	}
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(store)})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/audits/detail?audit_id=audit_000", nil))

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"audit_000"`) {
		t.Fatalf("audit detail status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestLegacyAccountRoleRouteReturnsNotFound(t *testing.T) {
	router := newTestRouter(t, server.Options{})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/usr_1/role", strings.NewReader(`{"role":"admin"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("%s %s status = %d body=%s", req.Method, req.URL.Path, rec.Code, rec.Body.String())
	}
}

func TestLegacyAdminDynamicRoutesNotFound(t *testing.T) {
	ctx := context.Background()
	proxyStore := mcpgateway.NewMemoryStore()
	proxy := testProxyGateway(proxyStore)
	knowledgeStore := knowledge.NewMemoryStore()
	knowledgeService := knowledge.NewService(knowledgeStore, nil)
	if _, err := knowledgeStore.CreateKnowledgeBase(ctx, knowledge.KnowledgeBase{KnowledgeBaseID: "kb_legacy", Name: "Legacy Contract", Status: knowledge.KnowledgeBaseActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := knowledgeStore.CreateDocument(ctx, knowledge.Document{DocumentID: "doc_legacy", KnowledgeBaseID: "kb_legacy", Name: "legacy.txt", Status: knowledge.DocumentReady}); err != nil {
		t.Fatal(err)
	}
	for _, upstream := range []mcpgateway.UpstreamServer{
		{ID: "server_legacy", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://legacy.example/mcp", Status: mcpgateway.StatusActive},
		{ID: "server_delete", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://delete.example/mcp", Status: mcpgateway.StatusActive},
		{ID: "server_sync", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://sync.example/mcp", Status: mcpgateway.StatusActive},
	} {
		if err := proxyStore.SaveUpstreamServer(ctx, upstream); err != nil {
			t.Fatal(err)
		}
	}
	if err := proxyStore.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "agent_legacy", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := proxy.RotateAccountToken(ctx, mcpgateway.AccountTokenIssueRequest{UserID: "agent_legacy"}); err != nil {
		t.Fatal(err)
	}
	for _, capability := range []mcpgateway.Capability{
		{ID: "cap_status", UpstreamServerID: "server_legacy", Type: mcpgateway.CapabilityTool, UpstreamName: "status", ExposedName: "legacy.status", InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive},
		{ID: "cap_rename", UpstreamServerID: "server_legacy", Type: mcpgateway.CapabilityTool, UpstreamName: "rename", ExposedName: "legacy.rename", InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive},
		{ID: "cap_gates", UpstreamServerID: "server_legacy", Type: mcpgateway.CapabilityTool, UpstreamName: "gates", ExposedName: "legacy.gates", InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive},
	} {
		if err := proxyStore.SaveCapability(ctx, capability); err != nil {
			t.Fatal(err)
		}
	}
	if err := proxyStore.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_legacy", UserID: "agent_legacy", CapabilityID: "cap_status", GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatal(err)
	}
	for _, gate := range []mcpgateway.GateRequest{
		{ID: "gate_detail", Status: mcpgateway.GatePending},
		{ID: "gate_accept", Status: mcpgateway.GatePending},
		{ID: "gate_reject", Status: mcpgateway.GatePending},
	} {
		if err := proxyStore.SaveGateRequest(ctx, gate); err != nil {
			t.Fatal(err)
		}
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway:     proxy,
		KnowledgeService: knowledgeService,
	})
	accountID := testAdminUserID(t, router)

	assertLegacyRoutesNotFound(t, router, []legacyRoute{
		{method: http.MethodPost, path: "/api/v1/admin/accounts/" + accountID + "/status", body: `{"status":"active"}`},
		{method: http.MethodPost, path: "/api/v1/admin/accounts/" + accountID + "/password/reset", body: `{"password":"passw0rd!"}`},
		{method: http.MethodGet, path: "/api/v1/admin/mcp/upstream-servers/server_legacy"},
		{method: http.MethodPut, path: "/api/v1/admin/mcp/upstream-servers/server_legacy", body: `{"name":"Legacy"}`},
		{method: http.MethodDelete, path: "/api/v1/admin/mcp/upstream-servers/server_delete"},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/upstream-servers/server_legacy/status", body: `{"status":"disabled"}`},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/upstream-servers/server_sync/sync-tools"},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/agents/agent_legacy/token/copy"},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/agents/agent_legacy/token/rotate", body: `{"scopes":["mcp:call"]}`},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/agents/agent_legacy/token/revoke"},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/capabilities/cap_status/status", body: `{"status":"disabled"}`},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/capabilities/cap_rename/rename", body: `{"exposed_name":"legacy.renamed"}`},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/capabilities/cap_gates/gates", body: `{"approval_required":true}`},
		{method: http.MethodGet, path: "/api/v1/admin/mcp/gates/gate_detail"},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/gates/gate_accept/accept"},
		{method: http.MethodPost, path: "/api/v1/admin/mcp/gates/gate_reject/reject", body: `{"reason":"legacy"}`},
		{method: http.MethodDelete, path: "/api/v1/admin/mcp/grants/grant_legacy"},
		{method: http.MethodGet, path: "/api/v1/admin/knowledge-bases/kb_legacy"},
		{method: http.MethodGet, path: "/api/v1/admin/knowledge-bases/kb_legacy/documents"},
		{method: http.MethodPost, path: "/api/v1/admin/knowledge-bases/kb_legacy/documents"},
		{method: http.MethodPost, path: "/api/v1/admin/knowledge-bases/kb_legacy/documents/sync"},
		{method: http.MethodDelete, path: "/api/v1/admin/knowledge-bases/kb_legacy/documents/doc_legacy"},
		{method: http.MethodDelete, path: "/api/v1/admin/knowledge-bases/kb_legacy"},
		{method: http.MethodGet, path: "/api/v1/admin/industry-packs/sales-crm/summary"},
		{method: http.MethodGet, path: "/api/v1/admin/industry-packs/sales-crm/customers"},
		{method: http.MethodGet, path: "/api/v1/admin/industry-packs/sales-crm/customers/1/timeline"},
	})
}

func TestStaticAdminHistoryFallbackDoesNotOverrideAdminAPI(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<div>admin app</div>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}

	router := newTestRouter(t, server.Options{
		StaticDir: staticDir,
	})

	req := httptest.NewRequest(http.MethodGet, "/admin/settings", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/admin/settings status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "<div>admin app</div>" {
		t.Fatalf("static fallback body = %q", rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("static fallback Cache-Control = %q, want no-cache", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/app/agents", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/app/agents status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "<div>admin app</div>" {
		t.Fatalf("app static fallback body = %q", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/login", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/login status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "<div>admin app</div>" {
		t.Fatalf("login static fallback body = %q", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/register", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/register status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "<div>admin app</div>" {
		t.Fatalf("register static fallback body = %q", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/admin/missing", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/api/v1/admin/missing status = %d, want %d", rec.Code, http.StatusNotFound)
	}

	req = httptest.NewRequest(http.MethodGet, "/agent/api/missing", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/agent/api/missing status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestStaticAssetsUsePrecompressedGzipAndImmutableCache(t *testing.T) {
	staticDir := t.TempDir()
	assetsDir := filepath.Join(staticDir, "assets")
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		t.Fatalf("create assets directory: %v", err)
	}
	original := bytes.Repeat([]byte("console.log('static asset');\n"), 100)
	assetPath := filepath.Join(assetsDir, "index-12345678.js")
	if err := os.WriteFile(assetPath, original, 0o644); err != nil {
		t.Fatalf("write static asset: %v", err)
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(original); err != nil {
		t.Fatalf("compress static asset: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}
	if err := os.WriteFile(assetPath+".gz", compressed.Bytes(), 0o644); err != nil {
		t.Fatalf("write compressed static asset: %v", err)
	}

	router := newTestRouter(t, server.Options{StaticDir: staticDir})

	req := httptest.NewRequest(http.MethodGet, "/assets/index-12345678.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("compressed static asset status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Fatalf("Vary = %q, want Accept-Encoding", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q, want immutable asset cache", got)
	}
	reader, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("open gzip response: %v", err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip response: %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close gzip response: %v", err)
	}
	if !bytes.Equal(decoded, original) {
		t.Fatal("compressed static asset body does not match original")
	}

	req = httptest.NewRequest(http.MethodGet, "/assets/index-12345678.js", nil)
	req.Header.Set("Accept-Encoding", "gzip;q=0")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("disabled gzip Content-Encoding = %q, want empty", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), original) {
		t.Fatal("identity static asset body does not match original")
	}

	req = httptest.NewRequest(http.MethodGet, "/assets/index-12345678.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-9")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("range static asset status = %d, want %d", rec.Code, http.StatusPartialContent)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("range static asset Content-Encoding = %q, want empty", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), original[:10]) {
		t.Fatal("range static asset body does not match original range")
	}

	req = httptest.NewRequest(http.MethodHead, "/assets/index-12345678.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("compressed static asset HEAD status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("compressed static asset HEAD body length = %d, want 0", rec.Body.Len())
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("compressed static asset HEAD Content-Encoding = %q, want gzip", got)
	}
}

func TestLegacyAgentStaticRouteNotFound(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<div>admin app</div>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}

	router := newTestRouter(t, server.Options{StaticDir: staticDir})

	for _, urlPath := range []string{"/agent", "/agent/history"} {
		req := httptest.NewRequest(http.MethodGet, urlPath, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want %d", urlPath, rec.Code, http.StatusNotFound)
		}
	}
}

func TestRootRedirectsToFrontendApp(t *testing.T) {
	router := newTestRouter(t, server.Options{})

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		req := httptest.NewRequest(method, "/", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusFound {
			t.Fatalf("%s / status = %d, want %d", method, rec.Code, http.StatusFound)
		}
		if location := rec.Header().Get("Location"); location != "/app" {
			t.Fatalf("%s / location = %q, want /app", method, location)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/missing", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/missing status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestStaticAdminHistoryFallbackUsesEmbeddedDistByDefault(t *testing.T) {
	router := newTestRouter(t, server.Options{})

	req := httptest.NewRequest(http.MethodGet, "/admin/settings", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/admin/settings status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`<div id="root"></div>`)) {
		t.Fatalf("embedded static fallback body missing app root: %s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/favicon.ico", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/favicon.ico status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=86400" {
		t.Fatalf("favicon Cache-Control = %q, want one-day public cache", got)
	}
}

func TestEmbeddedPublicRootSVGAssets(t *testing.T) {
	router := newTestRouter(t, server.Options{})

	for _, requestPath := range []string{
		"/favicon.svg",
		"/logo-v2-black-logo.svg",
		"/logo-v2-white-logo.svg",
	} {
		t.Run(requestPath, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, requestPath, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("%s status = %d, want %d", requestPath, rec.Code, http.StatusOK)
			}
			if got := rec.Header().Get("Content-Type"); got != "image/svg+xml" {
				t.Fatalf("%s Content-Type = %q, want image/svg+xml", requestPath, got)
			}
			if got := rec.Header().Get("Cache-Control"); got != "public, max-age=86400" {
				t.Fatalf("%s Cache-Control = %q, want one-day public cache", requestPath, got)
			}
			if !bytes.Contains(rec.Body.Bytes(), []byte("<svg")) {
				t.Fatalf("%s body does not contain an SVG element", requestPath)
			}
		})
	}

	req := httptest.NewRequest(http.MethodGet, "/unknown-logo.svg", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown root asset status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestEmbeddedPublicRootPNGAssets(t *testing.T) {
	router := newTestRouter(t, server.Options{})

	for _, requestPath := range []string{
		"/krillinai-mark-black.png",
		"/krillinai-mark-white.png",
		"/krillinai-wordmark-black.png",
		"/krillinai-wordmark-white.png",
	} {
		t.Run(requestPath, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, requestPath, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("%s status = %d, want %d", requestPath, rec.Code, http.StatusOK)
			}
			if got := rec.Header().Get("Content-Type"); got != "image/png" {
				t.Fatalf("%s Content-Type = %q, want image/png", requestPath, got)
			}
			if got := rec.Header().Get("Cache-Control"); got != "public, max-age=86400" {
				t.Fatalf("%s Cache-Control = %q, want one-day public cache", requestPath, got)
			}
			if !bytes.HasPrefix(rec.Body.Bytes(), []byte("\x89PNG\r\n\x1a\n")) {
				t.Fatalf("%s body is not a PNG", requestPath)
			}
		})
	}
}

func TestEmbeddedStaticAssetUsesPrecompressedGzip(t *testing.T) {
	router := newTestRouter(t, server.Options{})

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/admin status = %d, want %d", rec.Code, http.StatusOK)
	}
	marker := `src="/assets/`
	start := strings.Index(rec.Body.String(), marker)
	if start < 0 {
		t.Fatalf("embedded index does not reference an entry asset: %s", rec.Body.String())
	}
	start += len(`src="`)
	end := strings.Index(rec.Body.String()[start:], `"`)
	if end < 0 {
		t.Fatalf("embedded index entry asset is malformed: %s", rec.Body.String())
	}
	assetPath := rec.Body.String()[start : start+end]

	identityReq := httptest.NewRequest(http.MethodGet, assetPath, nil)
	identityRec := httptest.NewRecorder()
	router.ServeHTTP(identityRec, identityReq)
	if identityRec.Code != http.StatusOK {
		t.Fatalf("embedded identity asset status = %d, want %d", identityRec.Code, http.StatusOK)
	}

	req = httptest.NewRequest(http.MethodGet, assetPath, nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("embedded compressed asset status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("embedded asset Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("embedded asset Cache-Control = %q, want immutable asset cache", got)
	}
	reader, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("open embedded gzip response: %v", err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read embedded gzip response: %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close embedded gzip response: %v", err)
	}
	if !bytes.Equal(decoded, identityRec.Body.Bytes()) {
		t.Fatal("embedded compressed asset body does not match identity response")
	}
	if rec.Body.Len() >= identityRec.Body.Len() {
		t.Fatalf("embedded compressed asset size = %d, want less than identity size %d", rec.Body.Len(), identityRec.Body.Len())
	}
}

func TestStaticDirOverridesEmbeddedDist(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<div>override app</div>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}

	router := newTestRouter(t, server.Options{
		StaticDir: staticDir,
	})

	req := httptest.NewRequest(http.MethodGet, "/admin/settings", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/admin/settings status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "<div>override app</div>" {
		t.Fatalf("static fallback body = %q", rec.Body.String())
	}
}

func TestMCPRouteRequiresBearerToken(t *testing.T) {
	router := newTestRouter(t, server.Options{
		MCPAuth: server.MCPAuthOptions{
			Enabled:             true,
			Resource:            "http://example.com/mcp",
			ResourceMetadataURL: "http://example.com/.well-known/oauth-protected-resource/mcp",
			RequiredScopes:      []string{"mcp:call"},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("/mcp status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if got := rec.Header().Get("WWW-Authenticate"); got == "" {
		t.Fatal("missing WWW-Authenticate header")
	}
}

func TestProtectedResourceMetadata(t *testing.T) {
	router := newTestRouter(t, server.Options{
		MCPAuth: server.MCPAuthOptions{
			Enabled:              true,
			Resource:             "http://example.com/mcp",
			ResourceMetadataURL:  "http://example.com/.well-known/oauth-protected-resource/mcp",
			AuthorizationServers: []string{"http://example.com/mock-oauth"},
			RequiredScopes:       []string{"mcp:call"},
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/.well-known/oauth-protected-resource/mcp", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("metadata status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"resource":"http://example.com/mcp"`)) {
		t.Fatalf("metadata body missing resource: %s", rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"mcp:call"`)) {
		t.Fatalf("metadata body missing scope: %s", rec.Body.String())
	}
}

func TestUpstreamMCPEndpointsAndKnowledgeAlias(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	for _, upstream := range []mcpgateway.UpstreamServer{
		{ID: "crm-main", Name: "CRM", Namespace: "crm", Status: mcpgateway.StatusActive},
		{ID: mcpgateway.KnowledgeAdapterServerID, Name: "Knowledge", Namespace: "knowledge", Status: mcpgateway.StatusActive},
	} {
		if err := store.SaveUpstreamServer(ctx, upstream); err != nil {
			t.Fatal(err)
		}
	}
	for _, capability := range []mcpgateway.Capability{
		{ID: "cap_crm", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool, UpstreamName: "customer.search", ExposedName: "crm.customer.search", InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive},
		{ID: "cap_knowledge", UpstreamServerID: mcpgateway.KnowledgeAdapterServerID, Type: mcpgateway.CapabilityTool, UpstreamName: mcpgateway.KnowledgeSearchUpstreamName, ExposedName: mcpgateway.KnowledgeSearchExposedName, InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive},
	} {
		if err := store.SaveCapability(ctx, capability); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_" + capability.ID, UserID: "agent-1", CapabilityID: capability.ID, GrantType: mcpgateway.GrantTool}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "agent-1", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	accountSvc, mcpAuth := accountTokenMCPAuthFixture(t, store, "agent-1", "agent-1", "agent-token")
	mcpAuth.PublicBaseURL = "https://gateway.example.com"
	mcpAuth.Resource = "https://gateway.example.com/mcp"
	mcpAuth.ResourceMetadataURL = "https://gateway.example.com/.well-known/oauth-protected-resource/mcp"
	router := server.NewRouter(server.Options{
		AccountService: accountSvc,
		ProxyGateway:   configureTestIdentityResolvers(mcpgateway.NewService(mcpgateway.Config{Store: store})),
		MCPAuth:        mcpAuth,
	})
	httpServer := httptest.NewServer(router)
	defer httpServer.Close()

	assertTools := func(path string, want []string) {
		t.Helper()
		client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v1"}, nil)
		session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
			Endpoint:   httpServer.URL + path,
			HTTPClient: &http.Client{Transport: staticBearerTransport{token: "agent-token"}},
		}, nil)
		if err != nil {
			t.Fatalf("connect %s: %v", path, err)
		}
		defer session.Close()
		if got := session.InitializeResult().ProtocolVersion; got != "2026-07-28" {
			t.Fatalf("protocol version at %s = %q, want 2026-07-28", path, got)
		}
		if session.ID() != "" {
			t.Fatalf("session ID at %s = %q, want empty in stateless mode", path, session.ID())
		}
		result, err := session.ListTools(ctx, nil)
		if err != nil {
			t.Fatalf("list %s: %v", path, err)
		}
		got := make([]string, 0, len(result.Tools))
		for _, tool := range result.Tools {
			got = append(got, tool.Name)
		}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Fatalf("tools at %s = %v, want %v", path, got, want)
		}
	}
	assertProtocol := func(path string) {
		t.Helper()
		client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v1"}, nil)
		session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
			Endpoint:   httpServer.URL + path,
			HTTPClient: &http.Client{Transport: staticBearerTransport{token: "agent-token"}},
		}, nil)
		if err != nil {
			t.Fatalf("connect %s: %v", path, err)
		}
		defer session.Close()
		if got := session.InitializeResult().ProtocolVersion; got != "2026-07-28" {
			t.Fatalf("protocol version at %s = %q, want 2026-07-28", path, got)
		}
		if session.ID() != "" {
			t.Fatalf("session ID at %s = %q, want empty in stateless mode", path, session.ID())
		}
	}
	assertProtocol("/mcp")
	assertTools("/mcp/servers/crm-main", []string{"customer.search"})
	assertTools("/mcp/knowledge", []string{"search"})
	req := httptest.NewRequest(http.MethodPost, "/mcp/servers/crm-main", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "https://gateway.example.com/.well-known/oauth-protected-resource/mcp/servers/crm-main") {
		t.Fatalf("upstream auth challenge status=%d header=%q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}

	req = httptest.NewRequest(http.MethodGet, "/.well-known/oauth-protected-resource/mcp/knowledge", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"resource":"https://gateway.example.com/mcp/knowledge"`) {
		t.Fatalf("knowledge metadata status=%d body=%s", rec.Code, rec.Body.String())
	}

	crm, err := store.GetUpstreamServer(ctx, "crm-main")
	if err != nil {
		t.Fatal(err)
	}
	crm.Status = mcpgateway.StatusDisabled
	if err := store.SaveUpstreamServer(ctx, crm); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/mcp/servers/crm-main", nil)
	req.Header.Set("Authorization", "Bearer agent-token")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("disabled upstream status = %d, want 404", rec.Code)
	}
}

func TestDataMCPEndpointsAndDoubleAuthorization(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	access := dataaccess.NewService(dataaccess.NewMemoryStore())
	agentClient, err := agentactivitymcp.NewClient(nil, nil, access)
	if err != nil {
		t.Fatal(err)
	}
	businessClient, err := businessdatamcp.NewClient(nil, access)
	if err != nil {
		t.Fatal(err)
	}
	routingClient := mcpgateway.NewRoutingUpstreamClient(nil, nil)
	if err := routingClient.Register(agentactivitymcp.ServerID, agentClient); err != nil {
		t.Fatal(err)
	}
	if err := routingClient.Register(businessdatamcp.ServerID, businessClient); err != nil {
		t.Fatal(err)
	}
	for _, upstream := range []mcpgateway.UpstreamServer{
		{ID: agentactivitymcp.ServerID, Name: "Agent Activity", Transport: mcpgateway.TransportBuiltin, Namespace: "agent_activity", Status: mcpgateway.StatusActive},
		{ID: businessdatamcp.ServerID, Name: "Business Data", Transport: mcpgateway.TransportBuiltin, Namespace: "business_data", Status: mcpgateway.StatusActive},
	} {
		if err := store.SaveUpstreamServer(ctx, upstream); err != nil {
			t.Fatal(err)
		}
	}
	gateway := configureTestIdentityResolvers(mcpgateway.NewService(mcpgateway.Config{Store: store, UpstreamClient: routingClient}))
	for _, serverID := range []string{agentactivitymcp.ServerID, businessdatamcp.ServerID} {
		if err := gateway.SyncTools(ctx, serverID, ""); err != nil {
			t.Fatal(err)
		}
	}
	capabilities, err := store.ListCapabilities(ctx, mcpgateway.CapabilityFilter{Type: mcpgateway.CapabilityTool})
	if err != nil {
		t.Fatal(err)
	}
	for _, capability := range capabilities {
		capability.Status = mcpgateway.StatusActive
		if err := store.SaveCapability(ctx, capability); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_http_" + capability.ID, UserID: "user-1", CapabilityID: capability.ID, GrantType: mcpgateway.GrantTool}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "agent-1", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	accountSvc, mcpAuth := accountTokenMCPAuthFixture(t, store, "user-1", "agent-1", "agent-token")
	mcpAuth.Resource = "http://example.com/mcp"
	router := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: gateway, MCPAuth: mcpAuth})
	httpServer := httptest.NewServer(router)
	defer httpServer.Close()

	connect := func(path string) *mcp.ClientSession {
		t.Helper()
		client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v1"}, nil)
		session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
			Endpoint:   httpServer.URL + path,
			HTTPClient: &http.Client{Transport: staticBearerTransport{token: "agent-token"}},
		}, nil)
		if err != nil {
			t.Fatalf("connect %s: %v", path, err)
		}
		t.Cleanup(func() { _ = session.Close() })
		return session
	}
	assertToolSet := func(path string, want []string) {
		t.Helper()
		result, err := connect(path).ListTools(ctx, nil)
		if err != nil {
			t.Fatalf("list %s: %v", path, err)
		}
		got := make(map[string]bool, len(result.Tools))
		for _, tool := range result.Tools {
			got[tool.Name] = true
		}
		if len(got) != len(want) {
			t.Fatalf("tools at %s = %#v, want %v", path, got, want)
		}
		for _, name := range want {
			if !got[name] {
				t.Fatalf("tools at %s missing %q: %#v", path, name, got)
			}
		}
	}
	assertToolSet("/mcp/servers/agent-activity", []string{"summary", "agents", "agent_detail", "metric_explain"})
	assertToolSet("/mcp/servers/business-data", []string{"views", "dashboard", "compare", "metric_explain"})

	rootSession := connect("/mcp")
	listed, err := rootSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantAggregated := map[string]bool{
		"agent_activity.summary": true, "agent_activity.agents": true, "agent_activity.agent_detail": true, "agent_activity.metric_explain": true,
		"business_data.views": true, "business_data.dashboard": true, "business_data.compare": true, "business_data.metric_explain": true,
	}
	gotAggregated := map[string]bool{}
	for _, tool := range listed.Tools {
		if strings.HasPrefix(tool.Name, "agent_activity.") || strings.HasPrefix(tool.Name, "business_data.") {
			gotAggregated[tool.Name] = true
		}
	}
	if len(gotAggregated) != len(wantAggregated) {
		t.Fatalf("aggregated data tools = %#v, want %#v", gotAggregated, wantAggregated)
	}
	for name := range wantAggregated {
		if !gotAggregated[name] {
			t.Fatalf("aggregated data tools missing %q: %#v", name, gotAggregated)
		}
	}

	calls := []struct {
		name      string
		arguments map[string]any
		viewID    string
	}{
		{name: "agent_activity.metric_explain", arguments: map[string]any{"metric_ids": []any{"total_tokens"}}, viewID: dataaccess.ViewAgentActivity},
		{name: "business_data.metric_explain", arguments: map[string]any{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": []any{"exposure_count"}}, viewID: businessdata.ViewXiaohongshuOperation},
	}
	for _, call := range calls {
		result, err := rootSession.CallTool(ctx, &mcp.CallToolParams{Name: call.name, Arguments: call.arguments})
		if err != nil {
			t.Fatalf("call %s without data grant: %v", call.name, err)
		}
		body, ok := result.StructuredContent.(map[string]any)
		if !ok || !result.IsError || body["code"] != "data_view_forbidden" {
			t.Fatalf("call %s without data grant = %#v", call.name, result)
		}
		if _, err := access.Create(ctx, dataaccess.SetInput{UserID: "user-1", ResourceType: dataaccess.ResourceDataView, ResourceID: call.viewID, Actions: []string{dataaccess.ActionRead}, CreatedBy: "test"}); err != nil {
			t.Fatal(err)
		}
		result, err = rootSession.CallTool(ctx, &mcp.CallToolParams{Name: call.name, Arguments: call.arguments})
		if err != nil || result.IsError || result.StructuredContent == nil {
			t.Fatalf("call %s with both grants = %#v, error = %v", call.name, result, err)
		}
	}
}

func TestMCPRouteAcceptsLegacyInitializeWithoutCreatingSession(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveAgent(context.Background(), mcpgateway.AgentRegistration{AgentID: "agent-1", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	accountSvc, mcpAuth := accountTokenMCPAuthFixture(t, store, "user-1", "agent-1", "agent-token")
	mcpAuth.Resource = "http://example.com/mcp"
	router := newTestRouter(t, server.Options{
		AccountService: accountSvc,
		ProxyGateway:   configureTestIdentityResolvers(mcpgateway.NewService(mcpgateway.Config{Store: store})),
		MCPAuth:        mcpAuth,
	})
	body := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"legacy-test","version":"v1"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/mcp", body)
	req.Header.Set("Authorization", "Bearer agent-token")
	req.Header.Set("X-Claw-Agent-ID", "agent-1")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", "2025-11-25")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy initialize status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Mcp-Session-Id"); got != "" {
		t.Fatalf("legacy initialize session ID = %q, want empty in stateless mode", got)
	}
	if !strings.Contains(rec.Body.String(), `"protocolVersion":"2025-11-25"`) {
		t.Fatalf("legacy initialize body = %s", rec.Body.String())
	}

	body = strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	req = httptest.NewRequest(http.MethodPost, "/mcp", body)
	req.Header.Set("Authorization", "Bearer agent-token")
	req.Header.Set("X-Claw-Agent-ID", "agent-1")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", "2025-11-25")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy tools/list status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Mcp-Session-Id"); got != "" {
		t.Fatalf("legacy tools/list session ID = %q, want empty in stateless mode", got)
	}
	if !strings.Contains(rec.Body.String(), `"name":"mcp.gate.status"`) {
		t.Fatalf("legacy tools/list body missing builtin gate tool = %s", rec.Body.String())
	}
}

func TestMCPRoutePropagatesRequestCancellation(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{ID: "crm-main", Name: "CRM", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "agent-1", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := mcpgateway.Capability{
		ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search",
		InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive,
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_search", UserID: "agent-1", CapabilityID: capability.ID, GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatal(err)
	}
	accountSvc, mcpAuth := accountTokenMCPAuthFixture(t, store, "agent-1", "agent-1", "agent-token")
	mcpAuth.Resource = "http://example.com/mcp"
	upstream := &cancellableUpstreamClient{started: make(chan struct{}), cancelled: make(chan struct{})}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc,
		ProxyGateway:   configureTestIdentityResolvers(mcpgateway.NewService(mcpgateway.Config{Store: store, UpstreamClient: upstream})),
		MCPAuth:        mcpAuth,
	})
	httpServer := httptest.NewServer(router)
	defer httpServer.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   httpServer.URL + "/mcp",
		HTTPClient: &http.Client{Transport: staticBearerTransport{token: "agent-token"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	callCtx, cancel := context.WithCancel(ctx)
	callDone := make(chan error, 1)
	go func() {
		_, err := session.CallTool(callCtx, &mcp.CallToolParams{Name: "crm.customer.search", Arguments: map[string]any{}})
		callDone <- err
	}()
	select {
	case <-upstream.started:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for upstream call")
	}
	cancel()
	select {
	case <-upstream.cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for upstream cancellation")
	}
	select {
	case err := <-callDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("call error = %v, want context canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for cancelled tool call")
	}
}
