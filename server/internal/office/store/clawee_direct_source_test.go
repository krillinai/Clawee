package store

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/claweeactivity"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/management"
)

func TestPostgresStoreClaweeDirectSourceCreatesAndReusesSingleRevokedSource(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	insertOwnedOfficeAgent(t, ctx, db, "direct_owner", "direct_agent")

	first, err := store.GetOrCreateClaweeDirectSource(ctx, "direct_owner", "direct_agent", now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.GetOrCreateClaweeDirectSource(ctx, "direct_owner", "direct_agent", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("collector ids = %q and %q, want reuse", first, second)
	}

	var count int
	var sourceType, userID, deviceLabel string
	var revokedAt sql.NullTime
	if err := db.QueryRowContext(ctx, `
SELECT COUNT(*), MIN(source_type), MIN(user_id), MIN(device_label), MIN(revoked_at)
FROM office_collector_tokens
WHERE agent_id = $1
`, "direct_agent").Scan(&count, &sourceType, &userID, &deviceLabel, &revokedAt); err != nil {
		t.Fatal(err)
	}
	if count != 1 || sourceType != claweeactivity.DirectSourceType || userID != "direct_owner" || deviceLabel != "Clawee Direct" || !revokedAt.Valid {
		t.Fatalf("source = count=%d type=%q user=%q label=%q revoked=%v", count, sourceType, userID, deviceLabel, revokedAt.Valid)
	}
}

func TestPostgresStoreClaweeDirectSourceConcurrentCreateKeepsOneSource(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	insertOwnedOfficeAgent(t, ctx, db, "concurrent_owner", "concurrent_direct_agent")

	start := make(chan struct{})
	results := make(chan string, 2)
	errorsCh := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for range 2 {
		go func() {
			ready.Done()
			<-start
			collectorID, err := store.GetOrCreateClaweeDirectSource(ctx, "concurrent_owner", "concurrent_direct_agent", now)
			results <- collectorID
			errorsCh <- err
		}()
	}
	ready.Wait()
	close(start)
	first, second := <-results, <-results
	if firstErr, secondErr := <-errorsCh, <-errorsCh; firstErr != nil || secondErr != nil {
		t.Fatalf("create errors = %v, %v", firstErr, secondErr)
	}
	if first == "" || first != second {
		t.Fatalf("collector ids = %q and %q", first, second)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM office_collector_tokens WHERE agent_id = $1`, "concurrent_direct_agent").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("source count = %d, want 1", count)
	}
}

func TestPostgresStoreClaweeDirectSourceIsolationAndCollectorReregistration(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	insertOwnedOfficeAgent(t, ctx, db, "rollback_owner", "rollback_agent")

	collectorID, err := store.GetOrCreateClaweeDirectSource(ctx, "rollback_owner", "rollback_agent", now)
	if err != nil {
		t.Fatal(err)
	}
	overview, err := store.UserCollectorsOverview(ctx, "rollback_owner", now, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Collectors) != 0 {
		t.Fatalf("direct source leaked into collector overview: %#v", overview.Collectors)
	}
	if err := store.RevokeUserCollectorToken(ctx, "rollback_owner", collectorID, now); !errors.Is(err, management.ErrCollectorNotFound) {
		t.Fatalf("revoke direct source error = %v", err)
	}
	if err := store.DeleteUserCollector(ctx, "rollback_owner", collectorID, now, time.Minute); !errors.Is(err, management.ErrCollectorNotFound) {
		t.Fatalf("delete direct source error = %v", err)
	}

	if err := store.CreateOwnedRegistrationCode(ctx, "ROLLBACK", "rollback_owner", "admin", now, nil); err != nil {
		t.Fatal(err)
	}
	registered, err := store.RegisterCollector(ctx, collectorapi.RegistrationRequest{
		SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "ROLLBACK", AgentID: "rollback_agent",
		DeviceName: "rollback device", OS: "linux", Arch: "amd64", CollectorVersion: "0.1.0",
	}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if registered.CollectorID != collectorID {
		t.Fatalf("collector id = %q, want %q", registered.CollectorID, collectorID)
	}
	var sourceType string
	var revokedAt sql.NullTime
	if err := db.QueryRowContext(ctx, `SELECT source_type, revoked_at FROM office_collector_tokens WHERE collector_id = $1`, collectorID).Scan(&sourceType, &revokedAt); err != nil {
		t.Fatal(err)
	}
	if sourceType != "collector" || revokedAt.Valid {
		t.Fatalf("restored source type=%q revoked=%v", sourceType, revokedAt.Valid)
	}
	if _, ok, err := store.Authenticate(ctx, registered.CollectorToken); err != nil || !ok {
		t.Fatalf("restored collector authentication = ok=%v err=%v", ok, err)
	}
}

func TestPostgresStoreClaweeDirectSourceRejectsCollectorAndWrongOwner(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	insertOwnedOfficeAgent(t, ctx, db, "collector_owner", "collector_agent")
	if _, err := db.ExecContext(ctx, `
INSERT INTO office_collector_tokens (collector_id, token_hash, device_label, user_id, agent_id)
VALUES ('existing_collector', 'existing_hash', 'existing', 'collector_owner', 'collector_agent')
`); err != nil {
		t.Fatal(err)
	}

	if _, err := store.GetOrCreateClaweeDirectSource(ctx, "collector_owner", "collector_agent", now); !errors.Is(err, claweeactivity.ErrCollectorSource) {
		t.Fatalf("collector source error = %v", err)
	}
	if _, err := store.GetOrCreateClaweeDirectSource(ctx, "other_owner", "collector_agent", now); !errors.Is(err, claweeactivity.ErrAgentForbidden) {
		t.Fatalf("wrong owner error = %v", err)
	}
}

func insertOwnedOfficeAgent(t *testing.T, ctx context.Context, db *sql.DB, userID, agentID string) {
	t.Helper()
	ensureOfficeTestAccount(t, ctx, db, userID)
	if _, err := db.ExecContext(ctx, `
INSERT INTO mcp_agents (agent_id, name, status, created_at, updated_at)
VALUES ($1, $1, 'active', now(), now())
ON CONFLICT (agent_id) DO NOTHING
`, agentID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO account_agents (user_id, agent_id, created_at)
VALUES ($1, $2, now())
ON CONFLICT (user_id, agent_id) DO NOTHING
`, userID, agentID); err != nil {
		t.Fatal(err)
	}
}
