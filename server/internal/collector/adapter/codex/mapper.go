package codex

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/scrub"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type MapperConfig struct {
	AgentID     string
	DeviceID    string
	Now         time.Time
	ThreadEdges []ThreadEdge
}

type toolClass struct {
	status       collectorapi.Status
	activityType collectorapi.ActivityType
	toolType     string
	title        string
	metadata     map[string]string
}

func MapHook(payload HookPayload, config MapperConfig) []collectorapi.CollectorEvent {
	switch payload.HookEventName {
	case "SessionStart":
		return []collectorapi.CollectorEvent{
			baseEvent(payload, config, collectorapi.EventAgentSeen, collectorapi.StatusIdle),
			baseEvent(payload, config, collectorapi.EventSessionStarted, collectorapi.StatusThinking),
		}
	case "UserPromptSubmit":
		turnEvent := baseEvent(payload, config, collectorapi.EventTurnStarted, collectorapi.StatusThinking)
		turnEvent.Turn = &collectorapi.TurnSummary{
			TurnID:     turnID(payload),
			SessionID:  payload.SessionID,
			SubAgentID: subAgentID(payload, config),
			Title:      scrub.LimitText(payload.Prompt, scrub.DefaultTextLimit),
			UserPrompt: payload.Prompt,
			Status:     collectorapi.StatusThinking,
			StartedAt:  eventTime(config),
			UpdatedAt:  eventTime(config),
		}
		activityEvent := baseEvent(payload, config, collectorapi.EventActivityStarted, collectorapi.StatusThinking)
		activityEvent.Activity = thinkingActivity(payload, config)
		return []collectorapi.CollectorEvent{turnEvent, activityEvent}
	case "PreToolUse":
		class := classifyTool(payload)
		event := baseEvent(payload, config, collectorapi.EventToolCallStarted, class.status)
		event.ToolCall = toolCallSummary(payload, config, "running", false)
		event.Activity = activityForTool(payload, config, event.ToolCall, false)
		return []collectorapi.CollectorEvent{event}
	case "PostToolUse":
		eventType := collectorapi.EventToolCallCompleted
		status := collectorapi.StatusThinking
		toolStatus := "completed"
		if isFailure(payload) {
			eventType = collectorapi.EventToolCallFailed
			status = collectorapi.StatusError
			toolStatus = "error"
		}
		event := baseEvent(payload, config, eventType, status)
		event.ToolCall = toolCallSummary(payload, config, toolStatus, true)
		event.Activity = activityForTool(payload, config, event.ToolCall, true)
		events := []collectorapi.CollectorEvent{event}
		if payload.ToolName == "spawn_agent" {
			if sub := subAgentFromSpawn(payload, config, event.ToolCall.ToolCallID); sub != nil {
				subEvent := baseEvent(payload, config, collectorapi.EventSubAgentCreated, collectorapi.StatusThinking)
				subEvent.SubAgentID = &sub.SubAgentID
				subEvent.SubAgent = sub
				events = append(events, subEvent)
			}
		}
		return events
	case "PermissionRequest":
		return []collectorapi.CollectorEvent{baseEvent(payload, config, collectorapi.EventWaitingUser, collectorapi.StatusWaitingUser)}
	case "SubagentStart":
		created := baseEvent(payload, config, collectorapi.EventSubAgentCreated, collectorapi.StatusThinking)
		changed := baseEvent(payload, config, collectorapi.EventSubAgentStatusChanged, collectorapi.StatusThinking)
		id := subAgentID(payload, config)
		created.SubAgentID = &id
		changed.SubAgentID = &id
		return []collectorapi.CollectorEvent{created, changed}
	case "SubagentStop":
		event := baseEvent(payload, config, collectorapi.EventSubAgentCompleted, collectorapi.StatusIdle)
		id := subAgentID(payload, config)
		event.SubAgentID = &id
		return []collectorapi.CollectorEvent{event}
	case "Stop":
		sessionEvent := baseEvent(payload, config, collectorapi.EventSessionUpdated, collectorapi.StatusIdle)
		sessionEvent.Session = &collectorapi.SessionSummary{
			SessionID: payload.SessionID,
			Status:    collectorapi.StatusIdle,
		}
		turnEvent := baseEvent(payload, config, collectorapi.EventTurnCompleted, collectorapi.StatusIdle)
		turnEvent.Turn = &collectorapi.TurnSummary{
			TurnID:               turnID(payload),
			SessionID:            payload.SessionID,
			LastAssistantMessage: payload.LastAssistantMessage,
			Status:               collectorapi.StatusIdle,
			StartedAt:            eventTime(config),
			UpdatedAt:            eventTime(config),
			CompletedAt:          timePtr(eventTime(config)),
		}
		activityEvent := baseEvent(payload, config, collectorapi.EventActivityCompleted, collectorapi.StatusIdle)
		activityEvent.Activity = thinkingActivity(payload, config)
		activityEvent.Activity.CompletedAt = timePtr(eventTime(config))
		return []collectorapi.CollectorEvent{sessionEvent, turnEvent, activityEvent}
	default:
		event := baseEvent(payload, config, collectorapi.EventTurnUpdated, collectorapi.StatusThinking)
		event.Activity = thinkingActivity(payload, config)
		return []collectorapi.CollectorEvent{event}
	}
}

