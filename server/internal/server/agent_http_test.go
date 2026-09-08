package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentactivitymcp"
	"github.com/krillinai/Clawee/server/internal/businessdatamcp"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestAgentMCPCatalogReturnsAuthorizedCapabilitiesForCurrentAccount(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "catalog-owner@example.com", Name: "Catalog Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "catalog-other@example.com", Name: "Catalog Other", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, owner.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}

	proxyStore := mcpgateway.NewMemoryStore()
	proxyGateway := testProxyGateway(proxyStore)
	dataAccessService := dataaccess.NewService(dataaccess.NewMemoryStore())
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "owner-primary")
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "owner-secondary")
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, other.Account.UserID, "other-agent")
	if err := proxyStore.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{
		ID: "crm-main", Name: "CRM", Domain: "sales", Transport: mcpgateway.TransportStreamableHTTP,
		Endpoint: "http://crm.internal/mcp", Namespace: "crm", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	for _, capability := range []mcpgateway.Capability{
		{ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool, ExposedName: "crm.customer.search", Title: "查询客户", Status: mcpgateway.StatusActive},
		{ID: "cap_delete", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool, ExposedName: "crm.customer.delete", Title: "删除客户", Status: mcpgateway.StatusActive},
	} {
		if err := proxyStore.SaveCapability(ctx, capability); err != nil {
			t.Fatal(err)
		}
	}
	for _, upstream := range []mcpgateway.UpstreamServer{
		{ID: agentactivitymcp.ServerID, Name: "Agent 动态", Transport: mcpgateway.TransportBuiltin, Namespace: "agent_activity", Status: mcpgateway.StatusActive},
		{ID: businessdatamcp.ServerID, Name: "业务数据", Transport: mcpgateway.TransportBuiltin, Namespace: "business_data", Status: mcpgateway.StatusActive},
	} {
		if err := proxyStore.SaveUpstreamServer(ctx, upstream); err != nil {
			t.Fatal(err)
		}
	}
	for _, capability := range []mcpgateway.Capability{
		{ID: "cap_activity", UpstreamServerID: agentactivitymcp.ServerID, Type: mcpgateway.CapabilityTool, ExposedName: "agent_activity.summary", Status: mcpgateway.StatusActive},
		{ID: "cap_business", UpstreamServerID: businessdatamcp.ServerID, Type: mcpgateway.CapabilityTool, ExposedName: "business_data.views", Status: mcpgateway.StatusActive},
	} {
		if err := proxyStore.SaveCapability(ctx, capability); err != nil {
			t.Fatal(err)
		}
		if err := proxyStore.SaveGrant(ctx, mcpgateway.AccountGrant{
			ID: "grant_" + capability.ID, UserID: owner.Account.UserID, CapabilityID: capability.ID, GrantType: mcpgateway.GrantTool,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := proxyStore.SaveGrant(ctx, mcpgateway.AccountGrant{
		ID: "grant_search", UserID: owner.Account.UserID, CapabilityID: "cap_search", GrantType: mcpgateway.GrantTool,
	}); err != nil {
		t.Fatal(err)
	}

	router := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: proxyGateway, DataAccessService: dataAccessService})
	request := func(path string, authenticated bool) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if authenticated {
			req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}

	recorder := request("/api/v1/app/mcp/catalog", true)
	if recorder.Code != http.StatusOK {
		t.Fatalf("default catalog status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Data struct {
			Upstreams []struct {
				ID          string `json:"id"`
				IconURL     string `json:"icon_url"`
				MCPEndpoint string `json:"mcp_endpoint"`
				Status      string `json:"status"`
				Tools       []struct {
					Name        string `json:"name"`
					ExposedName string `json:"exposed_name"`
					Authorized  bool   `json:"authorized"`
				} `json:"tools"`
			} `json:"upstreams"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Data.Upstreams) != 1 {
		t.Fatalf("default catalog = %#v", response.Data)
	}
	upstream := response.Data.Upstreams[0]
	if upstream.MCPEndpoint != "http://example.com/mcp/servers/crm-main" || upstream.Status != mcpgateway.StatusActive {
		t.Fatalf("catalog upstream = %#v", upstream)
	}
	if upstream.IconURL != "/assets/app-icons/mcp-f654f2a2.png" {
		t.Fatalf("catalog upstream icon_url = %q", upstream.IconURL)
	}
	if strings.Contains(recorder.Body.String(), "crm.internal") {
		t.Fatalf("catalog leaked raw upstream endpoint: %s", recorder.Body.String())
	}
	tools := upstream.Tools
	if len(tools) != 1 || tools[0].Name != "customer.search" || tools[0].ExposedName != "crm.customer.search" || !tools[0].Authorized {
		t.Fatalf("catalog tools = %#v", tools)
	}
	if strings.Contains(recorder.Body.String(), agentactivitymcp.ServerID) || strings.Contains(recorder.Body.String(), businessdatamcp.ServerID) {
		t.Fatalf("catalog exposed data MCP without data grants: %s", recorder.Body.String())
	}
	if _, err := dataAccessService.Create(ctx, dataaccess.SetInput{UserID: owner.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	recorder = request("/api/v1/app/mcp/catalog", true)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), agentactivitymcp.ServerID) || strings.Contains(recorder.Body.String(), businessdatamcp.ServerID) {
		t.Fatalf("activity-authorized catalog status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := dataAccessService.Create(ctx, dataaccess.SetInput{UserID: owner.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewXiaohongshuOperation, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	recorder = request("/api/v1/app/mcp/catalog", true)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), agentactivitymcp.ServerID) || !strings.Contains(recorder.Body.String(), businessdatamcp.ServerID) {
		t.Fatalf("data-authorized catalog status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	failingDataAccessService := dataaccess.NewService(failingCatalogDataAccessStore{MemoryStore: dataaccess.NewMemoryStore()})
	failingRouter := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: proxyGateway, DataAccessService: failingDataAccessService})
	recorder = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/mcp/catalog", nil)
	req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	failingRouter.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"data_authorization_unavailable"`) {
		t.Fatalf("authorization unavailable status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder = request("/api/v1/app/mcp/catalog?agent_id=owner-secondary", true)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("secondary catalog status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = request("/api/v1/app/mcp/catalog?agent_id=other-agent", true)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("cross-account catalog status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = request("/api/v1/app/mcp/catalog", false)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated catalog status = %d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestUpdateAgentNameOnlyUpdatesOwnedAgentName(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "rename-owner@example.com", Name: "Rename Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "rename-other@example.com", Name: "Rename Other", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, owner.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}

	proxyStore := mcpgateway.NewMemoryStore()
	proxyGateway := testProxyGateway(proxyStore)
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "owner-agent")
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, other.Account.UserID, "other-agent")
	router := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: proxyGateway})
	request := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/app/agents/name", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, req)
		return recorder
	}

	recorder := request(`{"agent_id":"owner-agent","name":"  销售助手  "}`)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"name":"销售助手"`) {
		t.Fatalf("update name status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	agent, err := proxyStore.GetAgent(ctx, "owner-agent")
	if err != nil {
		t.Fatal(err)
	}
	if agent.AgentID != "owner-agent" || agent.Name != "销售助手" || agent.Status != mcpgateway.StatusActive {
		t.Fatalf("updated agent = %#v", agent)
	}

	recorder = request(`{"agent_id":"owner-agent","name":"   "}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("clear name status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	agent, err = proxyStore.GetAgent(ctx, "owner-agent")
	if err != nil || agent.Name != "" {
		t.Fatalf("cleared agent=%#v error=%v", agent, err)
	}

	recorder = request(`{"agent_id":"other-agent","name":"越权修改"}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("cross-account update status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	otherAgent, err := proxyStore.GetAgent(ctx, "other-agent")
	if err != nil || otherAgent.Name != "" {
		t.Fatalf("other agent=%#v error=%v", otherAgent, err)
	}

	recorder = request(`{"agent_id":"","name":"无效修改"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("empty agent id status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDeleteAgentOnlyDeletesOwnedAgent(t *testing.T) {
	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	accountSvc := newTestAccountService(accountStore)
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "delete-owner@example.com", Name: "Delete Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "delete-other@example.com", Name: "Delete Other", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, owner.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}

	proxyStore := mcpgateway.NewMemoryStore()
	proxyStore.SetOwnedAgentRemover(accountStore.DeleteAccountAgent)
	proxyGateway := testProxyGateway(proxyStore)
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "owned-agent")
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, other.Account.UserID, "other-agent")
	router := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: proxyGateway})
	request := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/app/agents/remove", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, req)
		return recorder
	}

	if recorder := request(`{"agent_id":""}`); recorder.Code != http.StatusBadRequest {
		t.Fatalf("empty agent id status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(`{"agent_id":"other-agent"}`); recorder.Code != http.StatusNotFound {
		t.Fatalf("cross-account delete status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := proxyStore.GetAgent(ctx, "other-agent"); err != nil {
		t.Fatalf("cross-account agent was changed: %v", err)
	}
	if recorder := request(`{"agent_id":"owned-agent"}`); recorder.Code != http.StatusNoContent {
		t.Fatalf("delete owned agent status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := proxyStore.GetAgent(ctx, "owned-agent"); !errors.Is(err, mcpgateway.ErrAgentNotFound) {
		t.Fatalf("deleted agent error=%v, want %v", err, mcpgateway.ErrAgentNotFound)
	}
	if _, err := accountSvc.AccountForAgent(ctx, "owned-agent"); !errors.Is(err, accounts.ErrAccountAgentNotFound) {
		t.Fatalf("deleted agent binding error=%v, want %v", err, accounts.ErrAccountAgentNotFound)
	}
}

func TestAgentListReturnsCollectorCreationSourceAndDevice(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "collector-owner@example.com", Name: "Collector Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, owner.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := mcpgateway.NewMemoryStore()
	proxyGateway := testProxyGateway(proxyStore)
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "collector-agent")
	agent, err := proxyStore.GetAgent(ctx, "collector-agent")
	if err != nil {
		t.Fatal(err)
	}
	agent.CreationSource = mcpgateway.AgentCreationSourceCollector
	if err := proxyStore.SaveAgent(ctx, agent); err != nil {
		t.Fatal(err)
	}
	lookup := staticAgentCollectorLookup{info: management.AgentCollectorInfo{
		CollectorID: "collector_1", OfficeAgentID: "codex:device_1:main", DeviceID: "device_1",
		DeviceName: "MacBook", Hostname: "mac.local", OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.1",
		Status: management.CollectorStatusOnline,
	}, ok: true}
	router := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: proxyGateway, AgentCollectorLookup: lookup})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/app/agents", nil)
	request.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"creation_source":"collector"`) ||
		!strings.Contains(recorder.Body.String(), `"collector_id":"collector_1"`) ||
		!strings.Contains(recorder.Body.String(), `"office_agent_id":"codex:device_1:main"`) ||
		!strings.Contains(recorder.Body.String(), `"device_id":"device_1"`) ||
		!strings.Contains(recorder.Body.String(), `"device_name":"MacBook"`) ||
		!strings.Contains(recorder.Body.String(), `"status":"online"`) {
		t.Fatalf("collector source response = %s", recorder.Body.String())
	}
}

func TestClaweeAgentRoutesUseOnlyBoundAgent(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "clawee-routes@example.com", Name: "Clawee Routes", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := mcpgateway.NewMemoryStore()
	proxyGateway := testProxyGateway(proxyStore)
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "other-owned-agent")
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "bound-agent")
	primaryAgentID, err := accountSvc.PrimaryAgentID(ctx, owner.Account.UserID)
	if err != nil || primaryAgentID != "other-owned-agent" {
		t.Fatalf("primary agent id=%q error=%v, want other-owned-agent", primaryAgentID, err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, owner.Account, []accounts.TokenRequest{{
		Audience: accounts.AudienceFrontend, ClientID: accounts.ClientClaweeAgent, AgentID: "bound-agent",
	}})
	if err != nil {
		t.Fatal(err)
	}
	token := tokens.Token(accounts.AudienceFrontend).Token
	router := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: proxyGateway})
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		router.ServeHTTP(rec, req)
		return rec
	}

	list := request(http.MethodGet, "/api/v1/app/agents", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"agent_id":"bound-agent"`) || strings.Contains(list.Body.String(), `"agent_id":"other-owned-agent"`) {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	listMismatch := request(http.MethodGet, "/api/v1/app/agents?agent_id=other-owned-agent", "")
	if listMismatch.Code != http.StatusForbidden || !strings.Contains(listMismatch.Body.String(), `"code":"agent_context_mismatch"`) {
		t.Fatalf("list mismatch status=%d body=%s", listMismatch.Code, listMismatch.Body.String())
	}
	detail := request(http.MethodGet, "/api/v1/app/agents/detail", "")
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), `"agent_id":"bound-agent"`) {
		t.Fatalf("detail status=%d body=%s", detail.Code, detail.Body.String())
	}
	catalog := request(http.MethodGet, "/api/v1/app/mcp/catalog", "")
	if catalog.Code != http.StatusOK || strings.Contains(catalog.Body.String(), `"agent_id"`) {
		t.Fatalf("catalog status=%d body=%s", catalog.Code, catalog.Body.String())
	}
	catalogMismatch := request(http.MethodGet, "/api/v1/app/mcp/catalog?agent_id=other-owned-agent", "")
	if catalogMismatch.Code != http.StatusBadRequest {
		t.Fatalf("catalog mismatch status=%d body=%s", catalogMismatch.Code, catalogMismatch.Body.String())
	}
	mismatch := request(http.MethodGet, "/api/v1/app/agents/detail?agent_id=other-owned-agent", "")
	if mismatch.Code != http.StatusForbidden || !strings.Contains(mismatch.Body.String(), `"code":"agent_context_mismatch"`) {
		t.Fatalf("mismatch status=%d body=%s", mismatch.Code, mismatch.Body.String())
	}
	actionMismatch := request(http.MethodPost, "/api/v1/app/mcp/token/rotate", `{"agent_id":"other-owned-agent"}`)
	if actionMismatch.Code != http.StatusBadRequest || !strings.Contains(actionMismatch.Body.String(), "invalid_request") {
		t.Fatalf("action mismatch status=%d body=%s", actionMismatch.Code, actionMismatch.Body.String())
	}
	for _, test := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/v1/app/mcp/token?agent_id=", ""},
		{http.MethodGet, "/api/v1/app/mcp/token?user_id=other", ""},
		{http.MethodGet, "/api/v1/app/mcp/catalog?user_id=other", ""},
		{http.MethodPost, "/api/v1/app/mcp/token/reveal", `{"agent_id":""}`},
		{http.MethodPost, "/api/v1/app/mcp/token/reveal", `{"agent_id":null}`},
		{http.MethodPost, "/api/v1/app/mcp/token/rotate?agent_id=", `{}`},
		{http.MethodPost, "/api/v1/app/mcp/token/revoke", `{"user_id":"other"}`},
	} {
		recorder := request(test.method, test.path, test.body)
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_request") {
			t.Fatalf("legacy account token input %s %s status=%d body=%s", test.method, test.path, recorder.Code, recorder.Body.String())
		}
	}
	create := request(http.MethodPost, "/api/v1/app/agents", `{"agent_id":"third-agent"}`)
	if create.Code != http.StatusForbidden {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}

	agent, err := proxyStore.GetAgent(ctx, "bound-agent")
	if err != nil {
		t.Fatal(err)
	}
	agent.Status = mcpgateway.StatusDisabled
	if err := proxyStore.SaveAgent(ctx, agent); err != nil {
		t.Fatal(err)
	}
	disabled := request(http.MethodGet, "/api/v1/app/agents", "")
	if disabled.Code != http.StatusForbidden || !strings.Contains(disabled.Body.String(), `"code":"agent_forbidden"`) {
		t.Fatalf("disabled status=%d body=%s", disabled.Code, disabled.Body.String())
	}
	meDisabled := request(http.MethodGet, "/api/v1/auth/me", "")
	if meDisabled.Code != http.StatusForbidden || !strings.Contains(meDisabled.Body.String(), `"code":"agent_forbidden"`) {
		t.Fatalf("disabled me status=%d body=%s", meDisabled.Code, meDisabled.Body.String())
	}
	logout := request(http.MethodPost, "/api/v1/auth/logout", "")
	if logout.Code != http.StatusNoContent {
		t.Fatalf("disabled logout status=%d body=%s", logout.Code, logout.Body.String())
	}
	if _, err := accountSvc.AuthenticateToken(ctx, token, accounts.AudienceFrontend); !errors.Is(err, accounts.ErrInvalidSession) {
		t.Fatalf("token after logout error=%v, want invalid session", err)
	}
}

