package dashboard

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNotifierPublishesAgentUpsertedForChangedAgent(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	publisher := &fakeRealtimePublisher{}

	reader := &fakeNotifyReader{
		agents: []AgentListItem{{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
			DisplayName: "Hermes C03",
			Status:      "searching",
		}},
	}
	notifier := NewNotifier(reader, publisher.Publish, func() time.Time { return now })
	notifier.NotifyCollectorWriteApplied(context.Background(), "collector_1", []CollectorChange{{
		AgentID: "agent_same",
	}})

	if len(publisher.events) == 0 {
		t.Fatal("no events published")
	}
	event := publisher.events[0]
	if event.eventType != "agent.upserted" {
		t.Fatalf("Type = %q", event.eventType)
	}
	if event.scope.CollectorID != "collector_1" || event.scope.AgentID != "agent_same" {
		t.Fatalf("scope = %#v", event.scope)
	}
	var payload struct {
		Agent AgentListItem `json:"agent"`
	}
	if err := json.Unmarshal(event.data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Agent.DisplayName != "Hermes C03" {
		t.Fatalf("DisplayName = %q", payload.Agent.DisplayName)
	}
}

func TestNotifierPublishesStatsAndActivityEventsForChangedAgent(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	publisher := &fakeRealtimePublisher{}

	reader := &fakeNotifyReader{
		office: OfficeSnapshot{
			SchemaVersion: SchemaVersion,
			ServerTime:    now,
			Summary:       OfficeSummary{TotalAgents: 1, OnlineAgents: 1},
			Filters:       OfficeFilters{StatusCounts: map[string]int{"running_commands": 1}},
		},
		agents: []AgentListItem{{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
			DisplayName: "Hermes C03",
			Status:      "running_commands",
		}},
		detail: AgentDetail{
			RecentActivities: []ActivityItem{{
				CollectorID:  "collector_1",
				AgentID:      "agent_same",
				ActivityID:   "activity_1",
				ActivityType: "running_commands",
				Status:       "running_commands",
				Title:        "Run tests",
				StartedAt:    now,
			}},
		},
	}
	notifier := NewNotifier(reader, publisher.Publish, func() time.Time { return now })
	notifier.NotifyCollectorWriteApplied(context.Background(), "collector_1", []CollectorChange{{
		AgentID:            "agent_same",
		ActivityID:         "activity_1",
		HasActivityStarted: true,
	}})

	seen := map[string]bool{}
	for _, event := range publisher.events {
		seen[event.eventType] = true
	}
	for _, eventType := range []string{"agent.upserted", "activity.upserted", "office.stats.updated"} {
		if !seen[eventType] {
			t.Fatalf("missing event %q, seen=%#v", eventType, seen)
		}
	}
}

func TestNotifierPublishesSessionAndTurnEventsForChangedAgent(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	completedAt := now.Add(-time.Minute)
	publisher := &fakeRealtimePublisher{}

	reader := &fakeNotifyReader{
		office: OfficeSnapshot{Summary: OfficeSummary{TotalAgents: 1}},
		agents: []AgentListItem{{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
			Status:      "coding",
		}},
		detail: AgentDetail{
			Sessions: []SessionItem{{
				SessionID:     "session_1",
				Status:        "coding",
				StartedAt:     now.Add(-10 * time.Minute),
				WorkspaceName: "claw-mcp",
			}},
			Turns: []TurnItem{{
				TurnID:      "turn_1",
				SessionID:   "session_1",
				Title:       "Implement SSE",
				Status:      "completed",
				StartedAt:   now.Add(-5 * time.Minute),
				UpdatedAt:   completedAt,
				CompletedAt: &completedAt,
			}},
		},
	}
	notifier := NewNotifier(reader, publisher.Publish, func() time.Time { return now })
	notifier.NotifyCollectorWriteApplied(context.Background(), "collector_1", []CollectorChange{{
		AgentID:          "agent_same",
		SessionID:        "session_1",
		TurnID:           "turn_1",
		HasSessionChange: true,
		HasTurnChange:    true,
	}, {
		AgentID:          "agent_same",
		SessionID:        "session_1",
		TurnID:           "turn_1",
		HasTurnCompleted: true,
	}})

	seen := map[string]fakeRealtimeEvent{}
	for _, event := range publisher.events {
		seen[event.eventType] = event
	}
	sessionEvent, ok := seen["session.upserted"]
	if !ok {
		t.Fatalf("missing session.upserted, seen=%#v", seen)
	}
	if sessionEvent.scope.SessionID != "session_1" {
		t.Fatalf("session scope = %#v", sessionEvent.scope)
	}
	var sessionPayload struct {
		Session SessionItem `json:"session"`
	}
	if err := json.Unmarshal(sessionEvent.data, &sessionPayload); err != nil {
		t.Fatal(err)
	}
	if sessionPayload.Session.SessionID != "session_1" {
		t.Fatalf("session payload = %#v", sessionPayload)
	}

	turnEvent, ok := seen["turn.completed"]
	if !ok {
		t.Fatalf("missing turn.completed, seen=%#v", seen)
	}
	if turnEvent.scope.TurnID != "turn_1" || turnEvent.scope.SessionID != "session_1" {
		t.Fatalf("turn scope = %#v", turnEvent.scope)
	}
	var turnPayload struct {
		Turn TurnItem `json:"turn"`
	}
	if err := json.Unmarshal(turnEvent.data, &turnPayload); err != nil {
		t.Fatal(err)
	}
	if turnPayload.Turn.TurnID != "turn_1" || turnPayload.Turn.CompletedAt == nil {
		t.Fatalf("turn payload = %#v", turnPayload)
	}
}

func TestNotifierPublishesMultipleSessionAndTurnEventsForSameAgentBatch(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	completedAt := now.Add(-time.Minute)
	publisher := &fakeRealtimePublisher{}

	reader := &fakeNotifyReader{
		office: OfficeSnapshot{Summary: OfficeSummary{TotalAgents: 1}},
		agents: []AgentListItem{{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
			Status:      "coding",
		}},
		detail: AgentDetail{
			Sessions: []SessionItem{{
				SessionID: "session_1",
				Status:    "coding",
				StartedAt: now.Add(-10 * time.Minute),
			}, {
				SessionID: "session_2",
				Status:    "thinking",
				StartedAt: now.Add(-5 * time.Minute),
			}, {
				SessionID: "session_unrelated",
				Status:    "idle",
				StartedAt: now.Add(-30 * time.Minute),
			}},
			Turns: []TurnItem{{
				TurnID:    "turn_1",
				SessionID: "session_1",
				Status:    "coding",
				StartedAt: now.Add(-9 * time.Minute),
				UpdatedAt: now.Add(-8 * time.Minute),
			}, {
				TurnID:    "turn_2",
				SessionID: "session_2",
				Status:    "thinking",
				StartedAt: now.Add(-4 * time.Minute),
				UpdatedAt: now.Add(-3 * time.Minute),
			}, {
				TurnID:      "turn_3",
				SessionID:   "session_2",
				Status:      "completed",
				StartedAt:   now.Add(-2 * time.Minute),
				UpdatedAt:   completedAt,
				CompletedAt: &completedAt,
			}, {
				TurnID:    "turn_unrelated",
				SessionID: "session_unrelated",
				Status:    "idle",
				StartedAt: now.Add(-20 * time.Minute),
				UpdatedAt: now.Add(-19 * time.Minute),
			}},
		},
	}
	notifier := NewNotifier(reader, publisher.Publish, func() time.Time { return now })
	notifier.NotifyCollectorWriteApplied(context.Background(), "collector_1", []CollectorChange{{
		AgentID:          "agent_same",
		SessionID:        "session_1",
		HasSessionChange: true,
	}, {
		AgentID:          "agent_same",
		SessionID:        "session_2",
		HasSessionChange: true,
	}, {
		AgentID:       "agent_same",
		TurnID:        "turn_1",
		HasTurnChange: true,
	}, {
		AgentID:       "agent_same",
		TurnID:        "turn_2",
		HasTurnChange: true,
	}, {
		AgentID:          "agent_same",
		TurnID:           "turn_3",
		HasTurnCompleted: true,
	}})

	if got := eventScopeIDs(publisher.events, "session.upserted", func(scope RealtimeScope) string { return scope.SessionID }); strings.Join(got, ",") != "session_1,session_2" {
		t.Fatalf("session.upserted IDs = %#v", got)
	}
	if got := eventScopeIDs(publisher.events, "turn.upserted", func(scope RealtimeScope) string { return scope.TurnID }); strings.Join(got, ",") != "turn_1,turn_2" {
		t.Fatalf("turn.upserted IDs = %#v", got)
	}
	if got := eventScopeIDs(publisher.events, "turn.completed", func(scope RealtimeScope) string { return scope.TurnID }); strings.Join(got, ",") != "turn_3" {
		t.Fatalf("turn.completed IDs = %#v", got)
	}
}

func TestNotifierPublishesSnapshotRequiredWhenRequestedSessionOrTurnIsMissing(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	publisher := &fakeRealtimePublisher{}

	reader := &fakeNotifyReader{
		office: OfficeSnapshot{Summary: OfficeSummary{TotalAgents: 1}},
		agents: []AgentListItem{{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
			Status:      "coding",
		}},
		detail: AgentDetail{
			Sessions: []SessionItem{{
				SessionID: "session_visible",
				Status:    "coding",
				StartedAt: now.Add(-10 * time.Minute),
			}},
			Turns: []TurnItem{{
				TurnID:    "turn_visible",
				SessionID: "session_visible",
				Status:    "coding",
				StartedAt: now.Add(-9 * time.Minute),
				UpdatedAt: now.Add(-8 * time.Minute),
			}},
		},
	}
	notifier := NewNotifier(reader, publisher.Publish, func() time.Time { return now })
	notifier.NotifyCollectorWriteApplied(context.Background(), "collector_1", []CollectorChange{{
		AgentID:          "agent_same",
		SessionID:        "session_missing",
		HasSessionChange: true,
	}, {
		AgentID:       "agent_same",
		TurnID:        "turn_missing",
		HasTurnChange: true,
	}})

	reasons := eventReasons(t, publisher.events, "snapshot.required")
	if strings.Join(reasons, ",") != "session_turn_event_not_found,session_turn_event_not_found" {
		t.Fatalf("snapshot.required reasons = %#v", reasons)
	}
}

func TestNotifierPublishesMultipleActivityAndSubAgentEventsForSameAgentBatch(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	publisher := &fakeRealtimePublisher{}

	reader := &fakeNotifyReader{
		office: OfficeSnapshot{Summary: OfficeSummary{TotalAgents: 1}},
		agents: []AgentListItem{{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
			Status:      "coding",
		}},
		detail: AgentDetail{
			RecentActivities: []ActivityItem{{
				CollectorID:  "collector_1",
				AgentID:      "agent_same",
				ActivityID:   "activity_started_1",
				ActivityType: "coding",
				Status:       "coding",
				StartedAt:    now.Add(-5 * time.Minute),
			}, {
				CollectorID:  "collector_1",
				AgentID:      "agent_same",
				ActivityID:   "activity_started_2",
				ActivityType: "reading_files",
				Status:       "reading_files",
				StartedAt:    now.Add(-4 * time.Minute),
			}, {
				CollectorID:  "collector_1",
				AgentID:      "agent_same",
				ActivityID:   "activity_completed_1",
				ActivityType: "running_commands",
				Status:       "idle",
				StartedAt:    now.Add(-3 * time.Minute),
			}, {
				CollectorID:  "collector_1",
				AgentID:      "agent_same",
				ActivityID:   "activity_completed_2",
				ActivityType: "searching",
				Status:       "idle",
				StartedAt:    now.Add(-2 * time.Minute),
			}, {
				CollectorID:  "collector_1",
				AgentID:      "agent_same",
				ActivityID:   "activity_unrelated",
				ActivityType: "thinking",
				Status:       "thinking",
				StartedAt:    now.Add(-20 * time.Minute),
			}},
		},
		subAgents: []SubAgentItem{{
			CollectorID:     "collector_1",
			ParentAgentID:   "agent_same",
			SubAgentID:      "sub_1",
			SessionID:       "session_1",
			ParentTurnID:    "turn_1",
			StartedAt:       now.Add(-10 * time.Minute),
			Status:          "coding",
			CurrentActivity: "coding",
		}, {
			CollectorID:     "collector_1",
			ParentAgentID:   "agent_same",
			SubAgentID:      "sub_2",
			SessionID:       "session_1",
			ParentTurnID:    "turn_1",
			StartedAt:       now.Add(-9 * time.Minute),
			Status:          "searching",
			CurrentActivity: "searching",
		}, {
			CollectorID:     "collector_1",
			ParentAgentID:   "agent_same",
			SubAgentID:      "sub_unrelated",
			SessionID:       "session_1",
			ParentTurnID:    "turn_1",
			StartedAt:       now.Add(-8 * time.Minute),
			Status:          "idle",
			CurrentActivity: "idle",
		}},
	}
	notifier := NewNotifier(reader, publisher.Publish, func() time.Time { return now })
	notifier.NotifyCollectorWriteApplied(context.Background(), "collector_1", []CollectorChange{{
		AgentID:            "agent_same",
		ActivityID:         "activity_started_1",
		HasActivityStarted: true,
	}, {
		AgentID:            "agent_same",
		ActivityID:         "activity_started_2",
		HasActivityStarted: true,
	}, {
		AgentID:              "agent_same",
		ActivityID:           "activity_completed_1",
		HasActivityCompleted: true,
	}, {
		AgentID:              "agent_same",
		ActivityID:           "activity_completed_2",
		HasActivityCompleted: true,
	}, {
		AgentID:           "agent_same",
		SubAgentID:        "sub_1",
		HasSubAgentChange: true,
	}, {
		AgentID:           "agent_same",
		SubAgentID:        "sub_2",
		HasSubAgentChange: true,
	}})

	if got := eventActivityIDs(t, publisher.events, "activity.upserted"); strings.Join(got, ",") != "activity_started_1,activity_started_2" {
		t.Fatalf("activity.upserted IDs = %#v", got)
	}
	if got := eventActivityIDs(t, publisher.events, "activity.completed"); strings.Join(got, ",") != "activity_completed_1,activity_completed_2" {
		t.Fatalf("activity.completed IDs = %#v", got)
	}
	if got := eventScopeIDs(publisher.events, "sub_agent.upserted", func(scope RealtimeScope) string { return scope.SubAgentID }); strings.Join(got, ",") != "sub_1,sub_2" {
		t.Fatalf("sub_agent.upserted IDs = %#v", got)
	}
}

func TestNotifierPublishesSnapshotRequiredWhenRequestedActivityIsMissing(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	publisher := &fakeRealtimePublisher{}

	reader := &fakeNotifyReader{
		office: OfficeSnapshot{Summary: OfficeSummary{TotalAgents: 1}},
		agents: []AgentListItem{{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
			Status:      "coding",
		}},
		detail: AgentDetail{
			RecentActivities: []ActivityItem{{
				CollectorID:  "collector_1",
				AgentID:      "agent_same",
				ActivityID:   "activity_visible",
				ActivityType: "coding",
				Status:       "coding",
				StartedAt:    now.Add(-5 * time.Minute),
			}},
		},
	}
	notifier := NewNotifier(reader, publisher.Publish, func() time.Time { return now })
	notifier.NotifyCollectorWriteApplied(context.Background(), "collector_1", []CollectorChange{{
		AgentID:            "agent_same",
		ActivityID:         "activity_missing",
		HasActivityStarted: true,
	}})

	reasons := eventReasons(t, publisher.events, "snapshot.required")
	if strings.Join(reasons, ",") != "activity_event_not_found" {
		t.Fatalf("snapshot.required reasons = %#v", reasons)
	}
}

func TestNotifierPublishesSnapshotRequiredForSnapshotReplacement(t *testing.T) {
	now := time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC)
	publisher := &fakeRealtimePublisher{}

	reader := &fakeNotifyReader{
		office: OfficeSnapshot{Summary: OfficeSummary{TotalAgents: 1}},
		agents: []AgentListItem{{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
			Status:      "coding",
		}},
		detail: AgentDetail{
			Sessions: []SessionItem{{
				SessionID: "session_1",
				Status:    "coding",
				StartedAt: now.Add(-10 * time.Minute),
			}},
		},
	}
	notifier := NewNotifier(reader, publisher.Publish, func() time.Time { return now })
	notifier.NotifyCollectorWriteApplied(context.Background(), "collector_1", []CollectorChange{{
		AgentID:          "agent_same",
		SessionID:        "session_1",
		HasSessionChange: true,
		RequiresSnapshot: true,
	}})

	reasons := eventReasons(t, publisher.events, "snapshot.required")
	if strings.Join(reasons, ",") != "agent_snapshot_replaced" {
		t.Fatalf("snapshot.required reasons = %#v", reasons)
	}
	if got := eventScopeIDs(publisher.events, "session.upserted", func(scope RealtimeScope) string { return scope.SessionID }); len(got) != 0 {
		t.Fatalf("session.upserted IDs = %#v", got)
	}
}

