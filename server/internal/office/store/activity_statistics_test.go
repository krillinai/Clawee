package store

import (
	"context"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/state"
)

func TestActivityStatisticsUsesTurnBoundaries(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	start := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	end := start.Add(24 * time.Hour)
	for _, userID := range []string{"activity_usr_1", "activity_usr_2"} {
		ensureOfficeTestAccount(t, ctx, db, userID)
	}
	collectors := []struct{ id, userID string }{{"activity_collector_1", "activity_usr_1"}, {"activity_collector_2", "activity_usr_1"}, {"activity_collector_3", "activity_usr_2"}}
	for index, collector := range collectors {
		if _, err := db.ExecContext(ctx, `INSERT INTO office_collector_tokens (collector_id,token_hash,device_label,user_id) VALUES ($1,$2,'test',$3)`, collector.id, collector.id+"_hash", collector.userID); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertAgent(ctx, state.AgentState{CollectorID: collector.id, DeviceID: "device", AgentID: "agent", AgentType: collectorapi.AgentTypeCodex, Status: collectorapi.StatusIdle, LastSeenAt: start}); err != nil {
			t.Fatal(err)
		}
		completed := start.Add(time.Duration(index+1) * time.Hour)
		if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: collector.id, AgentID: "agent", TurnID: "turn", SessionID: "session", Status: collectorapi.StatusIdle, StartedAt: start.Add(time.Minute), UpdatedAt: completed, CompletedAt: &completed}); err != nil {
			t.Fatal(err)
		}
	}
	boundaryCompleted := end
	if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: collectors[0].id, AgentID: "agent", TurnID: "boundary", SessionID: "session", Status: collectorapi.StatusIdle, StartedAt: end, UpdatedAt: end, CompletedAt: &boundaryCompleted}); err != nil {
		t.Fatal(err)
	}
	statistics, err := store.Statistics(ctx, start, end)
	if err != nil {
		t.Fatal(err)
	}
	if statistics.ActiveEmployees != 2 || statistics.ActiveAgents != 3 || statistics.CompletedTurns != 3 {
		t.Fatalf("statistics = %#v", statistics)
	}
}

func TestActivityStatisticsDeduplicatesSkillEvidencePerRun(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	start := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "skill_usage_owner")
	if _, err := db.ExecContext(ctx, `INSERT INTO office_collector_tokens (collector_id, token_hash, device_label, user_id) VALUES ('skill_collector', 'skill_token_hash', 'test', 'skill_usage_owner')`); err != nil {
		t.Fatal(err)
	}
	for index, kind := range []string{"explicit_request", "skill_file_read", "skill_resource_run", "skill_file_read"} {
		id := "evt_skill_" + string(rune('a'+index))
		_, err := store.ApplySourceEvent(ctx, state.SourceEventState{
			CollectorID: "skill_collector", SourceEventID: id, SourceType: "clawee",
			SourceEventType: "skill_evidence", StandardEventType: collectorapi.EventSourceEventReceived,
			AgentID: "agent", TurnID: map[bool]string{true: "run_2", false: "run_1"}[index == 3],
			OccurredAt: start.Add(time.Hour), ReceivedAt: start.Add(time.Hour),
		}, func(ctx context.Context, tx state.Store) error {
			invocation := "explicit"
			if index == 3 {
				invocation = "implicit"
			}
			return tx.InsertSkillEvidence(ctx, state.SkillEvidenceState{
				CollectorID: "skill_collector", SourceEventID: id, AgentID: "agent",
				RunID:   map[bool]string{true: "run_2", false: "run_1"}[index == 3],
				SkillID: "reports", SkillName: "reports", SkillKey: "reports", Source: "local",
				Evidence: kind, Invocation: invocation, OccurredAt: start.Add(time.Hour),
			})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	statistics, err := store.Statistics(ctx, start, start.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(statistics.SkillUsage) != 1 || statistics.SkillUsage[0].RequestedRuns != 1 ||
		statistics.SkillUsage[0].ObservedRuns != 2 || statistics.SkillUsage[0].ImplicitRuns != 1 {
		t.Fatalf("skill usage = %#v", statistics.SkillUsage)
	}
}
