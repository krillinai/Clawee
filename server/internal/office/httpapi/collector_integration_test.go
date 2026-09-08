package httpapi_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/auth"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/office/state"
	storepkg "github.com/krillinai/Clawee/server/internal/office/store"
	"github.com/krillinai/Clawee/server/internal/store"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
)

var integrationNow = time.Date(2026, 6, 2, 12, 0, 0, 0, time.UTC)

func TestCollectorRegistrationToHeartbeatEventsHTTPFlowPersistsOfficeState(t *testing.T) {
	db := openHTTPCollectorIntegrationDB(t)
	ctx := context.Background()
	officeStore := storepkg.NewPostgresStore(db)
	resetHTTPCollectorIntegrationTables(t, ctx, db)
	pool := openHTTPCollectorIntegrationPool(t, ctx)
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewPostgresStore(pool)})
	tokenCipher, err := mcpgateway.NewTokenCipher([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	proxyGateway := mcpgateway.NewService(mcpgateway.Config{
		Store:       store.NewMCPGatewayStore(pool),
		TokenCipher: tokenCipher,
	})
	agentProvisioner := agentprovisioning.NewService(accountSvc, proxyGateway)

	registeredAt := time.Date(2026, 6, 5, 9, 0, 0, 0, time.UTC)
	if _, err := db.ExecContext(ctx, `
INSERT INTO accounts (user_id, email, name, password_hash, status, created_at, updated_at)
VALUES ('owner_http_flow', 'owner_http_flow@office-test.local', 'owner_http_flow', 'test', 'active', now(), now())
ON CONFLICT (user_id) DO UPDATE SET status = 'active', updated_at = now()
`); err != nil {
		t.Fatal(err)
	}
	if err := officeStore.CreateOwnedRegistrationCode(ctx, "FLOW-1234", "owner_http_flow", "review", registeredAt, timePtr(registeredAt.Add(10*time.Minute))); err != nil {
		t.Fatal(err)
	}

	reducer := state.NewReducer(officeStore)
	notifier := dashboard.NewNotifier(officeStore, func(string, dashboard.RealtimeScope, json.RawMessage, time.Time) {}, func() time.Time {
		return integrationNow
	})
	api := httpapi.NewCollectorAPIWithOptions(httpapi.CollectorAPIOptions{
		Authenticator:     officeStore,
		Reducer:           reducer,
		Registrar:         officeStore,
		Now:               func() time.Time { return integrationNow },
		DashboardNotifier: notifier,
		AgentProvisioner:  agentProvisioner,
		AgentBinder:       officeStore,
	})
	handler := api.Handler()

	registerRec := httptest.NewRecorder()
	registerReq := httptest.NewRequest(http.MethodPost, "/api/v1/collector/register", jsonBody(t, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "FLOW-1234",
		AgentID:          "agent_http_1",
		DeviceName:       "mima-macbook",
		Hostname:         "mima.local",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
		Agents: []collectorapi.RegistrationAgent{{
			AgentType:   collectorapi.AgentTypeCodex,
			AgentID:     "agent_http_1",
			DisplayName: "Codex HTTP",
		}},
	}))
	handler.ServeHTTP(registerRec, registerReq)
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", registerRec.Code, registerRec.Body.String())
	}
	var registerResp collectorapi.RegistrationResponse
	if err := json.NewDecoder(registerRec.Body).Decode(&registerResp); err != nil {
		t.Fatal(err)
	}
	if registerResp.CollectorID == "" || registerResp.CollectorToken == "" || registerResp.DeviceID == "" {
		t.Fatalf("register resp missing ids: %#v", registerResp)
	}
	var registeredAgentCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mcp_agents WHERE agent_id = 'agent_http_1'`).Scan(&registeredAgentCount); err != nil {
		t.Fatal(err)
	}
	if registeredAgentCount != 0 {
		t.Fatalf("mcp agents after registration = %d, want 0", registeredAgentCount)
	}

	sentAt := integrationNow.Add(-5 * time.Second)
	heartbeatRec := httptest.NewRecorder()
	heartbeatReq := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", jsonBody(t, collectorapi.HeartbeatRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		CollectorID:      registerResp.CollectorID,
		DeviceID:         registerResp.DeviceID,
		SentAt:           sentAt,
		CollectorVersion: "0.1.1",
		Agents: []collectorapi.AgentSummary{{
			AgentID:          " agent_http_1 ",
			AgentType:        collectorapi.AgentTypeCodex,
			DisplayName:      "Codex HTTP",
			Version:          "1.2.3",
			Status:           collectorapi.StatusCoding,
			WorkspaceName:    "workspace-http",
			CurrentSessionID: "session_http_1",
			CurrentTurnID:    "turn_http_1",
			LastSeenAt:       sentAt,
		}},
	}))
	heartbeatReq.Header.Set("Authorization", "Bearer "+registerResp.CollectorToken)
	handler.ServeHTTP(heartbeatRec, heartbeatReq)
	if heartbeatRec.Code != http.StatusAccepted {
		t.Fatalf("heartbeat status = %d, body = %s", heartbeatRec.Code, heartbeatRec.Body.String())
	}

	var clientID, name, status, userID, mcpAgentID string
	if err := db.QueryRowContext(ctx, `
	SELECT a.client_id, a.name, a.status, aa.user_id, oa.mcp_agent_id
	FROM mcp_agents a
	JOIN account_agents aa ON aa.agent_id = a.agent_id
	JOIN office_agents oa ON oa.agent_id = a.agent_id
	WHERE a.agent_id = 'agent_http_1'
	`).Scan(&clientID, &name, &status, &userID, &mcpAgentID); err != nil {
		t.Fatal(err)
	}
	if clientID != "codex" || name != "owner_http_flow的Codex" || status != "active" || userID != "owner_http_flow" || mcpAgentID != "agent_http_1" {
		t.Fatalf("agent binding = client_id=%q name=%q status=%q user_id=%q mcp_agent_id=%q", clientID, name, status, userID, mcpAgentID)
	}

	eventTime := integrationNow.Add(-2 * time.Second)
	eventsRec := httptest.NewRecorder()
	eventsReq := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   registerResp.CollectorID,
		DeviceID:      registerResp.DeviceID,
		SentAt:        eventTime,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "event_session_1",
			EventType:  collectorapi.EventSessionStarted,
			OccurredAt: eventTime,
			AgentID:    "agent_http_1 ",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_http_1",
			Status:     collectorapi.StatusCoding,
			Session: &collectorapi.SessionSummary{
				SessionID:     "session_http_1",
				Status:        collectorapi.StatusCoding,
				Summary:       "Session summary",
				StartedAt:     eventTime,
				WorkspaceName: "workspace-http",
			},
		}, {
			EventID:    "event_turn_1",
			EventType:  collectorapi.EventTurnStarted,
			OccurredAt: eventTime.Add(100 * time.Millisecond),
			AgentID:    " agent_http_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_http_1",
			TurnID:     "turn_http_1",
			Status:     collectorapi.StatusCoding,
			Turn: &collectorapi.TurnSummary{
				TurnID:    "turn_http_1",
				SessionID: "session_http_1",
				Title:     "Fix review issue",
				Status:    collectorapi.StatusCoding,
				StartedAt: eventTime.Add(100 * time.Millisecond),
				UpdatedAt: eventTime.Add(100 * time.Millisecond),
			},
		}, {
			EventID:    "event_activity_1",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: eventTime.Add(200 * time.Millisecond),
			AgentID:    "agent_http_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_http_1",
			TurnID:     "turn_http_1",
			Status:     collectorapi.StatusRunningCommands,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "activity_http_1",
				SessionID:    "session_http_1",
				TurnID:       "turn_http_1",
				ActivityType: collectorapi.ActivityRunningCommands,
				Title:        "Run verification",
				Summary:      "go test ./internal/office/...",
				StartedAt:    eventTime.Add(200 * time.Millisecond),
			},
		}, {
			EventID:    "event_tool_1",
			EventType:  collectorapi.EventToolCallStarted,
			OccurredAt: eventTime.Add(300 * time.Millisecond),
			AgentID:    "  agent_http_1  ",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_http_1",
			TurnID:     "turn_http_1",
			Status:     collectorapi.StatusRunningCommands,
			ToolCall: &collectorapi.ToolCallSummary{
				ToolCallID: "tool_http_1",
				SessionID:  "session_http_1",
				TurnID:     "turn_http_1",
				ToolName:   "Bash",
				ToolType:   "command",
				Status:     "running",
				Input:      map[string]any{"command": "go test ./internal/office/..."},
				StartedAt:  eventTime.Add(300 * time.Millisecond),
			},
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "activity_http_1",
				SessionID:    "session_http_1",
				TurnID:       "turn_http_1",
				ToolCallID:   "tool_http_1",
				ActivityType: collectorapi.ActivityRunningCommands,
				Title:        "Run verification",
				Summary:      "go test ./internal/office/...",
				StartedAt:    eventTime.Add(200 * time.Millisecond),
			},
		}},
	}))
	eventsReq.Header.Set("Authorization", "Bearer "+registerResp.CollectorToken)
	handler.ServeHTTP(eventsRec, eventsReq)
	if eventsRec.Code != http.StatusAccepted {
		t.Fatalf("events status = %d, body = %s", eventsRec.Code, eventsRec.Body.String())
	}
	var eventsResp collectorapi.AcceptedResponse
	if err := json.NewDecoder(eventsRec.Body).Decode(&eventsResp); err != nil {
		t.Fatal(err)
	}
	if eventsResp.ReceivedEvents != 4 {
		t.Fatalf("received_events = %d", eventsResp.ReceivedEvents)
	}

	replayedEventsRec := httptest.NewRecorder()
	replayedEventsReq := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   registerResp.CollectorID,
		DeviceID:      registerResp.DeviceID,
		SentAt:        eventTime,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "event_session_1",
			EventType:  collectorapi.EventSessionStarted,
			OccurredAt: eventTime,
			AgentID:    " agent_http_1 ",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_http_1",
			Status:     collectorapi.StatusCoding,
			Session: &collectorapi.SessionSummary{
				SessionID:     "session_http_1",
				Status:        collectorapi.StatusCoding,
				Summary:       "Session summary",
				StartedAt:     eventTime,
				WorkspaceName: "workspace-http",
			},
		}},
	}))
	replayedEventsReq.Header.Set("Authorization", "Bearer "+registerResp.CollectorToken)
	handler.ServeHTTP(replayedEventsRec, replayedEventsReq)
	if replayedEventsRec.Code != http.StatusAccepted {
		t.Fatalf("replayed events status = %d, body = %s", replayedEventsRec.Code, replayedEventsRec.Body.String())
	}
	var mcpAgents, accountAgents, activeTokens int
	if err := db.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM mcp_agents WHERE agent_id = 'agent_http_1'),
  (SELECT COUNT(*) FROM account_agents WHERE agent_id = 'agent_http_1'),
	  (SELECT COUNT(*) FROM mcp_account_tokens WHERE user_id = 'owner_http_flow' AND status = 'active')
	`).Scan(&mcpAgents, &accountAgents, &activeTokens); err != nil {
		t.Fatal(err)
	}
	if mcpAgents != 1 || accountAgents != 1 || activeTokens != 0 {
		t.Fatalf("agent idempotency counts = mcp_agents=%d account_agents=%d active_tokens=%d, want 1/1/0", mcpAgents, accountAgents, activeTokens)
	}
	if err := db.QueryRowContext(ctx, `SELECT mcp_agent_id FROM office_agents WHERE agent_id = 'agent_http_1'`).Scan(&mcpAgentID); err != nil {
		t.Fatal(err)
	}
	if mcpAgentID != "agent_http_1" {
		t.Fatalf("mcp agent binding after replay = %q", mcpAgentID)
	}

	queryTime := integrationNow

	overview, err := officeStore.CollectorsOverview(ctx, queryTime, 60*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !overview.RegistrationCode.Exists || overview.RegistrationCode.Code != "FLOW-1234" {
		t.Fatalf("registration code = %#v", overview.RegistrationCode)
	}
	if overview.RegistrationCode.UsedCount != 1 {
		t.Fatalf("used_count = %d", overview.RegistrationCode.UsedCount)
	}
	if len(overview.Collectors) != 1 {
		t.Fatalf("collectors = %d", len(overview.Collectors))
	}
	if overview.Collectors[0].CollectorID != registerResp.CollectorID {
		t.Fatalf("collector_id = %q", overview.Collectors[0].CollectorID)
	}
	if overview.Collectors[0].Status != "online" {
		t.Fatalf("collector status = %q", overview.Collectors[0].Status)
	}

	snapshot, err := officeStore.OfficeSnapshot(ctx, queryTime)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Agents) != 1 {
		t.Fatalf("dashboard agents = %d", len(snapshot.Agents))
	}
	agent := snapshot.Agents[0]
	if agent.AgentID != "agent_http_1" {
		t.Fatalf("agent_id = %q", agent.AgentID)
	}
	if agent.Status != string(collectorapi.StatusRunningCommands) {
		t.Fatalf("agent status = %q", agent.Status)
	}
	if agent.CurrentSession == nil || agent.CurrentSession.SessionID != "session_http_1" {
		t.Fatalf("current session = %#v", agent.CurrentSession)
	}
	if agent.CurrentTurn == nil || agent.CurrentTurn.TurnID != "turn_http_1" {
		t.Fatalf("current turn = %#v", agent.CurrentTurn)
	}
	if len(snapshot.RecentFeed) == 0 {
		t.Fatal("recent feed is empty")
	}

	var tokenLastUsedAt sql.NullTime
	if err := db.QueryRowContext(ctx, `SELECT last_used_at FROM office_collector_tokens WHERE collector_id = $1`, registerResp.CollectorID).Scan(&tokenLastUsedAt); err != nil {
		t.Fatal(err)
	}
	if !tokenLastUsedAt.Valid {
		t.Fatal("collector token last_used_at is null")
	}

	var sourceEvents int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_agent_source_events WHERE collector_id = $1`, registerResp.CollectorID).Scan(&sourceEvents); err != nil {
		t.Fatal(err)
	}
	if sourceEvents != 4 {
		t.Fatalf("source events = %d", sourceEvents)
	}

}

func TestCollectorReRegistrationHTTPReusesOfficeAgentAndBinding(t *testing.T) {
	db := openHTTPCollectorIntegrationDB(t)
	ctx := context.Background()
	officeStore := storepkg.NewPostgresStore(db)
	resetHTTPCollectorIntegrationTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	if _, err := db.ExecContext(ctx, `
