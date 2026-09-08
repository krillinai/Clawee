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
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestOfficeCollectorRegisterRouteExistsAndRejectsInvalidPayload(t *testing.T) {
	router := newTestRouter(t, server.Options{
		ProxyGateway:       testProxyGateway(mcpgateway.NewMemoryStore()),
		OfficeCollectorAPI: httpapi.NewCollectorAPI(noopCollectorAuthenticator{}, noopCollectorReducer{}, nil, nil).Handler(),
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/register", strings.NewReader(`{"schema_version":"collector.v0","registration_code":"","os":"darwin","arch":"arm64","collector_version":"1.0.0"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("collector register status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode register error: %v", err)
	}
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "invalid_schema_version" {
		t.Fatalf("collector register error = %#v, want invalid_schema_version", body)
	}
}

func TestOfficeCollectorEventsRouteRequiresBearerToken(t *testing.T) {
	router := newTestRouter(t, server.Options{
		ProxyGateway:       testProxyGateway(mcpgateway.NewMemoryStore()),
		OfficeCollectorAPI: httpapi.NewCollectorAPI(noopCollectorAuthenticator{}, noopCollectorReducer{}, nil, nil).Handler(),
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", strings.NewReader(`{"schema_version":"collector.v1","collector_id":"collector_1","device_id":"device_1","events":[]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("collector events status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestOfficeAdminOverviewRouteExists(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:        testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:      accountSvc,
		OfficeManagementAPI: httpapi.NewManagementAPI(fakeManagementStoreForRouteTest{}, func() time.Time { return time.Date(2026, 6, 25, 12, 0, 0, 0, time.UTC) }),
	})
	cookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/collectors/overview", nil)
	req.AddCookie(adminCookie(t, cookies))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("admin office overview status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestOfficeAdminAgentBindingRouteExists(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	store := &captureManagementStoreForRouteTest{}
	router := newTestRouter(t, server.Options{
		ProxyGateway:        testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:      accountSvc,
		OfficeManagementAPI: httpapi.NewManagementAPI(store, func() time.Time { return time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC) }),
	})
	cookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/activity/mcp-agent-binding", strings.NewReader(`{"collector_id":"collector_1","agent_id":"office_1","mcp_agent_id":"mcp_1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie(t, cookies))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("admin office agent binding status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastBoundCollectorID != "collector_1" || store.lastBoundOfficeAgentID != "office_1" || store.lastBoundMCPAgentID != "mcp_1" {
		t.Fatalf("unexpected binding target: %#v", store)
	}
}

func TestOfficeAdminNormalizedRoutesPreserveIDsContainingSlashes(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	store := &captureManagementStoreForRouteTest{}
	reader := &fakeDashboardReaderForRouteTest{}
	router := newTestRouter(t, server.Options{
		ProxyGateway:        testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:      accountSvc,
		OfficeManagementAPI: httpapi.NewManagementAPI(store, func() time.Time { return time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC) }),
		OfficeDashboardAPI:  httpapi.NewDashboardAPI(reader, nil, func() time.Time { return time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC) }),
	})
	cookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	request := func(method, target, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		req.AddCookie(adminCookie(t, cookies))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	for _, test := range []struct {
		method string
		target string
		body   string
	}{
		{http.MethodPost, "/api/v1/admin/collectors/token/revoke", `{"collector_id":"collector/one"}`},
		{http.MethodPost, "/api/v1/admin/collectors/remove", `{"collector_id":"collector/one"}`},
		{http.MethodPut, "/api/v1/admin/activity/mcp-agent-binding", `{"collector_id":"collector/one","agent_id":"agent/same","mcp_agent_id":"mcp/one"}`},
		{http.MethodPost, "/api/v1/admin/activity/mcp-agent-binding/remove", `{"collector_id":"collector/one","agent_id":"agent/same"}`},
		{http.MethodPost, "/api/v1/admin/activity/agents/remove", `{"collector_id":"collector/one","agent_id":"agent/same"}`},
		{http.MethodGet, "/api/v1/admin/activity/detail?collector_id=collector%2Fone&agent_id=agent%2Fsame", ""},
		{http.MethodGet, "/api/v1/admin/activity/sub-agents?collector_id=collector%2Fone&agent_id=agent%2Fsame", ""},
	} {
		rec := request(test.method, test.target, test.body)
		if rec.Code >= http.StatusBadRequest {
			t.Fatalf("%s %s status = %d body=%s", test.method, test.target, rec.Code, rec.Body.String())
		}
	}

	if store.lastRevokedCollectorID != "collector/one" {
		t.Fatalf("revoked collector = %q", store.lastRevokedCollectorID)
	}
	if store.lastBoundCollectorID != "collector/one" || store.lastBoundOfficeAgentID != "agent/same" || store.lastBoundMCPAgentID != "mcp/one" {
		t.Fatalf("unexpected binding target: %#v", store)
	}
	if store.lastUnboundCollectorID != "collector/one" || store.lastUnboundOfficeAgentID != "agent/same" {
		t.Fatalf("unexpected unbinding target: %#v", store)
	}
	if store.lastDeletedOfficeCollectorID != "collector/one" || store.lastDeletedOfficeAgentID != "agent/same" {
		t.Fatalf("unexpected office agent delete target: %#v", store)
	}
	if reader.lastDetailCollectorID != "collector/one" || reader.lastDetailAgentID != "agent/same" {
		t.Fatalf("unexpected detail target: %#v", reader)
	}
	if reader.lastSubAgentsCollectorID != "collector/one" || reader.lastSubAgentsAgentID != "agent/same" {
		t.Fatalf("unexpected sub-agents target: %#v", reader)
	}
}

