package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/krillinai/Clawee/server/internal/office/auth"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/registration"
	"github.com/krillinai/Clawee/server/internal/office/state"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
)

func TestGenerateCollectorDeviceIDKeepsCodexAgentIDCompact(t *testing.T) {
	deviceID, err := generateCollectorDeviceID()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(deviceID, "device_") || len(deviceID) != len("device_")+16 {
		t.Fatalf("device_id = %q, want device_ plus 16 hex characters", deviceID)
	}
	if agentID := "codex:" + deviceID + ":main"; len(agentID) != 34 {
		t.Fatalf("agent_id length = %d, want 34: %q", len(agentID), agentID)
	}
}

func TestPostgresStoreRegistrationAndCollectorFlow(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	registeredAt := time.Date(2026, 6, 3, 10, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "owner_flow")
	if err := store.CreateOwnedRegistrationCode(ctx, "ABCD-1234", "owner_flow", "admin", registeredAt, ptrTime(registeredAt.Add(10*time.Minute))); err != nil {
		t.Fatal(err)
	}

	resp, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "ABCD-1234",
		AgentID:          "agent_same",
		DeviceName:       "mima-macbook",
		Hostname:         "mima-macbook.local",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
		Agents: []collectorapi.RegistrationAgent{{
			AgentType:   collectorapi.AgentTypeCodex,
			AgentID:     "codex-local-001",
			DisplayName: "Codex Local",
		}},
	}, registeredAt)
	if err != nil {
		t.Fatal(err)
	}
	if resp.CollectorID == "" || resp.CollectorToken == "" || resp.DeviceID == "" {
		t.Fatalf("registration response missing ids: %#v", resp)
	}
	if resp.PrivacyMode != "summary_only" {
		t.Fatalf("privacy_mode = %q", resp.PrivacyMode)
	}

	identity, ok, err := store.Authenticate(ctx, resp.CollectorToken)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || identity.CollectorID != resp.CollectorID {
		t.Fatalf("identity=%#v ok=%v", identity, ok)
	}

	receivedAt := registeredAt.Add(2 * time.Second)
	if err := store.UpsertDevice(ctx, state.DeviceHeartbeat{
		CollectorID:      resp.CollectorID,
		DeviceID:         resp.DeviceID,
		CollectorVersion: "0.1.1",
		LastSeenAt:       receivedAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: "collector_2",
		DeviceID:    "device_2",
		AgentID:     "agent_same",
		AgentType:   collectorapi.AgentTypeCodex,
		Status:      collectorapi.StatusCoding,
		LastSeenAt:  receivedAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: resp.CollectorID,
		DeviceID:    resp.DeviceID,
		AgentID:     "agent_same",
		AgentType:   collectorapi.AgentTypeCodex,
		Status:      collectorapi.StatusThinking,
		LastSeenAt:  receivedAt,
		Metadata:    map[string]string{"safe": "value"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(ctx, state.SessionState{
		CollectorID: resp.CollectorID,
		AgentID:     "agent_same",
		SessionID:   "sess_1",
		Status:      collectorapi.StatusThinking,
		StartedAt:   receivedAt,
		UpdatedAt:   receivedAt,
	}); err != nil {
		t.Fatal(err)
	}

	inserted, err := store.ApplySourceEvent(ctx, state.SourceEventState{
		CollectorID:       resp.CollectorID,
		SourceEventID:     "src_1",
		SourceType:        "codex",
		SourceEventType:   "PreToolUse",
		StandardEventType: collectorapi.EventToolCallStarted,
		AgentID:           "agent_same",
		SessionID:         "sess_1",
		TurnID:            "turn_1",
		ToolCallID:        "tool_1",
		OccurredAt:        receivedAt,
		ReceivedAt:        receivedAt,
		RawPayload:        []byte(`{"hook_event_name":"PreToolUse"}`),
		StandardPayload:   []byte(`{"event_id":"src_1"}`),
		ParseStatus:       "parsed",
	}, func(context.Context, state.Store) error {
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !inserted {
		t.Fatal("first source event insert should be inserted")
	}

	callbackCalled := false
	inserted, err = store.ApplySourceEvent(ctx, state.SourceEventState{
		CollectorID:       resp.CollectorID,
		SourceEventID:     "src_1",
		SourceType:        "codex",
		SourceEventType:   "PreToolUse",
		StandardEventType: collectorapi.EventToolCallStarted,
		AgentID:           "agent_same",
		OccurredAt:        receivedAt,
		ReceivedAt:        receivedAt,
		RawPayload:        []byte(`{"hook_event_name":"PreToolUse"}`),
		StandardPayload:   []byte(`{"event_id":"src_1"}`),
		ParseStatus:       "parsed",
	}, func(context.Context, state.Store) error {
		callbackCalled = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if inserted {
		t.Fatal("duplicate source event should not be inserted")
	}
	if callbackCalled {
		t.Fatal("duplicate source event should not call callback")
	}

	retryErr := errors.New("retry reducer failed")
	inserted, err = store.ApplySourceEvent(ctx, state.SourceEventState{
		CollectorID:       resp.CollectorID,
		SourceEventID:     "src_retry",
		SourceType:        "codex",
		SourceEventType:   "UserPromptSubmit",
		StandardEventType: collectorapi.EventTurnUpdated,
		AgentID:           "agent_same",
		OccurredAt:        receivedAt,
		ReceivedAt:        receivedAt,
		RawPayload:        []byte(`{"hook_event_name":"UserPromptSubmit"}`),
		StandardPayload:   []byte(`{"event_id":"src_retry"}`),
		ParseStatus:       "parsed",
	}, func(context.Context, state.Store) error {
		return retryErr
	})
	if !errors.Is(err, retryErr) {
		t.Fatalf("err = %v, want %v", err, retryErr)
	}
	if inserted {
		t.Fatal("failed callback should not report inserted")
	}

	inserted, err = store.ApplySourceEvent(ctx, state.SourceEventState{
		CollectorID:       resp.CollectorID,
		SourceEventID:     "src_retry",
		SourceType:        "codex",
		SourceEventType:   "UserPromptSubmit",
		StandardEventType: collectorapi.EventTurnUpdated,
		AgentID:           "agent_same",
		OccurredAt:        receivedAt,
		ReceivedAt:        receivedAt,
		RawPayload:        []byte(`{"hook_event_name":"UserPromptSubmit"}`),
		StandardPayload:   []byte(`{"event_id":"src_retry"}`),
		ParseStatus:       "parsed",
	}, func(ctx context.Context, txStore state.Store) error {
		return txStore.UpsertTurn(ctx, state.TurnState{
			CollectorID: resp.CollectorID,
			AgentID:     "agent_same",
			TurnID:      "turn_1",
			SessionID:   "sess_1",
			Status:      collectorapi.StatusCoding,
			StartedAt:   receivedAt,
			UpdatedAt:   receivedAt,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !inserted {
		t.Fatal("retry after rollback should be inserted")
	}

	if err := store.UpsertToolCall(ctx, state.ToolCallState{
		CollectorID:        resp.CollectorID,
		AgentID:            "agent_same",
		ToolCallID:         "tool_1",
		ExternalToolCallID: "call_1",
		SessionID:          "sess_1",
		TurnID:             "turn_1",
		ToolName:           "Bash",
		ToolType:           "command",
		Status:             "running",
		Input:              []byte(`{"command":"git status --short --branch"}`),
		StartedAt:          receivedAt,
		SourceEventStartID: "src_1",
		Metadata:           map[string]string{"command_category": "git_command"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertActivity(ctx, state.ActivityState{
		CollectorID:  resp.CollectorID,
		ActivityID:   "act_1",
		AgentID:      "agent_same",
		SessionID:    "sess_1",
		TurnID:       "turn_1",
		ToolCallID:   "tool_1",
		ActivityType: collectorapi.ActivityRunningCommands,
		Status:       collectorapi.StatusRunningCommands,
		Title:        "Running git command",
		StartedAt:    receivedAt,
		Metadata:     map[string]string{"tool_name": "Bash"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkOffline(ctx, receivedAt.Add(91*time.Second), 90*time.Second); err != nil {
		t.Fatal(err)
	}

	var status string
	if err := db.QueryRowContext(ctx, `SELECT status FROM office_agents WHERE collector_id = $1 AND agent_id = $2`, resp.CollectorID, "agent_same").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != string(collectorapi.StatusOffline) {
		t.Fatalf("status = %s", status)
	}

	secondResp, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "ABCD-1234",
		AgentID:          "agent_same",
		DeviceName:       "replacement-device",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
	}, registeredAt.Add(time.Second))
	if err != nil {
		t.Fatalf("second registration: %v", err)
	}
	if secondResp.CollectorID != resp.CollectorID {
		t.Fatalf("second collector id = %q, want %q", secondResp.CollectorID, resp.CollectorID)
	}
	if secondResp.CollectorToken == resp.CollectorToken || secondResp.DeviceID == resp.DeviceID {
		t.Fatalf("re-registration did not rotate credentials: first=%#v second=%#v", resp, secondResp)
	}
	var lastUsedAt, revokedAt sql.NullTime
	var deviceLabel, agentID string
	if err := db.QueryRowContext(ctx, `
SELECT last_used_at, revoked_at, device_label, agent_id
FROM office_collector_tokens
WHERE collector_id = $1
`, resp.CollectorID).Scan(&lastUsedAt, &revokedAt, &deviceLabel, &agentID); err != nil {
		t.Fatal(err)
	}
	if lastUsedAt.Valid || revokedAt.Valid || deviceLabel != "replacement-device" || agentID != "agent_same" {
		t.Fatalf("rotated collector row = last_used=%v revoked=%v label=%q agent=%q", lastUsedAt.Valid, revokedAt.Valid, deviceLabel, agentID)
	}
	if _, ok, err := store.Authenticate(ctx, resp.CollectorToken); err != nil || ok {
		t.Fatalf("old token authentication = ok=%v err=%v", ok, err)
	}
	if identity, ok, err := store.Authenticate(ctx, secondResp.CollectorToken); err != nil || !ok || identity.CollectorID != resp.CollectorID {
		t.Fatalf("new token authentication = identity=%#v ok=%v err=%v", identity, ok, err)
	}
	var collectorCount, registrationCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_collector_tokens WHERE agent_id = 'agent_same'`).Scan(&collectorCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_collector_registrations WHERE collector_id = $1`, resp.CollectorID).Scan(&registrationCount); err != nil {
		t.Fatal(err)
	}
	if collectorCount != 1 || registrationCount != 2 {
		t.Fatalf("collector rows=%d registration rows=%d, want 1 and 2", collectorCount, registrationCount)
	}

	var usedCount int
	if err := db.QueryRowContext(ctx, `
SELECT used_count FROM office_collector_registration_codes WHERE registration_code_hash = $1
`, auth.HashToken("ABCD-1234")).Scan(&usedCount); err != nil {
		t.Fatal(err)
	}
	if usedCount != 2 {
		t.Fatalf("used_count = %d, want 2", usedCount)
	}

	assertOfficeCollectorIsolation(t, ctx, db, store, resp, receivedAt)
}

func TestPostgresStoreRegisterCollectorRestoresRevokedCollector(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "owner_restore")
	if err := store.CreateOwnedRegistrationCode(ctx, "RESTORE", "owner_restore", "admin", now, nil); err != nil {
		t.Fatal(err)
	}
	first, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "RESTORE", AgentID: "agent_restore",
		OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE office_collector_tokens SET revoked_at = $2 WHERE collector_id = $1`, first.CollectorID, now); err != nil {
		t.Fatal(err)
	}
	second, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "RESTORE", AgentID: "agent_restore",
		OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.1",
	}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if second.CollectorID != first.CollectorID {
		t.Fatalf("collector id = %q, want %q", second.CollectorID, first.CollectorID)
	}
	var revokedAt sql.NullTime
	if err := db.QueryRowContext(ctx, `SELECT revoked_at FROM office_collector_tokens WHERE collector_id = $1`, first.CollectorID).Scan(&revokedAt); err != nil {
		t.Fatal(err)
	}
	if revokedAt.Valid {
		t.Fatalf("revoked_at = %s, want NULL", revokedAt.Time)
	}
}

func TestPostgresStoreRegisterCollectorRejectsAgentOwnedByAnotherAccount(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "owner_a")
	ensureOfficeTestAccount(t, ctx, db, "owner_b")
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DELETE FROM mcp_agents WHERE agent_id = 'agent_owned_b'`)
	})
	if _, err := db.ExecContext(ctx, `INSERT INTO mcp_agents (agent_id, name, status, created_at, updated_at) VALUES ('agent_owned_b', 'agent_owned_b', 'active', $1, $1)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO account_agents (user_id, agent_id, created_at) VALUES ('owner_b', 'agent_owned_b', $1)`, now); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOwnedRegistrationCode(ctx, "OWNER-A", "owner_a", "admin", now, nil); err != nil {
		t.Fatal(err)
	}
	_, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "OWNER-A", AgentID: "agent_owned_b",
		OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
	}, now)
	if !errors.Is(err, registration.ErrAgentIDConflict) {
		t.Fatalf("err = %v, want %v", err, registration.ErrAgentIDConflict)
	}
	var collectorCount, usedCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_collector_tokens WHERE agent_id = 'agent_owned_b'`).Scan(&collectorCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT used_count FROM office_collector_registration_codes WHERE registration_code_hash = $1`, auth.HashToken("OWNER-A")).Scan(&usedCount); err != nil {
		t.Fatal(err)
	}
	if collectorCount != 0 || usedCount != 0 {
		t.Fatalf("collector rows=%d used_count=%d, want 0 and 0", collectorCount, usedCount)
	}
}

func TestPostgresStoreRegisterCollectorRejectsCollectorOwnedByAnotherAccountWithoutRotatingToken(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "collector_owner_a")
	ensureOfficeTestAccount(t, ctx, db, "collector_owner_b")
	if err := store.CreateOwnedRegistrationCode(ctx, "COLLECTOR-A", "collector_owner_a", "admin", now, nil); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOwnedRegistrationCode(ctx, "COLLECTOR-B", "collector_owner_b", "admin", now, nil); err != nil {
		t.Fatal(err)
	}
	first, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "COLLECTOR-A", AgentID: "agent_collector_owner",
		OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "COLLECTOR-B", AgentID: "agent_collector_owner",
		OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
	}, now.Add(time.Minute))
	if !errors.Is(err, registration.ErrAgentIDConflict) {
		t.Fatalf("err = %v, want %v", err, registration.ErrAgentIDConflict)
	}
	identity, ok, err := store.Authenticate(ctx, first.CollectorToken)
	if err != nil || !ok || identity.CollectorID != first.CollectorID {
		t.Fatalf("original token authentication = identity=%#v ok=%v err=%v", identity, ok, err)
	}
	var usedCount int
	if err := db.QueryRowContext(ctx, `SELECT used_count FROM office_collector_registration_codes WHERE registration_code_hash = $1`, auth.HashToken("COLLECTOR-B")).Scan(&usedCount); err != nil {
		t.Fatal(err)
	}
	if usedCount != 0 {
		t.Fatalf("conflicting registration used_count = %d, want 0", usedCount)
	}
}

func TestCollectorAgentUniqueViolationMapping(t *testing.T) {
	if !isCollectorAgentUniqueViolation(&pgconn.PgError{Code: "23505", ConstraintName: "uq_office_collector_tokens_agent"}) {
		t.Fatal("collector agent unique violation was not recognized")
	}
	if isCollectorAgentUniqueViolation(&pgconn.PgError{Code: "23505", ConstraintName: "other_constraint"}) {
		t.Fatal("unrelated unique violation was recognized")
	}
}

func TestPostgresStoreConcurrentRegistrationKeepsSingleCollector(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "owner_concurrent")
	if err := store.CreateOwnedRegistrationCode(ctx, "CONCURRENT", "owner_concurrent", "admin", now, nil); err != nil {
		t.Fatal(err)
	}

	type result struct {
		resp collectorapi.RegistrationResponse
		err  error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for range 2 {
		go func() {
			ready.Done()
			<-start
			resp, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
				SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "CONCURRENT", AgentID: "agent_concurrent",
				OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
			}, now)
			results <- result{resp: resp, err: err}
		}()
	}
	ready.Wait()
	close(start)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("registration errors = %v, %v", first.err, second.err)
	}
	if first.resp.CollectorID != second.resp.CollectorID {
		t.Fatalf("collector ids = %q, %q", first.resp.CollectorID, second.resp.CollectorID)
	}
	validTokens := 0
	for _, token := range []string{first.resp.CollectorToken, second.resp.CollectorToken} {
		if _, ok, err := store.Authenticate(ctx, token); err != nil {
			t.Fatal(err)
		} else if ok {
			validTokens++
		}
	}
	if validTokens != 1 {
		t.Fatalf("valid tokens = %d, want 1", validTokens)
	}
	var collectors, registrations int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_collector_tokens WHERE agent_id = 'agent_concurrent'`).Scan(&collectors); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_collector_registrations WHERE collector_id = $1`, first.resp.CollectorID).Scan(&registrations); err != nil {
		t.Fatal(err)
	}
	if collectors != 1 || registrations != 2 {
		t.Fatalf("collectors=%d registrations=%d, want 1 and 2", collectors, registrations)
	}
}

