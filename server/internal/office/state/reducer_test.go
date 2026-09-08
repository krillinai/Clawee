package state

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

var reducerNow = time.Date(2026, 6, 2, 10, 0, 2, 0, time.UTC)
var occurredAt = time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)

func timePtr(value time.Time) *time.Time {
	return &value
}

func TestApplyHeartbeatUpsertsDeviceAndAgents(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	err := reducer.ApplyHeartbeat(context.Background(), collectorapi.HeartbeatRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		CollectorID:      "collector_1",
		DeviceID:         "device_1",
		SentAt:           occurredAt,
		CollectorVersion: "v0.1.0",
		Agents: []collectorapi.AgentSummary{{
			AgentID:          "codex:device_1:main",
			AgentType:        collectorapi.AgentTypeCodex,
			DisplayName:      "Codex Main",
			Status:           collectorapi.StatusThinking,
			WorkspaceName:    "claw-mcp",
			CurrentSessionID: "sess_1",
			CurrentTurnID:    "turn_1",
			Metadata: map[string]string{
				"safe":           "value",
				"prompt":         "secret",
				"model_response": "secret",
				"output_path":    "secret",
				"api_token":      "secret",
				"cookie_name":    "secret",
				"client_secret":  "secret",
				"password_hint":  "secret",
				"code_diff":      "secret",
				"raw_content":    "secret",
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}

	if len(store.devices) != 1 {
		t.Fatalf("devices = %#v", store.devices)
	}
	if store.devices[0].CollectorID != "collector_1" {
		t.Fatalf("device CollectorID = %q", store.devices[0].CollectorID)
	}
	if store.devices[0].LastSeenAt != reducerNow {
		t.Fatalf("device LastSeenAt = %s", store.devices[0].LastSeenAt)
	}
	if len(store.agents) != 1 {
		t.Fatalf("agents = %#v", store.agents)
	}
	agent := store.agents[0]
	if agent.CollectorID != "collector_1" {
		t.Fatalf("agent CollectorID = %q", agent.CollectorID)
	}
	if agent.LastSeenAt != reducerNow {
		t.Fatalf("LastSeenAt = %s", agent.LastSeenAt)
	}
	if got := agent.Metadata["safe"]; got != "value" {
		t.Fatalf("safe metadata = %q", got)
	}
	for _, key := range []string{"prompt", "model_response", "output_path", "api_token", "cookie_name", "client_secret", "password_hint", "code_diff", "raw_content"} {
		if _, ok := agent.Metadata[key]; ok {
			t.Fatalf("sensitive metadata %q leaked: %#v", key, agent.Metadata)
		}
	}
}

func TestApplyEventsDeduplicatesBeforeReducing(t *testing.T) {
	store := &fakeStore{duplicateSourceEventIDs: map[string]bool{"evt_1": true}}
	reducer := NewReducer(store)

	count, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_1",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusCoding,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "act_1",
				ActivityType: collectorapi.ActivityCoding,
				Title:        "应用代码修改",
				StartedAt:    occurredAt,
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("count = %d", count)
	}
	if len(store.agents) != 0 {
		t.Fatalf("duplicate event reduced agents: %#v", store.agents)
	}
	if len(store.activities) != 0 {
		t.Fatalf("duplicate event reduced activities: %#v", store.activities)
	}
	if store.applySourceEventCallbackCalls != 0 {
		t.Fatalf("duplicate event called reducer callback %d times", store.applySourceEventCallbackCalls)
	}
}

func TestApplyEventsStoresToolCallActivitySourceAndSubAgentNickname(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	count, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:         "src_spawn_post",
			EventType:       collectorapi.EventToolCallCompleted,
			SourceType:      "codex",
			SourceEventType: "PostToolUse",
			OccurredAt:      occurredAt,
			AgentID:         "codex:device_1:main",
			AgentType:       collectorapi.AgentTypeCodex,
			SessionID:       "sess_1",
			TurnID:          "sess_1:turn_parent",
			Status:          collectorapi.StatusThinking,
			ToolCall: &collectorapi.ToolCallSummary{
				ToolCallID:         "tool_spawn",
				ExternalToolCallID: "call_spawn",
				ToolName:           "spawn_agent",
				ToolType:           "agent_collaboration",
				Status:             "completed",
				Input:              map[string]any{"message": "check git status", "fork_context": true},
				Response:           map[string]any{"agent_id": "child_1", "nickname": "Faraday"},
				ResponseText:       "{\"agent_id\":\"child_1\",\"nickname\":\"Faraday\"}",
				StartedAt:          occurredAt,
				CompletedAt:        timePtr(occurredAt),
			},
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "act_spawn",
				ActivityType: collectorapi.ActivityAgentCollaboration,
				ToolCallID:   "tool_spawn",
				Title:        "Spawn sub agent",
				Summary:      "Faraday",
				StartedAt:    occurredAt,
				CompletedAt:  timePtr(occurredAt),
			},
			SubAgent: &collectorapi.SubAgentSummary{
				SubAgentID:      "child_1",
				ParentAgentID:   "codex:device_1:main",
				SessionID:       "sess_1",
				ParentTurnID:    "sess_1:turn_parent",
				SpawnToolCallID: "tool_spawn",
				Name:            "Faraday",
				Nickname:        "Faraday",
				Status:          collectorapi.StatusThinking,
				StartedAt:       occurredAt,
				UpdatedAt:       occurredAt,
			},
			SourceEvent: &collectorapi.SourceEventSummary{
				SourceEventID:   "src_spawn_post",
				SourceType:      "codex",
				SourceEventType: "PostToolUse",
				RawPayload:      map[string]any{"hook_event_name": "PostToolUse", "tool_name": "spawn_agent"},
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d", count)
	}
	if len(store.events) != 1 {
		t.Fatalf("sourceEvents = %#v", store.events)
	}
	if len(store.toolCalls) != 1 {
		t.Fatalf("toolCalls = %#v", store.toolCalls)
	}
	if store.toolCalls[0].ToolName != "spawn_agent" {
		t.Fatalf("tool call = %#v", store.toolCalls[0])
	}
	if len(store.activities) != 1 {
		t.Fatalf("activities = %#v", store.activities)
	}
	if store.activities[0].ToolCallID != "tool_spawn" {
		t.Fatalf("activity ToolCallID = %q", store.activities[0].ToolCallID)
	}
	if len(store.subAgents) != 1 {
		t.Fatalf("subAgents = %#v", store.subAgents)
	}
	if store.subAgents[0].Nickname != "Faraday" || store.subAgents[0].Name != "Faraday" {
		t.Fatalf("subAgent = %#v", store.subAgents[0])
	}
}

func TestApplyEventsKeepsDevelopmentPayloadFieldsBeforePersisting(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	count, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:         "evt_turn_sensitive",
			EventType:       collectorapi.EventTurnUpdated,
			SourceType:      "codex",
			SourceEventType: "UserPromptSubmit",
			OccurredAt:      occurredAt,
			AgentID:         "codex:device_1:main",
			AgentType:       collectorapi.AgentTypeCodex,
			SessionID:       "sess_1",
			TurnID:          "turn_1",
			Status:          collectorapi.StatusThinking,
			Turn: &collectorapi.TurnSummary{
				TurnID:               "turn_1",
				SessionID:            "sess_1",
				Title:                "Safe title",
				UserPrompt:           "secret prompt",
				AssistantSummary:     "secret assistant summary",
				LastAssistantMessage: "secret assistant message",
				Status:               collectorapi.StatusThinking,
				StartedAt:            occurredAt,
				UpdatedAt:            occurredAt,
			},
			SourceEvent: &collectorapi.SourceEventSummary{
				SourceEventID:   "src_turn_sensitive",
				SourceType:      "codex",
				SourceEventType: "UserPromptSubmit",
				RawPayload:      map[string]any{"prompt": "secret prompt"},
			},
		}, {
			EventID:         "evt_tool_sensitive",
			EventType:       collectorapi.EventToolCallCompleted,
			SourceType:      "codex",
			SourceEventType: "PostToolUse",
			OccurredAt:      occurredAt,
			AgentID:         "codex:device_1:main",
			AgentType:       collectorapi.AgentTypeCodex,
			SessionID:       "sess_1",
			TurnID:          "turn_1",
			Status:          collectorapi.StatusThinking,
			ToolCall: &collectorapi.ToolCallSummary{
				ToolCallID:   "tool_1",
				ToolName:     "Bash",
				ToolType:     "command",
				Status:       "completed",
				Input:        map[string]any{"command": "cat secret.txt"},
				Response:     map[string]any{"stdout": "secret output"},
				ResponseText: "secret output",
				StartedAt:    occurredAt,
				CompletedAt:  timePtr(occurredAt),
			},
			SourceEvent: &collectorapi.SourceEventSummary{
				SourceEventID:   "src_tool_sensitive",
				SourceType:      "codex",
				SourceEventType: "PostToolUse",
				RawPayload:      map[string]any{"tool_response": "secret output"},
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("count = %d, want 2", count)
	}
	if len(store.events) != 2 {
		t.Fatalf("events = %#v", store.events)
	}
	var foundPromptPayload bool
	var foundResponsePayload bool
	for _, event := range store.events {
		raw := string(event.RawPayload)
		standard := string(event.StandardPayload)
		if strings.Contains(raw, "secret prompt") && strings.Contains(standard, "secret prompt") {
			foundPromptPayload = true
		}
		if strings.Contains(raw, "secret output") && strings.Contains(standard, "secret output") {
			foundResponsePayload = true
		}
	}
	if !foundPromptPayload {
		t.Fatalf("events did not retain prompt payloads: %#v", store.events)
	}
	if !foundResponsePayload {
		t.Fatalf("events did not retain response payloads: %#v", store.events)
	}
	if len(store.turns) != 1 {
		t.Fatalf("turns = %#v", store.turns)
	}
	if store.turns[0].UserPrompt != "secret prompt" {
		t.Fatalf("turn UserPrompt = %q, want secret prompt", store.turns[0].UserPrompt)
	}
	if store.turns[0].AssistantSummary != "secret assistant summary" {
		t.Fatalf("turn AssistantSummary = %q, want secret assistant summary", store.turns[0].AssistantSummary)
	}
	if store.turns[0].LastAssistantMessage != "secret assistant message" {
		t.Fatalf("turn LastAssistantMessage = %q, want secret assistant message", store.turns[0].LastAssistantMessage)
	}
	if len(store.toolCalls) != 1 {
		t.Fatalf("toolCalls = %#v", store.toolCalls)
	}
	if !strings.Contains(string(store.toolCalls[0].Input), "cat secret.txt") {
		t.Fatalf("tool call Input = %s, want command", store.toolCalls[0].Input)
	}
	if !strings.Contains(string(store.toolCalls[0].Response), "secret output") {
		t.Fatalf("tool call Response = %s, want output", store.toolCalls[0].Response)
	}
	if store.toolCalls[0].ResponseText != "secret output" {
		t.Fatalf("tool call ResponseText = %q, want secret output", store.toolCalls[0].ResponseText)
	}
}

func TestApplyEventsStartsActivityAndUpdatesAgent(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	count, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_1",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			TurnID:     "turn_1",
			Status:     collectorapi.StatusRunningCommands,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "act_1",
				ActivityType: collectorapi.ActivityRunningCommands,
				Title:        "运行测试命令",
				Summary:      "Codex 正在运行本地命令",
				StartedAt:    occurredAt,
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d", count)
	}
	if len(store.agents) != 1 {
		t.Fatalf("agents = %#v", store.agents)
	}
	if store.agents[0].CollectorID != "collector_1" {
		t.Fatalf("agent CollectorID = %q", store.agents[0].CollectorID)
	}
	if got := store.agents[0].Status; got != collectorapi.StatusRunningCommands {
		t.Fatalf("agent status = %s", got)
	}
	if len(store.closedActivityScopes) != 1 {
		t.Fatalf("closed scopes = %#v", store.closedActivityScopes)
	}
	scope := store.closedActivityScopes[0]
	if scope.CollectorID != "collector_1" || scope.AgentID != "codex:device_1:main" || scope.SessionID != "sess_1" || scope.TurnID != "turn_1" {
		t.Fatalf("scope = %#v", scope)
	}
	if len(store.activities) != 1 {
		t.Fatalf("activities = %#v", store.activities)
	}
	if store.activities[0].CollectorID != "collector_1" {
		t.Fatalf("activity CollectorID = %q", store.activities[0].CollectorID)
	}
}

