package codex

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/krillinai/Clawee/server/internal/collector/debugstore"
	"github.com/krillinai/Clawee/server/internal/collector/scrub"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

var fixedTime = time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)

const testMainAgentID = "clawee_550e8400-e29b-41d4-a716-446655440000"

func TestMapHookTruncatesChineseTurnTitleWithoutBreakingReportJSON(t *testing.T) {
	prompt := strings.Repeat("中文", scrub.DefaultTextLimit)
	events := MapHook(HookPayload{
		HookEventName: "UserPromptSubmit",
		SessionID:     "session-1",
		TurnID:        "turn-1",
		Prompt:        prompt,
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	event := findEvent(t, events, collectorapi.EventTurnStarted)
	if event.Turn == nil {
		t.Fatal("Turn is nil")
	}
	if !utf8.ValidString(event.Turn.Title) {
		t.Fatalf("Turn.Title is invalid UTF-8: %q", event.Turn.Title)
	}
	if utf8.RuneCountInString(event.Turn.Title) != scrub.DefaultTextLimit {
		t.Fatalf("Turn.Title has %d runes, want %d", utf8.RuneCountInString(event.Turn.Title), scrub.DefaultTextLimit)
	}
	if event.Turn.UserPrompt != prompt {
		t.Fatal("Turn.UserPrompt was truncated")
	}
	body, err := json.Marshal(events)
	if err != nil {
		t.Fatalf("marshal events: %v", err)
	}
	if strings.Contains(string(body), `\ufffd`) {
		t.Fatalf("report JSON contains replacement character: %s", body)
	}
}

func TestDecodeHookPayloadAcceptsStringToolResponse(t *testing.T) {
	payload, err := decodeHookPayload([]byte(`{
		"hook_event_name":"PostToolUse",
		"session_id":"sess_1",
		"turn_id":"turn_1",
		"tool_name":"Bash",
		"tool_use_id":"call_1",
		"tool_response":"## main...origin/main\n?? docs/codex_hook_model.md\n"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if payload.ToolResponse.Text() != "## main...origin/main\n?? docs/codex_hook_model.md\n" {
		t.Fatalf("ToolResponse.Text = %q", payload.ToolResponse.Text())
	}
	if payload.ToolResponse.JSONValue() != nil {
		t.Fatalf("ToolResponse.JSONValue = %#v, want nil for plain text", payload.ToolResponse.JSONValue())
	}
}

func TestDecodeHookPayloadParsesJSONStringToolResponse(t *testing.T) {
	payload, err := decodeHookPayload([]byte(`{
		"hook_event_name":"PostToolUse",
		"session_id":"sess_1",
		"turn_id":"turn_1",
		"tool_name":"spawn_agent",
		"tool_use_id":"call_spawn",
		"tool_response":"{\"agent_id\":\"child_1\",\"nickname\":\"Faraday\"}"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	value, ok := payload.ToolResponse.JSONValue().(map[string]any)
	if !ok {
		t.Fatalf("JSONValue = %#v", payload.ToolResponse.JSONValue())
	}
	if value["agent_id"] != "child_1" || value["nickname"] != "Faraday" {
		t.Fatalf("JSONValue = %#v", value)
	}
}

func TestMapHookPreToolUseBashStartsRunningCommandActivity(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName: "PreToolUse",
		SessionID:     "session-1",
		TurnID:        "turn-1",
		ToolUseID:     "tool-1",
		ToolName:      "Bash",
		ToolInput: map[string]any{
			"command": "go test ./...",
			"prompt":  "sensitive prompt",
		},
	}, MapperConfig{AgentID: testMainAgentID, DeviceID: "device_1", Now: fixedTime})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}

	event := events[0]
	if event.AgentID != testMainAgentID {
		t.Fatalf("AgentID = %q, want %s", event.AgentID, testMainAgentID)
	}
	if event.EventType != collectorapi.EventToolCallStarted {
		t.Fatalf("EventType = %q, want %q", event.EventType, collectorapi.EventToolCallStarted)
	}
	if !strings.HasPrefix(event.EventID, "src_") {
		t.Fatalf("EventID = %q, want src_ prefix", event.EventID)
	}
	if event.TurnID != "session-1:turn-1" {
		t.Fatalf("TurnID = %q, want session-1:turn-1", event.TurnID)
	}
	if event.Status != collectorapi.StatusRunningCommands {
		t.Fatalf("Status = %q, want %q", event.Status, collectorapi.StatusRunningCommands)
	}
	if event.Activity == nil {
		t.Fatal("Activity is nil")
	}
	if event.ToolCall == nil {
		t.Fatal("ToolCall is nil")
	}
	if !strings.HasPrefix(event.Activity.ActivityID, "act_") {
		t.Fatalf("ActivityID = %q, want act_ prefix", event.Activity.ActivityID)
	}
	if event.Activity.ActivityType != collectorapi.ActivityRunningCommands {
		t.Fatalf("ActivityType = %q, want %q", event.Activity.ActivityType, collectorapi.ActivityRunningCommands)
	}
	if got := event.Activity.Metadata["command_category"]; got != "test_command" {
		t.Fatalf("command_category = %q, want test_command", got)
	}
	assertNoSensitiveMetadata(t, event.Metadata)
	assertNoSensitiveMetadata(t, event.Activity.Metadata)
}

func TestMapHookKeepsDevelopmentPayloadFields(t *testing.T) {
	tests := []struct {
		name    string
		payload HookPayload
	}{
		{
			name: "user prompt submit",
			payload: HookPayload{
				HookEventName: "UserPromptSubmit",
				SessionID:     "session-1",
				TurnID:        "turn-1",
				Prompt:        "secret user prompt",
				Raw:           map[string]any{"prompt": "secret user prompt"},
			},
		},
		{
			name: "pre tool use",
			payload: HookPayload{
				HookEventName: "PreToolUse",
				SessionID:     "session-1",
				TurnID:        "turn-1",
				ToolUseID:     "tool-1",
				ToolName:      "Bash",
				ToolInput:     map[string]any{"command": "echo secret", "prompt": "secret tool prompt"},
				Raw:           map[string]any{"tool_input": map[string]any{"command": "echo secret"}},
			},
		},
		{
			name: "post tool use",
			payload: mustDecodeHookPayload(t, `{
				"hook_event_name":"PostToolUse",
				"session_id":"session-1",
				"turn_id":"turn-1",
				"tool_use_id":"tool-1",
				"tool_name":"Bash",
				"tool_response":{"stdout":"secret command output","success":true}
			}`),
		},
		{
			name: "stop",
			payload: HookPayload{
				HookEventName:        "Stop",
				SessionID:            "session-1",
				TurnID:               "turn-1",
				LastAssistantMessage: "secret assistant answer",
				Raw:                  map[string]any{"last_assistant_message": "secret assistant answer"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events := MapHook(tt.payload, MapperConfig{DeviceID: "device-1", Now: fixedTime})
			if len(events) == 0 {
				t.Fatal("MapHook returned no events")
			}
			switch tt.name {
			case "user prompt submit":
				event := findEvent(t, events, collectorapi.EventTurnStarted)
				if event.Turn == nil {
					t.Fatal("Turn is nil")
				}
				if event.Turn.Title != "secret user prompt" {
					t.Fatalf("Turn.Title = %q, want secret user prompt", event.Turn.Title)
				}
				if event.Turn.UserPrompt != "secret user prompt" {
					t.Fatalf("Turn.UserPrompt = %q, want secret user prompt", event.Turn.UserPrompt)
				}
			case "pre tool use":
				event := findEvent(t, events, collectorapi.EventToolCallStarted)
				if event.ToolCall == nil {
					t.Fatal("ToolCall is nil")
				}
				if got := event.ToolCall.Input["command"]; got != "echo secret" {
					t.Fatalf("ToolCall.Input[command] = %#v, want echo secret", got)
				}
				if got := event.ToolCall.Input["prompt"]; got != "secret tool prompt" {
					t.Fatalf("ToolCall.Input[prompt] = %#v, want secret tool prompt", got)
				}
			case "post tool use":
				event := findEvent(t, events, collectorapi.EventToolCallCompleted)
				if event.ToolCall == nil {
					t.Fatal("ToolCall is nil")
				}
				response, ok := event.ToolCall.Response.(map[string]any)
				if !ok {
					t.Fatalf("ToolCall.Response = %#v, want map", event.ToolCall.Response)
				}
				if got := response["stdout"]; got != "secret command output" {
					t.Fatalf("ToolCall.Response[stdout] = %#v, want secret command output", got)
				}
				if !strings.Contains(event.ToolCall.ResponseText, "secret command output") {
					t.Fatalf("ToolCall.ResponseText = %q, want command output", event.ToolCall.ResponseText)
				}
			case "stop":
				event := findEvent(t, events, collectorapi.EventTurnCompleted)
				if event.Turn == nil {
					t.Fatal("Turn is nil")
				}
				if event.Turn.LastAssistantMessage != "secret assistant answer" {
					t.Fatalf("Turn.LastAssistantMessage = %q, want secret assistant answer", event.Turn.LastAssistantMessage)
				}
			}
		})
	}
}

func TestMapHookPostToolUseSpawnAgentKeepsResponseAndSubAgent(t *testing.T) {
	payload := mustDecodeHookPayload(t, `{
		"hook_event_name":"PostToolUse",
		"session_id":"session-1",
		"turn_id":"turn-1",
		"tool_use_id":"call_spawn",
		"tool_name":"spawn_agent",
		"tool_response":"{\"agent_id\":\"child_1\",\"nickname\":\"Faraday\",\"transcript\":\"secret child output\"}"
	}`)

	events := MapHook(payload, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 2 {
		t.Fatalf("MapHook returned %d events, want 2", len(events))
	}
	event := findEvent(t, events, collectorapi.EventToolCallCompleted)
	if event.ToolCall == nil {
		t.Fatal("ToolCall is nil")
	}
	response, ok := event.ToolCall.Response.(map[string]any)
	if !ok {
		t.Fatalf("ToolCall.Response = %#v, want map", event.ToolCall.Response)
	}
	if got := response["transcript"]; got != "secret child output" {
		t.Fatalf("ToolCall.Response[transcript] = %#v, want secret child output", got)
	}
	if events[1].SubAgent == nil {
		t.Fatal("SubAgent is nil")
	}
	if events[1].SubAgent.SubAgentID != "child_1" {
		t.Fatalf("SubAgentID = %q, want child_1", events[1].SubAgent.SubAgentID)
	}
	if events[1].SubAgent.Nickname != "Faraday" {
		t.Fatalf("Nickname = %q, want Faraday", events[1].SubAgent.Nickname)
	}
}

func TestMapHookPreToolUseKeepsMainAgentIDWithPayloadAgentFields(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName:  "PreToolUse",
		SessionID:      "session-1",
		TurnID:         "turn-1",
		ToolUseID:      "tool-1",
		ToolName:       "Bash",
		AgentID:        "payload-agent",
		ParentThreadID: "parent-thread",
		ChildThreadID:  "child-thread",
		CodexVersion:   "codex-test",
		CWD:            "/tmp/project",
		ToolInput:      map[string]any{"command": "pwd"},
	}, MapperConfig{AgentID: testMainAgentID, DeviceID: "device_1", Now: fixedTime})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}
	if events[0].AgentID != testMainAgentID {
		t.Fatalf("AgentID = %q, want %s", events[0].AgentID, testMainAgentID)
	}
}

func mustDecodeHookPayload(t *testing.T, raw string) HookPayload {
	t.Helper()
	payload, err := decodeHookPayload([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func findEvent(t *testing.T, events []collectorapi.CollectorEvent, eventType collectorapi.EventType) collectorapi.CollectorEvent {
	t.Helper()
	for _, event := range events {
		if event.EventType == eventType {
			return event
		}
	}
	t.Fatalf("MapHook did not emit %q: %#v", eventType, events)
	return collectorapi.CollectorEvent{}
}

func TestMapHookPreToolUseApplyPatchStartsCoding(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName: "PreToolUse",
		SessionID:     "session-1",
		TurnID:        "turn-1",
		ToolUseID:     "tool-2",
		ToolName:      "apply_patch",
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}
	if events[0].Status != collectorapi.StatusCoding {
		t.Fatalf("Status = %q, want %q", events[0].Status, collectorapi.StatusCoding)
	}
}

func TestMapHookPreToolUseReadStartsReadingFiles(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName: "PreToolUse",
		SessionID:     "session-1",
		TurnID:        "turn-1",
		ToolUseID:     "tool-read",
		ToolName:      "Read",
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}
	if events[0].Status != collectorapi.StatusReadingFiles {
		t.Fatalf("Status = %q, want %q", events[0].Status, collectorapi.StatusReadingFiles)
	}
	if events[0].Activity == nil {
		t.Fatal("Activity is nil")
	}
	if events[0].Activity.ActivityType != collectorapi.ActivityReadingFiles {
		t.Fatalf("ActivityType = %q, want %q", events[0].Activity.ActivityType, collectorapi.ActivityReadingFiles)
	}
}

func TestMapHookPreToolUseMCPStartsCallingBusinessSystem(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName: "PreToolUse",
		SessionID:     "session-1",
		TurnID:        "turn-1",
		ToolUseID:     "tool-mcp",
		ToolName:      "mcp__salesforce__query",
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}
	if events[0].Status != collectorapi.StatusCallingBusinessSystem {
		t.Fatalf("Status = %q, want %q", events[0].Status, collectorapi.StatusCallingBusinessSystem)
	}
	if events[0].Activity == nil {
		t.Fatal("Activity is nil")
	}
	if events[0].Activity.ActivityType != collectorapi.ActivityCallingBusinessSystem {
		t.Fatalf("ActivityType = %q, want %q", events[0].Activity.ActivityType, collectorapi.ActivityCallingBusinessSystem)
	}
	if got := events[0].Activity.Metadata["business_system"]; got != "salesforce" {
		t.Fatalf("business_system = %q, want salesforce", got)
	}
}

func TestMapHookPermissionRequestWaitsForUser(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName: "PermissionRequest",
		SessionID:     "session-1",
		TurnID:        "turn-1",
		ToolUseID:     "tool-3",
		ToolName:      "Bash",
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}
	if events[0].EventType != collectorapi.EventWaitingUser {
		t.Fatalf("EventType = %q, want %q", events[0].EventType, collectorapi.EventWaitingUser)
	}
	if events[0].Status != collectorapi.StatusWaitingUser {
		t.Fatalf("Status = %q, want %q", events[0].Status, collectorapi.StatusWaitingUser)
	}
}