func TestPostgresStoreConcurrentCrossAccountRegistrationMapsUniqueConflict(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "owner_race_a")
	ensureOfficeTestAccount(t, ctx, db, "owner_race_b")
	if err := store.CreateOwnedRegistrationCode(ctx, "RACE-A", "owner_race_a", "admin", now, nil); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOwnedRegistrationCode(ctx, "RACE-B", "owner_race_b", "admin", now, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
CREATE OR REPLACE FUNCTION test_delay_collector_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_sleep(0.2);
    RETURN NEW;
END $$;
CREATE TRIGGER test_delay_collector_insert
BEFORE INSERT ON office_collector_tokens
FOR EACH ROW EXECUTE FUNCTION test_delay_collector_insert();
`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DROP FUNCTION IF EXISTS test_delay_collector_insert() CASCADE`)
	})

	type result struct{ err error }
	start := make(chan struct{})
	results := make(chan result, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for _, code := range []string{"RACE-A", "RACE-B"} {
		code := code
		go func() {
			ready.Done()
			<-start
			_, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
				SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: code, AgentID: "agent_race",
				OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
			}, now)
			results <- result{err: err}
		}()
	}
	ready.Wait()
	close(start)
	first, second := <-results, <-results
	successes, conflicts := 0, 0
	for _, err := range []error{first.err, second.err} {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, registration.ErrAgentIDConflict):
			conflicts++
		default:
			t.Fatalf("unexpected registration error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d, want 1 and 1", successes, conflicts)
	}
	var collectors, totalUsed int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_collector_tokens WHERE agent_id = 'agent_race'`).Scan(&collectors); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(SUM(used_count), 0) FROM office_collector_registration_codes WHERE registration_code_hash IN ($1, $2)`, auth.HashToken("RACE-A"), auth.HashToken("RACE-B")).Scan(&totalUsed); err != nil {
		t.Fatal(err)
	}
	if collectors != 1 || totalUsed != 1 {
		t.Fatalf("collectors=%d total used_count=%d, want 1 and 1", collectors, totalUsed)
	}
}