type fakeNotifyReader struct {
	office    OfficeSnapshot
	agents    []AgentListItem
	detail    AgentDetail
	subAgents []SubAgentItem
	err       error
}

func (r *fakeNotifyReader) OfficeSnapshot(ctx context.Context, now time.Time) (OfficeSnapshot, error) {
	return r.office, r.err
}

func (r *fakeNotifyReader) Agents(ctx context.Context, now time.Time) ([]AgentListItem, error) {
	return r.agents, r.err
}

func (r *fakeNotifyReader) AgentDetail(ctx context.Context, collectorID string, agentID string, now time.Time) (AgentDetail, error) {
	return r.detail, r.err
}

func (r *fakeNotifyReader) SubAgents(ctx context.Context, collectorID string, agentID string, now time.Time) ([]SubAgentItem, error) {
	return r.subAgents, r.err
}

type fakeRealtimePublisher struct {
	events []fakeRealtimeEvent
}

type fakeRealtimeEvent struct {
	eventType string
	scope     RealtimeScope
	data      json.RawMessage
	emittedAt time.Time
}

func (p *fakeRealtimePublisher) Publish(eventType string, scope RealtimeScope, data json.RawMessage, emittedAt time.Time) {
	p.events = append(p.events, fakeRealtimeEvent{
		eventType: eventType,
		scope:     scope,
		data:      data,
		emittedAt: emittedAt,
	})
}

func eventScopeIDs(events []fakeRealtimeEvent, eventType string, id func(RealtimeScope) string) []string {
	out := []string{}
	for _, event := range events {
		if event.eventType == eventType {
			out = append(out, id(event.scope))
		}
	}
	return out
}

func eventActivityIDs(t *testing.T, events []fakeRealtimeEvent, eventType string) []string {
	t.Helper()
	out := []string{}
	for _, event := range events {
		if event.eventType != eventType {
			continue
		}
		var payload struct {
			Activity ActivityItem `json:"activity"`
		}
		if err := json.Unmarshal(event.data, &payload); err != nil {
			t.Fatal(err)
		}
		out = append(out, payload.Activity.ActivityID)
	}
	return out
}

func eventReasons(t *testing.T, events []fakeRealtimeEvent, eventType string) []string {
	t.Helper()
	out := []string{}
	for _, event := range events {
		if event.eventType != eventType {
			continue
		}
		var payload struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(event.data, &payload); err != nil {
			t.Fatal(err)
		}
		out = append(out, payload.Reason)
	}
	return out
}
