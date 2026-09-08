package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/dashboard"
)

var ErrNotFound = errors.New("dashboard resource not found")

type DashboardReader interface {
	OfficeSnapshot(context.Context, time.Time) (dashboard.OfficeSnapshot, error)
	Agents(context.Context, time.Time) ([]dashboard.AgentListItem, error)
	AgentDetailWithOptions(context.Context, string, string, time.Time, dashboard.AgentDetailOptions) (dashboard.AgentDetail, error)
	SubAgents(context.Context, string, string, time.Time) ([]dashboard.SubAgentItem, error)
	RecentActivities(context.Context, int, time.Time) ([]dashboard.ActivityFeedItem, error)
}

type UserDashboardReader interface {
	UserOfficeSnapshot(context.Context, string, time.Time) (dashboard.OfficeSnapshot, error)
	UserAgents(context.Context, string, time.Time) ([]dashboard.AgentListItem, error)
	UserAgentDetailWithOptions(context.Context, string, string, string, time.Time, dashboard.AgentDetailOptions) (dashboard.AgentDetail, error)
	UserSubAgents(context.Context, string, string, string, time.Time) ([]dashboard.SubAgentItem, error)
	UserRecentActivities(context.Context, string, int, time.Time) ([]dashboard.ActivityFeedItem, error)
}

type SSEHandler interface {
	ServeHTTP(http.ResponseWriter, *http.Request)
}

type scopedSSEHandler interface {
	ServeFilteredHTTP(http.ResponseWriter, *http.Request, func(dashboard.RealtimeScope) bool)
}

type DashboardAPI struct {
	reader DashboardReader
	broker SSEHandler
	now    Clock
}

func NewDashboardAPI(reader DashboardReader, broker SSEHandler, now Clock) *DashboardAPI {
	return &DashboardAPI{reader: reader, broker: broker, now: now}
}

func (api *DashboardAPI) OverviewHandler() http.Handler {
	return http.HandlerFunc(api.handleOffice)
}

func (api *DashboardAPI) AgentsHandler() http.Handler {
	return http.HandlerFunc(api.handleAgents)
}

func (api *DashboardAPI) DetailHandler() http.Handler {
	return http.HandlerFunc(api.handleDetailQuery)
}

func (api *DashboardAPI) SubAgentsHandler() http.Handler {
	return http.HandlerFunc(api.handleSubAgentsQuery)
}

func (api *DashboardAPI) RecentActivitiesHandler() http.Handler {
	return http.HandlerFunc(api.handleRecentActivities)
}

func (api *DashboardAPI) RealtimeEventsHandler() http.Handler {
	return http.HandlerFunc(api.handleRealtimeEvents)
}

func (api *DashboardAPI) UserHandler(managementStore ManagementStore, reader UserDashboardReader) http.Handler {
	mux := http.NewServeMux()
	user := &userDashboardAPI{dashboard: api, management: managementStore, reader: reader}
	mux.HandleFunc("/api/v1/app/activity/overview", user.handleOverview)
	mux.HandleFunc("/api/v1/app/activity/agents", user.handleAgents)
	mux.HandleFunc("/api/v1/app/activity/detail", user.handleDetail)
	mux.HandleFunc("/api/v1/app/activity/sub-agents", user.handleSubAgents)
	mux.HandleFunc("/api/v1/app/activity/recent", user.handleRecent)
	mux.HandleFunc("/api/v1/app/activity/events", user.handleEvents)
	return mux
}

type userDashboardAPI struct {
	dashboard  *DashboardAPI
	management ManagementStore
	reader     UserDashboardReader
}

func (api *userDashboardAPI) userID(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID := strings.TrimSpace(managementOperator(r.Context()))
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "account identity is required")
		return "", false
	}
	return userID, true
}

func (api *userDashboardAPI) handleOverview(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	userID, ok := api.userID(w, r)
	if !ok {
		return
	}
	snapshot, err := api.reader.UserOfficeSnapshot(r.Context(), userID, api.dashboard.receivedAt())
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	snapshot.SSEURL = "/api/v1/app/activity/events"
	normalizeOfficeSnapshot(&snapshot)
	writeJSON(w, http.StatusOK, snapshot)
}

func (api *userDashboardAPI) handleAgents(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	userID, ok := api.userID(w, r)
	if !ok {
		return
	}
	items, err := api.reader.UserAgents(r.Context(), userID, api.dashboard.receivedAt())
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schema_version": dashboard.SchemaVersion, "server_time": api.dashboard.receivedAt(), "agents": normalizeAgentListItems(items)})
}