func TestApplyEventsRetriesStateMergeFailure(t *testing.T) {
	store := &fakeStore{upsertAgentErr: errors.New("upsert agent failed")}
	reducer := NewReducer(store)
	req := collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_retry",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusCoding,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "act_1",
				ActivityType: collectorapi.ActivityCoding,
				Title:        "应用代码修改",
				StartedAt:    occurredAt,
			},
		}},
	}

	count, err := reducer.ApplyEvents(context.Background(), req, reducerNow)
	if err == nil {
		t.Fatal("expected first apply error")
	}
	if count != 0 {
		t.Fatalf("first count = %d", count)
	}
	if store.committedSourceEventIDs["evt_retry"] {
		t.Fatalf("failed event was committed: %#v", store.committedSourceEventIDs)
	}

	count, err = reducer.ApplyEvents(context.Background(), req, reducerNow)
	if err == nil {
		t.Fatal("expected retry apply error")
	}
	if count != 0 {
		t.Fatalf("retry count = %d", count)
	}
	if store.applySourceEventCallbackCalls != 2 {
		t.Fatalf("callback calls = %d", store.applySourceEventCallbackCalls)
	}
	if len(store.events) != 0 {
		t.Fatalf("failed events were stored: %#v", store.events)
	}
}

func TestApplyEventsCountsOnlyAfterCallbackSuccess(t *testing.T) {
	store := &fakeStore{upsertAgentErr: errors.New("upsert agent failed")}
	reducer := NewReducer(store)

	count, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_failed_count",
			EventType:  collectorapi.EventTurnUpdated,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			TurnID:     "turn_1",
			Status:     collectorapi.StatusCoding,
		}},
	}, reducerNow)
	if err == nil {
		t.Fatal("expected apply error")
	}
	if count != 0 {
		t.Fatalf("count = %d", count)
	}
	if len(store.events) != 0 {
		t.Fatalf("failed event was stored: %#v", store.events)
	}
}