INSERT INTO accounts (user_id, email, name, password_hash, status, created_at, updated_at)
VALUES ('owner_reregister', 'owner_reregister@office-test.local', 'owner_reregister', 'test', 'active', now(), now())
ON CONFLICT (user_id) DO UPDATE SET status = 'active', updated_at = now()
`); err != nil {
		t.Fatal(err)
	}
	if err := officeStore.CreateOwnedRegistrationCode(ctx, "REREGISTER", "owner_reregister", "review", now, nil); err != nil {
		t.Fatal(err)
	}
	api := httpapi.NewCollectorAPIWithOptions(httpapi.CollectorAPIOptions{
		Authenticator: officeStore, Reducer: state.NewReducer(officeStore), Registrar: officeStore,
		Now: func() time.Time { return now },
	})
	handler := api.Handler()

	register := func(deviceName string) collectorapi.RegistrationResponse {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/register", jsonBody(t, collectorapi.RegistrationRequest{
			SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "REREGISTER", AgentID: "agent_reregister",
			DeviceName: deviceName, OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
		}))
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("register status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var resp collectorapi.RegistrationResponse
		if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
			t.Fatal(err)
		}
		return resp
	}
	heartbeat := func(resp collectorapi.RegistrationResponse, token string, wantStatus int) {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", jsonBody(t, collectorapi.HeartbeatRequest{
			SchemaVersion: collectorapi.SchemaVersion, CollectorID: resp.CollectorID, DeviceID: resp.DeviceID,
			SentAt: now, CollectorVersion: "0.1.0",
			Agents: []collectorapi.AgentSummary{{AgentID: "agent_reregister", AgentType: collectorapi.AgentTypeCodex, Status: collectorapi.StatusIdle, LastSeenAt: now}},
		}))
		req.Header.Set("Authorization", "Bearer "+token)
		handler.ServeHTTP(rec, req)
		if rec.Code != wantStatus {
			t.Fatalf("heartbeat status = %d, want %d, body = %s", rec.Code, wantStatus, rec.Body.String())
		}
	}

	first := register("first-device")
	heartbeat(first, first.CollectorToken, http.StatusAccepted)
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DELETE FROM mcp_agents WHERE agent_id = 'mcp_reregister'`)
	})
	if _, err := db.ExecContext(ctx, `INSERT INTO mcp_agents (agent_id, name, status, created_at, updated_at) VALUES ('mcp_reregister', 'mcp_reregister', 'active', $1, $1)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE office_agents SET mcp_agent_id = 'mcp_reregister' WHERE collector_id = $1 AND agent_id = 'agent_reregister'`, first.CollectorID); err != nil {
		t.Fatal(err)
	}

	second := register("second-device")
	if second.CollectorID != first.CollectorID || second.CollectorToken == first.CollectorToken || second.DeviceID == first.DeviceID {
		t.Fatalf("first=%#v second=%#v", first, second)
	}
	heartbeat(first, first.CollectorToken, http.StatusUnauthorized)
	heartbeat(second, second.CollectorToken, http.StatusAccepted)

	var officeAgents, collectors int
	var deviceID, mcpAgentID string
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*), MAX(device_id), MAX(mcp_agent_id) FROM office_agents WHERE collector_id = $1 AND agent_id = 'agent_reregister'`, first.CollectorID).Scan(&officeAgents, &deviceID, &mcpAgentID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_collector_tokens WHERE agent_id = 'agent_reregister'`).Scan(&collectors); err != nil {
		t.Fatal(err)
	}
	if officeAgents != 1 || collectors != 1 || deviceID != second.DeviceID || mcpAgentID != "mcp_reregister" {
		t.Fatalf("office_agents=%d collectors=%d device=%q mcp_agent=%q", officeAgents, collectors, deviceID, mcpAgentID)
	}
}