func TestClaweeBindingMiddlewarePreservesInternalErrors(t *testing.T) {
	ctx := context.Background()
	accountStore := &ownerLookupErrorStore{MemoryStore: accounts.NewMemoryStore()}
	accountSvc := newTestAccountService(accountStore)
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "owner-error@example.com", Name: "Owner Error", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := &agentLookupErrorStore{MemoryStore: mcpgateway.NewMemoryStore()}
	proxyGateway := testProxyGateway(proxyStore)
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "bound-agent")
	tokens, err := accountSvc.IssueTokens(ctx, owner.Account, []accounts.TokenRequest{{
		Audience: accounts.AudienceFrontend, ClientID: accounts.ClientClaweeAgent, AgentID: "bound-agent",
	}})
	if err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: proxyGateway})
	request := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/app/agents", nil)
		req.Header.Set("Authorization", "Bearer "+tokens.Token(accounts.AudienceFrontend).Token)
		router.ServeHTTP(rec, req)
		return rec
	}

	accountStore.failOwnerLookup = true
	rec := request()
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("owner lookup status=%d body=%s", rec.Code, rec.Body.String())
	}
	accountStore.failOwnerLookup = false
	proxyStore.failAgentLookup = true
	rec = request()
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("agent lookup status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func createOwnedAgentForCatalogTest(t *testing.T, ctx context.Context, accountSvc *accounts.Service, proxyGateway *mcpgateway.Service, userID, agentID string) {
	t.Helper()
	err := proxyGateway.CreateOwnedAgent(ctx, userID, mcpgateway.AgentRegistration{
		AgentID: agentID, ActorID: userID, Status: mcpgateway.StatusActive,
	})
	if err != nil {
		t.Fatalf("create agent %s: %v", agentID, err)
	}
	if err := accountSvc.BindAgent(ctx, userID, agentID); err != nil {
		t.Fatalf("bind agent %s: %v", agentID, err)
	}
}