func TestApplyEventsStoresSanitizedPayload(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)
	req := collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_payload",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusRunningCommands,
			Metadata: map[string]string{
				"prompt": "secret",
				"safe":   "value",
			},
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "act_1",
				ActivityType: collectorapi.ActivityRunningCommands,
				Title:        "运行测试命令",
				StartedAt:    occurredAt,
				Metadata: map[string]string{
					"token":     "secret",
					"tool_name": "Bash",
				},
			},
		}},
	}

	count, err := reducer.ApplyEvents(context.Background(), req, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d", count)
	}
	if len(store.events) != 1 {
		t.Fatalf("events = %#v", store.events)
	}

	payload := string(store.events[0].StandardPayload)
	for _, forbidden := range []string{"prompt", "secret", "token"} {
		if strings.Contains(payload, forbidden) {
			t.Fatalf("payload leaked %q: %s", forbidden, payload)
		}
		if strings.Contains(string(store.events[0].RawPayload), forbidden) {
			t.Fatalf("raw payload leaked %q: %s", forbidden, store.events[0].RawPayload)
		}
	}
	for _, expected := range []string{"safe", "value", "tool_name", "Bash"} {
		if !strings.Contains(payload, expected) {
			t.Fatalf("payload missing %q: %s", expected, payload)
		}
	}
	if req.Events[0].Metadata["prompt"] != "secret" {
		t.Fatalf("event metadata was mutated: %#v", req.Events[0].Metadata)
	}
	if req.Events[0].Activity.Metadata["token"] != "secret" {
		t.Fatalf("activity metadata was mutated: %#v", req.Events[0].Activity.Metadata)
	}
}