func baseEvent(payload HookPayload, config MapperConfig, eventType collectorapi.EventType, status collectorapi.Status) collectorapi.CollectorEvent {
	now := config.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}

	metadata := scrub.KeepMetadata(map[string]any{
		"cwd":           payload.CWD,
		"codex_version": payload.CodexVersion,
		"tool_name":     payload.ToolName,
		"hook_event":    payload.HookEventName,
	}, []string{"cwd", "codex_version", "tool_name", "hook_event"})

	event := collectorapi.CollectorEvent{
		EventID:         stableID("src", config.DeviceID, payload.SessionID, payload.TurnID, payload.ToolUseID, payload.HookEventName, payload.ToolName, string(eventType), subAgentID(payload, config)),
		EventType:       eventType,
		SourceType:      "codex",
		SourceEventType: payload.HookEventName,
		OccurredAt:      now,
		AgentID:         mainAgentID(payload, config),
		AgentType:       collectorapi.AgentTypeCodex,
		SessionID:       payload.SessionID,
		TurnID:          turnID(payload),
		Status:          status,
		SourceEvent: &collectorapi.SourceEventSummary{
			SourceEventID:   stableID("src", config.DeviceID, payload.SessionID, payload.TurnID, payload.ToolUseID, payload.HookEventName, payload.ToolName, string(eventType), subAgentID(payload, config)),
			SourceType:      "codex",
			SourceEventType: payload.HookEventName,
			RawPayload:      payload.Raw,
			ParseStatus:     "parsed",
		},
		Metadata: metadata,
	}
	if id := subAgentID(payload, config); id != "" {
		event.SubAgentID = &id
	}
	return event
}

func thinkingActivity(payload HookPayload, config MapperConfig) *collectorapi.ActivitySummary {
	now := eventTime(config)

	return &collectorapi.ActivitySummary{
		ActivityID:   stableID("act", config.DeviceID, payload.SessionID, payload.TurnID, payload.HookEventName),
		ActivityType: collectorapi.ActivityThinking,
		Title:        "Thinking",
		StartedAt:    now,
	}
}

func toolCallSummary(payload HookPayload, config MapperConfig, status string, completed bool) *collectorapi.ToolCallSummary {
	now := eventTime(config)
	class := classifyTool(payload)
	tool := &collectorapi.ToolCallSummary{
		ToolCallID:         stableID("tool", config.DeviceID, payload.SessionID, payload.TurnID, payload.ToolUseID, payload.ToolName),
		ExternalToolCallID: payload.ToolUseID,
		ToolName:           payload.ToolName,
		ToolType:           class.toolType,
		Status:             status,
		Input:              payload.ToolInput,
		Response:           payload.ToolResponse.JSONValue(),
		ResponseText:       payload.ToolResponse.Text(),
		StartedAt:          now,
		Metadata:           class.metadata,
	}
	if completed {
		tool.CompletedAt = timePtr(now)
	}
	return tool
}