func TestOfficeAppActivityDetailRequiresDataViewGrant(t *testing.T) {
	ctx := context.Background()
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	reader := &fakeDashboardReaderForRouteTest{}
	router := newTestRouter(t, server.Options{
		ProxyGateway:       testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:     accountSvc,
		DataAccessService:  dataService,
		OfficeDashboardAPI: httpapi.NewDashboardAPI(reader, nil, func() time.Time { return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC) }),
	})
	cookies := register(t, router, `{"email":"activity-detail@example.com","password":"passw0rd!"}`)

	accountsList, err := accountSvc.ListAccounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(accountsList) != 1 {
		t.Fatalf("accounts = %d, want 1", len(accountsList))
	}

	request := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/app/activity/detail?collector_id=collector%2Fother&agent_id=agent%2Fother", nil)
		req.AddCookie(frontendCookie(t, cookies))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	if rec := request(); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"code":"data_view_forbidden"`) {
		t.Fatalf("detail without grant status = %d body=%s", rec.Code, rec.Body.String())
	}
	if reader.lastDetailCollectorID != "" || reader.lastDetailAgentID != "" {
		t.Fatalf("unauthorized detail reached reader: %#v", reader)
	}

	if _, err := dataService.Create(ctx, dataaccess.SetInput{
		UserID: accountsList[0].UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}
	if rec := request(); rec.Code != http.StatusOK {
		t.Fatalf("detail with grant status = %d body=%s", rec.Code, rec.Body.String())
	}
	if reader.lastDetailCollectorID != "collector/other" || reader.lastDetailAgentID != "agent/other" {
		t.Fatalf("detail target = %q/%q", reader.lastDetailCollectorID, reader.lastDetailAgentID)
	}
}

func TestOfficeAppActivityDetailFailsClosedWithoutDataAccessService(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:       testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:     accountSvc,
		OfficeDashboardAPI: httpapi.NewDashboardAPI(&fakeDashboardReaderForRouteTest{}, nil, func() time.Time { return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC) }),
	})
	cookies := register(t, router, `{"email":"activity-detail-unavailable@example.com","password":"passw0rd!"}`)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/activity/detail?collector_id=collector_1&agent_id=agent_1", nil)
	req.AddCookie(frontendCookie(t, cookies))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"code":"data_authorization_unavailable"`) {
		t.Fatalf("detail without data access service status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAccountCollectorRegistrationCodeUsesSessionOwner(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	store := &captureManagementStoreForRouteTest{}
	router := newTestRouter(t, server.Options{
		ProxyGateway:        testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:      accountSvc,
		OfficeManagementAPI: httpapi.NewManagementAPI(store, func() time.Time { return time.Date(2026, 6, 25, 12, 0, 0, 0, time.UTC) }),
	})
	register(t, router, `{"email":"admin@example.com","name":"平台管理员","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","name":"平台用户","password":"passw0rd!"}`)

	accountsList, err := accountSvc.ListAccounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantUserID := ""
	for _, account := range accountsList {
		if account.Email == "user@example.com" {
			wantUserID = account.UserID
		}
	}
	if wantUserID == "" {
		t.Fatal("normal account not found")
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/app/collector-registration-codes", strings.NewReader(`{"user_id":"spoofed"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(frontendCookie(t, userCookies))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("create registration code status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastUserID != wantUserID {
		t.Fatalf("owner = %q, want session user %q", store.lastUserID, wantUserID)
	}
	if store.lastCreatedBy != "平台用户" {
		t.Fatalf("operator = %q, want 平台用户", store.lastCreatedBy)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/app/collector-registration-codes", nil)
	req.AddCookie(frontendCookie(t, userCookies))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get registration code status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastUserID != wantUserID {
		t.Fatalf("queried owner = %q, want session user %q", store.lastUserID, wantUserID)
	}
	if !strings.Contains(rec.Body.String(), `"registration_code":"reg_once"`) || !strings.Contains(rec.Body.String(), `"used_count":2`) {
		t.Fatalf("registration code response = %s", rec.Body.String())
	}
}

func TestOfficeAdminAgentActivityRouteReturnsOfficeSnapshot(t *testing.T) {
	now := time.Date(2026, 6, 25, 12, 0, 0, 0, time.UTC)
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	reader := &fakeDashboardReaderForRouteTest{
		office: dashboard.OfficeSnapshot{
			SchemaVersion: dashboard.SchemaVersion,
			ServerTime:    now,
			SSEURL:        "/api/v1/admin/office/realtime/events",
			Filters: dashboard.OfficeFilters{
				Workspaces: []dashboard.WorkspaceCount{{WorkspaceName: "workspace-a", AgentCount: 1}},
				StatusCounts: map[string]int{
					"thinking": 1,
				},
				BusinessSystems: []dashboard.BusinessSystemCount{{SystemName: "salesforce", ActiveCount: 1}},
			},
			Summary:    dashboard.OfficeSummary{TotalAgents: 1, ActiveTurns: 1},
			Agents:     []dashboard.AgentListItem{{CollectorID: "collector_1", AgentID: "agent_1"}},
			RecentFeed: []dashboard.ActivityFeedItem{{CollectorID: "collector_1", AgentID: "agent_1", Text: "running tests", OccurredAt: now}},
		},
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway:       testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:     accountSvc,
		OfficeDashboardAPI: httpapi.NewDashboardAPI(reader, nil, func() time.Time { return now }),
	})
	cookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/overview", nil)
	req.AddCookie(adminCookie(t, cookies))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("admin office agent activity status = %d body=%s", rec.Code, rec.Body.String())
	}
	body := unwrapAPIDataMap(t, rec.Body.Bytes())
	for _, field := range []string{"sse_url", "filters", "summary", "recent_feed"} {
		if _, ok := body[field]; !ok {
			t.Fatalf("missing %q in response: %s", field, rec.Body.String())
		}
	}
	if _, ok := body["agents"]; !ok {
		t.Fatalf("missing agents in response: %s", rec.Body.String())
	}
	if _, ok := body["collector_id"]; ok {
		t.Fatalf("route returned agent detail/list payload instead of office snapshot: %s", rec.Body.String())
	}
}

func TestOfficeAdminActivityAgentsReturnsAgentListInsteadOfOverview(t *testing.T) {
	now := time.Date(2026, 6, 25, 12, 0, 0, 0, time.UTC)
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	reader := &fakeDashboardReaderForRouteTest{
		office: dashboard.OfficeSnapshot{Summary: dashboard.OfficeSummary{TotalAgents: 99}},
		agents: []dashboard.AgentListItem{{CollectorID: "collector_1", AgentID: "agent_1"}},
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway:       testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService:     accountSvc,
		OfficeDashboardAPI: httpapi.NewDashboardAPI(reader, nil, func() time.Time { return now }),
	})
	cookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/agents", nil)
	req.AddCookie(adminCookie(t, cookies))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("activity agents status = %d body=%s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if _, ok := envelope.Data["agents"]; !ok {
		t.Fatalf("activity agents response missing agents: %s", rec.Body.String())
	}
	if _, ok := envelope.Data["summary"]; ok {
		t.Fatalf("activity agents returned overview summary: %s", rec.Body.String())
	}
}