func TestMapHookSubagentStartCreatesAndUpdatesSubAgent(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName: "SubagentStart",
		SessionID:     "session-1",
		TurnID:        "turn-1",
		AgentID:       "child_thread_1",
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 2 {
		t.Fatalf("MapHook returned %d events, want 2", len(events))
	}

	for i, event := range events {
		if event.SubAgentID == nil {
			t.Fatalf("events[%d].SubAgentID is nil", i)
		}
		if *event.SubAgentID != "child_thread_1" {
			t.Fatalf("events[%d].SubAgentID = %q, want child_thread_1", i, *event.SubAgentID)
		}
	}
	if events[0].EventType != collectorapi.EventSubAgentCreated {
		t.Fatalf("first EventType = %q, want %q", events[0].EventType, collectorapi.EventSubAgentCreated)
	}
	if events[1].EventType != collectorapi.EventSubAgentStatusChanged {
		t.Fatalf("second EventType = %q, want %q", events[1].EventType, collectorapi.EventSubAgentStatusChanged)
	}
	if events[0].EventID == events[1].EventID {
		t.Fatalf("EventID duplicated for distinct event types: %q", events[0].EventID)
	}
	if events[0].SourceEvent.SourceEventID == events[1].SourceEvent.SourceEventID {
		t.Fatalf("SourceEventID duplicated for distinct standard events: %q", events[0].SourceEvent.SourceEventID)
	}
}