func (api *userDashboardAPI) handleDetail(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	userID, ok := api.userID(w, r)
	if !ok {
		return
	}
	collectorID := strings.TrimSpace(r.URL.Query().Get("collector_id"))
	agentID := strings.TrimSpace(r.URL.Query().Get("agent_id"))
	options, err := agentDetailOptions(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_include_history", "include_history must be true or false")
		return
	}
	detail, err := api.reader.UserAgentDetailWithOptions(r.Context(), userID, collectorID, agentID, api.dashboard.receivedAt(), options)
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	normalizeAgentDetail(&detail)
	writeJSON(w, http.StatusOK, detail)
}

func (api *userDashboardAPI) handleSubAgents(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	userID, ok := api.userID(w, r)
	if !ok {
		return
	}
	collectorID := strings.TrimSpace(r.URL.Query().Get("collector_id"))
	agentID := strings.TrimSpace(r.URL.Query().Get("agent_id"))
	items, err := api.reader.UserSubAgents(r.Context(), userID, collectorID, agentID, api.dashboard.receivedAt())
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	if items == nil {
		items = []dashboard.SubAgentItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"schema_version": dashboard.SchemaVersion, "server_time": api.dashboard.receivedAt(), "collector_id": collectorID, "agent_id": agentID, "sub_agents": items})
}

func (api *userDashboardAPI) handleRecent(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	limit, err := activityLimit(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be an integer from 1 to 100")
		return
	}
	userID, ok := api.userID(w, r)
	if !ok {
		return
	}
	items, err := api.reader.UserRecentActivities(r.Context(), userID, limit, api.dashboard.receivedAt())
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schema_version": dashboard.SchemaVersion, "server_time": api.dashboard.receivedAt(), "recent_feed": items})
}

func (api *userDashboardAPI) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	userID, ok := api.userID(w, r)
	if !ok {
		return
	}
	overview, err := api.management.UserCollectorsOverview(r.Context(), userID, api.dashboard.receivedAt(), defaultOnlineThreshold)
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	allowed := make(map[string]struct{}, len(overview.Collectors))
	for _, item := range overview.Collectors {
		allowed[item.CollectorID] = struct{}{}
	}
	broker, ok := api.dashboard.broker.(scopedSSEHandler)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "realtime_unavailable", "realtime broker is not configured")
		return
	}
	broker.ServeFilteredHTTP(w, r, func(scope dashboard.RealtimeScope) bool {
		_, exists := allowed[scope.CollectorID]
		return scope.CollectorID != "" && exists
	})
}

func activityLimit(r *http.Request) (int, error) {
	limit := 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			return 0, errors.New("invalid limit")
		}
		limit = parsed
	}
	return limit, nil
}

func agentDetailOptions(r *http.Request) (dashboard.AgentDetailOptions, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("include_history"))
	if raw == "" || raw == "true" {
		return dashboard.AgentDetailOptions{IncludeHistory: true}, nil
	}
	if raw == "false" {
		return dashboard.AgentDetailOptions{}, nil
	}
	return dashboard.AgentDetailOptions{}, errors.New("invalid include_history")
}

func (api *DashboardAPI) handleOffice(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	snapshot, err := api.reader.OfficeSnapshot(r.Context(), api.receivedAt())
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	normalizeOfficeSnapshot(&snapshot)
	writeJSON(w, http.StatusOK, snapshot)
}

func normalizeOfficeSnapshot(snapshot *dashboard.OfficeSnapshot) {
	if snapshot.Agents == nil {
		snapshot.Agents = []dashboard.AgentListItem{}
	}
	for i := range snapshot.Agents {
		normalizeAgentListItem(&snapshot.Agents[i])
	}
	if snapshot.RecentFeed == nil {
		snapshot.RecentFeed = []dashboard.ActivityFeedItem{}
	}
	if snapshot.Filters.Workspaces == nil {
		snapshot.Filters.Workspaces = []dashboard.WorkspaceCount{}
	}
	if snapshot.Filters.BusinessSystems == nil {
		snapshot.Filters.BusinessSystems = []dashboard.BusinessSystemCount{}
	}
	if snapshot.Filters.StatusCounts == nil {
		snapshot.Filters.StatusCounts = map[string]int{}
	}
}