func TestApplyEventsMaintainsSession(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_session_1",
			EventType:  collectorapi.EventSessionStarted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			Status:     collectorapi.StatusThinking,
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.sessions) != 1 {
		t.Fatalf("sessions = %#v", store.sessions)
	}
	if store.sessions[0].CollectorID != "collector_1" {
		t.Fatalf("session CollectorID = %q", store.sessions[0].CollectorID)
	}
	if store.sessions[0].SessionID != "sess_1" {
		t.Fatalf("session = %#v", store.sessions[0])
	}
}

func TestApplyEventsCompletesSession(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)
	completedAt := occurredAt.Add(2 * time.Minute)

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        completedAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_session_done",
			EventType:  collectorapi.EventSessionCompleted,
			OccurredAt: completedAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			Status:     collectorapi.StatusIdle,
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.sessions) != 1 {
		t.Fatalf("sessions = %#v", store.sessions)
	}
	if store.sessions[0].EndedAt == nil || !store.sessions[0].EndedAt.Equal(completedAt) {
		t.Fatalf("session EndedAt = %#v", store.sessions[0].EndedAt)
	}
	if store.sessions[0].Status != collectorapi.StatusIdle {
		t.Fatalf("session Status = %q", store.sessions[0].Status)
	}
}

func TestApplyEventsUpdatesSessionFromPayload(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)
	startedAt := occurredAt.Add(-30 * time.Minute)

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_session_payload",
			EventType:  collectorapi.EventSessionUpdated,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			Status:     collectorapi.StatusThinking,
			Session: &collectorapi.SessionSummary{
				SessionID:     "sess_1",
				Status:        collectorapi.StatusCoding,
				Summary:       "实现 session 泳道",
				StartedAt:     startedAt,
				WorkspaceName: "claw-mcp",
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.sessions) != 1 {
		t.Fatalf("sessions = %#v", store.sessions)
	}
	session := store.sessions[0]
	if session.SessionID != "sess_1" {
		t.Fatalf("SessionID = %q", session.SessionID)
	}
	if session.Status != collectorapi.StatusCoding {
		t.Fatalf("Status = %q", session.Status)
	}
	if session.Summary != "实现 session 泳道" {
		t.Fatalf("Summary = %q", session.Summary)
	}
	if session.WorkspaceName != "claw-mcp" {
		t.Fatalf("WorkspaceName = %q", session.WorkspaceName)
	}
	if !session.StartedAt.Equal(startedAt) {
		t.Fatalf("StartedAt = %s", session.StartedAt)
	}
	if !session.UpdateStartedAt {
		t.Fatal("UpdateStartedAt = false")
	}
}