func activityForTool(payload HookPayload, config MapperConfig, tool *collectorapi.ToolCallSummary, completed bool) *collectorapi.ActivitySummary {
	now := eventTime(config)
	class := classifyTool(payload)
	activity := &collectorapi.ActivitySummary{
		ActivityID:   stableID("act", config.DeviceID, payload.SessionID, payload.TurnID, payload.ToolUseID, payload.ToolName),
		ActivityType: class.activityType,
		ToolCallID:   tool.ToolCallID,
		Title:        class.title,
		StartedAt:    now,
		Metadata:     class.metadata,
	}
	if completed {
		activity.CompletedAt = timePtr(now)
	}
	return activity
}

func eventTime(config MapperConfig) time.Time {
	if config.Now.IsZero() {
		return time.Now().UTC()
	}
	return config.Now
}

func classifyTool(payload HookPayload) toolClass {
	name := strings.ToLower(strings.TrimSpace(payload.ToolName))
	switch {
	case name == "bash" || name == "shell" || name == "exec":
		metadata := map[string]string{}
		if category := commandCategory(payload.ToolInput); category != "" {
			metadata["command_category"] = category
		}
		return toolClass{
			status:       collectorapi.StatusRunningCommands,
			activityType: collectorapi.ActivityRunningCommands,
			toolType:     "command",
			title:        commandTitle(metadata["command_category"]),
			metadata:     metadata,
		}
	case name == "apply_patch" || name == "edit" || name == "write" || name == "multiedit":
		return toolClass{
			status:       collectorapi.StatusCoding,
			activityType: collectorapi.ActivityCoding,
			toolType:     "code_edit",
			title:        "Editing code",
		}
	case name == "read" || name == "glob" || name == "grep" || name == "list":
		return toolClass{
			status:       collectorapi.StatusReadingFiles,
			activityType: collectorapi.ActivityReadingFiles,
			toolType:     "file_read",
			title:        "Reading files",
		}
	case name == "spawn_agent" || name == "wait_agent" || name == "close_agent":
		return toolClass{
			status:       collectorapi.StatusThinking,
			activityType: collectorapi.ActivityAgentCollaboration,
			toolType:     "agent_collaboration",
			title:        "Spawn sub agent",
		}
	case strings.HasPrefix(name, "mcp__"):
		metadata := map[string]string{}
		if systemName := mcpSystemName(payload.ToolName); systemName != "" {
			metadata["business_system"] = systemName
		}
		return toolClass{
			status:       collectorapi.StatusCallingBusinessSystem,
			activityType: collectorapi.ActivityCallingBusinessSystem,
			toolType:     "calling_business_system",
			title:        "Calling business system",
			metadata:     metadata,
		}
	default:
		return toolClass{
			status:       collectorapi.StatusThinking,
			activityType: collectorapi.ActivityThinking,
			toolType:     "unknown",
			title:        "Thinking",
		}
	}
}

func commandCategory(toolInput map[string]any) string {
	command, ok := toolInput["command"].(string)
	if !ok {
		return ""
	}

	normalized := strings.ToLower(strings.TrimSpace(command))
	switch {
	case strings.HasPrefix(normalized, "go test") ||
		strings.HasPrefix(normalized, "npm test") ||
		strings.HasPrefix(normalized, "pnpm test") ||
		strings.HasPrefix(normalized, "yarn test") ||
		strings.HasPrefix(normalized, "bun test") ||
		strings.Contains(normalized, " test "):
		return "test_command"
	case strings.HasPrefix(normalized, "git "):
		return "git_command"
	case strings.HasPrefix(normalized, "go build") ||
		strings.HasPrefix(normalized, "npm run build") ||
		strings.HasPrefix(normalized, "pnpm build") ||
		strings.HasPrefix(normalized, "yarn build"):
		return "build_command"
	default:
		return "shell_command"
	}
}

func commandTitle(category string) string {
	switch category {
	case "test_command":
		return "Running tests"
	case "git_command":
		return "Running git command"
	case "build_command":
		return "Running build"
	default:
		return "Running command"
	}
}

