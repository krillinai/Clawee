package store

import (
	"context"
	"database/sql"
	"sync"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/auth"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/state"
)

func TestPostgresStoreCollectorsOverviewReturnsRegistrationCodeAndCollectorStatuses(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 4, 10, 0, 0, 0, time.UTC)
	createOwnedRegistrationCodeForOverview(t, ctx, db, store, "reg_online", now.Add(-30*time.Second))
	createOwnedRegistrationCodeForOverview(t, ctx, db, store, "reg_offline", now.Add(-2*time.Minute))
	createOwnedRegistrationCodeForOverview(t, ctx, db, store, "reg_never", now.Add(-3*time.Minute))

	online := registerCollectorForOverview(t, ctx, store, "reg_online", "online-device", now.Add(-30*time.Second), now.Add(-30*time.Second))
	offline := registerCollectorForOverview(t, ctx, store, "reg_offline", "offline-device", now.Add(-2*time.Minute), now.Add(-2*time.Minute))
	never := registerCollectorForOverview(t, ctx, store, "reg_never", "never-device", now.Add(-3*time.Minute), time.Time{})

	overview, err := store.CollectorsOverview(ctx, now, 60*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	if overview.SchemaVersion != management.SchemaVersion {
		t.Fatalf("SchemaVersion = %q", overview.SchemaVersion)
	}
	if !overview.ServerTime.Equal(now) {
		t.Fatalf("ServerTime = %v, want %v", overview.ServerTime, now)
	}
	if overview.OnlineThresholdSeconds != 60 {
		t.Fatalf("OnlineThresholdSeconds = %d", overview.OnlineThresholdSeconds)
	}
	if !overview.RegistrationCode.Exists {
		t.Fatal("RegistrationCode.Exists = false")
	}
	if overview.RegistrationCode.Code != "reg_online" {
		t.Fatalf("RegistrationCode.Code = %q, want reg_online", overview.RegistrationCode.Code)
	}
	if overview.RegistrationCode.UsedCount != 1 {
		t.Fatalf("RegistrationCode.UsedCount = %d", overview.RegistrationCode.UsedCount)
	}
	if overview.Summary.TotalCollectors != 3 {
		t.Fatalf("Summary.TotalCollectors = %d", overview.Summary.TotalCollectors)
	}
	if overview.Summary.OnlineCollectors != 1 {
		t.Fatalf("Summary.OnlineCollectors = %d", overview.Summary.OnlineCollectors)
	}
	if overview.Summary.OfflineCollectors != 1 {
		t.Fatalf("Summary.OfflineCollectors = %d", overview.Summary.OfflineCollectors)
	}
	if overview.Summary.NeverSeenCollectors != 1 {
		t.Fatalf("Summary.NeverSeenCollectors = %d", overview.Summary.NeverSeenCollectors)
	}

	statuses := map[string]string{}
	for _, collector := range overview.Collectors {
		statuses[collector.CollectorID] = collector.Status
		if collector.RegisteredAgentCount != 1 {
			t.Fatalf("collector %s RegisteredAgentCount = %d", collector.CollectorID, collector.RegisteredAgentCount)
		}
	}
	if statuses[online.CollectorID] != management.CollectorStatusOnline {
		t.Fatalf("online status = %q", statuses[online.CollectorID])
	}
	if statuses[offline.CollectorID] != management.CollectorStatusOffline {
		t.Fatalf("offline status = %q", statuses[offline.CollectorID])
	}
	if statuses[never.CollectorID] != management.CollectorStatusNever {
		t.Fatalf("never status = %q", statuses[never.CollectorID])
	}
}

func TestPostgresStoreCollectorsOverviewCountsActualOfficeAgents(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC)
	createOwnedRegistrationCodeForOverview(t, ctx, db, store, "reg_agent_count", now.Add(-time.Minute))
	collector := registerCollectorForOverview(t, ctx, store, "reg_agent_count", "count-device", now.Add(-time.Minute), now.Add(-time.Minute))
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: collector.CollectorID,
		DeviceID:    collector.DeviceID,
		AgentID:     "count-device-second-agent",
		AgentType:   collectorapi.AgentTypeCodex,
		Status:      collectorapi.StatusIdle,
		LastSeenAt:  now,
	}); err != nil {
		t.Fatal(err)
	}

	overview, err := store.CollectorsOverview(ctx, now, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Collectors) != 1 {
		t.Fatalf("collectors = %d, want 1", len(overview.Collectors))
	}
	if overview.Collectors[0].RegisteredAgentCount != 2 {
		t.Fatalf("RegisteredAgentCount = %d, want actual office_agents count 2", overview.Collectors[0].RegisteredAgentCount)
	}
}