func TestApplyEventsSessionUpdateWithoutPayloadStartedAtDoesNotUpdateStartedAt(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_session_idle",
			EventType:  collectorapi.EventSessionUpdated,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			Status:     collectorapi.StatusIdle,
			Session: &collectorapi.SessionSummary{
				SessionID: "sess_1",
				Status:    collectorapi.StatusIdle,
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.sessions) != 1 {
		t.Fatalf("sessions = %#v", store.sessions)
	}
	session := store.sessions[0]
	if session.Status != collectorapi.StatusIdle {
		t.Fatalf("Status = %q, want idle", session.Status)
	}
	if session.UpdateStartedAt {
		t.Fatal("UpdateStartedAt = true")
	}
	if !session.StartedAt.Equal(occurredAt) {
		t.Fatalf("StartedAt = %s, want event occurredAt fallback", session.StartedAt)
	}
}

func TestApplyEventsMaintainsSubAgent(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)
	child := "child_1"

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_1",
			EventType:  collectorapi.EventSubAgentCreated,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			TurnID:     "turn_1",
			SubAgentID: &child,
			Status:     collectorapi.StatusThinking,
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.subAgents) != 1 {
		t.Fatalf("subAgents = %#v", store.subAgents)
	}
	if store.subAgents[0].CollectorID != "collector_1" {
		t.Fatalf("subAgent CollectorID = %q", store.subAgents[0].CollectorID)
	}
	if store.subAgents[0].SubAgentID != "child_1" {
		t.Fatalf("subAgent = %#v", store.subAgents[0])
	}
}