func isFailure(payload HookPayload) bool {
	response := payload.ToolResponse.Map()
	if response == nil {
		return false
	}
	for _, key := range []string{"success", "ok"} {
		value, ok := response[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case bool:
			if !typed {
				return true
			}
		case string:
			if strings.ToLower(strings.TrimSpace(typed)) == "false" {
				return true
			}
		}
	}

	if value, ok := response["exit_status"]; ok {
		switch typed := value.(type) {
		case int:
			return typed != 0
		case int64:
			return typed != 0
		case float64:
			return typed != 0
		case json.Number:
			return strings.TrimSpace(typed.String()) != "0"
		case string:
			text := strings.TrimSpace(typed)
			return text != "" && text != "0"
		}
	}

	for _, key := range []string{"failed", "error", "is_error"} {
		value, ok := response[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case bool:
			if typed {
				return true
			}
		case string:
			text := strings.ToLower(strings.TrimSpace(typed))
			if text == "true" || text == "error" || text == "failed" || text == "failure" {
				return true
			}
		}
	}
	return false
}

func mcpSystemName(toolName string) string {
	parts := strings.Split(strings.TrimSpace(toolName), "__")
	if len(parts) < 2 {
		return ""
	}
	return scrub.LimitText(parts[1], scrub.DefaultTextLimit)
}

func mainAgentID(payload HookPayload, config MapperConfig) string {
	return config.AgentID
}

func turnID(payload HookPayload) string {
	if payload.SessionID != "" && payload.TurnID != "" {
		return payload.SessionID + ":" + payload.TurnID
	}
	if payload.TurnID != "" {
		return payload.TurnID
	}
	return payload.SessionID
}

func subAgentFromSpawn(payload HookPayload, config MapperConfig, spawnToolCallID string) *collectorapi.SubAgentSummary {
	response := payload.ToolResponse.Map()
	if response == nil {
		return nil
	}
	childID, _ := response["agent_id"].(string)
	if childID == "" {
		return nil
	}
	nickname, _ := response["nickname"].(string)
	now := eventTime(config)
	return &collectorapi.SubAgentSummary{
		SubAgentID:      childID,
		ParentAgentID:   mainAgentID(payload, config),
		SessionID:       payload.SessionID,
		ParentTurnID:    turnID(payload),
		SpawnToolCallID: spawnToolCallID,
		Name:            nickname,
		Nickname:        nickname,
		Status:          collectorapi.StatusThinking,
		CurrentActivity: "Starting",
		StartedAt:       now,
		UpdatedAt:       now,
		Metadata: scrub.KeepMetadata(map[string]any{
			"source_agent_id": childID,
			"nickname":        nickname,
		}, []string{"source_agent_id", "nickname"}),
	}
}

func subAgentID(payload HookPayload, config MapperConfig) string {
	if payload.ChildThreadID != "" {
		return payload.ChildThreadID
	}
	// 标准模型规则：任何携带 agent_id 的 hook 都归属于 child agent，
	// main agent 的 hook 不带 agent_id（参见 docs/codex_hook_model.md）。
	// Codex 实际日志中没有 child_thread_id，子 agent 的 UserPromptSubmit /
	// PreToolUse / PostToolUse / SubagentStart / SubagentStop 全部只通过
	// agent_id 标识，因此这里不能只认 SubagentStart/Stop。
	if payload.AgentID != "" {
		return payload.AgentID
	}
	if id := calibratedSubAgentID(payload, config.ThreadEdges); id != "" {
		return id
	}
	return ""
}

func calibratedSubAgentID(payload HookPayload, edges []ThreadEdge) string {
	parentID := payload.ParentThreadID
	if parentID == "" {
		parentID = payload.SessionID
	}
	for _, edge := range edges {
		if edge.ParentThreadID == parentID && edge.ChildThreadID != "" {
			return edge.ChildThreadID
		}
	}
	return ""
}

func stableID(prefix string, parts ...string) string {
	hash := sha1.New()
	for _, part := range parts {
		hash.Write([]byte(part))
		hash.Write([]byte{0})
	}
	return prefix + "_" + hex.EncodeToString(hash.Sum(nil))[:16]
}

func timePtr(value time.Time) *time.Time {
	return &value
}
