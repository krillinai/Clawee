package codex

import (
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestActivityMergerMergesConsecutiveActivityStartedWithinWindow(t *testing.T) {
	startedAt := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	merger := NewActivityMerger(3 * time.Second)

	events := merger.Merge([]collectorapi.CollectorEvent{
		eventWithActivity(startedAt, collectorapi.ActivityRunningCommands),
		eventWithActivity(startedAt.Add(2*time.Second), collectorapi.ActivityRunningCommands),
	})

	if len(events) != 1 {
		t.Fatalf("Merge returned %d events, want 1", len(events))
	}
	if events[0].Activity == nil {
		t.Fatal("Activity is nil")
	}
	if events[0].Activity.CompletedAt == nil {
		t.Fatal("Activity.CompletedAt is nil")
	}
	if !events[0].Activity.CompletedAt.Equal(startedAt.Add(2 * time.Second)) {
		t.Fatalf("Activity.CompletedAt = %v, want %v", events[0].Activity.CompletedAt, startedAt.Add(2*time.Second))
	}
}

func TestActivityMergerMergesChainedActivityStartedWithinWindow(t *testing.T) {
	startedAt := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	merger := NewActivityMerger(3 * time.Second)

	events := merger.Merge([]collectorapi.CollectorEvent{
		eventWithActivity(startedAt, collectorapi.ActivityRunningCommands),
		eventWithActivity(startedAt.Add(2*time.Second), collectorapi.ActivityRunningCommands),
		eventWithActivity(startedAt.Add(4*time.Second), collectorapi.ActivityRunningCommands),
	})

	if len(events) != 1 {
		t.Fatalf("Merge returned %d events, want 1", len(events))
	}
	if !events[0].OccurredAt.Equal(startedAt) {
		t.Fatalf("OccurredAt = %v, want %v", events[0].OccurredAt, startedAt)
	}
	if events[0].Activity == nil {
		t.Fatal("Activity is nil")
	}
	if events[0].Activity.CompletedAt == nil {
		t.Fatal("Activity.CompletedAt is nil")
	}
	if !events[0].Activity.CompletedAt.Equal(startedAt.Add(4 * time.Second)) {
		t.Fatalf("Activity.CompletedAt = %v, want %v", events[0].Activity.CompletedAt, startedAt.Add(4*time.Second))
	}
}

func TestActivityMergerDoesNotSwallowActivityAcrossBatches(t *testing.T) {
	startedAt := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	merger := NewActivityMerger(3 * time.Second)

	firstEvents := merger.Merge([]collectorapi.CollectorEvent{
		eventWithActivity(startedAt, collectorapi.ActivityRunningCommands),
	})

	if len(firstEvents) != 1 {
		t.Fatalf("first Merge returned %d events, want 1", len(firstEvents))
	}

	secondEvents := merger.Merge([]collectorapi.CollectorEvent{
		eventWithActivity(startedAt.Add(2*time.Second), collectorapi.ActivityRunningCommands),
	})

	if len(secondEvents) != 1 {
		t.Fatalf("second Merge returned %d events, want 1", len(secondEvents))
	}
	if secondEvents[0].Activity == nil {
		t.Fatal("secondEvents[0].Activity is nil")
	}
	if !secondEvents[0].OccurredAt.Equal(startedAt.Add(2 * time.Second)) {
		t.Fatalf("second OccurredAt = %v, want %v", secondEvents[0].OccurredAt, startedAt.Add(2*time.Second))
	}
}

func TestActivityMergerDoesNotMergeDifferentActivityType(t *testing.T) {
	startedAt := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	merger := NewActivityMerger(3 * time.Second)

	events := merger.Merge([]collectorapi.CollectorEvent{
		eventWithActivity(startedAt, collectorapi.ActivityRunningCommands),
		eventWithActivity(startedAt.Add(2*time.Second), collectorapi.ActivityCoding),
	})

	if len(events) != 2 {
		t.Fatalf("Merge returned %d events, want 2", len(events))
	}
	if events[0].Activity == nil {
		t.Fatal("events[0].Activity is nil")
	}
	if events[0].Activity.CompletedAt != nil {
		t.Fatalf("events[0].Activity.CompletedAt = %v, want nil", events[0].Activity.CompletedAt)
	}
	if events[1].Activity == nil {
		t.Fatal("events[1].Activity is nil")
	}
	if events[1].Activity.ActivityType != collectorapi.ActivityCoding {
		t.Fatalf("events[1].Activity.ActivityType = %q, want %q", events[1].Activity.ActivityType, collectorapi.ActivityCoding)
	}
}

func eventWithActivity(occurredAt time.Time, activityType collectorapi.ActivityType) collectorapi.CollectorEvent {
	subAgentID := "sub-agent-1"

	return collectorapi.CollectorEvent{
		EventID:    "event-1",
		EventType:  collectorapi.EventActivityStarted,
		OccurredAt: occurredAt,
		AgentID:    "agent-1",
		AgentType:  collectorapi.AgentTypeCodex,
		SessionID:  "session-1",
		TurnID:     "turn-1",
		SubAgentID: &subAgentID,
		Status:     collectorapi.StatusRunningCommands,
		Activity: &collectorapi.ActivitySummary{
			ActivityID:   "activity-1",
			ActivityType: activityType,
			Title:        "Running command",
			StartedAt:    occurredAt,
		},
	}
}
