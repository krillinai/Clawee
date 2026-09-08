package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/dashboard"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/realtime"
)

func TestDashboardOfficeReturnsSnapshot(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	reader := &fakeDashboardReader{
		office: dashboard.OfficeSnapshot{
			SchemaVersion: dashboard.SchemaVersion,
			ServerTime:    now,
			SSEURL:        "/api/v1/admin/activity/events",
			Agents: []dashboard.AgentListItem{{
				CollectorID: "collector_1",
				AgentID:     "agent_same",
				DisplayName: "Hermes C03",
				Status:      "searching",
			}},
		},
	}
	api := NewDashboardAPI(reader, nil, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/overview", nil)
	api.OverviewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body dashboard.OfficeSnapshot
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.SchemaVersion != dashboard.SchemaVersion {
		t.Fatalf("schema_version = %q", body.SchemaVersion)
	}
	if body.SSEURL != "/api/v1/admin/activity/events" {
		t.Fatalf("sse_url = %q", body.SSEURL)
	}
	if len(body.Agents) != 1 {
		t.Fatalf("agents len = %d", len(body.Agents))
	}
	if body.Agents[0].CollectorID != "collector_1" || body.Agents[0].AgentID != "agent_same" {
		t.Fatalf("agent key = %#v", body.Agents[0])
	}
}

func TestDashboardOfficeReturnsEmptyArraysForNilCollections(t *testing.T) {
	now := time.Date(2026, 6, 4, 11, 45, 0, 0, time.UTC)
	reader := &fakeDashboardReader{
		office: dashboard.OfficeSnapshot{
			SchemaVersion: dashboard.SchemaVersion,
			ServerTime:    now,
			SSEURL:        "/api/v1/admin/activity/events",
			Agents: []dashboard.AgentListItem{{
				CollectorID: "collector_1",
				AgentID:     "agent_without_sub_agents",
				SubAgents:   dashboard.SubAgentSummary{},
			}},
		},
	}
	api := NewDashboardAPI(reader, nil, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/overview", nil)
	api.OverviewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rawBody := rec.Body.String()
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["agents"] == nil {
		t.Fatalf("agents = nil, body = %s", rawBody)
	}
	agents, ok := body["agents"].([]any)
	if !ok || len(agents) != 1 {
		t.Fatalf("agents = %#v, body = %s", body["agents"], rawBody)
	}
	agent, ok := agents[0].(map[string]any)
	if !ok {
		t.Fatalf("agents[0] = %#v, body = %s", agents[0], rawBody)
	}
	subAgents, ok := agent["sub_agents"].(map[string]any)
	if !ok {
		t.Fatalf("agents[0].sub_agents = %#v, body = %s", agent["sub_agents"], rawBody)
	}
	if subAgents["preview"] == nil {
		t.Fatalf("agents[0].sub_agents.preview = nil, body = %s", rawBody)
	}
	if agent["sessions"] == nil {
		t.Fatalf("agents[0].sessions = nil, body = %s", rawBody)
	}
	if body["recent_feed"] == nil {
		t.Fatalf("recent_feed = nil, body = %s", rawBody)
	}
	filters, ok := body["filters"].(map[string]any)
	if !ok {
		t.Fatalf("filters = %#v", body["filters"])
	}
	if filters["workspaces"] == nil {
		t.Fatalf("filters.workspaces = nil, body = %s", rawBody)
	}
	if filters["business_systems"] == nil {
		t.Fatalf("filters.business_systems = nil, body = %s", rawBody)
	}
	if filters["status_counts"] == nil {
		t.Fatalf("filters.status_counts = nil, body = %s", rawBody)
	}
}

func TestDashboardOfficeReturnsEmptyArrayForNilSubAgentPreview(t *testing.T) {
	now := time.Date(2026, 6, 4, 12, 10, 0, 0, time.UTC)
	reader := &fakeDashboardReader{
		office: dashboard.OfficeSnapshot{
			SchemaVersion: dashboard.SchemaVersion,
			ServerTime:    now,
			SSEURL:        "/api/v1/admin/activity/events",
			Agents: []dashboard.AgentListItem{{
				CollectorID: "collector_1",
				AgentID:     "agent_without_sub_agents",
				DisplayName: "Codex Local",
				Status:      "thinking",
				SubAgents: dashboard.SubAgentSummary{
					ActiveCount: 0,
					TotalCount:  0,
				},
			}},
		},
	}
	api := NewDashboardAPI(reader, nil, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/overview", nil)
	api.OverviewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rawBody := rec.Body.String()
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	agents, ok := body["agents"].([]any)
	if !ok || len(agents) != 1 {
		t.Fatalf("agents = %#v, body = %s", body["agents"], rawBody)
	}
	agent, ok := agents[0].(map[string]any)
	if !ok {
		t.Fatalf("agent = %#v, body = %s", agents[0], rawBody)
	}
	subAgents, ok := agent["sub_agents"].(map[string]any)
	if !ok {
		t.Fatalf("sub_agents = %#v, body = %s", agent["sub_agents"], rawBody)
	}
	preview, ok := subAgents["preview"].([]any)
	if !ok {
		t.Fatalf("sub_agents.preview = %#v, body = %s", subAgents["preview"], rawBody)
	}
	if len(preview) != 0 {
		t.Fatalf("sub_agents.preview len = %d, want 0", len(preview))
	}
}

func TestDashboardListEndpointsReturnEmptyArraysForNilCollections(t *testing.T) {
	now := time.Date(2026, 6, 4, 12, 20, 0, 0, time.UTC)
	reader := &fakeDashboardReader{
		detail: dashboard.AgentDetail{
			SchemaVersion: dashboard.SchemaVersion,
			ServerTime:    now,
			Agent: dashboard.AgentListItem{
				CollectorID: "collector_1",
				AgentID:     "agent_without_sub_agents",
				DisplayName: "Codex Local",
				Status:      "thinking",
			},
		},
	}
	api := NewDashboardAPI(reader, nil, func() time.Time { return now })

	tests := []struct {
		name    string
		handler http.Handler
		path    string
		field   string
	}{
		{name: "agents", handler: api.AgentsHandler(), path: "/api/v1/admin/activity/agents", field: "agents"},
		{name: "sub agents", handler: api.SubAgentsHandler(), path: "/api/v1/admin/activity/sub-agents?collector_id=collector_1&agent_id=agent_without_sub_agents", field: "sub_agents"},
		{name: "recent feed", handler: api.RecentActivitiesHandler(), path: "/api/v1/admin/activity/recent", field: "recent_feed"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			tt.handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			rawBody := rec.Body.String()
			var body map[string]any
			if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			items, ok := body[tt.field].([]any)
			if !ok {
				t.Fatalf("%s = %#v, body = %s", tt.field, body[tt.field], rawBody)
			}
			if len(items) != 0 {
				t.Fatalf("%s len = %d, want 0", tt.field, len(items))
			}
		})
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/detail?collector_id=collector_1&agent_id=agent_without_sub_agents", nil)
	api.DetailHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rawBody := rec.Body.String()
	var detail map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"sub_agents", "status_timeline", "recent_activities"} {
		items, ok := detail[field].([]any)
		if !ok {
			t.Fatalf("%s = %#v, body = %s", field, detail[field], rawBody)
		}
		if len(items) != 0 {
			t.Fatalf("%s len = %d, want 0", field, len(items))
		}
	}
	agent, ok := detail["agent"].(map[string]any)
	if !ok {
		t.Fatalf("agent = %#v, body = %s", detail["agent"], rawBody)
	}
	subAgents, ok := agent["sub_agents"].(map[string]any)
	if !ok {
		t.Fatalf("agent.sub_agents = %#v, body = %s", agent["sub_agents"], rawBody)
	}
	if preview, ok := subAgents["preview"].([]any); !ok || len(preview) != 0 {
		t.Fatalf("agent.sub_agents.preview = %#v, body = %s", subAgents["preview"], rawBody)
	}
}

func TestDashboardAgentDetailUsesCollectorAndAgentFromQuery(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	reader := &fakeDashboardReader{
		detail: dashboard.AgentDetail{
			SchemaVersion: dashboard.SchemaVersion,
			ServerTime:    now,
			Agent: dashboard.AgentListItem{
				CollectorID: "collector_1",
				AgentID:     "agent_same",
				DisplayName: "Hermes C03",
			},
		},
	}
	api := NewDashboardAPI(reader, nil, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/detail?collector_id=collector_1&agent_id=agent_same", nil)
	api.DetailHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if reader.lastCollectorID != "collector_1" || reader.lastAgentID != "agent_same" {
		t.Fatalf("reader key = %s/%s", reader.lastCollectorID, reader.lastAgentID)
	}
	if !reader.lastDetailOptions.IncludeHistory {
		t.Fatal("IncludeHistory = false, want default true")
	}
	var body dashboard.AgentDetail
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Agent.CollectorID != "collector_1" || body.Agent.AgentID != "agent_same" {
		t.Fatalf("agent key = %#v", body.Agent)
	}
}

func TestDashboardAgentDetailCanExcludeHistory(t *testing.T) {
	reader := &fakeDashboardReader{}
	api := NewDashboardAPI(reader, nil, func() time.Time {
		return time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/detail?collector_id=collector_1&agent_id=agent_same&include_history=false", nil)
	api.DetailHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if reader.lastDetailOptions.IncludeHistory {
		t.Fatal("IncludeHistory = true, want false")
	}
}

func TestDashboardAgentDetailRejectsInvalidIncludeHistory(t *testing.T) {
	reader := &fakeDashboardReader{}
	api := NewDashboardAPI(reader, nil, func() time.Time {
		return time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/detail?collector_id=collector_1&agent_id=agent_same&include_history=invalid", nil)
	api.DetailHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "invalid_include_history")
}

func TestDashboardAgentDetailNotFoundReturns404(t *testing.T) {
	api := NewDashboardAPI(&fakeDashboardReader{err: ErrNotFound}, nil, func() time.Time {
		return time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/detail?collector_id=collector_1&agent_id=missing_agent", nil)
	api.DetailHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "not_found")
}

func TestDashboardPostReturnsMethodNotAllowed(t *testing.T) {
	api := NewDashboardAPI(&fakeDashboardReader{}, nil, func() time.Time {
		return time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/activity/overview", strings.NewReader(`{}`))
	api.OverviewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "method_not_allowed")
}

func TestDashboardInternalErrorReturns500(t *testing.T) {
	api := NewDashboardAPI(&fakeDashboardReader{err: errors.New("query failed")}, nil, func() time.Time {
		return time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/overview", nil)
	api.OverviewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "internal_error")
}

type fakeDashboardReader struct {
	office            dashboard.OfficeSnapshot
	agents            []dashboard.AgentListItem
	detail            dashboard.AgentDetail
	subAgents         []dashboard.SubAgentItem
	feed              []dashboard.ActivityFeedItem
	err               error
	lastCollectorID   string
	lastAgentID       string
	lastDetailOptions dashboard.AgentDetailOptions
	userCollectors    map[string]map[string]bool
}

func (r *fakeDashboardReader) OfficeSnapshot(ctx context.Context, now time.Time) (dashboard.OfficeSnapshot, error) {
	return r.office, r.err
}

func (r *fakeDashboardReader) Agents(ctx context.Context, now time.Time) ([]dashboard.AgentListItem, error) {
	return r.agents, r.err
}

func (r *fakeDashboardReader) AgentDetail(ctx context.Context, collectorID string, agentID string, now time.Time) (dashboard.AgentDetail, error) {
	r.lastCollectorID = collectorID
	r.lastAgentID = agentID
	return r.detail, r.err
}

func (r *fakeDashboardReader) AgentDetailWithOptions(ctx context.Context, collectorID string, agentID string, now time.Time, options dashboard.AgentDetailOptions) (dashboard.AgentDetail, error) {
	r.lastDetailOptions = options
	return r.AgentDetail(ctx, collectorID, agentID, now)
}

func (r *fakeDashboardReader) SubAgents(ctx context.Context, collectorID string, agentID string, now time.Time) ([]dashboard.SubAgentItem, error) {
	r.lastCollectorID = collectorID
	r.lastAgentID = agentID
	return r.subAgents, r.err
}

func (r *fakeDashboardReader) RecentActivities(ctx context.Context, limit int, now time.Time) ([]dashboard.ActivityFeedItem, error) {
	return r.feed, r.err
}

func (r *fakeDashboardReader) UserOfficeSnapshot(ctx context.Context, userID string, now time.Time) (dashboard.OfficeSnapshot, error) {
	office := r.office
	office.Agents = r.filterUserAgents(userID, office.Agents)
	feed, err := r.UserRecentActivities(ctx, userID, len(office.RecentFeed), now)
	office.RecentFeed = feed
	return office, err
}

func (r *fakeDashboardReader) UserAgents(_ context.Context, userID string, _ time.Time) ([]dashboard.AgentListItem, error) {
	return r.filterUserAgents(userID, r.agents), r.err
}

func (r *fakeDashboardReader) UserAgentDetail(_ context.Context, userID, collectorID, agentID string, _ time.Time) (dashboard.AgentDetail, error) {
	if !r.userCollectors[userID][collectorID] {
		return dashboard.AgentDetail{}, ErrNotFound
	}
	r.lastCollectorID = collectorID
	r.lastAgentID = agentID
	return r.detail, r.err
}

func (r *fakeDashboardReader) UserAgentDetailWithOptions(ctx context.Context, userID, collectorID, agentID string, now time.Time, options dashboard.AgentDetailOptions) (dashboard.AgentDetail, error) {
	r.lastDetailOptions = options
	return r.UserAgentDetail(ctx, userID, collectorID, agentID, now)
}

func (r *fakeDashboardReader) UserSubAgents(_ context.Context, userID, collectorID, agentID string, _ time.Time) ([]dashboard.SubAgentItem, error) {
	if !r.userCollectors[userID][collectorID] {
		return nil, ErrNotFound
	}
	return r.subAgents, r.err
}

func (r *fakeDashboardReader) UserRecentActivities(_ context.Context, userID string, limit int, _ time.Time) ([]dashboard.ActivityFeedItem, error) {
	out := make([]dashboard.ActivityFeedItem, 0)
	for _, item := range r.feed {
		if r.userCollectors[userID][item.CollectorID] {
			out = append(out, item)
			if limit > 0 && len(out) == limit {
				break
			}
		}
	}
	return out, r.err
}

func (r *fakeDashboardReader) filterUserAgents(userID string, items []dashboard.AgentListItem) []dashboard.AgentListItem {
	out := make([]dashboard.AgentListItem, 0)
	for _, item := range items {
		if r.userCollectors[userID][item.CollectorID] {
			out = append(out, item)
		}
	}
	return out
}

var _ DashboardReader = (*fakeDashboardReader)(nil)
var _ UserDashboardReader = (*fakeDashboardReader)(nil)

func TestDashboardRealtimeEventsReturnsSSEHeaders(t *testing.T) {
	broker := realtime.NewBroker()
	api := NewDashboardAPI(&fakeDashboardReader{}, broker, func() time.Time {
		return time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/activity/events", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		api.RealtimeEventsHandler().ServeHTTP(rec, req)
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done

	if got := rec.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q", got)
	}
	if !strings.Contains(rec.Body.String(), "event: hello") {
		t.Fatalf("body does not contain hello event: %s", rec.Body.String())
	}
}

func TestUserDashboardScopesActivityByCollectorOwner(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	ownedAgent := dashboard.AgentListItem{CollectorID: "collector_owned", AgentID: "agent_owned", Status: "thinking"}
	otherAgent := dashboard.AgentListItem{CollectorID: "collector_other", AgentID: "agent_other", Status: "coding"}
	reader := &fakeDashboardReader{
		office:         dashboard.OfficeSnapshot{SchemaVersion: dashboard.SchemaVersion, Agents: []dashboard.AgentListItem{ownedAgent, otherAgent}, RecentFeed: []dashboard.ActivityFeedItem{{CollectorID: "collector_owned", Text: "owned"}, {CollectorID: "collector_other", Text: "other"}}},
		agents:         []dashboard.AgentListItem{ownedAgent, otherAgent},
		feed:           []dashboard.ActivityFeedItem{{CollectorID: "collector_owned", Text: "owned"}, {CollectorID: "collector_other", Text: "other"}},
		userCollectors: map[string]map[string]bool{"usr_1": {"collector_owned": true}},
	}
	store := &fakeManagementStore{overview: management.CollectorsOverview{Collectors: []management.CollectorItem{{CollectorID: "collector_owned", UserID: "usr_1"}, {CollectorID: "collector_other", UserID: "usr_2"}}}}
	handler := NewDashboardAPI(reader, nil, func() time.Time { return now }).UserHandler(store, reader)
	request := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req = req.WithContext(ContextWithManagementOperator(req.Context(), "usr_1"))
		handler.ServeHTTP(rec, req)
		return rec
	}

	for _, target := range []string{"/api/v1/app/activity/overview", "/api/v1/app/activity/agents", "/api/v1/app/activity/recent?limit=20"} {
		rec := request(target)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "collector_owned") || strings.Contains(rec.Body.String(), "collector_other") {
			t.Fatalf("GET %s status = %d body=%s", target, rec.Code, rec.Body.String())
		}
		if target == "/api/v1/app/activity/overview" && !strings.Contains(rec.Body.String(), `"sse_url":"/api/v1/app/activity/events"`) {
			t.Fatalf("overview SSE URL = %s", rec.Body.String())
		}
	}
	rec := request("/api/v1/app/activity/detail?collector_id=collector_other&agent_id=agent_other")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other detail status = %d body=%s", rec.Code, rec.Body.String())
	}
}
