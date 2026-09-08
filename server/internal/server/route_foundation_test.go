package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/knowledge"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestTargetAuthRoutesAreMounted(t *testing.T) {
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	if _, err := accountSvc.Register(context.Background(), accounts.RegisterRequest{
		Email: "route-auth@example.com", Name: "Route Auth", Password: "passw0rd!",
	}); err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc})

	for _, path := range []string{"/api/v1/auth/login"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"email":"route-auth@example.com","password":"passw0rd!"}`))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST %s status = %d, want %d; body=%s", path, rec.Code, http.StatusOK, rec.Body.String())
		}
		if rec.Header().Get("Deprecation") != "" {
			t.Fatalf("POST %s unexpectedly marked deprecated", path)
		}
	}
}

func TestTargetAppAgentRoutesUseCurrentAccount(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	result, err := accountSvc.Register(context.Background(), accounts.RegisterRequest{
		Email: "route-app@example.com", Name: "Route App", Password: "passw0rd!",
	})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(context.Background(), result.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc,
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
	})

	for _, path := range []string{"/api/v1/app/agents"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want %d; body=%s", path, rec.Code, http.StatusOK, rec.Body.String())
		}
		var items []json.RawMessage
		if err := json.Unmarshal(unwrapAPIRawData(t, rec.Body.Bytes()), &items); err != nil {
			t.Fatalf("decode GET %s agents list: %v body=%s", path, err, rec.Body.String())
		}
		if items == nil || len(items) != 0 {
			t.Fatalf("GET %s agents = %s, want non-null empty array", path, rec.Body.String())
		}
	}
}

type legacyRoute struct {
	method string
	path   string
	body   string
}

func assertLegacyRoutesNotFound(t *testing.T, router http.Handler, routes []legacyRoute) {
	t.Helper()
	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
			if route.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound {
				t.Errorf("%s %s status = %d, want %d; body=%s", route.method, route.path, rec.Code, http.StatusNotFound, rec.Body.String())
			}
			if rec.Code == http.StatusNotFound {
				if rec.Header().Get("Deprecation") != "" {
					t.Errorf("%s %s Deprecation header = %q, want empty", route.method, route.path, rec.Header().Get("Deprecation"))
				}
				if rec.Header().Get("Sunset") != "" {
					t.Errorf("%s %s Sunset header = %q, want empty", route.method, route.path, rec.Header().Get("Sunset"))
				}
			}
			if strings.Contains(rec.Body.String(), `"error"`) {
				t.Errorf("%s %s returned a handler error instead of route-level 404: %s", route.method, route.path, rec.Body.String())
			}
		})
	}
}

func TestLegacyTopLevelRoutesNotFound(t *testing.T) {
	router := newTestRouter(t, server.Options{
		ProxyGateway:            testProxyGateway(mcpgateway.NewMemoryStore()),
		OfficeDashboardAPI:      httpapi.NewDashboardAPI(&fakeDashboardReaderForRouteTest{}, nil, func() time.Time { return time.Now().UTC() }),
		OfficeManagementAPI:     httpapi.NewManagementAPI(fakeManagementStoreForRouteTest{}, func() time.Time { return time.Now().UTC() }),
		OfficeUserDashboardAPI:  http.NotFoundHandler(),
		OfficeUserCollectorsAPI: http.NotFoundHandler(),
		KnowledgeService:        knowledge.NewService(knowledge.NewMemoryStore(), nil),
		SkillHubService:         skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()}),
	})

	assertLegacyRoutesNotFound(t, router, []legacyRoute{
		{method: http.MethodPost, path: "/auth/login", body: `{"email":"route-auth@example.com","password":"passw0rd!"}`},
		{method: http.MethodGet, path: "/agent/api/me"},
		{method: http.MethodPost, path: "/agent/api/office/collector-registration-codes", body: `{}`},
		{method: http.MethodGet, path: "/admin/api/status"},
		{method: http.MethodGet, path: "/admin/api/rbac/permissions"},
		{method: http.MethodGet, path: "/api/v1/skills"},
	})
}

func TestSkillHubSourceRoutesRequireSourceService(t *testing.T) {
	router := newTestRouter(t, server.Options{
		SkillHubService: skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()}),
	})
	for _, route := range []legacyRoute{
		{method: http.MethodGet, path: "/api/v1/admin/skill-sources"},
		{method: http.MethodPost, path: "/api/v1/admin/skill-sources", body: `{}`},
		{method: http.MethodGet, path: "/api/v1/admin/skill-sources/detail?source_id=source_1"},
		{method: http.MethodPut, path: "/api/v1/admin/skill-sources", body: `{}`},
		{method: http.MethodPost, path: "/api/v1/admin/skill-sources/sync", body: `{}`},
		{method: http.MethodPost, path: "/api/v1/admin/skill-sources/disable", body: `{}`},
		{method: http.MethodPost, path: "/api/v1/admin/skill-sources/enable", body: `{}`},
		{method: http.MethodPost, path: "/api/v1/admin/skill-sources/token/remove", body: `{}`},
		{method: http.MethodPost, path: "/api/v1/admin/skill-sources/items/bind", body: `{}`},
		{method: http.MethodPost, path: "/api/v1/admin/skill-sources/items/unbind", body: `{}`},
		{method: http.MethodGet, path: "/api/v1/admin/skill-sources/sync-runs?source_id=source_1"},
	} {
		assertLegacyRoutesNotFound(t, router, []legacyRoute{route})
	}
}

func TestTargetAppAgentRoutesShareAuthenticationBoundary(t *testing.T) {
	router := server.NewRouter(server.Options{
		AccountService:    newTestAccountService(accounts.NewMemoryStore()),
		KnowledgeService:  knowledge.NewService(knowledge.NewMemoryStore(), nil),
		DataAccessService: dataaccess.NewService(dataaccess.NewMemoryStore()),
	})

	routes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/app/agents"},
		{http.MethodPatch, "/api/v1/app/agents/name"},
		{http.MethodPost, "/api/v1/app/agents/remove"},
		{http.MethodGet, "/api/v1/app/mcp/token"},
		{http.MethodGet, "/api/v1/app/agents/tools"},
		{http.MethodGet, "/api/v1/app/mcp/catalog"},
		{http.MethodPost, "/api/v1/app/mcp/token/reveal"},
		{http.MethodPost, "/api/v1/app/mcp/token/rotate"},
		{http.MethodPost, "/api/v1/app/mcp/token/revoke"},
		{http.MethodGet, "/api/v1/app/knowledge-bases"},
		{http.MethodGet, "/api/v1/app/knowledge-bases/documents?knowledge_base_id=kb-1"},
		{http.MethodPost, "/api/v1/app/knowledge-bases/documents"},
		{http.MethodGet, "/api/v1/app/data-views"},
		{http.MethodGet, "/api/v1/app/activity/statistics"},
		{http.MethodPost, "/api/v1/app/business-data-sources/bilibili/authorize"},
		{http.MethodPost, "/api/v1/app/business-data-sources/bilibili/sync"},
		{http.MethodGet, "/api/v1/app/business-data-sources/bilibili"},
		{http.MethodPost, "/api/v1/app/business-data-sources/bilibili/bdsrc_1/sync"},
		{http.MethodPatch, "/api/v1/app/business-data-sources/bilibili/bdsrc_1"},
		{http.MethodDelete, "/api/v1/app/business-data-sources/bilibili/bdsrc_1"},
	}
	for _, route := range routes {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(route.method, route.path, nil)
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want %d", route.method, route.path, rec.Code, http.StatusUnauthorized)
		}
	}
}

func TestTargetAppAgentRoutesSupportOwnedAgentCollection(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	registered, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "agent-owner@example.com", Name: "Agent Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore())})
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		req.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(rec, req)
		return rec
	}

	rec := request(http.MethodPost, "/api/v1/app/agents", `{"agent_id":"personal-agent","name":"Personal Agent","user_id":"another-user"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("cross-account create status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodPost, "/api/v1/app/agents", `{"agent_id":"personal-agent","name":"Personal Agent","token_scopes":["mcp:call"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/v1/app/agents", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	var list struct {
		Data []struct {
			Agent struct {
				AgentID string `json:"agent_id"`
			} `json:"agent"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Data) != 1 || list.Data[0].Agent.AgentID != "personal-agent" {
		t.Fatalf("list response = %s", rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/v1/app/agents/detail?agent_id=personal-agent", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"agent_id":"personal-agent"`) {
		t.Fatalf("detail status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/v1/app/mcp/token?agent_id=personal-agent", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("token status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/v1/app/mcp/token", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "account_token_not_found") {
		t.Fatalf("missing account token status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestTargetHumanAPIRoutesShareApplicationAuthenticationBoundaries(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := server.NewRouter(server.Options{
		AccountService:          accountSvc,
		ProxyGateway:            testProxyGateway(mcpgateway.NewMemoryStore()),
		OfficeDashboardAPI:      httpapi.NewDashboardAPI(&fakeDashboardReaderForRouteTest{}, nil, func() time.Time { return time.Now().UTC() }),
		OfficeUserDashboardAPI:  http.NotFoundHandler(),
		OfficeManagementAPI:     httpapi.NewManagementAPI(fakeManagementStoreForRouteTest{}, func() time.Time { return time.Now().UTC() }),
		OfficeUserCollectorsAPI: http.NotFoundHandler(),
		KnowledgeService:        knowledge.NewService(knowledge.NewMemoryStore(), nil),
		SkillHubService:         skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()}),
	})

	routes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/app/skills"},
		{http.MethodGet, "/api/v1/app/skills/detail?skill_id=skill_123"},
		{http.MethodGet, "/api/v1/app/skills/package?skill_id=skill_123"},
		{http.MethodGet, "/api/v1/app/collectors"},
		{http.MethodGet, "/api/v1/app/collectors/detail?collector_id=collector_123"},
		{http.MethodPost, "/api/v1/app/collectors/token/revoke"},
		{http.MethodPost, "/api/v1/app/collectors/remove"},
		{http.MethodGet, "/api/v1/app/activity/overview"},
		{http.MethodGet, "/api/v1/app/activity/agents"},
		{http.MethodGet, "/api/v1/app/activity/detail?collector_id=collector_123&agent_id=agent_123"},
		{http.MethodGet, "/api/v1/app/activity/sub-agents?collector_id=collector_123&agent_id=agent_123"},
		{http.MethodGet, "/api/v1/app/activity/recent?limit=20"},
		{http.MethodGet, "/api/v1/app/activity/events"},
		{http.MethodGet, "/api/v1/admin/accounts/detail?user_id=usr_123"},
		{http.MethodPatch, "/api/v1/admin/accounts"},
		{http.MethodPost, "/api/v1/admin/accounts/password/reset"},
		{http.MethodGet, "/api/v1/admin/mcp/upstream-servers/detail?server_id=server_123"},
		{http.MethodPatch, "/api/v1/admin/mcp/upstream-servers"},
		{http.MethodPost, "/api/v1/admin/mcp/upstream-servers/remove"},
		{http.MethodPost, "/api/v1/admin/mcp/upstream-servers/sync-tools"},
		{http.MethodGet, "/api/v1/admin/mcp/agents/detail?agent_id=agent_123"},
		{http.MethodPost, "/api/v1/admin/mcp/agents/remove"},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/reveal"},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/rotate"},
		{http.MethodPost, "/api/v1/admin/mcp/accounts/token/revoke"},
		{http.MethodGet, "/api/v1/admin/mcp/capabilities/detail?capability_id=cap_123"},
		{http.MethodPatch, "/api/v1/admin/mcp/capabilities"},
		{http.MethodPost, "/api/v1/admin/mcp/capabilities/remove"},
		{http.MethodPut, "/api/v1/admin/mcp/capabilities/gate-policy"},
		{http.MethodPost, "/api/v1/admin/mcp/grants/remove"},
		{http.MethodGet, "/api/v1/admin/mcp/gates/detail?gate_id=gate_123"},
		{http.MethodPost, "/api/v1/admin/mcp/gates/decide"},
		{http.MethodGet, "/api/v1/admin/mcp/audits/detail?audit_id=audit_123"},
		{http.MethodGet, "/api/v1/admin/collectors/overview"},
		{http.MethodPost, "/api/v1/admin/collectors/token/revoke"},
		{http.MethodPost, "/api/v1/admin/collectors/remove"},
		{http.MethodPost, "/api/v1/admin/collector-registration-codes"},
		{http.MethodGet, "/api/v1/admin/activity/overview"},
		{http.MethodGet, "/api/v1/admin/activity/detail?collector_id=collector_123&agent_id=agent_123"},
		{http.MethodGet, "/api/v1/admin/activity/sub-agents?collector_id=collector_123&agent_id=agent_123"},
		{http.MethodGet, "/api/v1/admin/activity/recent?limit=20"},
		{http.MethodGet, "/api/v1/admin/activity/events"},
		{http.MethodPut, "/api/v1/admin/activity/mcp-agent-binding"},
		{http.MethodPost, "/api/v1/admin/activity/mcp-agent-binding/remove"},
		{http.MethodPost, "/api/v1/admin/activity/agents/remove"},
		{http.MethodGet, "/api/v1/admin/knowledge-bases/detail?knowledge_base_id=kb_123"},
		{http.MethodPatch, "/api/v1/admin/knowledge-bases"},
		{http.MethodPost, "/api/v1/admin/knowledge-bases/remove"},
		{http.MethodGet, "/api/v1/admin/knowledge-bases/documents?knowledge_base_id=kb_123"},
		{http.MethodPost, "/api/v1/admin/knowledge-bases/documents"},
		{http.MethodPost, "/api/v1/admin/knowledge-bases/documents/sync"},
		{http.MethodPost, "/api/v1/admin/knowledge-bases/documents/remove"},
		{http.MethodGet, "/api/v1/admin/skills/detail?skill_id=skill_123"},
		{http.MethodGet, "/api/v1/admin/skills/version-files?skill_id=skill_123&version_id=version_123"},
		{http.MethodGet, "/api/v1/admin/skills/version-file?skill_id=skill_123&version_id=version_123&path=SKILL.md"},
		{http.MethodGet, "/api/v1/admin/skills/version-package?skill_id=skill_123&version_id=version_123"},
		{http.MethodPatch, "/api/v1/admin/skills/space"},
		{http.MethodPut, "/api/v1/admin/skills/current-version"},
		{http.MethodPost, "/api/v1/admin/skills/current-version/remove"},
	}

	for _, route := range routes {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(route.method, route.path, nil)
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s status = %d, want %d", route.method, route.path, rec.Code, http.StatusUnauthorized)
		}
	}
}

func TestSalesCRMIndustryPackRoutesAreNotMounted(t *testing.T) {
	router := server.NewRouter(server.Options{})
	paths := []string{
		"/api/v1/admin/industry-packs/summary?pack_id=sales-crm",
		"/api/v1/admin/industry-packs/customers?pack_id=sales-crm",
		"/api/v1/admin/industry-packs/customer-timeline?pack_id=sales-crm&customer_id=1",
		"/api/v1/admin/industry-packs/sales-crm/summary",
		"/api/v1/admin/industry-packs/sales-crm/customers",
		"/api/v1/admin/industry-packs/sales-crm/customers/1/timeline",
		"/admin/api/industry-packs/summary?pack_id=sales-crm",
		"/admin/api/industry-packs/customers?pack_id=sales-crm",
		"/admin/api/industry-packs/customer-timeline?pack_id=sales-crm&customer_id=1",
		"/admin/api/industry-packs/sales-crm/summary",
		"/admin/api/industry-packs/sales-crm/customers",
		"/admin/api/industry-packs/sales-crm/customers/1/timeline",
	}

	for _, path := range paths {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want %d; body=%s", path, rec.Code, http.StatusNotFound, rec.Body.String())
		}
	}
}