func TestApplyEventsUpdatesSubAgentCurrentActivityFromActivity(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)
	child := "child_1"

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_sub_agent_activity",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			TurnID:     "turn_1",
			SubAgentID: &child,
			Status:     collectorapi.StatusReadingFiles,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "act_read",
				ActivityType: collectorapi.ActivityReadingFiles,
				Title:        "Reading files",
				StartedAt:    occurredAt,
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.subAgents) != 1 {
		t.Fatalf("subAgents = %#v", store.subAgents)
	}
	if store.subAgents[0].Status != collectorapi.StatusReadingFiles {
		t.Fatalf("subAgent status = %q, want %q", store.subAgents[0].Status, collectorapi.StatusReadingFiles)
	}
	if store.subAgents[0].CurrentActivity != "Reading files" {
		t.Fatalf("CurrentActivity = %q, want Reading files", store.subAgents[0].CurrentActivity)
	}
}

func TestApplyEventsCompletesSubAgentWithCollectorID(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)
	child := "child_1"

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_sub_agent_done",
			EventType:  collectorapi.EventSubAgentCompleted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SubAgentID: &child,
			Status:     collectorapi.StatusIdle,
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.subAgentCompletions) != 1 {
		t.Fatalf("subAgent completions = %#v", store.subAgentCompletions)
	}
	if store.subAgentCompletions[0].CollectorID != "collector_1" {
		t.Fatalf("subAgent completion CollectorID = %q", store.subAgentCompletions[0].CollectorID)
	}
	if store.subAgentCompletions[0].Status != collectorapi.StatusIdle {
		t.Fatalf("subAgent completion Status = %q, want idle", store.subAgentCompletions[0].Status)
	}
}

func TestApplyEventsCompletesActivityWithCollectorScope(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	count, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_activity_done",
			EventType:  collectorapi.EventActivityCompleted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			TurnID:     "turn_1",
			Status:     collectorapi.StatusIdle,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "act_1",
				ActivityType: collectorapi.ActivityRunningCommands,
				StartedAt:    occurredAt,
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d", count)
	}
	if len(store.activityCompletions) != 1 {
		t.Fatalf("activity completions = %#v", store.activityCompletions)
	}
	scope := store.activityCompletions[0].Scope
	if scope.CollectorID != "collector_1" || scope.AgentID != "codex:device_1:main" || scope.SessionID != "sess_1" || scope.TurnID != "turn_1" {
		t.Fatalf("activity completion scope = %#v", scope)
	}
}

func TestApplyEventsCompletesActivityOnAgentError(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)
	completedAt := time.Date(2026, 6, 2, 10, 0, 1, 0, time.UTC)

	count, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_activity_error",
			EventType:  collectorapi.EventAgentError,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			TurnID:     "turn_1",
			Status:     collectorapi.StatusError,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "act_1",
				ActivityType: collectorapi.ActivityRunningCommands,
				StartedAt:    occurredAt,
				CompletedAt:  &completedAt,
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d", count)
	}
	if len(store.activities) != 0 {
		t.Fatalf("activities = %#v", store.activities)
	}
	if len(store.activityCompletions) != 1 {
		t.Fatalf("activity completions = %#v", store.activityCompletions)
	}

	completion := store.activityCompletions[0]
	if completion.ActivityID != "act_1" {
		t.Fatalf("activity completion ActivityID = %q", completion.ActivityID)
	}
	if completion.ActivityType != collectorapi.ActivityRunningCommands {
		t.Fatalf("activity completion ActivityType = %s", completion.ActivityType)
	}
	if completion.CompletedAt != completedAt {
		t.Fatalf("activity completion CompletedAt = %s", completion.CompletedAt)
	}
	scope := completion.Scope
	if scope.CollectorID != "collector_1" || scope.AgentID != "codex:device_1:main" || scope.SessionID != "sess_1" || scope.TurnID != "turn_1" {
		t.Fatalf("activity completion scope = %#v", scope)
	}
}

