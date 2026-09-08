package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/state"
)

func TestBindMCPAgentLinksSameOwnerAndCollectorUpsertKeepsLink(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	seedGovernanceAgents(t, ctx, db, "owner_link", "collector_link", "office_link", "mcp_link")

	if err := store.BindMCPAgent(ctx, "collector_link", "office_link", "mcp_link", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: "collector_link",
		AgentID:     "office_link",
		DeviceID:    "device_link",
		AgentType:   "codex",
		Status:      "idle",
		LastSeenAt:  time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	var linked string
	if err := db.QueryRowContext(ctx, `SELECT mcp_agent_id FROM office_agents WHERE collector_id = 'collector_link' AND agent_id = 'office_link'`).Scan(&linked); err != nil {
		t.Fatal(err)
	}
	if linked != "mcp_link" {
		t.Fatalf("mcp_agent_id = %q, want mcp_link", linked)
	}
}

func TestBindMCPAgentRejectsDifferentOwners(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	seedGovernanceAgents(t, ctx, db, "owner_office", "collector_owner", "office_owner", "mcp_owner")
	ensureOfficeTestAccount(t, ctx, db, "owner_mcp")
	if _, err := db.ExecContext(ctx, `UPDATE account_agents SET user_id = 'owner_mcp' WHERE agent_id = 'mcp_owner'`); err != nil {
		t.Fatal(err)
	}

	err := store.BindMCPAgent(ctx, "collector_owner", "office_owner", "mcp_owner", time.Now().UTC())
	if !errors.Is(err, management.ErrAgentOwnerMismatch) {
		t.Fatalf("BindMCPAgent error = %v, want ErrAgentOwnerMismatch", err)
	}
}

func TestBindMCPAgentRejectsMCPIdentityAlreadyLinkedElsewhere(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	seedGovernanceAgents(t, ctx, db, "owner_reuse", "collector_reuse", "office_first", "mcp_reuse")
	if _, err := db.ExecContext(ctx, `
INSERT INTO office_agents (collector_id, agent_id, device_id, agent_type, status, last_seen_at)
VALUES ('collector_reuse', 'office_second', 'device_reuse', 'codex', 'idle', now())
`); err != nil {
		t.Fatal(err)
	}
	if err := store.BindMCPAgent(ctx, "collector_reuse", "office_first", "mcp_reuse", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	err := store.BindMCPAgent(ctx, "collector_reuse", "office_second", "mcp_reuse", time.Now().UTC())
	if !errors.Is(err, management.ErrMCPAgentAlreadyBound) {
		t.Fatalf("BindMCPAgent error = %v, want ErrMCPAgentAlreadyBound", err)
	}
}

func TestUnbindMCPAgentKeepsBothAgents(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	seedGovernanceAgents(t, ctx, db, "owner_unlink", "collector_unlink", "office_unlink", "mcp_unlink")
	if err := store.BindMCPAgent(ctx, "collector_unlink", "office_unlink", "mcp_unlink", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	if err := store.UnbindMCPAgent(ctx, "collector_unlink", "office_unlink", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	var officeCount, mcpCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_agents WHERE collector_id = 'collector_unlink' AND agent_id = 'office_unlink' AND mcp_agent_id IS NULL`).Scan(&officeCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mcp_agents WHERE agent_id = 'mcp_unlink'`).Scan(&mcpCount); err != nil {
		t.Fatal(err)
	}
	if officeCount != 1 || mcpCount != 1 {
		t.Fatalf("counts after unbind = office:%d mcp:%d, want 1/1", officeCount, mcpCount)
	}
}

func TestDeleteOfficeAgentRemovesOnlyUnboundAgentState(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 7, 10, 0, 0, 0, time.UTC)

	for _, agentID := range []string{"delete_agent", "keep_agent"} {
		if err := store.UpsertAgent(ctx, state.AgentState{
			CollectorID: "collector_delete_agent", AgentID: agentID, DeviceID: "device_test",
			AgentType: "codex", Status: "offline", LastSeenAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.UpsertSession(ctx, state.SessionState{CollectorID: "collector_delete_agent", AgentID: "delete_agent", SessionID: "session_delete", Status: "idle", StartedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: "collector_delete_agent", AgentID: "delete_agent", TurnID: "turn_delete", SessionID: "session_delete", Status: "idle", StartedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSubAgent(ctx, state.SubAgentState{CollectorID: "collector_delete_agent", ParentAgentID: "delete_agent", SubAgentID: "sub_delete", Status: "idle", StartedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertActivity(ctx, state.ActivityState{CollectorID: "collector_delete_agent", AgentID: "delete_agent", ActivityID: "activity_delete", ActivityType: "coding", Status: "idle", StartedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertToolCall(ctx, state.ToolCallState{CollectorID: "collector_delete_agent", AgentID: "delete_agent", ToolCallID: "tool_delete", ToolName: "test", Status: "completed", StartedAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplySourceEvent(ctx, state.SourceEventState{
		CollectorID: "collector_delete_agent", SourceEventID: "event_delete", StandardEventType: "turn.updated",
		AgentID: "delete_agent", OccurredAt: now, ReceivedAt: now,
	}, func(context.Context, state.Store) error { return nil }); err != nil {
		t.Fatal(err)
	}

	if err := store.DeleteOfficeAgent(ctx, "collector_delete_agent", "delete_agent"); err != nil {
		t.Fatal(err)
	}

	queries := []string{
		`SELECT COUNT(*) FROM office_agents WHERE collector_id = $1 AND agent_id = $2`,
		`SELECT COUNT(*) FROM office_agent_sessions WHERE collector_id = $1 AND agent_id = $2`,
		`SELECT COUNT(*) FROM office_agent_turns WHERE collector_id = $1 AND agent_id = $2`,
		`SELECT COUNT(*) FROM office_agent_sub_agents WHERE collector_id = $1 AND parent_agent_id = $2`,
		`SELECT COUNT(*) FROM office_agent_activities WHERE collector_id = $1 AND agent_id = $2`,
		`SELECT COUNT(*) FROM office_agent_tool_calls WHERE collector_id = $1 AND agent_id = $2`,
		`SELECT COUNT(*) FROM office_agent_source_events WHERE collector_id = $1 AND agent_id = $2`,
	}
	for _, query := range queries {
		var count int
		if err := db.QueryRowContext(ctx, query, "collector_delete_agent", "delete_agent").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("deleted agent scoped row count = %d, want 0 for query %q", count, query)
		}
	}
	var keptCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_agents WHERE collector_id = $1 AND agent_id = $2`, "collector_delete_agent", "keep_agent").Scan(&keptCount); err != nil {
		t.Fatal(err)
	}
	if keptCount != 1 {
		t.Fatalf("kept agent count = %d, want 1", keptCount)
	}
}

func TestDeleteOfficeAgentRejectsBoundAgent(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	seedGovernanceAgents(t, ctx, db, "owner_delete_bound", "collector_delete_bound", "office_delete_bound", "mcp_delete_bound")
	if err := store.BindMCPAgent(ctx, "collector_delete_bound", "office_delete_bound", "mcp_delete_bound", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	err := store.DeleteOfficeAgent(ctx, "collector_delete_bound", "office_delete_bound")
	if !errors.Is(err, management.ErrOfficeAgentBound) {
		t.Fatalf("DeleteOfficeAgent error = %v, want %v", err, management.ErrOfficeAgentBound)
	}
}

func TestFindAgentCollectorReturnsLinkedCollectorAndDevice(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	seedGovernanceAgents(t, ctx, db, "owner_info", "collector_info", "office_info", "mcp_info")

	registeredAt := time.Date(2026, 8, 5, 9, 0, 0, 0, time.UTC)
	lastSeenAt := registeredAt.Add(time.Minute)
	if _, err := db.ExecContext(ctx, `
INSERT INTO office_collector_registrations (
	registration_id, registration_code_hash, collector_id, device_id, device_name,
	hostname, os, arch, collector_version, registered_agent_ids, registered_at
)
VALUES ('registration_info', 'registration_info_hash', 'collector_info', 'device_test',
	'MacBook Pro', 'macbook.local', 'darwin', 'arm64', '0.1.0', '["office_info"]'::jsonb, $1)
`, registeredAt); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertDevice(ctx, state.DeviceHeartbeat{
		CollectorID:      "collector_info",
		DeviceID:         "device_test",
		CollectorVersion: "0.1.1",
		LastSeenAt:       lastSeenAt,
	}); err != nil {
		t.Fatal(err)
	}
	collectorLastSeenAt := lastSeenAt.Add(time.Minute)
	if err := store.UpsertDevice(ctx, state.DeviceHeartbeat{
		CollectorID:      "collector_info",
		DeviceID:         "device_latest",
		CollectorVersion: "0.2.0",
		LastSeenAt:       collectorLastSeenAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.BindMCPAgent(ctx, "collector_info", "office_info", "mcp_info", lastSeenAt); err != nil {
		t.Fatal(err)
	}

	info, ok, err := store.FindAgentCollector(ctx, "mcp_info", collectorLastSeenAt.Add(30*time.Second), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("FindAgentCollector() did not find linked collector")
	}
	if info.CollectorID != "collector_info" || info.OfficeAgentID != "office_info" || info.DeviceID != "device_test" || info.DeviceName != "MacBook Pro" || info.Hostname != "macbook.local" || info.OS != "darwin" || info.Arch != "arm64" || info.CollectorVersion != "0.1.1" {
		t.Fatalf("collector info = %#v", info)
	}
	if info.LastSeenAt == nil || !info.LastSeenAt.Equal(collectorLastSeenAt) {
		t.Fatalf("LastSeenAt = %v, want %v", info.LastSeenAt, collectorLastSeenAt)
	}
	if info.Status != management.CollectorStatusOnline {
		t.Fatalf("Status = %q, want %q", info.Status, management.CollectorStatusOnline)
	}
}

func seedGovernanceAgents(t *testing.T, ctx context.Context, db *sql.DB, ownerID, collectorID, officeAgentID, mcpAgentID string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := db.ExecContext(context.Background(), `DELETE FROM mcp_agents WHERE agent_id = $1`, mcpAgentID); err != nil {
			t.Errorf("cleanup MCP agent %q: %v", mcpAgentID, err)
		}
	})
	ensureOfficeTestAccount(t, ctx, db, ownerID)
	if _, err := db.ExecContext(ctx, `DELETE FROM mcp_agents WHERE agent_id = $1`, mcpAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO office_collector_tokens (collector_id, token_hash, device_label, user_id)
VALUES ($1, $1 || '_hash', 'test device', $2)
`, collectorID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO office_agents (collector_id, agent_id, device_id, agent_type, display_name, status, last_seen_at)
VALUES ($1, $2, 'device_test', 'codex', $2, 'idle', now())
`, collectorID, officeAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO mcp_agents (agent_id, name, status, created_at, updated_at)
VALUES ($1, $1, 'active', now(), now())
`, mcpAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO account_agents (user_id, agent_id, created_at)
VALUES ($1, $2, now())
`, ownerID, mcpAgentID); err != nil {
		t.Fatal(err)
	}
}