func TestPostgresStoreCreateManagementRegistrationCodeReturnsPlaintext(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 4, 11, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "usr_1")
	resp, err := store.CreateManagementRegistrationCode(ctx, "usr_1", "local-admin", now)
	if err != nil {
		t.Fatal(err)
	}
	if resp.RegistrationCode == "" {
		t.Fatal("RegistrationCode is empty")
	}
	if !resp.CreatedAt.Equal(now) {
		t.Fatalf("CreatedAt = %v, want %v", resp.CreatedAt, now)
	}
	if resp.ExpiresAt != nil {
		t.Fatalf("ExpiresAt = %v, want nil", resp.ExpiresAt)
	}
	var storedCode, storedUserID string
	var storedExpiresAt sql.NullTime
	if err := db.QueryRowContext(ctx, `
SELECT registration_code, user_id, expires_at
FROM office_collector_registration_codes
WHERE registration_code_hash = $1
`, auth.HashToken(resp.RegistrationCode)).Scan(&storedCode, &storedUserID, &storedExpiresAt); err != nil {
		t.Fatal(err)
	}
	if storedCode != resp.RegistrationCode || storedUserID != "usr_1" || storedExpiresAt.Valid {
		t.Fatalf("storedCode = %q, storedUserID = %q, storedExpiresAt = %v", storedCode, storedUserID, storedExpiresAt)
	}

	overview, err := store.CollectorsOverview(ctx, now, 60*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !overview.RegistrationCode.Exists {
		t.Fatal("RegistrationCode.Exists = false")
	}
	if overview.RegistrationCode.Code != resp.RegistrationCode {
		t.Fatalf("RegistrationCode.Code = %q, want %q", overview.RegistrationCode.Code, resp.RegistrationCode)
	}
	if overview.RegistrationCode.CreatedAt == nil {
		t.Fatal("RegistrationCode.CreatedAt is nil")
	}
	if !overview.RegistrationCode.CreatedAt.Equal(resp.CreatedAt) {
		t.Fatalf("RegistrationCode.CreatedAt = %v, want %v", overview.RegistrationCode.CreatedAt, resp.CreatedAt)
	}
	if overview.RegistrationCode.ExpiresAt != nil {
		t.Fatalf("RegistrationCode.ExpiresAt = %v, want nil", overview.RegistrationCode.ExpiresAt)
	}
}