func TestCollectorHeartbeatRejectsUnownedLegacyTokenBeforeWrites(t *testing.T) {
	db := openHTTPCollectorIntegrationDB(t)
	ctx := context.Background()
	officeStore := storepkg.NewPostgresStore(db)
	resetHTTPCollectorIntegrationTables(t, ctx, db)
	pool := openHTTPCollectorIntegrationPool(t, ctx)
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewPostgresStore(pool)})
	tokenCipher, err := mcpgateway.NewTokenCipher([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	proxyGateway := mcpgateway.NewService(mcpgateway.Config{
		Store:       store.NewMCPGatewayStore(pool),
		TokenCipher: tokenCipher,
	})
	if _, err := db.ExecContext(ctx, `
INSERT INTO office_collector_tokens (collector_id, token_hash, device_label)
VALUES ('collector_legacy', $1, 'legacy')
`, auth.HashToken("legacy-token")); err != nil {
		t.Fatal(err)
	}

	api := httpapi.NewCollectorAPIWithOptions(httpapi.CollectorAPIOptions{
		Authenticator:    officeStore,
		Reducer:          state.NewReducer(officeStore),
		Now:              func() time.Time { return integrationNow },
		AgentProvisioner: agentprovisioning.NewService(accountSvc, proxyGateway),
		AgentBinder:      officeStore,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", jsonBody(t, collectorapi.HeartbeatRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_legacy",
		DeviceID:      "device_legacy",
		Agents: []collectorapi.AgentSummary{{
			AgentID: "legacy_unowned_agent", AgentType: collectorapi.AgentTypeCodex,
			Status: collectorapi.StatusIdle, LastSeenAt: integrationNow,
		}},
	}))
	req.Header.Set("Authorization", "Bearer legacy-token")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"unauthorized"`) {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	for table, query := range map[string]string{
		"mcp_agents":     `SELECT COUNT(*) FROM mcp_agents WHERE agent_id = 'legacy_unowned_agent'`,
		"account_agents": `SELECT COUNT(*) FROM account_agents WHERE agent_id = 'legacy_unowned_agent'`,
		"office_agents":  `SELECT COUNT(*) FROM office_agents WHERE collector_id = 'collector_legacy'`,
	} {
		var count int
		if err := db.QueryRowContext(ctx, query).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s rows = %d, want 0", table, count)
		}
	}
	var lastUsedAt sql.NullTime
	if err := db.QueryRowContext(ctx, `
SELECT last_used_at FROM office_collector_tokens WHERE collector_id = 'collector_legacy'
`).Scan(&lastUsedAt); err != nil {
		t.Fatal(err)
	}
	if lastUsedAt.Valid {
		t.Fatalf("last_used_at = %s, want NULL", lastUsedAt.Time)
	}
}

func openHTTPCollectorIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn, err := httpCollectorIntegrationDatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置，跳过破坏性 Postgres 集成测试")
	}
	dsn = testpostgres.New(t)
	t.Setenv("CLAW_MCP_TEST_DATABASE_URL", dsn)
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		t.Fatalf("test database unavailable: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func openHTTPCollectorIntegrationPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	dsn, err := httpCollectorIntegrationDatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestHTTPCollectorIntegrationDatabaseURLRequiresTestDatabase(t *testing.T) {
	originalValue, hadOriginal := os.LookupEnv("CLAW_MCP_TEST_DATABASE_URL")
	if hadOriginal {
		t.Cleanup(func() { _ = os.Setenv("CLAW_MCP_TEST_DATABASE_URL", originalValue) })
	} else {
		t.Cleanup(func() { _ = os.Unsetenv("CLAW_MCP_TEST_DATABASE_URL") })
	}

	if err := os.Setenv("CLAW_MCP_TEST_DATABASE_URL", "postgres://claw_mcp:pass@localhost:5932/claw_mcp?sslmode=disable"); err != nil {
		t.Fatal(err)
	}
	_, err := httpCollectorIntegrationDatabaseURL()
	if err == nil {
		t.Fatal("httpCollectorIntegrationDatabaseURL() err = nil, want error")
	}
	msg := err.Error()
	for _, fragment := range []string{"CLAW_MCP_TEST_DATABASE_URL", "_test", "claw_mcp"} {
		if !strings.Contains(msg, fragment) {
			t.Fatalf("error %q does not contain %q", msg, fragment)
		}
	}

	if err := os.Setenv("CLAW_MCP_TEST_DATABASE_URL", "postgres://claw_mcp:pass@localhost:5933/claw_mcp_test?sslmode=disable"); err != nil {
		t.Fatal(err)
	}
	dsn, err := httpCollectorIntegrationDatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dsn, "claw_mcp_test") {
		t.Fatalf("dsn = %q, want test database", dsn)
	}
}

func httpCollectorIntegrationDatabaseURL() (string, error) {
	dsn, ok := os.LookupEnv("CLAW_MCP_TEST_DATABASE_URL")
	if !ok {
		return "", nil
	}
	dsn = strings.TrimSpace(dsn)
	if dsn == "" {
		return "", nil
	}
	dbName, err := httpCollectorIntegrationDatabaseNameFromDSN(dsn)
	if err != nil {
		return "", err
	}
	if !strings.HasSuffix(dbName, "_test") {
		return "", fmt.Errorf("CLAW_MCP_TEST_DATABASE_URL database name %q must end with _test", dbName)
	}
	return dsn, nil
}

func httpCollectorIntegrationDatabaseNameFromDSN(dsn string) (string, error) {
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" {
		return "", fmt.Errorf("CLAW_MCP_TEST_DATABASE_URL is invalid and database name must end with _test")
	}
	dbName := strings.TrimPrefix(parsed.Path, "/")
	if dbName == "" {
		return "", fmt.Errorf("CLAW_MCP_TEST_DATABASE_URL database name %q must end with _test", dbName)
	}
	return dbName, nil
}

func resetHTTPCollectorIntegrationTables(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `TRUNCATE office_agents, office_collector_tokens, office_collector_registration_codes CASCADE`); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`DELETE FROM mcp_account_tokens WHERE user_id = 'owner_http_flow'`,
		`DELETE FROM account_agents WHERE agent_id IN ('agent_http_1', 'legacy_unowned_agent')`,
		`DELETE FROM mcp_agents WHERE agent_id IN ('agent_http_1', 'legacy_unowned_agent')`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
}

func applyHTTPCollectorIntegrationMigration(t *testing.T, ctx context.Context, db *sql.DB, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	up := string(raw)
	if i := strings.Index(up, "\n-- +goose Down"); i >= 0 {
		up = up[:i]
	}
	up = strings.Replace(up, "-- +goose Up\n", "", 1)
	if _, err := db.ExecContext(ctx, up); err != nil {
		t.Fatalf("apply migration %s: %v", path, err)
	}
}

func jsonBody(t *testing.T, payload any) *bytes.Reader {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(body)
}

func timePtr(ts time.Time) *time.Time {
	return &ts
}
