package claweeactivity

import (
	"encoding/json"
	"testing"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestMapEventMaterializesRunContentWithStableDerivedIDs(t *testing.T) {
	req := validRequest(`{"prompt":"检查测试","created_by":"api","workspace_name":"claw-mcp"}`)
	req.Events[0].EventType = "run_started"
	if err := ValidateAndSanitize(&req); err != nil {
		t.Fatal(err)
	}
	events, err := MapEvent(req.Events[0], "trusted-agent")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("mapped events = %d", len(events))
	}
	if events[1].EventType != collectorapi.EventTurnStarted || events[1].Turn == nil || events[1].Turn.UserPrompt != "检查测试" {
		t.Fatalf("turn event = %#v", events[1])
	}
	for _, event := range events {
		if event.AgentID != "trusted-agent" || event.SourceEvent == nil || event.SourceEvent.RawPayload == nil {
			t.Fatalf("mapped ownership/source = %#v", event)
		}
		if event.EventID != req.Events[0].EventID+":"+string(event.EventType) {
			t.Fatalf("event id = %q", event.EventID)
		}
	}
}

func TestMapEventStoresApprovalParsedPayloadOnlyOnCarrier(t *testing.T) {
	req := validRequest(`{"approval":{"id":"approval_1","status":"pending","title":"执行命令","summary":"需要确认","details":{"risk":"high"}}}`)
	req.Events[0].EventType = "approval"
	if err := ValidateAndSanitize(&req); err != nil {
		t.Fatal(err)
	}
	events, err := MapEvent(req.Events[0], "agent_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].SourceEvent.ParsedPayload != nil || events[1].SourceEvent.ParsedPayload == nil {
		t.Fatalf("approval carriers = %#v", events)
	}
	encoded, _ := json.Marshal(events[1].SourceEvent.ParsedPayload)
	if string(encoded) == "{}" {
		t.Fatal("parsed payload is empty")
	}
}

func TestMapEventMaterializesMCPInputAndResult(t *testing.T) {
	use := validRequest(`{"toolCallId":"mcp_1","name":"crm__lookup","input":{"arguments":{"customer":"A"}}}`)
	use.Events[0].EventType = "tool_use"
	if err := ValidateAndSanitize(&use); err != nil {
		t.Fatal(err)
	}
	started, err := MapEvent(use.Events[0], "agent_1")
	if err != nil {
		t.Fatal(err)
	}
	if started[0].ToolCall == nil || started[0].ToolCall.ToolType != "calling_business_system" {
		t.Fatalf("started tool = %#v", started[0].ToolCall)
	}

	result := validRequest(`{"toolCallId":"mcp_1","output":"done","response":{"count":1},"isError":false,"durationMs":12}`)
	result.Events[0].EventType = "tool_result"
	if err := ValidateAndSanitize(&result); err != nil {
		t.Fatal(err)
	}
	completed, err := MapEvent(result.Events[0], "agent_1")
	if err != nil {
		t.Fatal(err)
	}
	if completed[0].ToolCall == nil || completed[0].ToolCall.ResponseText != "done" || completed[0].ToolCall.Response == nil ||
		completed[0].ToolCall.ToolType != "calling_business_system" || completed[0].ToolCall.DurationMS != 12 ||
		completed[1].Activity.ActivityType != collectorapi.ActivityCallingBusinessSystem {
		t.Fatalf("completed tool = %#v", completed[0].ToolCall)
	}
}

func TestMapEventMaterializesCommandExitCode(t *testing.T) {
	result := validRequest(`{"toolCallId":"command_1","output":"done","exitCode":7,"isError":true}`)
	result.Events[0].EventType = "tool_result"
	if err := ValidateAndSanitize(&result); err != nil {
		t.Fatal(err)
	}
	completed, err := MapEvent(result.Events[0], "agent_1")
	if err != nil {
		t.Fatal(err)
	}
	response, ok := completed[0].ToolCall.Response.(map[string]any)
	if !ok || response["exit_code"] != float64(7) || completed[0].ToolCall.ToolType != "command" ||
		completed[1].Activity.ActivityType != collectorapi.ActivityRunningCommands {
		t.Fatalf("command result = %#v", completed)
	}
}

func TestMapEventMaterializesErrorAgentStateAndActivity(t *testing.T) {
	req := validRequest(`{"code":"run_failed","message":"执行失败","details":{"stage":"tool"}}`)
	req.Events[0].EventType = "error"
	if err := ValidateAndSanitize(&req); err != nil {
		t.Fatal(err)
	}
	events, err := MapEvent(req.Events[0], "agent_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].EventType != collectorapi.EventAgentError ||
		events[0].SourceEvent.ParsedPayload == nil {
		t.Fatalf("agent error event = %#v", events)
	}
	if events[1].EventType != collectorapi.EventActivityCompleted || events[1].Activity == nil ||
		events[1].Activity.Title != "Agent 执行错误" || events[1].SourceEvent.ParsedPayload != nil {
		t.Fatalf("error activity event = %#v", events[1])
	}
}
