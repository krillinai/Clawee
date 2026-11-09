package store

import (
	"context"
	"fmt"
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

func TestActivityStatisticsComputesPlatformActivity(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)

	start := time.Date(2026, 8, 10, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 7)
	for _, userID := range []string{"platform_all", "platform_partial", "platform_error", "platform_disabled"} {
		ensureOfficeTestAccount(t, ctx, db, userID)
	}
	if _, err := db.ExecContext(ctx, `UPDATE accounts SET status='disabled' WHERE user_id='platform_disabled'`); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ collectorID, userID string }{
		{"platform_collector_all", "platform_all"},
		{"platform_collector_partial", "platform_partial"},
		{"platform_collector_error", "platform_error"},
		{"platform_collector_disabled", "platform_disabled"},
	} {
		if _, err := db.ExecContext(ctx, `INSERT INTO office_collector_tokens (collector_id,token_hash,device_label,user_id) VALUES ($1,$2,'test',$3)`, item.collectorID, item.collectorID+"_hash", item.userID); err != nil {
			t.Fatal(err)
		}
	}
	for day := 0; day < 7; day++ {
		at := start.AddDate(0, 0, day).Add(time.Hour)
		if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: "platform_collector_all", AgentID: "agent", TurnID: fmt.Sprintf("all-%d", day), SessionID: "session", Status: collectorapi.StatusIdle, StartedAt: at, UpdatedAt: at}); err != nil {
			t.Fatal(err)
		}
		if day < 6 {
			if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: "platform_collector_partial", AgentID: "agent", TurnID: fmt.Sprintf("partial-%d", day), SessionID: "session", Status: collectorapi.StatusIdle, StartedAt: at, UpdatedAt: at}); err != nil {
				t.Fatal(err)
			}
		}
		if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: "platform_collector_error", AgentID: "agent", TurnID: fmt.Sprintf("error-%d", day), SessionID: "session", Status: collectorapi.StatusError, StartedAt: at, UpdatedAt: at}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: "platform_collector_disabled", AgentID: "agent", TurnID: fmt.Sprintf("disabled-%d", day), SessionID: "session", Status: collectorapi.StatusIdle, StartedAt: at, UpdatedAt: at}); err != nil {
			t.Fatal(err)
		}
	}

	statistics, err := store.Statistics(ctx, start, end)
	if err != nil {
		t.Fatal(err)
	}
	if statistics.PlatformActivity.ActiveUsers != 1 || statistics.PlatformActivity.TotalUsers != 3 || statistics.PlatformActivity.Rate < 0.333 || statistics.PlatformActivity.Rate > 0.334 {
		t.Fatalf("platform activity = %#v", statistics.PlatformActivity)
	}
}