func TestMapHookPostToolUseSpawnAgentUsesDistinctSourceEventIDs(t *testing.T) {
	payload, err := decodeHookPayload([]byte(`{
		"hook_event_name":"PostToolUse",
		"session_id":"session-1",
		"turn_id":"turn-1",
		"tool_use_id":"call_spawn",
		"tool_name":"spawn_agent",
		"tool_response":"{\"agent_id\":\"child_1\",\"nickname\":\"Faraday\"}"
	}`))
	if err != nil {
		t.Fatal(err)
	}

	events := MapHook(payload, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 2 {
		t.Fatalf("MapHook returned %d events, want 2", len(events))
	}
	if events[0].SourceEvent.SourceEventID == events[1].SourceEvent.SourceEventID {
		t.Fatalf("SourceEventID duplicated for spawn standard events: %q", events[0].SourceEvent.SourceEventID)
	}
}

func TestMapHookSubagentStartUsesConfiguredThreadEdgeWhenPayloadChildMissing(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName:  "SubagentStart",
		SessionID:      "parent-thread",
		TurnID:         "turn-1",
		ParentThreadID: "parent-thread",
	}, MapperConfig{
		DeviceID: "device-1",
		Now:      fixedTime,
		ThreadEdges: []ThreadEdge{
			{
				ParentThreadID: "parent-thread",
				ChildThreadID:  "child-from-sqlite",
				Status:         "open",
			},
		},
	})

	if len(events) != 2 {
		t.Fatalf("MapHook returned %d events, want 2", len(events))
	}
	for i, event := range events {
		if event.SubAgentID == nil {
			t.Fatalf("events[%d].SubAgentID is nil", i)
		}
		if *event.SubAgentID != "child-from-sqlite" {
			t.Fatalf("events[%d].SubAgentID = %q, want child-from-sqlite", i, *event.SubAgentID)
		}
	}
}