func TestApplyEventsDoesNotUpsertTurnUpdatedWithoutTurnID(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	count, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_turn_update_no_turn",
			EventType:  collectorapi.EventTurnUpdated,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			Status:     collectorapi.StatusCoding,
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d", count)
	}
	if len(store.turns) != 0 {
		t.Fatalf("turns = %#v", store.turns)
	}
}

func TestApplyEventsDoesNotCompleteSessionOnTurnCompleted(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_turn_done",
			EventType:  collectorapi.EventTurnCompleted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			TurnID:     "turn_1",
			Status:     collectorapi.StatusIdle,
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.sessions) != 0 {
		t.Fatalf("sessions = %#v", store.sessions)
	}
	if len(store.turnCompletions) != 1 {
		t.Fatalf("turn completions = %#v", store.turnCompletions)
	}
	if store.turnCompletions[0].CollectorID != "collector_1" {
		t.Fatalf("turn completion CollectorID = %q", store.turnCompletions[0].CollectorID)
	}
}

func TestApplyEventsPersistsTurnDetailsOnTurnCompleted(t *testing.T) {
	store := &fakeStore{}
	reducer := NewReducer(store)

	_, err := reducer.ApplyEvents(context.Background(), collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        occurredAt,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "evt_turn_done",
			EventType:  collectorapi.EventTurnCompleted,
			OccurredAt: occurredAt,
			AgentID:    "codex:device_1:main",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "sess_1",
			TurnID:     "turn_1",
			Status:     collectorapi.StatusIdle,
			Turn: &collectorapi.TurnSummary{
				TurnID:               "turn_1",
				SessionID:            "sess_1",
				LastAssistantMessage: "secret assistant message",
				Status:               collectorapi.StatusIdle,
				StartedAt:            occurredAt,
				UpdatedAt:            occurredAt,
				CompletedAt:          timePtr(occurredAt),
			},
		}},
	}, reducerNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.turns) != 1 {
		t.Fatalf("turns = %#v", store.turns)
	}
	if store.turns[0].LastAssistantMessage != "secret assistant message" {
		t.Fatalf("turn LastAssistantMessage = %q, want secret assistant message", store.turns[0].LastAssistantMessage)
	}
	if len(store.turnCompletions) != 1 {
		t.Fatalf("turn completions = %#v", store.turnCompletions)
	}
}

type fakeStore struct {
	duplicateSourceEventIDs       map[string]bool
	committedSourceEventIDs       map[string]bool
	applySourceEventCallbackCalls int
	upsertAgentErr                error
	devices                       []DeviceHeartbeat
	agents                        []AgentState
	sessions                      []SessionState
	events                        []SourceEventState
	activities                    []ActivityState
	activityCompletions           []ActivityCompletion
	closedActivityScopes          []ActivityScope
	subAgents                     []SubAgentState
	subAgentCompletions           []SubAgentCompletion
	turns                         []TurnState
	turnCompletions               []TurnCompletion
	toolCalls                     []ToolCallState
	toolCallCompletions           []ToolCallCompletion
}

func (s *fakeStore) UpsertDevice(ctx context.Context, input DeviceHeartbeat) error {
	s.devices = append(s.devices, input)
	return nil
}

func (s *fakeStore) UpsertAgent(ctx context.Context, input AgentState) error {
	if s.upsertAgentErr != nil {
		return s.upsertAgentErr
	}
	s.agents = append(s.agents, input)
	return nil
}

func (s *fakeStore) UpsertSession(ctx context.Context, input SessionState) error {
	s.sessions = append(s.sessions, input)
	return nil
}