func TestActivityStatisticsTotalsIgnoreDetailLimitAndUseOccurrenceTime(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	start := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "skill_totals_owner")
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DELETE FROM employee_ai_activity_facts WHERE fact_id IN ('created','updated','sync','tomorrow')`)
	})
	if _, err := db.ExecContext(ctx, `INSERT INTO office_collector_tokens (collector_id,token_hash,device_label,user_id) VALUES ('totals_collector','totals_hash','test','skill_totals_owner')`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 102; i++ {
		id := fmt.Sprintf("totals_%d", i)
		_, err := store.ApplySourceEvent(ctx, state.SourceEventState{
			CollectorID: "totals_collector", SourceEventID: id, SourceType: "clawee",
			SourceEventType: "skill_evidence", StandardEventType: collectorapi.EventSourceEventReceived,
			AgentID: "agent", TurnID: "shared_run", OccurredAt: start.Add(time.Hour), ReceivedAt: start.Add(time.Hour),
		}, func(ctx context.Context, tx state.Store) error {
			return tx.InsertSkillEvidence(ctx, state.SkillEvidenceState{
				CollectorID: "totals_collector", SourceEventID: id, AgentID: "agent", RunID: "shared_run",
				SkillID: id, SkillName: id, SkillKey: id, Source: "local", Evidence: "skill_file_read",
				Invocation: "implicit", OccurredAt: start.Add(time.Hour),
			})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, fact := range []struct {
		id, event, origin string
		at                time.Time
	}{
		{"created", "skill.created", "admin_upload", start.Add(time.Hour)},
		{"updated", "skill.version_uploaded", "app_upload", start.Add(time.Hour)},
		{"sync", "skill.created", "source_sync", start.Add(time.Hour)},
		{"tomorrow", "skill.created", "app_upload", start.Add(25 * time.Hour)},
	} {
		actorKind, actorID := "user", any("skill_totals_owner")
		if fact.origin == "source_sync" {
			actorKind, actorID = "system", nil
		}
		_, err := db.ExecContext(ctx, `INSERT INTO employee_ai_activity_facts (fact_id,event_type,actor_kind,actor_user_id,origin,target_id,target_name,source_system,source_event_key,occurred_at) VALUES ($1,$2,$3,$4,$5,'skill','reports','skillhub',$1,$6)`,
			fact.id, fact.event, actorKind, actorID, fact.origin, fact.at)
		if err != nil {
			t.Fatal(err)
		}
	}
	statistics, err := store.Statistics(ctx, start, start.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(statistics.SkillUsage) != 100 || statistics.SkillUsageTotals.ObservedSkillRuns != 102 || statistics.SkillUsageTotals.ImplicitSkillRuns != 102 ||
		statistics.SkillContributions.CreatedCount != 1 || statistics.SkillContributions.UpdatedCount != 1 {
		t.Fatalf("statistics = %#v", statistics)
	}
}

func TestEmployeeAIActivityFactsRejectUnknownCodesAndMissingActor(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	for _, tc := range []struct{ event, origin, actor string }{
		{"skill.deleted", "admin_upload", "owner"},
		{"skill.created", "unregistered", "owner"},
		{"skill.created", "app_upload", ""},
	} {
		_, err := db.ExecContext(ctx, `INSERT INTO employee_ai_activity_facts (fact_id,event_type,actor_kind,actor_user_id,origin,target_id,target_name,source_system,source_event_key) VALUES ('invalid',$1,'user',$2,$3,'skill','name','skillhub','invalid')`,
			tc.event, tc.actor, tc.origin)
		if err == nil {
			t.Fatalf("accepted event=%s origin=%s actor=%q", tc.event, tc.origin, tc.actor)
		}
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
	if totals := statistics.SkillUsageTotals; totals.RequestedSkillRuns != 1 || totals.ObservedSkillRuns != 2 || totals.ExplicitSkillRuns != 1 || totals.ImplicitSkillRuns != 1 {
		t.Fatalf("skill totals = %#v", totals)
	}
}

func TestActivityStatisticsAggregatesEmployeeSkillUsageAcrossCollectors(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	start := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	for _, userID := range []string{"employee-a", "employee-b"} {
		ensureOfficeTestAccount(t, ctx, db, userID)
	}
	if _, err := db.ExecContext(ctx, `UPDATE accounts SET name = '' WHERE user_id = 'employee-b'`); err != nil {
		t.Fatal(err)
	}
	for _, collector := range []struct{ id, userID string }{
		{"employee_collector_a1", "employee-a"}, {"employee_collector_a2", "employee-a"},
		{"employee_collector_b", "employee-b"}, {"employee_collector_unbound", ""},
	} {
		if _, err := db.ExecContext(ctx, `INSERT INTO office_collector_tokens (collector_id, token_hash, device_label, user_id) VALUES ($1, $1, 'test', NULLIF($2, ''))`, collector.id, collector.userID); err != nil {
			t.Fatal(err)
		}
	}
	insertEvidence := func(collector, agent, run, skill, evidence, invocation, eventID string) {
		t.Helper()
		at := start.Add(time.Hour)
		_, err := store.ApplySourceEvent(ctx, state.SourceEventState{
			CollectorID: collector, SourceEventID: eventID, SourceType: "clawee", SourceEventType: "skill_evidence",
			StandardEventType: collectorapi.EventSourceEventReceived, AgentID: agent, TurnID: run, OccurredAt: at, ReceivedAt: at,
		}, func(ctx context.Context, tx state.Store) error {
			return tx.InsertSkillEvidence(ctx, state.SkillEvidenceState{
				CollectorID: collector, SourceEventID: eventID, AgentID: agent, RunID: run,
				SkillID: skill, SkillName: skill, SkillKey: skill, Source: "local", Evidence: evidence,
				Invocation: invocation, OccurredAt: at,
			})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	insertEvidence("employee_collector_a1", "agent-a", "run-a1", "reports", "explicit_request", "explicit", "employee_a_request")
	insertEvidence("employee_collector_a1", "agent-a", "run-a1", "reports", "skill_file_read", "explicit", "employee_a_read")
	insertEvidence("employee_collector_a1", "agent-a", "run-a1", "reports", "skill_file_read", "explicit", "employee_a_read_duplicate")
	insertEvidence("employee_collector_a2", "agent-b", "run-a2", "finance", "skill_resource_run", "implicit", "employee_a_other_skill")
	insertEvidence("employee_collector_b", "agent-c", "run-b", "reports", "skill_file_read", "implicit", "employee_b_read")
	insertEvidence("employee_collector_unbound", "agent-d", "run-unbound", "hidden", "skill_file_read", "implicit", "employee_unbound_read")

	statistics, err := store.Statistics(ctx, start, start.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(statistics.EmployeeSkillUsage) != 2 {
		t.Fatalf("employee skill usage = %#v", statistics.EmployeeSkillUsage)
	}
	first, second := statistics.EmployeeSkillUsage[0], statistics.EmployeeSkillUsage[1]
	if first.EmployeeID != "employee-a" || first.EmployeeName != "employee-a" || first.ObservedSkillCount != 2 || first.RequestedSkillRuns != 1 || first.ObservedSkillRuns != 2 || first.ExplicitSkillRuns != 1 || first.ImplicitSkillRuns != 1 || first.LastObservedAt == nil {
		t.Fatalf("employee-a usage = %#v", first)
	}
	if second.EmployeeID != "employee-b" || second.EmployeeName != "employee-b" || second.ObservedSkillCount != 1 || second.RequestedSkillRuns != 0 || second.ObservedSkillRuns != 1 || second.ExplicitSkillRuns != 0 || second.ImplicitSkillRuns != 1 || second.LastObservedAt == nil {
		t.Fatalf("employee-b usage = %#v", second)
	}
}

func TestActivityStatisticsUsesSkillEvidenceDateAcrossRunBoundary(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	cleanupOfficePostgresStore(t, db)
	resetOfficeTables(t, ctx, db)
	start := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	ensureOfficeTestAccount(t, ctx, db, "cross_day_owner")
	if _, err := db.ExecContext(ctx, `INSERT INTO office_collector_tokens (collector_id, token_hash, device_label, user_id) VALUES ('cross_day_collector', 'cross_day_hash', 'test', 'cross_day_owner')`); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		id, evidence string
		at           time.Time
	}{
		{"cross_day_request", "explicit_request", start.Add(23*time.Hour + 59*time.Minute)},
		{"cross_day_read", "skill_file_read", start.Add(24*time.Hour + time.Minute)},
	} {
		_, err := store.ApplySourceEvent(ctx, state.SourceEventState{
			CollectorID: "cross_day_collector", SourceEventID: item.id, SourceType: "clawee",
			SourceEventType: "skill_evidence", StandardEventType: collectorapi.EventSourceEventReceived,
			AgentID: "agent", TurnID: "cross_day_run", OccurredAt: item.at, ReceivedAt: item.at,
		}, func(ctx context.Context, tx state.Store) error {
			return tx.InsertSkillEvidence(ctx, state.SkillEvidenceState{
				CollectorID: "cross_day_collector", SourceEventID: item.id, AgentID: "agent",
				RunID: "cross_day_run", SkillID: "reports", SkillName: "reports", SkillKey: "reports",
				Source: "local", Evidence: item.evidence, Invocation: "explicit", OccurredAt: item.at,
			})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	first, err := store.Statistics(ctx, start, start.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Statistics(ctx, start.Add(24*time.Hour), start.Add(48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if first.SkillUsageTotals.RequestedSkillRuns != 1 || first.SkillUsageTotals.ObservedSkillRuns != 0 ||
		second.SkillUsageTotals.RequestedSkillRuns != 0 || second.SkillUsageTotals.ObservedSkillRuns != 1 || second.SkillUsageTotals.ExplicitSkillRuns != 1 {
		t.Fatalf("first day = %#v; second day = %#v", first.SkillUsageTotals, second.SkillUsageTotals)
	}
	if len(first.EmployeeSkillUsage) != 1 || first.EmployeeSkillUsage[0].RequestedSkillRuns != 1 || first.EmployeeSkillUsage[0].ObservedSkillRuns != 0 || first.EmployeeSkillUsage[0].LastObservedAt != nil {
		t.Fatalf("first day employee usage = %#v", first.EmployeeSkillUsage)
	}
	if len(second.EmployeeSkillUsage) != 1 || second.EmployeeSkillUsage[0].RequestedSkillRuns != 0 || second.EmployeeSkillUsage[0].ObservedSkillRuns != 1 || second.EmployeeSkillUsage[0].LastObservedAt == nil {
		t.Fatalf("second day employee usage = %#v", second.EmployeeSkillUsage)
	}
}
