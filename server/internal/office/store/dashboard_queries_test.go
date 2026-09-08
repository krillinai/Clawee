package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/state"
)

func TestPostgresStoreUserDashboardQueriesEnforceCollectorOwner(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "usr_1")
	ensureOfficeTestAccount(t, ctx, db, "usr_2")
	if err := store.CreateOwnedRegistrationCode(ctx, "reg_usr_1", "usr_1", "admin", now.Add(-time.Minute), ptrTime(now.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOwnedRegistrationCode(ctx, "reg_usr_2", "usr_2", "admin", now.Add(-time.Minute), ptrTime(now.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	owned := registerCollectorForOverview(t, ctx, store, "reg_usr_1", "owned", now.Add(-time.Minute), now)
	other := registerCollectorForOverview(t, ctx, store, "reg_usr_2", "other", now.Add(-time.Minute), now)

	for _, item := range []state.AgentState{
		{CollectorID: owned.CollectorID, DeviceID: owned.DeviceID, AgentID: "owned-agent", AgentType: collectorapi.AgentTypeCodex, DisplayName: "Owned", Status: collectorapi.StatusThinking, LastSeenAt: now},
		{CollectorID: other.CollectorID, DeviceID: other.DeviceID, AgentID: "other-agent", AgentType: collectorapi.AgentTypeCodex, DisplayName: "Other", Status: collectorapi.StatusCoding, LastSeenAt: now},
	} {
		if err := store.UpsertAgent(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	for _, item := range []state.ActivityState{
		{CollectorID: owned.CollectorID, AgentID: "owned-agent", ActivityID: "activity_owned", ActivityType: collectorapi.ActivityThinking, Status: collectorapi.StatusThinking, Title: "Owned", StartedAt: now},
		{CollectorID: other.CollectorID, AgentID: "other-agent", ActivityID: "activity_other", ActivityType: collectorapi.ActivityThinking, Status: collectorapi.StatusThinking, Title: "Other", StartedAt: now},
	} {
		if err := store.UpsertActivity(ctx, item); err != nil {
			t.Fatal(err)
		}
	}

	overview, err := store.UserCollectorsOverview(ctx, "usr_1", now, time.Minute)
	if err != nil || len(overview.Collectors) != 1 || overview.Collectors[0].CollectorID != owned.CollectorID {
		t.Fatalf("user collector overview = %#v, err=%v", overview.Collectors, err)
	}
	agents, err := store.UserAgents(ctx, "usr_1", now)
	if err != nil || len(agents) != 1 || agents[0].CollectorID != owned.CollectorID {
		t.Fatalf("user agents = %#v, err=%v", agents, err)
	}
	if agents[0].OwnerUserID != "usr_1" || agents[0].OwnerName != "usr_1" || agents[0].OwnerEmail != "usr_1@office-test.local" {
		t.Fatalf("user agent owner = %#v", agents[0])
	}
	snapshot, err := store.UserOfficeSnapshot(ctx, "usr_1", now)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.SSEURL != "/api/v1/app/activity/events" {
		t.Fatalf("user SSEURL = %q", snapshot.SSEURL)
	}
	activities, err := store.UserRecentActivities(ctx, "usr_1", 20, now)
	if err != nil || len(activities) != 1 || activities[0].CollectorID != owned.CollectorID {
		t.Fatalf("user activities = %#v, err=%v", activities, err)
	}
	if _, err := store.UserAgentDetail(ctx, "usr_1", other.CollectorID, "other-agent", now); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross-account detail err = %v, want sql.ErrNoRows", err)
	}
	if err := store.RevokeUserCollectorToken(ctx, "usr_1", other.CollectorID, now); !errors.Is(err, management.ErrCollectorNotFound) {
		t.Fatalf("cross-account revoke err = %v, want not found", err)
	}
	if err := store.RevokeUserCollectorToken(ctx, "usr_1", owned.CollectorID, now); err != nil {
		t.Fatalf("owned revoke err = %v", err)
	}
}

func TestDashboardUsesServerManagedMCPAgentNameEverywhere(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 8, 7, 12, 0, 0, 0, time.UTC)
	const mcpAgentID = "mcp_dashboard_canonical_name"
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DELETE FROM mcp_agents WHERE agent_id = $1`, mcpAgentID)
	})
	if _, err := db.ExecContext(ctx, `DELETE FROM mcp_agents WHERE agent_id = $1`, mcpAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO mcp_agents (agent_id, name, status, creation_source, created_at, updated_at)
VALUES ($1, '徐刚的Codex', 'active', 'collector', $2, $2)
`, mcpAgentID, now); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: "collector_canonical_name", DeviceID: "device_canonical_name", AgentID: "office_canonical_name",
		AgentType: collectorapi.AgentTypeCodex, DisplayName: "Codex Local", Status: collectorapi.StatusIdle, LastSeenAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
UPDATE office_agents SET mcp_agent_id = $1
WHERE collector_id = 'collector_canonical_name' AND agent_id = 'office_canonical_name'
`, mcpAgentID); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertActivity(ctx, state.ActivityState{
		CollectorID: "collector_canonical_name", AgentID: "office_canonical_name", ActivityID: "activity_canonical_name",
		ActivityType: collectorapi.ActivityCoding, Status: collectorapi.StatusCoding, Title: "Coding", StartedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	agents, err := store.Agents(ctx, now)
	if err != nil || len(agents) != 1 || agents[0].DisplayName != "徐刚的Codex" {
		t.Fatalf("agents = %#v, err=%v", agents, err)
	}
	detail, err := store.AgentDetail(ctx, "collector_canonical_name", "office_canonical_name", now)
	if err != nil || detail.Agent.DisplayName != "徐刚的Codex" {
		t.Fatalf("detail = %#v, err=%v", detail, err)
	}
	activities, err := store.RecentActivities(ctx, 20, now)
	if err != nil || len(activities) != 1 || !strings.Contains(activities[0].Text, "徐刚的Codex") {
		t.Fatalf("activities = %#v, err=%v", activities, err)
	}
}

func TestDashboardOfficeSnapshotUsesOfficePrefixedTables(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	startedAt := now.Add(-12 * time.Minute)

	if err := seedDashboardAgent(ctx, store, "collector_1", "agent_same", "device_1", "Hermes C03", collectorapi.StatusCallingBusinessSystem, startedAt, now); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: "collector_2",
		DeviceID:    "device_2",
		AgentID:     "agent_same",
		AgentType:   collectorapi.AgentTypeCodex,
		DisplayName: "Other Agent",
		Status:      collectorapi.StatusWaitingUser,
		LastSeenAt:  now,
	}); err != nil {
		t.Fatal(err)
	}
	endedAt := now.Add(-1 * time.Minute)
	if err := store.UpsertSession(ctx, state.SessionState{
		CollectorID:   "collector_1",
		AgentID:       "agent_same",
		SessionID:     "sess_done",
		Status:        collectorapi.StatusIdle,
		Summary:       "已完成会话",
		StartedAt:     now.Add(-20 * time.Minute),
		EndedAt:       &endedAt,
		WorkspaceName: "Global Operations",
		UpdatedAt:     endedAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertToolCall(ctx, state.ToolCallState{
		CollectorID: "collector_1",
		AgentID:     "agent_same",
		ToolCallID:  "tool_old",
		SessionID:   "sess_done",
		TurnID:      "turn_1",
		ToolName:    "old_tool",
		ToolType:    "search",
		Status:      "completed",
		StartedAt:   now.Add(-10 * time.Minute),
		CompletedAt: &endedAt,
		DurationMS:  500,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertToolCall(ctx, state.ToolCallState{
		CollectorID: "collector_1",
		AgentID:     "agent_same",
		ToolCallID:  "tool_recent_previous",
		SessionID:   "sess_1",
		TurnID:      "turn_1",
		ToolName:    "read_previous",
		ToolType:    "reading_files",
		Status:      "completed",
		StartedAt:   now.Add(-3 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertToolCall(ctx, state.ToolCallState{
		CollectorID: "collector_1",
		AgentID:     "agent_same",
		ToolCallID:  "tool_recent",
		SessionID:   "sess_1",
		TurnID:      "turn_1",
		ToolName:    "run_query",
		ToolType:    "business_system",
		Status:      "running",
		StartedAt:   now.Add(-2 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertToolCall(ctx, state.ToolCallState{
		CollectorID: "collector_1",
		AgentID:     "agent_same",
		ToolCallID:  "tool_command",
		SessionID:   "sess_1",
		TurnID:      "turn_1",
		ToolName:    "Bash",
		ToolType:    "command",
		Status:      "running",
		Input:       []byte(`{"command":"git diff --stat"}`),
		StartedAt:   now.Add(-30 * time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertActivity(ctx, state.ActivityState{
		CollectorID:  "collector_1",
		AgentID:      "agent_same",
		ActivityID:   "act_command",
		SessionID:    "sess_1",
		TurnID:       "turn_1",
		ToolCallID:   "tool_command",
		ActivityType: collectorapi.ActivityRunningCommands,
		Status:       collectorapi.StatusRunningCommands,
		Title:        "Running command",
		StartedAt:    now.Add(-30 * time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertToolCall(ctx, state.ToolCallState{
		CollectorID: "collector_2",
		AgentID:     "agent_same",
		ToolCallID:  "tool_future",
		ToolName:    "future_tool",
		ToolType:    "command",
		Status:      "running",
		StartedAt:   now.Add(2 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	snapshot, err := store.OfficeSnapshot(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.SchemaVersion != "office.v1" {
		t.Fatalf("SchemaVersion = %q", snapshot.SchemaVersion)
	}
	if snapshot.SSEURL != "/api/v1/admin/activity/events" {
		t.Fatalf("SSEURL = %q", snapshot.SSEURL)
	}
	if len(snapshot.Agents) != 2 {
		t.Fatalf("agents len = %d", len(snapshot.Agents))
	}

	agent := findAgent(t, snapshot.Agents, "collector_1", "agent_same")
	if agent.DisplayName != "Hermes C03" {
		t.Fatalf("DisplayName = %q", agent.DisplayName)
	}
	if agent.CollectorID != "collector_1" || agent.AgentID != "agent_same" {
		t.Fatalf("agent key = %s/%s", agent.CollectorID, agent.AgentID)
	}
	if agent.ActiveBusinessCall == nil {
		t.Fatal("ActiveBusinessCall is nil")
	}
	if agent.ActiveBusinessCall.SystemName != "ERP Gateway" {
		t.Fatalf("SystemName = %q", agent.ActiveBusinessCall.SystemName)
	}
	if agent.SubAgents.ActiveCount != 1 || agent.SubAgents.TotalCount != 1 {
		t.Fatalf("SubAgents = %#v", agent.SubAgents)
	}
	if agent.CurrentSession == nil || agent.CurrentSession.SessionID != "sess_1" {
		t.Fatalf("CurrentSession = %#v", agent.CurrentSession)
	}
	if agent.CurrentTurn == nil || agent.CurrentTurn.Title != "ERP: purchase order query" {
		t.Fatalf("CurrentTurn = %#v", agent.CurrentTurn)
	}
	if snapshot.Summary.TotalAgents != 2 {
		t.Fatalf("TotalAgents = %d", snapshot.Summary.TotalAgents)
	}
	if snapshot.Summary.WorkingAgents != 1 {
		t.Fatalf("WorkingAgents = %d, want 1", snapshot.Summary.WorkingAgents)
	}
	if snapshot.Summary.ActiveSessions != 1 {
		t.Fatalf("ActiveSessions = %d, want 1", snapshot.Summary.ActiveSessions)
	}
	if snapshot.Summary.ActiveTurns != 1 {
		t.Fatalf("ActiveTurns = %d, want 1", snapshot.Summary.ActiveTurns)
	}
	if snapshot.Summary.RecentToolCallCount != 3 {
		t.Fatalf("RecentToolCallCount = %d, want 3", snapshot.Summary.RecentToolCallCount)
	}
	if agent.RecentToolCalls != 3 {
		t.Fatalf("RecentToolCalls = %d, want 3", agent.RecentToolCalls)
	}
	if agent.LastAction == nil || agent.LastAction.ToolName != "Bash" {
		t.Fatalf("LastAction = %#v", agent.LastAction)
	}
	if len(snapshot.RecentFeed) == 0 {
		t.Fatal("RecentFeed is empty")
	}
	if snapshot.RecentFeed[0].ActivityID != "act_command" ||
		snapshot.RecentFeed[0].ActivityType != string(collectorapi.ActivityRunningCommands) ||
		snapshot.RecentFeed[0].Status != string(collectorapi.StatusRunningCommands) ||
		snapshot.RecentFeed[0].Title != "Running command" ||
		snapshot.RecentFeed[0].Summary != "git diff --stat" {
		t.Fatalf("command RecentFeed[0] = %#v", snapshot.RecentFeed[0])
	}
	if len(agent.Sessions) != 2 {
		t.Fatalf("Sessions len = %d, want 2: %#v", len(agent.Sessions), agent.Sessions)
	}
	if agent.Sessions[0].SessionID != "sess_1" || !agent.Sessions[0].Active || agent.Sessions[0].CurrentTurnTitle != "ERP: purchase order query" {
		t.Fatalf("active session brief = %#v", agent.Sessions[0])
	}
	if agent.Sessions[0].LastAction == nil || agent.Sessions[0].LastAction.ToolName != "Bash" {
		t.Fatalf("session LastAction = %#v", agent.Sessions[0].LastAction)
	}
	if len(agent.Sessions[0].RecentActions) != 2 {
		t.Fatalf("session RecentActions len = %d, want 2: %#v", len(agent.Sessions[0].RecentActions), agent.Sessions[0].RecentActions)
	}
	if agent.Sessions[0].RecentActions[0].ToolName != "Bash" || agent.Sessions[0].RecentActions[1].ToolName != "run_query" {
		t.Fatalf("session RecentActions = %#v", agent.Sessions[0].RecentActions)
	}
	otherAgent := findAgent(t, snapshot.Agents, "collector_2", "agent_same")
	if otherAgent.RecentToolCalls != 0 {
		t.Fatalf("future RecentToolCalls = %d, want 0", otherAgent.RecentToolCalls)
	}
}

func TestAgentDetailWithOptionsExcludesHistory(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 8, 18, 16, 0, 0, 0, time.UTC)
	if err := seedDashboardAgent(ctx, store, "collector_compact", "agent_compact", "device_compact", "Codex", collectorapi.StatusThinking, now.Add(-time.Minute), now); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertToolCall(ctx, state.ToolCallState{
		CollectorID:  "collector_compact",
		AgentID:      "agent_compact",
		ToolCallID:   "tool_compact",
		SessionID:    "sess_1",
		TurnID:       "turn_1",
		ToolName:     "Bash",
		ToolType:     "command",
		Status:       "completed",
		ResponseText: strings.Repeat("large response ", 100),
		StartedAt:    now,
	}); err != nil {
		t.Fatal(err)
	}

	compactDetail, err := store.AgentDetailWithOptions(ctx, "collector_compact", "agent_compact", now, dashboard.AgentDetailOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(compactDetail.Sessions) == 0 || len(compactDetail.Turns) == 0 {
		t.Fatalf("compact detail sessions/turns = %d/%d, want non-empty", len(compactDetail.Sessions), len(compactDetail.Turns))
	}
	if len(compactDetail.SubAgents) != 0 || len(compactDetail.ToolCalls) != 0 || len(compactDetail.StatusTimeline) != 0 || len(compactDetail.RecentActivities) != 0 {
		t.Fatalf("compact detail returned history: sub_agents=%d tool_calls=%d timeline=%d activities=%d", len(compactDetail.SubAgents), len(compactDetail.ToolCalls), len(compactDetail.StatusTimeline), len(compactDetail.RecentActivities))
	}
	if compactDetail.Stats.RecentActivityCount != 1 {
		t.Fatalf("compact detail RecentActivityCount = %d, want 1", compactDetail.Stats.RecentActivityCount)
	}

	fullDetail, err := store.AgentDetail(ctx, "collector_compact", "agent_compact", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(fullDetail.SubAgents) == 0 || len(fullDetail.ToolCalls) == 0 || len(fullDetail.StatusTimeline) == 0 || len(fullDetail.RecentActivities) == 0 {
		t.Fatalf("full detail history = sub_agents:%d tool_calls:%d timeline:%d activities:%d, want non-empty", len(fullDetail.SubAgents), len(fullDetail.ToolCalls), len(fullDetail.StatusTimeline), len(fullDetail.RecentActivities))
	}
}

func TestDashboardOfficeSnapshotReturnsEmptyArrays(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 4, 11, 45, 0, 0, time.UTC)
	snapshot, err := store.OfficeSnapshot(ctx, now)
	if err != nil {
		t.Fatal(err)
	}

	if snapshot.Agents == nil {
		t.Fatal("Agents is nil, want empty slice")
	}
	if len(snapshot.Agents) != 0 {
		t.Fatalf("Agents len = %d, want 0", len(snapshot.Agents))
	}
	if snapshot.RecentFeed == nil {
		t.Fatal("RecentFeed is nil, want empty slice")
	}
	if len(snapshot.RecentFeed) != 0 {
		t.Fatalf("RecentFeed len = %d, want 0", len(snapshot.RecentFeed))
	}
	if snapshot.Filters.Workspaces == nil {
		t.Fatal("Filters.Workspaces is nil, want empty slice")
	}
	if len(snapshot.Filters.Workspaces) != 0 {
		t.Fatalf("Filters.Workspaces len = %d, want 0", len(snapshot.Filters.Workspaces))
	}
	if snapshot.Filters.BusinessSystems == nil {
		t.Fatal("Filters.BusinessSystems is nil, want empty slice")
	}
	if len(snapshot.Filters.BusinessSystems) != 0 {
		t.Fatalf("Filters.BusinessSystems len = %d, want 0", len(snapshot.Filters.BusinessSystems))
	}
	if snapshot.Filters.StatusCounts == nil {
		t.Fatal("Filters.StatusCounts is nil, want empty map")
	}
	if len(snapshot.Filters.StatusCounts) != 0 {
		t.Fatalf("Filters.StatusCounts len = %d, want 0", len(snapshot.Filters.StatusCounts))
	}
}

func TestDashboardOfficeSnapshotDerivesStaleRunningState(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	staleAt := now.Add(-dashboardStaleAfter).Add(-time.Second)
	if err := seedDashboardAgent(ctx, store, "collector_1", "agent_stale", "device_1", "Codex", collectorapi.StatusThinking, staleAt.Add(-5*time.Minute), staleAt); err != nil {
		t.Fatal(err)
	}

	snapshot, err := store.OfficeSnapshot(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	agent := findAgent(t, snapshot.Agents, "collector_1", "agent_stale")
	if agent.Status != string(collectorapi.StatusOffline) {
		t.Fatalf("Status = %q, want offline", agent.Status)
	}
	if agent.CurrentSession == nil || agent.CurrentSession.Status != string(collectorapi.StatusIdle) {
		t.Fatalf("CurrentSession = %#v, want idle stale session", agent.CurrentSession)
	}
	if agent.CurrentTurn == nil || agent.CurrentTurn.Status != string(collectorapi.StatusIdle) {
		t.Fatalf("CurrentTurn = %#v, want idle stale turn", agent.CurrentTurn)
	}
	if len(agent.Sessions) == 0 || agent.Sessions[0].Active {
		t.Fatalf("Sessions = %#v, want stale session inactive", agent.Sessions)
	}
	if snapshot.Summary.WorkingAgents != 0 {
		t.Fatalf("WorkingAgents = %d, want 0", snapshot.Summary.WorkingAgents)
	}
	if snapshot.Summary.OnlineAgents != 0 {
		t.Fatalf("OnlineAgents = %d, want 0", snapshot.Summary.OnlineAgents)
	}
	if snapshot.Summary.ActiveSessions != 0 {
		t.Fatalf("ActiveSessions = %d, want 0", snapshot.Summary.ActiveSessions)
	}
	if snapshot.Summary.ActiveTurns != 0 {
		t.Fatalf("ActiveTurns = %d, want 0", snapshot.Summary.ActiveTurns)
	}

	detail, err := store.AgentDetail(ctx, "collector_1", "agent_stale", now)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Stats.ActiveSessions != 0 {
		t.Fatalf("detail ActiveSessions = %d, want 0", detail.Stats.ActiveSessions)
	}
	if len(detail.Sessions) == 0 || detail.Sessions[0].Status != string(collectorapi.StatusIdle) {
		t.Fatalf("detail Sessions = %#v, want idle stale session", detail.Sessions)
	}
	if len(detail.Turns) == 0 || detail.Turns[0].Status != string(collectorapi.StatusIdle) {
		t.Fatalf("detail Turns = %#v, want idle stale turn", detail.Turns)
	}
}

func seedDashboardAgent(ctx context.Context, store *PostgresStore, collectorID string, agentID string, deviceID string, displayName string, status collectorapi.Status, startedAt time.Time, now time.Time) error {
	if err := store.UpsertDevice(ctx, state.DeviceHeartbeat{
		CollectorID:      collectorID,
		DeviceID:         deviceID,
		CollectorVersion: "0.1.0",
		LastSeenAt:       now,
	}); err != nil {
		return err
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID:      collectorID,
		DeviceID:         deviceID,
		AgentID:          agentID,
		AgentType:        collectorapi.AgentTypeCodex,
		DisplayName:      displayName,
		Status:           status,
		WorkspaceName:    "Global Operations",
		CurrentSessionID: "sess_1",
		CurrentTurnID:    "turn_1",
		LastSeenAt:       now,
		Metadata: map[string]string{
			"role_label": "Analyst",
		},
	}); err != nil {
		return err
	}
	if err := store.UpsertSession(ctx, state.SessionState{
		CollectorID:   collectorID,
		AgentID:       agentID,
		SessionID:     "sess_1",
		Status:        status,
		Summary:       "当前会话",
		StartedAt:     startedAt,
		WorkspaceName: "Global Operations",
		UpdatedAt:     now,
	}); err != nil {
		return err
	}
	if err := store.UpsertTurn(ctx, state.TurnState{
		CollectorID:      collectorID,
		AgentID:          agentID,
		TurnID:           "turn_1",
		SessionID:        "sess_1",
		Title:            "ERP: purchase order query",
		Status:           status,
		StartedAt:        startedAt,
		UpdatedAt:        now,
		AssistantSummary: "查询采购订单",
	}); err != nil {
		return err
	}
	if err := store.UpsertSubAgent(ctx, state.SubAgentState{
		CollectorID:     collectorID,
		ParentAgentID:   agentID,
		SubAgentID:      "sub_1",
		SessionID:       "sess_1",
		ParentTurnID:    "turn_1",
		Name:            "Researcher",
		Role:            "researcher",
		Status:          collectorapi.StatusSearching,
		CurrentActivity: "Find PO records",
		StartedAt:       startedAt,
		UpdatedAt:       now,
	}); err != nil {
		return err
	}
	return store.UpsertActivity(ctx, state.ActivityState{
		CollectorID:  collectorID,
		ActivityID:   "act_1",
		AgentID:      agentID,
		SessionID:    "sess_1",
		TurnID:       "turn_1",
		ActivityType: collectorapi.ActivityCallingBusinessSystem,
		Status:       collectorapi.StatusCallingBusinessSystem,
		Title:        "Calling ERP",
		Summary:      "采购订单查询",
		StartedAt:    startedAt,
		Metadata: map[string]string{
			"system_type":       "erp",
			"business_system":   "ERP Gateway",
			"operation_label":   "采购订单查询",
			"risk_level":        "low",
			"external_event_id": "erp_evt_7f42",
		},
	})
}

func findAgent(t *testing.T, agents []dashboard.AgentListItem, collectorID string, agentID string) dashboard.AgentListItem {
	t.Helper()
	for _, agent := range agents {
		if agent.CollectorID == collectorID && agent.AgentID == agentID {
			return agent
		}
	}
	t.Fatalf("agent %s/%s not found in %#v", collectorID, agentID, agents)
	return dashboard.AgentListItem{}
}