func containsJSONField(body []byte, field, want string) bool {
	var envelope map[string]any
	if json.Unmarshal(body, &envelope) != nil {
		return false
	}
	data, _ := envelope["data"].(map[string]any)
	value, _ := data[field].(string)
	return value == want
}

type ownerLookupErrorStore struct {
	*accounts.MemoryStore
	failOwnerLookup bool
}

func (s *ownerLookupErrorStore) GetAccountForAgent(ctx context.Context, agentID string) (accounts.Account, error) {
	if s.failOwnerLookup {
		return accounts.Account{}, errors.New("owner lookup unavailable")
	}
	return s.MemoryStore.GetAccountForAgent(ctx, agentID)
}

type agentLookupErrorStore struct {
	*mcpgateway.MemoryStore
	failAgentLookup bool
}

type failingCatalogDataAccessStore struct{ *dataaccess.MemoryStore }

func (failingCatalogDataAccessStore) ListGrants(context.Context, dataaccess.Filter) ([]dataaccess.Grant, error) {
	return nil, errors.New("data authorization unavailable")
}

type staticAgentCollectorLookup struct {
	info management.AgentCollectorInfo
	ok   bool
	err  error
}

func (s staticAgentCollectorLookup) FindAgentCollector(context.Context, string, time.Time, time.Duration) (management.AgentCollectorInfo, bool, error) {
	return s.info, s.ok, s.err
}

func (s *agentLookupErrorStore) GetAgent(ctx context.Context, agentID string) (mcpgateway.AgentRegistration, error) {
	if s.failAgentLookup {
		return mcpgateway.AgentRegistration{}, errors.New("agent lookup unavailable")
	}
	return s.MemoryStore.GetAgent(ctx, agentID)
}