func TestMapHookSubagentToolUseKeepsSubAgentScopeAndStatus(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName:  "PreToolUse",
		SessionID:      "child-thread",
		TurnID:         "turn-1",
		ToolUseID:      "tool-read",
		ToolName:       "Read",
		ParentThreadID: "parent-thread",
	}, MapperConfig{
		DeviceID: "device-1",
		Now:      fixedTime,
		ThreadEdges: []ThreadEdge{
			{
				ParentThreadID: "parent-thread",
				ChildThreadID:  "child-thread",
				Status:         "open",
			},
		},
	})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}
	if events[0].SubAgentID == nil {
		t.Fatal("SubAgentID is nil")
	}
	if *events[0].SubAgentID != "child-thread" {
		t.Fatalf("SubAgentID = %q, want child-thread", *events[0].SubAgentID)
	}
	if events[0].Status != collectorapi.StatusReadingFiles {
		t.Fatalf("Status = %q, want %q", events[0].Status, collectorapi.StatusReadingFiles)
	}
	if events[0].Activity == nil {
		t.Fatal("Activity is nil")
	}
	if events[0].Activity.Title != "Reading files" {
		t.Fatalf("Activity.Title = %q, want Reading files", events[0].Activity.Title)
	}
}

// 真实 Codex 日志里子 agent 的工具/turn hook 不带 child_thread_id，
// 只带 agent_id。MapHook 必须据此把事件归属到 child agent，否则子 agent
// 状态无法推进，会一直停留在创建时的 thinking。
func TestMapHookSubagentToolUseUsesAgentIDWithoutThreadEdges(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName: "PreToolUse",
		SessionID:     "019ea5dd-86f7",
		TurnID:        "019ea5dd-fd9a",
		ToolUseID:     "call_exVMSop2",
		ToolName:      "Bash",
		AgentID:       "019ea5dd-fc33",
		ToolInput:     map[string]any{"command": "git status"},
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}
	if events[0].SubAgentID == nil {
		t.Fatal("SubAgentID is nil; child-agent tool hook was misattributed to main agent")
	}
	if *events[0].SubAgentID != "019ea5dd-fc33" {
		t.Fatalf("SubAgentID = %q, want 019ea5dd-fc33", *events[0].SubAgentID)
	}
	if events[0].Status != collectorapi.StatusRunningCommands {
		t.Fatalf("Status = %q, want %q", events[0].Status, collectorapi.StatusRunningCommands)
	}
}