func TestPostgresStoreAuthenticateRejectsUnownedLegacyToken(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	if _, err := db.ExecContext(ctx, `
INSERT INTO office_collector_tokens (collector_id, token_hash, device_label)
VALUES ('collector_legacy', $1, 'legacy')
`, auth.HashToken("legacy-token")); err != nil {
		t.Fatal(err)
	}

	identity, ok, err := store.Authenticate(ctx, "legacy-token")
	if err != nil {
		t.Fatal(err)
	}
	if ok || identity.CollectorID != "" || identity.UserID != "" {
		t.Fatalf("identity = %#v, ok = %v", identity, ok)
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

func TestPostgresStoreRegisterCollectorRejectsExpiredAndRevokedCodes(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 3, 10, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "owner_invalid_codes")
	if err := store.CreateOwnedRegistrationCode(ctx, "EXPIRED", "owner_invalid_codes", "admin", now.Add(-20*time.Minute), ptrTime(now.Add(-time.Minute))); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOwnedRegistrationCode(ctx, "REVOKED", "owner_invalid_codes", "admin", now, ptrTime(now.Add(10*time.Minute))); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
UPDATE office_collector_registration_codes SET revoked_at = $2 WHERE registration_code_hash = $1
`, auth.HashToken("REVOKED"), now); err != nil {
		t.Fatal(err)
	}

	_, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "EXPIRED",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
	}, now)
	if !errors.Is(err, registration.ErrRegistrationCodeExpired) {
		t.Fatalf("expired err = %v", err)
	}

	_, err = store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "REVOKED",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
	}, now)
	if !errors.Is(err, registration.ErrRegistrationCodeRevoked) {
		t.Fatalf("revoked err = %v", err)
	}
}

func TestPostgresStoreRegisterCollectorRejectsUnownedCode(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 3, 10, 0, 0, 0, time.UTC)
	if _, err := db.ExecContext(ctx, `
INSERT INTO office_collector_registration_codes
	(registration_code_hash, registration_code, created_by, created_at, expires_at, used_count)
VALUES ($1, '', 'legacy', $2, NULL, 0)
`, auth.HashToken("NO-EXPIRY"), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	_, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "NO-EXPIRY",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
	}, now)
	if !errors.Is(err, registration.ErrRegistrationOwnerInvalid) {
		t.Fatalf("err = %v, want %v", err, registration.ErrRegistrationOwnerInvalid)
	}
}

func TestPostgresStoreCreateOwnedRegistrationCodeStoresPlaintextAndHash(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	expiresAt := time.Date(2026, 6, 10, 10, 24, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "owner_hash_only")
	if err := store.CreateOwnedRegistrationCode(ctx, "reg_plaintext_123", "owner_hash_only", "admin", expiresAt.Add(-10*time.Minute), &expiresAt); err != nil {
		t.Fatal(err)
	}

	var storedCode string
	var storedHash string
	if err := db.QueryRowContext(ctx, `
SELECT registration_code, registration_code_hash
FROM office_collector_registration_codes
WHERE registration_code_hash = $1
`, auth.HashToken("reg_plaintext_123")).Scan(&storedCode, &storedHash); err != nil {
		t.Fatal(err)
	}
	if storedCode != "reg_plaintext_123" {
		t.Fatalf("registration_code = %q, want reg_plaintext_123", storedCode)
	}
	if storedHash != auth.HashToken("reg_plaintext_123") {
		t.Fatalf("registration_code_hash = %q", storedHash)
	}
}

func TestPostgresStoreCompleteTurnMarksTurnIdle(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	startedAt := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	completedAt := startedAt.Add(2 * time.Minute)
	if err := store.UpsertTurn(ctx, state.TurnState{
		CollectorID: "collector_1",
		AgentID:     "agent_1",
		TurnID:      "turn_1",
		SessionID:   "sess_1",
		Status:      collectorapi.StatusThinking,
		StartedAt:   startedAt,
		UpdatedAt:   startedAt,
	}); err != nil {
		t.Fatal(err)
	}

	if err := store.CompleteTurn(ctx, state.TurnCompletion{
		CollectorID: "collector_1",
		AgentID:     "agent_1",
		TurnID:      "turn_1",
		CompletedAt: completedAt,
	}); err != nil {
		t.Fatal(err)
	}

	var status string
	var storedCompletedAt time.Time
	if err := db.QueryRowContext(ctx, `
SELECT status, completed_at
FROM office_agent_turns
WHERE collector_id = $1 AND agent_id = $2 AND turn_id = $3
`, "collector_1", "agent_1", "turn_1").Scan(&status, &storedCompletedAt); err != nil {
		t.Fatal(err)
	}
	if status != string(collectorapi.StatusIdle) {
		t.Fatalf("status = %q, want %q", status, collectorapi.StatusIdle)
	}
	if !storedCompletedAt.Equal(completedAt) {
		t.Fatalf("completed_at = %s, want %s", storedCompletedAt, completedAt)
	}
}

func TestOfficeTestDatabaseURLRequiresExplicitEnv(t *testing.T) {
	originalValue, hadOriginal := os.LookupEnv("CLAW_MCP_TEST_DATABASE_URL")
	if hadOriginal {
		t.Cleanup(func() { _ = os.Setenv("CLAW_MCP_TEST_DATABASE_URL", originalValue) })
	} else {
		t.Cleanup(func() { _ = os.Unsetenv("CLAW_MCP_TEST_DATABASE_URL") })
	}

	if err := os.Unsetenv("CLAW_MCP_TEST_DATABASE_URL"); err != nil {
		t.Fatal(err)
	}
	if dsn, err := officeTestDatabaseURL(); err != nil || dsn != "" {
		t.Fatalf("unset env => (%q, %v), want empty,nil", dsn, err)
	}

	if err := os.Setenv("CLAW_MCP_TEST_DATABASE_URL", "   "); err != nil {
		t.Fatal(err)
	}
	if dsn, err := officeTestDatabaseURL(); err != nil || dsn != "" {
		t.Fatalf("blank env => (%q, %v), want empty,nil", dsn, err)
	}

	wantDSN := "postgres://example/claw_mcp_test"
	if err := os.Setenv("CLAW_MCP_TEST_DATABASE_URL", wantDSN); err != nil {
		t.Fatal(err)
	}
	if dsn, err := officeTestDatabaseURL(); err != nil || dsn != wantDSN {
		t.Fatalf("explicit env => (%q, %v), want %q,nil", dsn, err, wantDSN)
	}
}

func TestRegisterCollectorLocksOnlyRegistrationCodeRow(t *testing.T) {
	raw, err := os.ReadFile("postgres.go")
	if err != nil {
		t.Fatal(err)
	}
	source := strings.ToLower(string(raw))
	if !strings.Contains(source, "where c.registration_code_hash = $1\nfor update of c") {
		t.Fatal("RegisterCollector must lock only the registration code row")
	}
}

func TestOfficeTestDatabaseURLRejectsUnsafeDatabaseNames(t *testing.T) {
	originalValue, hadOriginal := os.LookupEnv("CLAW_MCP_TEST_DATABASE_URL")
	if hadOriginal {
		t.Cleanup(func() { _ = os.Setenv("CLAW_MCP_TEST_DATABASE_URL", originalValue) })
	} else {
		t.Cleanup(func() { _ = os.Unsetenv("CLAW_MCP_TEST_DATABASE_URL") })
	}

	tests := []struct {
		name string
		dsn  string
		want string
	}{
		{
			name: "invalid dsn",
			dsn:  "://bad",
			want: "CLAW_MCP_TEST_DATABASE_URL",
		},
		{
			name: "non test database",
			dsn:  "postgres://claw_mcp:pass@localhost:5932/claw_mcp?sslmode=disable",
			want: "database name \"claw_mcp\" must end with _test",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := os.Setenv("CLAW_MCP_TEST_DATABASE_URL", tt.dsn); err != nil {
				t.Fatal(err)
			}
			_, err := officeTestDatabaseURL()
			if err == nil {
				t.Fatalf("officeTestDatabaseURL() err = nil, want error")
			}
			msg := err.Error()
			for _, fragment := range []string{"CLAW_MCP_TEST_DATABASE_URL", "_test", tt.want} {
				if !strings.Contains(msg, fragment) {
					t.Fatalf("error %q does not contain %q", msg, fragment)
				}
			}
		})
	}
}

func officeTestDatabaseURL() (string, error) {
	dsn, ok := os.LookupEnv("CLAW_MCP_TEST_DATABASE_URL")
	if !ok {
		return "", nil
	}
	dsn = strings.TrimSpace(dsn)
	if dsn == "" {
		return "", nil
	}
	dbName, err := databaseNameFromDSN(dsn)
	if err != nil {
		return "", err
	}
	if !strings.HasSuffix(dbName, "_test") {
		return "", fmt.Errorf("CLAW_MCP_TEST_DATABASE_URL database name %q must end with _test", dbName)
	}
	return dsn, nil
}

func databaseNameFromDSN(dsn string) (string, error) {
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

func openOfficeTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn, err := officeTestDatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置，跳过破坏性 Postgres 集成测试")
	}
	db, err := sql.Open("pgx", testpostgres.New(t))
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

func resetOfficeTables(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `TRUNCATE office_agents, office_collector_tokens, office_collector_registration_codes CASCADE`); err != nil {
		t.Fatal(err)
	}
}

func ensureOfficeTestAccount(t *testing.T, ctx context.Context, db *sql.DB, userID string) {
	t.Helper()
	_, err := db.ExecContext(ctx, `
INSERT INTO accounts (user_id, email, name, password_hash, status, created_at, updated_at)
VALUES ($1, $1 || '@office-test.local', $1, 'test', 'active', now(), now())
ON CONFLICT (user_id) DO UPDATE SET status = 'active', updated_at = now()
`, userID)
	if err != nil {
		t.Fatal(err)
	}
}

func ptrTime(value time.Time) *time.Time {
	return &value
}

func cleanupOfficePostgresStore(t *testing.T, db *sql.DB) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		for _, stmt := range []string{
			`TRUNCATE TABLE office_agent_tool_calls RESTART IDENTITY`,
			`TRUNCATE TABLE office_agent_source_events RESTART IDENTITY`,
			`TRUNCATE TABLE office_agent_activities RESTART IDENTITY`,
			`TRUNCATE TABLE office_agent_sub_agents RESTART IDENTITY`,
			`TRUNCATE TABLE office_agent_turns RESTART IDENTITY`,
			`TRUNCATE TABLE office_agent_sessions RESTART IDENTITY`,
			`TRUNCATE TABLE office_agents RESTART IDENTITY`,
			`TRUNCATE TABLE office_collector_devices RESTART IDENTITY`,
			`TRUNCATE TABLE office_collector_registrations RESTART IDENTITY`,
			`TRUNCATE TABLE office_collector_registration_codes RESTART IDENTITY`,
			`TRUNCATE TABLE office_collector_tokens RESTART IDENTITY`,
		} {
			if _, err := db.ExecContext(ctx, stmt); err != nil {
				t.Logf("cleanup stmt failed: %s: %v", stmt, err)
			}
		}
	})
}

func applyOfficeMigrationFile(t *testing.T, ctx context.Context, db *sql.DB, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	up := string(raw)
	if idx := len(up); idx > 0 {
		if marker := "\n-- +goose Down"; true {
			if i := indexOf(up, marker); i >= 0 {
				up = up[:i]
			}
		}
	}
	up = replaceOnce(up, "-- +goose Up\n", "")
	if _, err := db.ExecContext(ctx, up); err != nil {
		t.Fatalf("apply migration %s: %v", path, err)
	}
}

func indexOf(s string, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

func replaceOnce(s string, old string, new string) string {
	if i := indexOf(s, old); i >= 0 {
		return s[:i] + new + s[i+len(old):]
	}
	return s
}

func assertOfficeCollectorIsolation(t *testing.T, ctx context.Context, db *sql.DB, store *PostgresStore, resp collectorapi.RegistrationResponse, now time.Time) {
	t.Helper()

	if err := store.UpsertDevice(ctx, state.DeviceHeartbeat{
		CollectorID:      "collector_2",
		DeviceID:         "device_2",
		CollectorVersion: "v0.1.0",
		LastSeenAt:       now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: "collector_2",
		DeviceID:    "device_2",
		AgentID:     "agent_same",
		AgentType:   collectorapi.AgentTypeCodex,
		Status:      collectorapi.StatusCoding,
		LastSeenAt:  now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertActivity(ctx, state.ActivityState{
		CollectorID:  "collector_2",
		ActivityID:   "act_1",
		AgentID:      "agent_same",
		ActivityType: collectorapi.ActivitySearching,
		Status:       collectorapi.StatusSearching,
		StartedAt:    now,
	}); err != nil {
		t.Fatal(err)
	}

	var collector2Activities int
	if err := db.QueryRowContext(ctx, `
SELECT count(*) FROM office_agent_activities
WHERE collector_id = $1 AND agent_id = $2 AND activity_id = $3
`, "collector_2", "agent_same", "act_1").Scan(&collector2Activities); err != nil {
		t.Fatal(err)
	}
	if collector2Activities != 1 {
		t.Fatalf("collector_2 activities = %d", collector2Activities)
	}

	if err := store.CompleteActivity(ctx, state.ActivityCompletion{
		ActivityID: "act_1",
		Scope: state.ActivityScope{
			CollectorID: resp.CollectorID,
			AgentID:     "agent_same",
		},
		CompletedAt: now.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}

	var collector2Open int
	if err := db.QueryRowContext(ctx, `
SELECT count(*) FROM office_agent_activities
WHERE collector_id = $1 AND agent_id = $2 AND activity_id = $3 AND completed_at IS NULL
`, "collector_2", "agent_same", "act_1").Scan(&collector2Open); err != nil {
		t.Fatal(err)
	}
	if collector2Open != 1 {
		t.Fatalf("collector_2 open activities = %d", collector2Open)
	}
}