func (s *fakeStore) ApplySourceEvent(ctx context.Context, input SourceEventState, reduce func(context.Context, Store) error) (bool, error) {
	if s.duplicateSourceEventIDs[input.SourceEventID] || s.committedSourceEventIDs[input.SourceEventID] {
		return false, nil
	}

	tx := s.clone()
	s.applySourceEventCallbackCalls++
	if err := reduce(ctx, tx); err != nil {
		return false, err
	}

	s.devices = tx.devices
	s.agents = tx.agents
	s.sessions = tx.sessions
	s.activities = tx.activities
	s.activityCompletions = tx.activityCompletions
	s.closedActivityScopes = tx.closedActivityScopes
	s.subAgents = tx.subAgents
	s.subAgentCompletions = tx.subAgentCompletions
	s.turns = tx.turns
	s.turnCompletions = tx.turnCompletions
	s.toolCalls = tx.toolCalls
	s.toolCallCompletions = tx.toolCallCompletions
	s.events = append(s.events, input)
	if s.committedSourceEventIDs == nil {
		s.committedSourceEventIDs = map[string]bool{}
	}
	s.committedSourceEventIDs[input.SourceEventID] = true
	return true, nil
}

func (s *fakeStore) clone() *fakeStore {
	return &fakeStore{
		duplicateSourceEventIDs: s.duplicateSourceEventIDs,
		committedSourceEventIDs: s.committedSourceEventIDs,
		upsertAgentErr:          s.upsertAgentErr,
		devices:                 append([]DeviceHeartbeat(nil), s.devices...),
		agents:                  append([]AgentState(nil), s.agents...),
		sessions:                append([]SessionState(nil), s.sessions...),
		events:                  append([]SourceEventState(nil), s.events...),
		activities:              append([]ActivityState(nil), s.activities...),
		activityCompletions:     append([]ActivityCompletion(nil), s.activityCompletions...),
		closedActivityScopes:    append([]ActivityScope(nil), s.closedActivityScopes...),
		subAgents:               append([]SubAgentState(nil), s.subAgents...),
		subAgentCompletions:     append([]SubAgentCompletion(nil), s.subAgentCompletions...),
		turns:                   append([]TurnState(nil), s.turns...),
		turnCompletions:         append([]TurnCompletion(nil), s.turnCompletions...),
		toolCalls:               append([]ToolCallState(nil), s.toolCalls...),
		toolCallCompletions:     append([]ToolCallCompletion(nil), s.toolCallCompletions...),
	}
}

func (s *fakeStore) CloseOpenActivities(ctx context.Context, scope ActivityScope, completedAt time.Time) error {
	s.closedActivityScopes = append(s.closedActivityScopes, scope)
	return nil
}

func (s *fakeStore) UpsertActivity(ctx context.Context, input ActivityState) error {
	s.activities = append(s.activities, input)
	return nil
}

func (s *fakeStore) CompleteActivity(ctx context.Context, input ActivityCompletion) error {
	s.activityCompletions = append(s.activityCompletions, input)
	return nil
}

func (s *fakeStore) UpsertSubAgent(ctx context.Context, input SubAgentState) error {
	s.subAgents = append(s.subAgents, input)
	return nil
}

func (s *fakeStore) CompleteSubAgent(ctx context.Context, input SubAgentCompletion) error {
	s.subAgentCompletions = append(s.subAgentCompletions, input)
	return nil
}

func (s *fakeStore) UpsertTurn(ctx context.Context, input TurnState) error {
	s.turns = append(s.turns, input)
	return nil
}

func (s *fakeStore) CompleteTurn(ctx context.Context, input TurnCompletion) error {
	s.turnCompletions = append(s.turnCompletions, input)
	return nil
}

func (s *fakeStore) UpsertToolCall(ctx context.Context, input ToolCallState) error {
	s.toolCalls = append(s.toolCalls, input)
	return nil
}

func (s *fakeStore) CompleteToolCall(ctx context.Context, input ToolCallCompletion) error {
	s.toolCallCompletions = append(s.toolCallCompletions, input)
	return nil
}