func TestMapHookPreToolUseUnknownFallsBackToThinking(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName: "PreToolUse",
		SessionID:     "session-1",
		TurnID:        "turn-1",
		ToolUseID:     "tool-4",
		ToolName:      "Unknown",
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	if len(events) != 1 {
		t.Fatalf("MapHook returned %d events, want 1", len(events))
	}
	if events[0].Status != collectorapi.StatusThinking {
		t.Fatalf("Status = %q, want %q", events[0].Status, collectorapi.StatusThinking)
	}
}

func TestMapHookPostToolUseFailureMapsToAgentError(t *testing.T) {
	tests := []struct {
		name         string
		toolResponse map[string]any
	}{
		{
			name: "success false",
			toolResponse: map[string]any{
				"success": false,
			},
		},
		{
			name: "exit status non zero",
			toolResponse: map[string]any{
				"exit_status": 1,
			},
		},
		{
			name: "ok false",
			toolResponse: map[string]any{
				"ok": false,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response, err := json.Marshal(tt.toolResponse)
			if err != nil {
				t.Fatal(err)
			}
			payload, err := decodeHookPayload([]byte(`{
				"hook_event_name":"PostToolUse",
				"session_id":"session-1",
				"turn_id":"turn-1",
				"tool_use_id":"tool-5",
				"tool_name":"Bash",
				"tool_response":` + string(response) + `
			}`))
			if err != nil {
				t.Fatal(err)
			}
			events := MapHook(payload, MapperConfig{DeviceID: "device-1", Now: fixedTime})

			if len(events) != 1 {
				t.Fatalf("MapHook returned %d events, want 1", len(events))
			}
			if events[0].EventType != collectorapi.EventToolCallFailed {
				t.Fatalf("EventType = %q, want %q", events[0].EventType, collectorapi.EventToolCallFailed)
			}
			if events[0].Status != collectorapi.StatusError {
				t.Fatalf("Status = %q, want %q", events[0].Status, collectorapi.StatusError)
			}
		})
	}
}

