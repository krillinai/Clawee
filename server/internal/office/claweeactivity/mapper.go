package claweeactivity

import (
	"fmt"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func MapEvent(input ActivityEvent, agentID string) ([]collectorapi.CollectorEvent, error) {
	payload, err := decodePayload(input)
	if err != nil {
		return nil, err
	}
	base := func(eventType collectorapi.EventType, status collectorapi.Status) collectorapi.CollectorEvent {
		id := input.EventID + ":" + string(eventType)
		return collectorapi.CollectorEvent{
			EventID: id, EventType: eventType, SourceType: collectorSourceType, SourceEventType: input.EventType,
			OccurredAt: input.OccurredAt, AgentID: agentID, AgentType: collectorapi.AgentTypeCodex,
			SessionID: input.SessionID, TurnID: input.TurnID, Status: status,
			SourceEvent: &collectorapi.SourceEventSummary{
				SourceEventID: id, SourceType: collectorSourceType, SourceEventType: input.EventType,
				RawPayload: map[string]any{}, ParseStatus: "parsed",
			},
		}
	}
	withParsed := func(event *collectorapi.CollectorEvent) {
		event.SourceEvent.ParsedPayload = payload
	}

	switch input.EventType {
	case "run_started":
		workspace := stringField(payload, "workspace_name")
		prompt := stringField(payload, "prompt")
		session := base(collectorapi.EventSessionUpdated, collectorapi.StatusThinking)
		session.Session = &collectorapi.SessionSummary{
			SessionID: input.SessionID, Status: collectorapi.StatusThinking, WorkspaceName: workspace,
		}
		turn := base(collectorapi.EventTurnStarted, collectorapi.StatusThinking)
		turn.Turn = &collectorapi.TurnSummary{
			TurnID: input.TurnID, SessionID: input.SessionID, UserPrompt: prompt,
			Status: collectorapi.StatusThinking, StartedAt: input.OccurredAt, UpdatedAt: input.OccurredAt,
		}
		activity := base(collectorapi.EventActivityStarted, collectorapi.StatusThinking)
		activity.Activity = activitySummary(input, "thinking", collectorapi.ActivityThinking, "开始处理", prompt, input.OccurredAt, nil)
		return []collectorapi.CollectorEvent{session, turn, activity}, nil

	case "status":
		status := statusFromLabel(stringField(payload, "label"))
		if stringField(payload, "label") == "finalizing" {
			event := base(collectorapi.EventActivityStarted, status)
			event.Activity = activitySummary(input, "summarizing", collectorapi.ActivitySummarizing, "整理回复", "", input.OccurredAt, nil)
			return []collectorapi.CollectorEvent{event}, nil
		}
		event := base(collectorapi.EventTurnUpdated, status)
		event.Turn = turnSummary(input, status)
		return []collectorapi.CollectorEvent{event}, nil

	case "assistant_message":
		event := base(collectorapi.EventTurnUpdated, collectorapi.StatusSummarizing)
		event.Turn = turnSummary(input, event.Status)
		event.Turn.LastAssistantMessage = stringField(payload, "text")
		return []collectorapi.CollectorEvent{event}, nil

	case "reasoning_summary":
		event := base(collectorapi.EventTurnUpdated, collectorapi.StatusThinking)
		event.Turn = turnSummary(input, event.Status)
		event.Turn.AssistantSummary = stringField(payload, "text")
		return []collectorapi.CollectorEvent{event}, nil

	case "tool_use":
		toolCallID := stringField(payload, "toolCallId")
		name := stringField(payload, "name")
		inputPayload, _ := payload["input"].(map[string]any)
		status, activityType, toolType := toolStatus(name)
		tool := base(collectorapi.EventToolCallStarted, status)
		tool.ToolCall = &collectorapi.ToolCallSummary{
			ToolCallID: toolCallID, ExternalToolCallID: toolCallID, SessionID: input.SessionID, TurnID: input.TurnID,
			ToolName: name, ToolType: toolType, Status: "running", Input: inputPayload, StartedAt: input.OccurredAt,
		}
		activity := base(collectorapi.EventActivityStarted, status)
		activity.Activity = activitySummary(input, "tool:"+toolCallID, activityType, toolTitle(name), summarizeToolInput(inputPayload), input.OccurredAt, nil)
		activity.Activity.ToolCallID = toolCallID
		return []collectorapi.CollectorEvent{tool, activity}, nil

	case "tool_result":
		toolCallID := stringField(payload, "toolCallId")
		failed := boolField(payload, "isError")
		_, isCommand := payload["exitCode"]
		activityType := collectorapi.ActivityCallingBusinessSystem
		toolType := "calling_business_system"
		response := payload["response"]
		if isCommand {
			activityType = collectorapi.ActivityRunningCommands
			toolType = "command"
			response = map[string]any{"exit_code": payload["exitCode"]}
		}
		standardType := collectorapi.EventToolCallCompleted
		toolStatusValue := "completed"
		agentStatus := collectorapi.StatusThinking
		if failed {
			standardType = collectorapi.EventToolCallFailed
			toolStatusValue = "failed"
			agentStatus = collectorapi.StatusError
		}
		completedAt := input.OccurredAt
		tool := base(standardType, agentStatus)
		tool.ToolCall = &collectorapi.ToolCallSummary{
			ToolCallID: toolCallID, ExternalToolCallID: toolCallID, SessionID: input.SessionID, TurnID: input.TurnID,
			ToolType: toolType, Status: toolStatusValue, Response: response, ResponseText: stringField(payload, "output"),
			StartedAt: input.OccurredAt, CompletedAt: &completedAt, DurationMS: int64Field(payload, "durationMs"),
		}
		activity := base(collectorapi.EventActivityCompleted, agentStatus)
		activity.Activity = activitySummary(input, "tool:"+toolCallID, activityType, "工具调用完成", stringField(payload, "output"), input.OccurredAt, &completedAt)
		activity.Activity.ToolCallID = toolCallID
		return []collectorapi.CollectorEvent{tool, activity}, nil

	case "file_change":
		completed := stringField(payload, "status") != "in_progress"
		standardType := collectorapi.EventActivityStarted
		var completedAt *time.Time
		if completed {
			standardType = collectorapi.EventActivityCompleted
			at := input.OccurredAt
			completedAt = &at
		}
		event := base(standardType, collectorapi.StatusCoding)
		event.Activity = activitySummary(input, "file", collectorapi.ActivityCoding, "修改文件", summarizeFileChanges(payload["changes"]), input.OccurredAt, completedAt)
		withParsed(&event)
		return []collectorapi.CollectorEvent{event}, nil

	case "approval":
		approval, _ := payload["approval"].(map[string]any)
		approvalID := stringField(approval, "id")
		if approvalID == "" {
			approvalID = input.EventID
		}
		title := stringField(approval, "title")
		summary := stringField(approval, "summary")
		if stringField(approval, "status") == "pending" {
			waiting := base(collectorapi.EventWaitingUser, collectorapi.StatusWaitingUser)
			activity := base(collectorapi.EventActivityStarted, collectorapi.StatusWaitingUser)
			activity.Activity = activitySummary(input, "approval:"+approvalID, collectorapi.ActivityThinking, title, summary, input.OccurredAt, nil)
			withParsed(&activity)
			return []collectorapi.CollectorEvent{waiting, activity}, nil
		}
		completedAt := input.OccurredAt
		activity := base(collectorapi.EventActivityCompleted, collectorapi.StatusThinking)
		activity.Activity = activitySummary(input, "approval:"+approvalID, collectorapi.ActivityThinking, title, summary, input.OccurredAt, &completedAt)
		withParsed(&activity)
		turn := base(collectorapi.EventTurnUpdated, collectorapi.StatusThinking)
		turn.Turn = turnSummary(input, collectorapi.StatusThinking)
		return []collectorapi.CollectorEvent{activity, turn}, nil

	case "diagnostic":
		status := collectorapi.StatusThinking
		if stringField(payload, "severity") == "error" {
			status = collectorapi.StatusError
		}
		event := base(collectorapi.EventSourceEventReceived, status)
		withParsed(&event)
		return []collectorapi.CollectorEvent{event}, nil

	case "error":
		agentError := base(collectorapi.EventAgentError, collectorapi.StatusError)
		withParsed(&agentError)
		activity := base(collectorapi.EventActivityCompleted, collectorapi.StatusError)
		activity.Activity = activitySummary(input, "error", collectorapi.ActivityThinking, "Agent 执行错误", stringField(payload, "message"), input.OccurredAt, pointerTime(input.OccurredAt))
		return []collectorapi.CollectorEvent{agentError, activity}, nil

	case "done":
		status := collectorapi.StatusIdle
		if stringField(payload, "status") == "failed" {
			status = collectorapi.StatusError
		}
		completedAt := input.OccurredAt
		turn := base(collectorapi.EventTurnCompleted, status)
		turn.Turn = turnSummary(input, status)
		turn.Turn.CompletedAt = &completedAt
		activity := base(collectorapi.EventActivityCompleted, status)
		activity.Activity = activitySummary(input, "thinking", collectorapi.ActivityThinking, "处理完成", stringField(payload, "terminationReason"), input.OccurredAt, &completedAt)
		session := base(collectorapi.EventSessionUpdated, status)
		session.Session = &collectorapi.SessionSummary{SessionID: input.SessionID, Status: status}
		return []collectorapi.CollectorEvent{turn, activity, session}, nil
	default:
		return nil, fmt.Errorf("unsupported event type %q", input.EventType)
	}
}

func turnSummary(input ActivityEvent, status collectorapi.Status) *collectorapi.TurnSummary {
	return &collectorapi.TurnSummary{
		TurnID: input.TurnID, SessionID: input.SessionID, Status: status,
		StartedAt: input.OccurredAt, UpdatedAt: input.OccurredAt,
	}
}

func activitySummary(input ActivityEvent, suffix string, activityType collectorapi.ActivityType, title, summary string, startedAt time.Time, completedAt *time.Time) *collectorapi.ActivitySummary {
	return &collectorapi.ActivitySummary{
		ActivityID: input.RunID + ":" + suffix, SessionID: input.SessionID, TurnID: input.TurnID,
		ActivityType: activityType, Title: title, Summary: summary, StartedAt: startedAt, CompletedAt: completedAt,
	}
}

func statusFromLabel(label string) collectorapi.Status {
	if label == "finalizing" {
		return collectorapi.StatusSummarizing
	}
	return collectorapi.StatusThinking
}

func toolStatus(name string) (collectorapi.Status, collectorapi.ActivityType, string) {
	if name == "command_execution" {
		return collectorapi.StatusRunningCommands, collectorapi.ActivityRunningCommands, "command"
	}
	return collectorapi.StatusCallingBusinessSystem, collectorapi.ActivityCallingBusinessSystem, "calling_business_system"
}

func toolTitle(name string) string {
	if name == "command_execution" {
		return "执行命令"
	}
	return "调用 " + name
}

func summarizeToolInput(input map[string]any) string {
	if command, ok := input["command"].(string); ok {
		return command
	}
	return ""
}

func summarizeFileChanges(value any) string {
	changes, _ := value.([]any)
	parts := make([]string, 0, len(changes))
	for _, value := range changes {
		change, _ := value.(map[string]any)
		path := stringField(change, "path")
		kind := stringField(change, "kind")
		if path != "" {
			parts = append(parts, strings.TrimSpace(kind+" "+path))
		}
	}
	return strings.Join(parts, "\n")
}

func pointerTime(value time.Time) *time.Time {
	return &value
}