func TestLegacyOfficeAdminPathIsNotPrimaryRoute(t *testing.T) {
	router := newTestRouter(t, server.Options{
		ProxyGateway:        testProxyGateway(mcpgateway.NewMemoryStore()),
		OfficeManagementAPI: nil,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/collectors/overview", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("legacy office admin path status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestLegacyOfficeDynamicRoutesNotFound(t *testing.T) {
	router := newTestRouter(t, server.Options{
		ProxyGateway:        testProxyGateway(mcpgateway.NewMemoryStore()),
		OfficeManagementAPI: httpapi.NewManagementAPI(&captureManagementStoreForRouteTest{}, func() time.Time { return time.Now().UTC() }),
		OfficeDashboardAPI:  httpapi.NewDashboardAPI(&fakeDashboardReaderForRouteTest{}, nil, func() time.Time { return time.Now().UTC() }),
	})

	assertLegacyRoutesNotFound(t, router, []legacyRoute{
		{method: http.MethodGet, path: "/api/v1/admin/office/collectors/overview"},
		{method: http.MethodPost, path: "/api/v1/admin/office/collectors/collector_legacy/token/revoke"},
		{method: http.MethodPost, path: "/api/v1/admin/office/collector-registration-codes"},
		{method: http.MethodPut, path: "/api/v1/admin/office/agents/collector_legacy/agent_legacy/mcp-binding", body: `{"mcp_agent_id":"mcp_legacy"}`},
		{method: http.MethodDelete, path: "/api/v1/admin/office/agents/collector_legacy/agent_legacy/mcp-binding"},
		{method: http.MethodGet, path: "/api/v1/admin/office/agent-activity"},
		{method: http.MethodGet, path: "/api/v1/admin/office/agent-activity/collector_legacy/agent_legacy"},
		{method: http.MethodGet, path: "/api/v1/admin/office/agent-activity/collector_legacy/agent_legacy/sub-agents"},
		{method: http.MethodGet, path: "/api/v1/admin/office/activities/recent"},
		{method: http.MethodGet, path: "/api/v1/admin/office/realtime/events"},
	})
}

func TestOfficeInstallRoutesUseCollectorsPrefix(t *testing.T) {
	router := newTestRouter(t, server.Options{
		ProxyGateway:     testProxyGateway(mcpgateway.NewMemoryStore()),
		OfficeInstallAPI: httpapi.NewInstallAPI(t.TempDir()).Handler(),
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/office/collectors/install?code=reg_123", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("prefixed install status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/install?code=reg_123", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("legacy install status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

type noopCollectorAuthenticator struct{}

func (noopCollectorAuthenticator) Authenticate(_ context.Context, _ string) (httpapi.CollectorIdentity, bool, error) {
	return httpapi.CollectorIdentity{}, false, nil
}

type noopCollectorReducer struct{}

func (noopCollectorReducer) ApplyHeartbeat(_ context.Context, _ collectorapi.HeartbeatRequest, _ time.Time) error {
	return nil
}
func (noopCollectorReducer) ApplyEvents(_ context.Context, _ collectorapi.EventsRequest, _ time.Time) (int, error) {
	return 0, nil
}

type fakeManagementStoreForRouteTest struct{}

func (fakeManagementStoreForRouteTest) CollectorsOverview(_ context.Context, now time.Time, onlineThreshold time.Duration) (management.CollectorsOverview, error) {
	return management.CollectorsOverview{
		SchemaVersion:          management.SchemaVersion,
		ServerTime:             now,
		OnlineThresholdSeconds: int(onlineThreshold.Seconds()),
	}, nil
}

func (s fakeManagementStoreForRouteTest) UserCollectorsOverview(ctx context.Context, _ string, now time.Time, onlineThreshold time.Duration) (management.CollectorsOverview, error) {
	return s.CollectorsOverview(ctx, now, onlineThreshold)
}

func (fakeManagementStoreForRouteTest) CreateManagementRegistrationCode(_ context.Context, _, _ string, createdAt time.Time) (management.CreateRegistrationCodeResponse, error) {
	expiresAt := createdAt.Add(10 * time.Minute)
	return management.CreateRegistrationCodeResponse{CreatedAt: createdAt, ExpiresAt: &expiresAt}, nil
}

func (fakeManagementStoreForRouteTest) EnsureManagementRegistrationCode(_ context.Context, _, createdBy string, createdAt time.Time) (management.RegistrationCodeSummary, error) {
	return management.RegistrationCodeSummary{Exists: true, Code: "reg_ensured", CreatedBy: createdBy, CreatedAt: &createdAt}, nil
}

func (fakeManagementStoreForRouteTest) RevokeCollectorToken(_ context.Context, _ string, _ time.Time) error {
	return nil
}

func (fakeManagementStoreForRouteTest) RevokeUserCollectorToken(_ context.Context, _, _ string, _ time.Time) error {
	return nil
}

func (fakeManagementStoreForRouteTest) DeleteCollector(_ context.Context, _ string, _ time.Time, _ time.Duration) error {
	return nil
}

func (fakeManagementStoreForRouteTest) DeleteUserCollector(_ context.Context, _, _ string, _ time.Time, _ time.Duration) error {
	return nil
}

func (fakeManagementStoreForRouteTest) BindMCPAgent(_ context.Context, _, _, _ string, _ time.Time) error {
	return nil
}

func (fakeManagementStoreForRouteTest) UnbindMCPAgent(_ context.Context, _, _ string, _ time.Time) error {
	return nil
}

func (fakeManagementStoreForRouteTest) DeleteOfficeAgent(_ context.Context, _, _ string) error {
	return nil
}

type captureManagementStoreForRouteTest struct {
	lastUserID                   string
	lastCreatedBy                string
	lastRevokedCollectorID       string
	lastBoundCollectorID         string
	lastBoundOfficeAgentID       string
	lastBoundMCPAgentID          string
	lastUnboundCollectorID       string
	lastUnboundOfficeAgentID     string
	lastDeletedOfficeCollectorID string
	lastDeletedOfficeAgentID     string
	ensureCalls                  int
}

func (*captureManagementStoreForRouteTest) CollectorsOverview(_ context.Context, now time.Time, onlineThreshold time.Duration) (management.CollectorsOverview, error) {
	return management.CollectorsOverview{SchemaVersion: management.SchemaVersion, ServerTime: now, OnlineThresholdSeconds: int(onlineThreshold.Seconds())}, nil
}

func (s *captureManagementStoreForRouteTest) UserCollectorsOverview(_ context.Context, userID string, now time.Time, onlineThreshold time.Duration) (management.CollectorsOverview, error) {
	s.lastUserID = userID
	createdAt := now.Add(-time.Hour)
	return management.CollectorsOverview{
		SchemaVersion:          management.SchemaVersion,
		ServerTime:             now,
		OnlineThresholdSeconds: int(onlineThreshold.Seconds()),
		RegistrationCode: management.RegistrationCodeSummary{
			Exists:    true,
			Code:      "reg_once",
			CreatedAt: &createdAt,
			UsedCount: 2,
		},
	}, nil
}

func (s *captureManagementStoreForRouteTest) CreateManagementRegistrationCode(_ context.Context, userID, createdBy string, createdAt time.Time) (management.CreateRegistrationCodeResponse, error) {
	s.lastUserID = userID
	s.lastCreatedBy = createdBy
	expiresAt := createdAt.Add(10 * time.Minute)
	return management.CreateRegistrationCodeResponse{RegistrationCode: "reg_once", CreatedAt: createdAt, ExpiresAt: &expiresAt}, nil
}

func (s *captureManagementStoreForRouteTest) EnsureManagementRegistrationCode(_ context.Context, userID, createdBy string, createdAt time.Time) (management.RegistrationCodeSummary, error) {
	s.ensureCalls++
	s.lastUserID = userID
	s.lastCreatedBy = createdBy
	return management.RegistrationCodeSummary{Exists: true, Code: "reg_once", CreatedBy: createdBy, CreatedAt: &createdAt, UsedCount: 2}, nil
}

func (s *captureManagementStoreForRouteTest) RevokeCollectorToken(_ context.Context, collectorID string, _ time.Time) error {
	s.lastRevokedCollectorID = collectorID
	return nil
}

func (*captureManagementStoreForRouteTest) RevokeUserCollectorToken(_ context.Context, _, _ string, _ time.Time) error {
	return nil
}

func (*captureManagementStoreForRouteTest) DeleteCollector(_ context.Context, _ string, _ time.Time, _ time.Duration) error {
	return nil
}

func (*captureManagementStoreForRouteTest) DeleteUserCollector(_ context.Context, _, _ string, _ time.Time, _ time.Duration) error {
	return nil
}

func (s *captureManagementStoreForRouteTest) BindMCPAgent(_ context.Context, collectorID, officeAgentID, mcpAgentID string, _ time.Time) error {
	s.lastBoundCollectorID = collectorID
	s.lastBoundOfficeAgentID = officeAgentID
	s.lastBoundMCPAgentID = mcpAgentID
	return nil
}

func (s *captureManagementStoreForRouteTest) UnbindMCPAgent(_ context.Context, collectorID, officeAgentID string, _ time.Time) error {
	s.lastUnboundCollectorID = collectorID
	s.lastUnboundOfficeAgentID = officeAgentID
	return nil
}

func (s *captureManagementStoreForRouteTest) DeleteOfficeAgent(_ context.Context, collectorID, officeAgentID string) error {
	s.lastDeletedOfficeCollectorID = collectorID
	s.lastDeletedOfficeAgentID = officeAgentID
	return nil
}

type fakeDashboardReaderForRouteTest struct {
	office                   dashboard.OfficeSnapshot
	agents                   []dashboard.AgentListItem
	lastDetailCollectorID    string
	lastDetailAgentID        string
	lastSubAgentsCollectorID string
	lastSubAgentsAgentID     string
}

func (r *fakeDashboardReaderForRouteTest) OfficeSnapshot(_ context.Context, _ time.Time) (dashboard.OfficeSnapshot, error) {
	return r.office, nil
}

func (r *fakeDashboardReaderForRouteTest) Agents(_ context.Context, _ time.Time) ([]dashboard.AgentListItem, error) {
	return r.agents, nil
}

func (r *fakeDashboardReaderForRouteTest) AgentDetail(_ context.Context, collectorID, agentID string, _ time.Time) (dashboard.AgentDetail, error) {
	r.lastDetailCollectorID = collectorID
	r.lastDetailAgentID = agentID
	return dashboard.AgentDetail{}, nil
}

func (r *fakeDashboardReaderForRouteTest) AgentDetailWithOptions(ctx context.Context, collectorID, agentID string, now time.Time, _ dashboard.AgentDetailOptions) (dashboard.AgentDetail, error) {
	return r.AgentDetail(ctx, collectorID, agentID, now)
}

func (r *fakeDashboardReaderForRouteTest) UserAgentDetailWithOptions(_ context.Context, _, _, _ string, _ time.Time, _ dashboard.AgentDetailOptions) (dashboard.AgentDetail, error) {
	return dashboard.AgentDetail{}, nil
}

func (r *fakeDashboardReaderForRouteTest) SubAgents(_ context.Context, collectorID, agentID string, _ time.Time) ([]dashboard.SubAgentItem, error) {
	r.lastSubAgentsCollectorID = collectorID
	r.lastSubAgentsAgentID = agentID
	return nil, nil
}

func (r *fakeDashboardReaderForRouteTest) RecentActivities(_ context.Context, _ int, _ time.Time) ([]dashboard.ActivityFeedItem, error) {
	return nil, nil
}