func TestMapHookStopUpdatesSessionToIdle(t *testing.T) {
	events := MapHook(HookPayload{
		HookEventName:        "Stop",
		SessionID:            "session-1",
		TurnID:               "turn-1",
		LastAssistantMessage: "done",
	}, MapperConfig{DeviceID: "device-1", Now: fixedTime})

	var found bool
	for _, event := range events {
		if event.EventType != collectorapi.EventSessionUpdated {
			continue
		}
		found = true
		if event.SessionID != "session-1" {
			t.Fatalf("SessionID = %q, want session-1", event.SessionID)
		}
		if event.Status != collectorapi.StatusIdle {
			t.Fatalf("Status = %q, want %q", event.Status, collectorapi.StatusIdle)
		}
		if event.Session == nil {
			t.Fatal("Session is nil")
		}
		if event.Session.Status != collectorapi.StatusIdle {
			t.Fatalf("Session.Status = %q, want %q", event.Session.Status, collectorapi.StatusIdle)
		}
	}
	if !found {
		t.Fatalf("MapHook did not emit %q: %#v", collectorapi.EventSessionUpdated, events)
	}
}

func TestHookServerAcceptsCodexHook(t *testing.T) {
	accepted := make(chan struct{})
	sink := &memorySink{accepted: accepted}
	server := NewHookServer(MapperConfig{DeviceID: "device_1", Now: fixedTime}, sink, nil)
	request := httptest.NewRequest(http.MethodPost, "/ingest/codex", strings.NewReader(`{
		"hook_event_name": "PreToolUse",
		"session_id": "session-1",
		"turn_id": "turn-1",
		"tool_use_id": "tool-read",
		"tool_name": "Read"
	}`))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusAccepted)
	}

	select {
	case <-accepted:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("sink.Accept was not called")
	}

	if got := sink.Len(); got != 1 {
		t.Fatalf("sink.events length = %d, want 1", got)
	}
}

