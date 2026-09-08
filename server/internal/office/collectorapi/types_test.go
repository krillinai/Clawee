package collectorapi

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRegistrationRequestJSON(t *testing.T) {
	body := []byte(`{
		"schema_version":"collector.v1",
		"registration_code":"ABCD-1234",
		"agent_id":"clawee_agent_1",
		"device_name":"xugang-macbook",
		"hostname":"xugang-macbook.local",
		"os":"darwin",
		"arch":"arm64",
		"collector_version":"0.1.0",
		"agents":[{
			"agent_type":"codex",
			"agent_id":"codex-local-001",
			"display_name":"Codex Local",
			"version":"0.1.0",
			"workspace_name":"claw-mcp",
			"metadata":{"source":"local_discovery"}
		}]
	}`)

	var req RegistrationRequest
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatal(err)
	}
	if req.SchemaVersion != SchemaVersion {
		t.Fatalf("SchemaVersion = %q", req.SchemaVersion)
	}
	if req.RegistrationCode != "ABCD-1234" {
		t.Fatalf("RegistrationCode = %q", req.RegistrationCode)
	}
	if req.AgentID != "clawee_agent_1" {
		t.Fatalf("AgentID = %q", req.AgentID)
	}
	if req.DeviceName != "xugang-macbook" {
		t.Fatalf("DeviceName = %q", req.DeviceName)
	}
	if req.Hostname != "xugang-macbook.local" {
		t.Fatalf("Hostname = %q", req.Hostname)
	}
	if req.OS != "darwin" {
		t.Fatalf("OS = %q", req.OS)
	}
	if req.Arch != "arm64" {
		t.Fatalf("Arch = %q", req.Arch)
	}
	if req.CollectorVersion != "0.1.0" {
		t.Fatalf("CollectorVersion = %q", req.CollectorVersion)
	}
	if len(req.Agents) != 1 {
		t.Fatalf("len(Agents) = %d", len(req.Agents))
	}
	agent := req.Agents[0]
	if agent.AgentType != AgentTypeCodex {
		t.Fatalf("AgentType = %q", agent.AgentType)
	}
	if agent.AgentID != "codex-local-001" {
		t.Fatalf("AgentID = %q", agent.AgentID)
	}
	if agent.DisplayName != "Codex Local" {
		t.Fatalf("DisplayName = %q", agent.DisplayName)
	}
	if agent.Version != "0.1.0" {
		t.Fatalf("Version = %q", agent.Version)
	}
	if agent.WorkspaceName != "claw-mcp" {
		t.Fatalf("WorkspaceName = %q", agent.WorkspaceName)
	}
	if agent.Metadata["source"] != "local_discovery" {
		t.Fatalf("metadata = %#v", agent.Metadata)
	}
}

func TestRegistrationResponseJSON(t *testing.T) {
	resp := RegistrationResponse{
		CollectorID:    "collector_123",
		CollectorToken: "collector_token",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	}

	body, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}

	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got["collector_id"] != "collector_123" {
		t.Fatalf("collector_id = %#v", got["collector_id"])
	}
	if got["collector_token"] != "collector_token" {
		t.Fatalf("collector_token = %#v", got["collector_token"])
	}
	if got["device_id"] != "device_123" {
		t.Fatalf("device_id = %#v", got["device_id"])
	}
	if got["privacy_mode"] != "summary_only" {
		t.Fatalf("privacy_mode = %#v", got["privacy_mode"])
	}
	if _, ok := got["expires_at"]; ok {
		t.Fatalf("expires_at should be omitted when nil: %s", body)
	}
}