func normalizeAgentListItem(agent *dashboard.AgentListItem) {
	if agent.SubAgents.Preview == nil {
		agent.SubAgents.Preview = []dashboard.SubAgentItem{}
	}
	if agent.Sessions == nil {
		agent.Sessions = []dashboard.AgentSessionBrief{}
	}
	for i := range agent.Sessions {
		if agent.Sessions[i].RecentActions == nil {
			agent.Sessions[i].RecentActions = []dashboard.AgentLastAction{}
		}
	}
}

func normalizeAgentListItems(agents []dashboard.AgentListItem) []dashboard.AgentListItem {
	if agents == nil {
		return []dashboard.AgentListItem{}
	}
	for i := range agents {
		normalizeAgentListItem(&agents[i])
	}
	return agents
}

func normalizeAgentDetail(detail *dashboard.AgentDetail) {
	normalizeAgentListItem(&detail.Agent)
	if detail.Sessions == nil {
		detail.Sessions = []dashboard.SessionItem{}
	}
	if detail.Turns == nil {
		detail.Turns = []dashboard.TurnItem{}
	}
	if detail.SubAgents == nil {
		detail.SubAgents = []dashboard.SubAgentItem{}
	}
	if detail.ToolCalls == nil {
		detail.ToolCalls = []dashboard.ToolCallItem{}
	}
	if detail.StatusTimeline == nil {
		detail.StatusTimeline = []dashboard.TimelineItem{}
	}
	if detail.RecentActivities == nil {
		detail.RecentActivities = []dashboard.ActivityItem{}
	}
}

func (api *DashboardAPI) handleAgents(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	serverTime := api.receivedAt()
	agents, err := api.reader.Agents(r.Context(), serverTime)
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	agents = normalizeAgentListItems(agents)
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": dashboard.SchemaVersion,
		"server_time":    serverTime,
		"agents":         agents,
	})
}

func (api *DashboardAPI) handleDetailQuery(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	options, err := agentDetailOptions(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_include_history", "include_history must be true or false")
		return
	}
	api.writeAgentDetail(w, r, strings.TrimSpace(r.URL.Query().Get("collector_id")), strings.TrimSpace(r.URL.Query().Get("agent_id")), api.receivedAt(), options)
}

func (api *DashboardAPI) handleSubAgentsQuery(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	api.writeSubAgents(w, r, strings.TrimSpace(r.URL.Query().Get("collector_id")), strings.TrimSpace(r.URL.Query().Get("agent_id")), api.receivedAt())
}

func (api *DashboardAPI) writeAgentDetail(w http.ResponseWriter, r *http.Request, collectorID, agentID string, serverTime time.Time, options dashboard.AgentDetailOptions) {
	detail, err := api.reader.AgentDetailWithOptions(r.Context(), collectorID, agentID, serverTime, options)
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	normalizeAgentDetail(&detail)
	writeJSON(w, http.StatusOK, detail)
}

func (api *DashboardAPI) writeSubAgents(w http.ResponseWriter, r *http.Request, collectorID, agentID string, serverTime time.Time) {
	items, err := api.reader.SubAgents(r.Context(), collectorID, agentID, serverTime)
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	if items == nil {
		items = []dashboard.SubAgentItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": dashboard.SchemaVersion,
		"server_time":    serverTime,
		"collector_id":   collectorID,
		"agent_id":       agentID,
		"sub_agents":     items,
	})
}

func (api *DashboardAPI) handleRecentActivities(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	limit := 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be an integer from 1 to 100")
			return
		}
		limit = parsed
	}
	serverTime := api.receivedAt()
	feed, err := api.reader.RecentActivities(r.Context(), limit, serverTime)
	if err != nil {
		writeDashboardError(w, err)
		return
	}
	if feed == nil {
		feed = []dashboard.ActivityFeedItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": dashboard.SchemaVersion,
		"server_time":    serverTime,
		"recent_feed":    feed,
	})
}

func (api *DashboardAPI) handleRealtimeEvents(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	if api.broker == nil {
		writeError(w, http.StatusServiceUnavailable, "realtime_unavailable", "realtime broker is not configured")
		return
	}
	api.broker.ServeHTTP(w, r)
}

func (api *DashboardAPI) receivedAt() time.Time {
	if api.now == nil {
		return time.Now().UTC()
	}
	return api.now().UTC()
}

func requireGet(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet {
		return true
	}
	w.Header().Set("Allow", http.MethodGet)
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method must be GET")
	return false
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeDashboardError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrNotFound) || errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "not_found", "dashboard resource not found")
		return
	}
	writeError(w, http.StatusInternalServerError, "internal_error", "dashboard query failed")
}