func TestHookServerDoesNotServeOldCodexHooksPath(t *testing.T) {
	sink := &memorySink{}
	server := NewHookServer(MapperConfig{DeviceID: "device_1", Now: fixedTime}, sink, nil)
	request := httptest.NewRequest(http.MethodPost, "/codex/hooks", strings.NewReader(`{
		"hook_event_name": "PreToolUse",
		"session_id": "session-1",
		"turn_id": "turn-1",
		"tool_use_id": "tool-read",
		"tool_name": "Read"
	}`))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNotFound)
	}
	if got := sink.Len(); got != 0 {
		t.Fatalf("sink.events length = %d, want 0", got)
	}
}

func TestHookServerReturnsAcceptedWithoutWaitingForSink(t *testing.T) {
	sink := &blockingSink{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	server := NewHookServer(MapperConfig{DeviceID: "device_1", Now: fixedTime}, sink, nil)
	request := httptest.NewRequest(http.MethodPost, "/ingest/codex", strings.NewReader(`{
		"hook_event_name": "PreToolUse",
		"session_id": "session-1",
		"turn_id": "turn-1",
		"tool_use_id": "tool-read",
		"tool_name": "Read"
	}`))
	response := httptest.NewRecorder()
	done := make(chan struct{})

	go func() {
		server.Handler().ServeHTTP(response, request)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		close(sink.release)
		t.Fatal("handler waited for sink.Accept")
	}
	defer close(sink.release)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusAccepted)
	}

	select {
	case <-sink.started:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("sink.Accept was not started")
	}
}

type rawIngestRecorder struct {
	agentType string
	path      string
	body      string
	calls     int
}

func (r *rawIngestRecorder) RawIngest(agentType string, path string, body []byte) {
	r.agentType = agentType
	r.path = path
	r.body = string(body)
	r.calls++
}

func TestHookServerLogsRawCodexHookBeforeMapping(t *testing.T) {
	sink := &memorySink{}
	recorder := &rawIngestRecorder{}
	server := NewHookServer(MapperConfig{DeviceID: "device_1", Now: fixedTime}, sink, recorder)
	body := `{
		"hook_event_name": "PreToolUse",
		"session_id": "session-1",
		"turn_id": "turn-1",
		"tool_name": "Bash",
		"tool_input": {"command": "echo secret"}
	}`
	request := httptest.NewRequest(http.MethodPost, "/ingest/codex", strings.NewReader(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusAccepted)
	}
	if recorder.calls != 1 {
		t.Fatalf("raw ingest calls = %d, want 1", recorder.calls)
	}
	if recorder.agentType != "codex" {
		t.Fatalf("agentType = %q, want codex", recorder.agentType)
	}
	if recorder.path != "/ingest/codex" {
		t.Fatalf("path = %q, want /ingest/codex", recorder.path)
	}
	if recorder.body != body {
		t.Fatalf("body = %q, want original body", recorder.body)
	}
}

func TestHookServerRecordsDebugChainForAcceptedPayload(t *testing.T) {
	sink := &memorySink{}
	store := debugstore.New(debugstore.Config{Capacity: 50, Now: func() time.Time { return fixedTime }})
	server := NewHookServerWithDebug(MapperConfig{DeviceID: "device_1", Now: fixedTime}, sink, nil, store)
	body := `{
		"hook_event_name": "PreToolUse",
		"session_id": "session-1",
		"turn_id": "turn-1",
		"tool_use_id": "tool-read",
		"tool_name": "Read"
	}`
	request := httptest.NewRequest(http.MethodPost, "/ingest/codex", strings.NewReader(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusAccepted)
	}
	state := store.State(50)
	if len(state.RecentChains) != 1 {
		t.Fatalf("chains len = %d, want 1", len(state.RecentChains))
	}
	chain := state.RecentChains[0]
	if chain.RawPayload != body {
		t.Fatalf("raw payload = %s", chain.RawPayload)
	}
	if chain.ParseStatus != debugstore.ParseStatusSuccess {
		t.Fatalf("parse status = %s", chain.ParseStatus)
	}
	if chain.MapStatus != debugstore.MapStatusSuccess {
		t.Fatalf("map status = %s", chain.MapStatus)
	}
	if len(chain.MappedEvents) == 0 {
		t.Fatal("expected mapped events")
	}
}