func TestPostgresStoreCreateManagementRegistrationCodeRevokesPreviousCode(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 4, 11, 30, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "usr_rotate")
	first, err := store.CreateManagementRegistrationCode(ctx, "usr_rotate", "local-admin", now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateManagementRegistrationCode(ctx, "usr_rotate", "local-admin", now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}

	var firstRevokedAt sql.NullTime
	if err := db.QueryRowContext(ctx, `
SELECT revoked_at
FROM office_collector_registration_codes
WHERE registration_code_hash = $1
`, auth.HashToken(first.RegistrationCode)).Scan(&firstRevokedAt); err != nil {
		t.Fatal(err)
	}
	if !firstRevokedAt.Valid || !firstRevokedAt.Time.Equal(now.Add(time.Minute)) {
		t.Fatalf("first revoked_at = %v", firstRevokedAt)
	}

	overview, err := store.UserCollectorsOverview(ctx, "usr_rotate", now.Add(time.Minute), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if overview.RegistrationCode.Code != second.RegistrationCode {
		t.Fatalf("current registration code = %q, want %q", overview.RegistrationCode.Code, second.RegistrationCode)
	}
}

func TestPostgresStoreEnsureManagementRegistrationCodeIsConcurrentSafe(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	ensureOfficeTestAccount(t, ctx, db, "usr_ensure")

	now := time.Date(2026, 8, 4, 10, 0, 0, 0, time.UTC)
	const callers = 8
	results := make(chan management.RegistrationCodeSummary, callers)
	errs := make(chan error, callers)
	var ready sync.WaitGroup
	ready.Add(callers)
	start := make(chan struct{})
	for range callers {
		go func() {
			ready.Done()
			<-start
			summary, err := store.EnsureManagementRegistrationCode(ctx, "usr_ensure", "Clawee User", now)
			if err != nil {
				errs <- err
				return
			}
			results <- summary
		}()
	}
	ready.Wait()
	close(start)

	var code string
	for range callers {
		select {
		case err := <-errs:
			t.Fatal(err)
		case summary := <-results:
			if !summary.Exists || summary.Code == "" {
				t.Fatalf("summary = %#v", summary)
			}
			if code == "" {
				code = summary.Code
			} else if summary.Code != code {
				t.Fatalf("concurrent ensure returned %q and %q", code, summary.Code)
			}
		}
	}

	var activeCount int
	if err := db.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM office_collector_registration_codes
WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
`, "usr_ensure", now).Scan(&activeCount); err != nil {
		t.Fatal(err)
	}
	if activeCount != 1 {
		t.Fatalf("active registration codes = %d, want 1", activeCount)
	}
}

func TestPostgresStoreDeleteCollectorRemovesCollectorAndScopedAgentState(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	createOwnedRegistrationCodeForOverview(t, ctx, db, store, "reg_delete", now.Add(-3*time.Minute))
	createOwnedRegistrationCodeForOverview(t, ctx, db, store, "reg_keep", now.Add(-4*time.Minute))
	deleted := registerCollectorForOverview(t, ctx, store, "reg_delete", "delete-device", now.Add(-3*time.Minute), now.Add(-3*time.Minute))
	kept := registerCollectorForOverview(t, ctx, store, "reg_keep", "keep-device", now.Add(-4*time.Minute), now.Add(-4*time.Minute))

	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: deleted.CollectorID,
		DeviceID:    deleted.DeviceID,
		AgentID:     "delete-agent",
		AgentType:   collectorapi.AgentTypeCodex,
		Status:      collectorapi.StatusCoding,
		LastSeenAt:  now.Add(-3 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: kept.CollectorID,
		DeviceID:    kept.DeviceID,
		AgentID:     "keep-agent",
		AgentType:   collectorapi.AgentTypeCodex,
		Status:      collectorapi.StatusCoding,
		LastSeenAt:  now.Add(-4 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(ctx, state.SessionState{
		CollectorID: deleted.CollectorID,
		AgentID:     "delete-agent",
		SessionID:   "delete-session",
		Status:      collectorapi.StatusCoding,
		StartedAt:   now.Add(-3 * time.Minute),
		UpdatedAt:   now.Add(-3 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertTurn(ctx, state.TurnState{
		CollectorID: deleted.CollectorID,
		AgentID:     "delete-agent",
		TurnID:      "delete-turn",
		SessionID:   "delete-session",
		Status:      collectorapi.StatusCoding,
		StartedAt:   now.Add(-3 * time.Minute),
		UpdatedAt:   now.Add(-3 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSubAgent(ctx, state.SubAgentState{
		CollectorID:   deleted.CollectorID,
		ParentAgentID: "delete-agent",
		SubAgentID:    "delete-sub-agent",
		Status:        collectorapi.StatusThinking,
		StartedAt:     now.Add(-3 * time.Minute),
		UpdatedAt:     now.Add(-3 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertActivity(ctx, state.ActivityState{
		CollectorID:  deleted.CollectorID,
		ActivityID:   "delete-activity",
		AgentID:      "delete-agent",
		ActivityType: collectorapi.ActivityCoding,
		Status:       collectorapi.StatusCoding,
		StartedAt:    now.Add(-3 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplySourceEvent(ctx, state.SourceEventState{
		CollectorID:       deleted.CollectorID,
		SourceEventID:     "delete-event",
		SourceType:        "codex",
		SourceEventType:   "UserPromptSubmit",
		StandardEventType: collectorapi.EventTurnUpdated,
		AgentID:           "delete-agent",
		OccurredAt:        now.Add(-3 * time.Minute),
		ReceivedAt:        now.Add(-3 * time.Minute),
	}, func(context.Context, state.Store) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeCollectorToken(ctx, deleted.CollectorID, now.Add(-2*time.Minute)); err != nil {
		t.Fatal(err)
	}

	if err := store.DeleteCollector(ctx, deleted.CollectorID, now, 60*time.Second); err != nil {
		t.Fatal(err)
	}

	for _, table := range []string{
		"office_collector_tokens",
		"office_collector_devices",
		"office_collector_registrations",
		"office_agent_source_events",
		"office_agents",
		"office_agent_sessions",
		"office_agent_turns",
		"office_agent_sub_agents",
		"office_agent_activities",
		"office_agent_tool_calls",
	} {
		assertCollectorRowCount(t, ctx, db, table, deleted.CollectorID, 0)
	}
	assertCollectorRowCount(t, ctx, db, "office_collector_tokens", kept.CollectorID, 1)
	assertCollectorRowCount(t, ctx, db, "office_agents", kept.CollectorID, 2)
}

func TestPostgresStoreDeleteCollectorRejectsActiveOfflineCollector(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 4, 12, 20, 0, 0, time.UTC)
	createOwnedRegistrationCodeForOverview(t, ctx, db, store, "reg_active_offline", now.Add(-3*time.Minute))
	offline := registerCollectorForOverview(t, ctx, store, "reg_active_offline", "active-offline-device", now.Add(-3*time.Minute), now.Add(-3*time.Minute))

	err := store.DeleteCollector(ctx, offline.CollectorID, now, 60*time.Second)
	if err != management.ErrCollectorNotDisabled {
		t.Fatalf("err = %v, want %v", err, management.ErrCollectorNotDisabled)
	}
	assertCollectorRowCount(t, ctx, db, "office_collector_tokens", offline.CollectorID, 1)
}

func TestPostgresStoreDeleteCollectorRejectsOnlineCollector(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	now := time.Date(2026, 6, 4, 12, 30, 0, 0, time.UTC)
	createOwnedRegistrationCodeForOverview(t, ctx, db, store, "reg_online", now.Add(-10*time.Second))
	online := registerCollectorForOverview(t, ctx, store, "reg_online", "online-device", now.Add(-10*time.Second), now.Add(-10*time.Second))

	err := store.DeleteCollector(ctx, online.CollectorID, now, 60*time.Second)
	if err != management.ErrCollectorOnline {
		t.Fatalf("err = %v, want %v", err, management.ErrCollectorOnline)
	}
	assertCollectorRowCount(t, ctx, db, "office_collector_tokens", online.CollectorID, 1)
}

func TestPostgresStoreDeleteCollectorReturnsNotFound(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	err := store.DeleteCollector(ctx, "missing", time.Date(2026, 6, 4, 13, 0, 0, 0, time.UTC), 60*time.Second)
	if err != management.ErrCollectorNotFound {
		t.Fatalf("err = %v, want %v", err, management.ErrCollectorNotFound)
	}
}

func registerCollectorForOverview(t *testing.T, ctx context.Context, store *PostgresStore, registrationCode, deviceName string, registeredAt, lastSeenAt time.Time) collectorapi.RegistrationResponse {
	t.Helper()

	resp, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: registrationCode,
		AgentID:          deviceName + "-agent",
		DeviceName:       deviceName,
		Hostname:         deviceName + ".local",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
		Agents: []collectorapi.RegistrationAgent{{
			AgentType:   collectorapi.AgentTypeCodex,
			AgentID:     deviceName + "-agent",
			DisplayName: deviceName + " agent",
		}},
	}, registeredAt)
	if err != nil {
		t.Fatal(err)
	}

	if !lastSeenAt.IsZero() {
		if err := store.UpsertDevice(ctx, state.DeviceHeartbeat{
			CollectorID:      resp.CollectorID,
			DeviceID:         resp.DeviceID,
			CollectorVersion: "0.1.1",
			LastSeenAt:       lastSeenAt,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.UpsertAgent(ctx, state.AgentState{
		CollectorID: resp.CollectorID,
		DeviceID:    resp.DeviceID,
		AgentID:     deviceName + "-agent",
		AgentType:   collectorapi.AgentTypeCodex,
		DisplayName: deviceName + " agent",
		Status:      collectorapi.StatusIdle,
		LastSeenAt:  registeredAt,
	}); err != nil {
		t.Fatal(err)
	}
	return resp
}

func createOwnedRegistrationCodeForOverview(t *testing.T, ctx context.Context, db *sql.DB, store *PostgresStore, code string, registeredAt time.Time) {
	t.Helper()
	ensureOfficeTestAccount(t, ctx, db, "owner_management")
	if err := store.CreateOwnedRegistrationCode(ctx, code, "owner_management", "local-admin", registeredAt.Add(-time.Minute), ptrTime(registeredAt.Add(10*time.Minute))); err != nil {
		t.Fatal(err)
	}
}

func assertCollectorRowCount(t *testing.T, ctx context.Context, db *sql.DB, table string, collectorID string, want int) {
	t.Helper()
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM `+table+` WHERE collector_id = $1`, collectorID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("%s row count = %d, want %d", table, count, want)
	}
}