func TestEventsRequestStandardTurnToolActivitySourceJSON(t *testing.T) {
	body := []byte(`{
		"schema_version":"collector.v1",
		"collector_id":"collector_1",
		"device_id":"device_1",
		"sent_at":"2026-06-08T06:14:09Z",
		"events":[{
			"event_id":"evt_spawn_done",
			"event_type":"tool_call_completed",
			"source_type":"codex",
			"source_event_type":"PostToolUse",
			"occurred_at":"2026-06-08T06:14:09Z",
			"agent_id":"codex:device_1:main",
			"agent_type":"codex",
			"session_id":"019ea5dd-86f7-7cc0-9ac1-2a36ddeb316a",
			"turn_id":"019ea5dd-86f7-7cc0-9ac1-2a36ddeb316a:019ea5dd-cdc3-7762-995e-b425a3a4d295",
			"status":"thinking",
			"turn":{
				"turn_id":"019ea5dd-86f7-7cc0-9ac1-2a36ddeb316a:019ea5dd-cdc3-7762-995e-b425a3a4d295",
				"session_id":"019ea5dd-86f7-7cc0-9ac1-2a36ddeb316a",
				"title":"Check git status",
				"user_prompt":"check git status",
				"last_assistant_message":"Spawning Faraday to check git status",
				"status":"thinking",
				"started_at":"2026-06-08T06:14:09Z",
				"updated_at":"2026-06-08T06:14:09Z"
			},
			"tool_call":{
				"tool_call_id":"tool_1",
				"external_tool_call_id":"call_rRrgdACTTmVM188SGsgoh7UX",
				"tool_name":"spawn_agent",
				"tool_type":"agent_collaboration",
				"status":"completed",
				"input":{"message":"check git status","fork_context":true},
				"response":{"agent_id":"019ea5dd-fc33-7681-a6e1-3a2f797ef5f9","nickname":"Faraday"},
				"response_text":"{\"agent_id\":\"019ea5dd-fc33-7681-a6e1-3a2f797ef5f9\",\"nickname\":\"Faraday\"}",
				"started_at":"2026-06-08T06:14:09Z",
				"completed_at":"2026-06-08T06:14:09Z"
			},
			"activity":{
				"activity_id":"act_1",
				"activity_type":"agent_collaboration",
				"tool_call_id":"tool_1",
				"title":"Spawn sub agent",
				"summary":"Faraday",
				"started_at":"2026-06-08T06:14:09Z",
				"completed_at":"2026-06-08T06:14:09Z"
			},
			"sub_agent":{
				"sub_agent_id":"019ea5dd-fc33-7681-a6e1-3a2f797ef5f9",
				"parent_agent_id":"codex:device_1:main",
				"session_id":"019ea5dd-86f7-7cc0-9ac1-2a36ddeb316a",
				"parent_turn_id":"019ea5dd-86f7-7cc0-9ac1-2a36ddeb316a:019ea5dd-cdc3-7762-995e-b425a3a4d295",
				"spawn_tool_call_id":"tool_1",
				"name":"Faraday",
				"nickname":"Faraday",
				"status":"thinking",
				"started_at":"2026-06-08T06:14:09Z",
				"updated_at":"2026-06-08T06:14:09Z"
			},
			"source_event":{
				"source_event_id":"src_1",
				"source_type":"codex",
				"source_event_type":"PostToolUse",
				"raw_payload":{"hook_event_name":"PostToolUse","tool_name":"spawn_agent"}
			}
		}]
	}`)

	var req EventsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatal(err)
	}
	if len(req.Events) != 1 {
		t.Fatalf("events len = %d, want 1", len(req.Events))
	}
	event := req.Events[0]
	if event.EventType != EventToolCallCompleted {
		t.Fatalf("EventType = %q, want %q", event.EventType, EventToolCallCompleted)
	}
	if event.TurnID != "019ea5dd-86f7-7cc0-9ac1-2a36ddeb316a:019ea5dd-cdc3-7762-995e-b425a3a4d295" {
		t.Fatalf("TurnID = %q", event.TurnID)
	}
	if event.Turn == nil || event.Turn.TurnID != event.TurnID {
		t.Fatalf("Turn = %#v", event.Turn)
	}
	if event.Turn.UserPrompt != "check git status" {
		t.Fatalf("Turn.UserPrompt = %q", event.Turn.UserPrompt)
	}
	if event.Turn.LastAssistantMessage != "Spawning Faraday to check git status" {
		t.Fatalf("Turn.LastAssistantMessage = %q", event.Turn.LastAssistantMessage)
	}
	if event.ToolCall == nil || event.ToolCall.ExternalToolCallID != "call_rRrgdACTTmVM188SGsgoh7UX" {
		t.Fatalf("ToolCall = %#v", event.ToolCall)
	}
	if event.Activity == nil || event.Activity.ToolCallID != "tool_1" {
		t.Fatalf("Activity = %#v", event.Activity)
	}
	if event.SubAgent == nil || event.SubAgent.Nickname != "Faraday" {
		t.Fatalf("SubAgent = %#v", event.SubAgent)
	}
	if event.SourceEvent == nil || event.SourceEvent.SourceEventType != "PostToolUse" {
		t.Fatalf("SourceEvent = %#v", event.SourceEvent)
	}
}

func TestCollectorAPIStandardTypesHaveNoLegacyTaskFields(t *testing.T) {
	legacyFieldNames := []string{"TaskID", "CurrentTaskID", "Tasks"}
	legacyJSONTags := []string{"task_id", "current_task", "tasks"}

	for _, typ := range []reflect.Type{
		reflect.TypeOf(CollectorEvent{}),
		reflect.TypeOf(AgentSummary{}),
	} {
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			for _, legacyFieldName := range legacyFieldNames {
				if strings.Contains(field.Name, legacyFieldName) {
					t.Fatalf("%s has legacy field %s", typ.Name(), field.Name)
				}
			}
			jsonTag := field.Tag.Get("json")
			for _, legacyJSONTag := range legacyJSONTags {
				if strings.Contains(jsonTag, legacyJSONTag) {
					t.Fatalf("%s.%s has legacy json tag %q", typ.Name(), field.Name, jsonTag)
				}
			}
		}
	}
}