func TestHookServerRecordsDebugChainForInvalidPayload(t *testing.T) {
	store := debugstore.New(debugstore.Config{Capacity: 50, Now: func() time.Time { return fixedTime }})
	server := NewHookServerWithDebug(MapperConfig{DeviceID: "device_1", Now: fixedTime}, &memorySink{}, nil, store)
	body := `{"hook_event_name":`
	request := httptest.NewRequest(http.MethodPost, "/ingest/codex", strings.NewReader(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	state := store.State(50)
	if len(state.RecentChains) != 1 {
		t.Fatalf("chains len = %d, want 1", len(state.RecentChains))
	}
	chain := state.RecentChains[0]
	if chain.RawPayload != body {
		t.Fatalf("raw payload = %s", chain.RawPayload)
	}
	if chain.ParseStatus != debugstore.ParseStatusFailed {
		t.Fatalf("parse status = %s", chain.ParseStatus)
	}
	if chain.ParseError == "" {
		t.Fatal("expected parse error")
	}
}

func TestHookServerLogsInvalidRawCodexHookBeforeBadRequest(t *testing.T) {
	sink := &memorySink{}
	recorder := &rawIngestRecorder{}
	server := NewHookServer(MapperConfig{DeviceID: "device_1", Now: fixedTime}, sink, recorder)
	body := `{"hook_event_name":`
	request := httptest.NewRequest(http.MethodPost, "/ingest/codex", strings.NewReader(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if recorder.calls != 1 {
		t.Fatalf("raw ingest calls = %d, want 1", recorder.calls)
	}
	if recorder.body != body {
		t.Fatalf("body = %q, want invalid raw body", recorder.body)
	}
	if got := sink.Len(); got != 0 {
		t.Fatalf("sink.events length = %d, want 0", got)
	}
}

func TestHookServerRejectsTrailingRawCodexHookBeforeMapping(t *testing.T) {
	sink := &memorySink{}
	recorder := &rawIngestRecorder{}
	server := NewHookServer(MapperConfig{DeviceID: "device_1", Now: fixedTime}, sink, recorder)
	body := `{"hook_event_name":"PreToolUse","session_id":"session-1"} trailing`
	request := httptest.NewRequest(http.MethodPost, "/ingest/codex", strings.NewReader(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if recorder.calls != 1 {
		t.Fatalf("raw ingest calls = %d, want 1", recorder.calls)
	}
	if recorder.body != body {
		t.Fatalf("body = %q, want trailing raw body", recorder.body)
	}
	if got := sink.Len(); got != 0 {
		t.Fatalf("sink.events length = %d, want 0", got)
	}
}

type memorySink struct {
	mu       sync.Mutex
	accepted chan struct{}
	events   []collectorapi.CollectorEvent
}

func (s *memorySink) Accept(events []collectorapi.CollectorEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.events = append(s.events, events...)
	if s.accepted != nil {
		close(s.accepted)
		s.accepted = nil
	}
}

func (s *memorySink) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return len(s.events)
}

type blockingSink struct {
	once    sync.Once
	started chan struct{}
	release chan struct{}
}

func (s *blockingSink) Accept(events []collectorapi.CollectorEvent) {
	s.once.Do(func() {
		close(s.started)
	})
	<-s.release
}

func assertNoSensitiveMetadata(t *testing.T, metadata map[string]string) {
	t.Helper()

	for key, value := range metadata {
		if key == "prompt" || key == "command" || value == "sensitive prompt" || value == "go test ./..." {
			t.Fatalf("metadata leaked sensitive value: %q=%q", key, value)
		}
	}
}
