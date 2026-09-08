package dashboard

import (
	"encoding/json"
	"strings"
	"time"
)

const SchemaVersion = "office.v1"

type AgentKey struct {
	CollectorID string `json:"collector_id"`
	AgentID     string `json:"agent_id"`
}

type OfficeSnapshot struct {
	SchemaVersion string             `json:"schema_version"`
	ServerTime    time.Time          `json:"server_time"`
	SSEURL        string             `json:"sse_url"`
	Filters       OfficeFilters      `json:"filters"`
	Summary       OfficeSummary      `json:"summary"`
	Agents        []AgentListItem    `json:"agents"`
	RecentFeed    []ActivityFeedItem `json:"recent_feed"`
}

type OfficeFilters struct {
	Workspaces      []WorkspaceCount      `json:"workspaces"`
	StatusCounts    map[string]int        `json:"status_counts"`
	BusinessSystems []BusinessSystemCount `json:"business_systems"`
}

type WorkspaceCount struct {
	WorkspaceName string `json:"workspace_name"`
	AgentCount    int    `json:"agent_count"`
}

type BusinessSystemCount struct {
	SystemType  string `json:"system_type"`
	SystemName  string `json:"system_name"`
	ActiveCount int    `json:"active_count"`
}

type OfficeSummary struct {
	TotalAgents         int `json:"total_agents"`
	OnlineAgents        int `json:"online_agents"`
	ActiveSubAgents     int `json:"active_sub_agents"`
	BlockedAgents       int `json:"blocked_agents"`
	ErrorAgents         int `json:"error_agents"`
	WorkingAgents       int `json:"working_agents"`
	ActiveSessions      int `json:"active_sessions"`
	ActiveTurns         int `json:"active_turns"`
	RecentToolCallCount int `json:"recent_tool_call_count"`
}

type AgentListItem struct {
	CollectorID        string              `json:"collector_id"`
	AgentID            string              `json:"agent_id"`
	MCPAgentID         string              `json:"mcp_agent_id,omitempty"`
	OwnerUserID        string              `json:"owner_user_id,omitempty"`
	OwnerName          string              `json:"owner_name,omitempty"`
	OwnerEmail         string              `json:"owner_email,omitempty"`
	DisplayName        string              `json:"display_name"`
	AvatarLabel        string              `json:"avatar_label"`
	AgentType          string              `json:"agent_type"`
	RoleLabel          string              `json:"role_label"`
	DeviceID           string              `json:"device_id"`
	WorkspaceName      string              `json:"workspace_name"`
	Status             string              `json:"status"`
	CurrentSession     *SessionItem        `json:"current_session,omitempty"`
	CurrentTurn        *TurnItem           `json:"current_turn,omitempty"`
	SubAgents          SubAgentSummary     `json:"sub_agents"`
	ActiveBusinessCall *BusinessCall       `json:"active_business_call,omitempty"`
	Sessions           []AgentSessionBrief `json:"sessions"`
	LastAction         *AgentLastAction    `json:"last_action,omitempty"`
	RecentToolCalls    int                 `json:"recent_tool_calls"`
	LastSeenAt         time.Time           `json:"last_seen_at"`
	UpdatedAt          time.Time           `json:"updated_at"`
}

type AgentSessionBrief struct {
	SessionID        string            `json:"session_id"`
	Status           string            `json:"status"`
	CurrentTurnTitle string            `json:"current_turn_title"`
	Active           bool              `json:"active"`
	LastAction       *AgentLastAction  `json:"last_action,omitempty"`
	RecentActions    []AgentLastAction `json:"recent_actions"`
}

type AgentLastAction struct {
	ToolName  string    `json:"tool_name"`
	ToolType  string    `json:"tool_type"`
	Status    string    `json:"status"`
	StartedAt time.Time `json:"started_at"`
}

type AgentDetail struct {
	SchemaVersion      string         `json:"schema_version"`
	ServerTime         time.Time      `json:"server_time"`
	Agent              AgentListItem  `json:"agent"`
	CurrentSession     *SessionItem   `json:"current_session,omitempty"`
	CurrentTurn        *TurnItem      `json:"current_turn,omitempty"`
	Sessions           []SessionItem  `json:"sessions"`
	Turns              []TurnItem     `json:"turns"`
	SubAgents          []SubAgentItem `json:"sub_agents"`
	ToolCalls          []ToolCallItem `json:"tool_calls"`
	StatusTimeline     []TimelineItem `json:"status_timeline"`
	RecentActivities   []ActivityItem `json:"recent_activities"`
	ActiveBusinessCall *BusinessCall  `json:"active_business_call,omitempty"`
	Stats              AgentStats     `json:"stats"`
}

type AgentDetailOptions struct {
	IncludeHistory bool
}

type AgentStats struct {
	SessionDurationMS   int64  `json:"session_duration_ms"`
	ActiveSubAgents     int    `json:"active_sub_agents"`
	TotalSubAgents      int    `json:"total_sub_agents"`
	RecentActivityCount int    `json:"recent_activity_count"`
	BusinessRiskLevel   string `json:"business_risk_level"`
	ActiveSessions      int    `json:"active_sessions"`
	ActiveWorkMS        int64  `json:"active_work_ms"`
	ToolTypeVariety     int    `json:"tool_type_variety"`
	ToolCallCount       int    `json:"tool_call_count"`
}

type SessionItem struct {
	SessionID     string     `json:"session_id"`
	Status        string     `json:"status"`
	Summary       string     `json:"summary"`
	StartedAt     time.Time  `json:"started_at"`
	EndedAt       *time.Time `json:"ended_at,omitempty"`
	WorkspaceName string     `json:"workspace_name"`
	DurationMS    int64      `json:"duration_ms"`
}

type TurnItem struct {
	TurnID               string     `json:"turn_id"`
	SessionID            string     `json:"session_id"`
	SubAgentID           string     `json:"sub_agent_id,omitempty"`
	ParentAgentID        string     `json:"parent_agent_id,omitempty"`
	ParentTurnID         string     `json:"parent_turn_id,omitempty"`
	SpawnToolCallID      string     `json:"spawn_tool_call_id,omitempty"`
	Title                string     `json:"title"`
	UserPrompt           string     `json:"user_prompt"`
	AssistantSummary     string     `json:"assistant_summary"`
	LastAssistantMessage string     `json:"last_assistant_message"`
	Status               string     `json:"status"`
	StartedAt            time.Time  `json:"started_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
	CompletedAt          *time.Time `json:"completed_at,omitempty"`
	Progress             *int       `json:"progress,omitempty"`
}

type ToolCallItem struct {
	CollectorID        string          `json:"collector_id"`
	AgentID            string          `json:"agent_id"`
	ToolCallID         string          `json:"tool_call_id"`
	ExternalToolCallID string          `json:"external_tool_call_id"`
	SessionID          string          `json:"session_id"`
	TurnID             string          `json:"turn_id"`
	SubAgentID         string          `json:"sub_agent_id,omitempty"`
	ToolName           string          `json:"tool_name"`
	ToolType           string          `json:"tool_type"`
	Status             string          `json:"status"`
	Input              json.RawMessage `json:"input"`
	Response           json.RawMessage `json:"response"`
	ResponseText       string          `json:"response_text"`
	StartedAt          time.Time       `json:"started_at"`
	CompletedAt        *time.Time      `json:"completed_at,omitempty"`
	DurationMS         int64           `json:"duration_ms"`
}

type SubAgentSummary struct {
	ActiveCount int            `json:"active_count"`
	TotalCount  int            `json:"total_count"`
	Preview     []SubAgentItem `json:"preview"`
}

type SubAgentItem struct {
	CollectorID        string        `json:"collector_id"`
	ParentAgentID      string        `json:"parent_agent_id"`
	SubAgentID         string        `json:"sub_agent_id"`
	SessionID          string        `json:"session_id"`
	ParentTurnID       string        `json:"parent_turn_id"`
	TurnTitle          string        `json:"turn_title"`
	Nickname           string        `json:"nickname"`
	SpawnToolCallID    string        `json:"spawn_tool_call_id"`
	Name               string        `json:"name"`
	Role               string        `json:"role"`
	Status             string        `json:"status"`
	CurrentActivity    string        `json:"current_activity"`
	ActiveBusinessCall *BusinessCall `json:"active_business_call,omitempty"`
	StartedAt          time.Time     `json:"started_at"`
	UpdatedAt          time.Time     `json:"updated_at"`
	CompletedAt        *time.Time    `json:"completed_at,omitempty"`
	DurationMS         int64         `json:"duration_ms"`
}

type ActivityItem struct {
	CollectorID  string        `json:"collector_id"`
	ActivityID   string        `json:"activity_id"`
	AgentID      string        `json:"agent_id"`
	SubAgentID   string        `json:"sub_agent_id,omitempty"`
	SessionID    string        `json:"session_id"`
	TurnID       string        `json:"turn_id"`
	ToolCallID   string        `json:"tool_call_id,omitempty"`
	ActivityType string        `json:"activity_type"`
	Status       string        `json:"status"`
	Title        string        `json:"title"`
	Summary      string        `json:"summary"`
	StartedAt    time.Time     `json:"started_at"`
	CompletedAt  *time.Time    `json:"completed_at,omitempty"`
	DurationMS   int64         `json:"duration_ms"`
	BusinessCall *BusinessCall `json:"business_call,omitempty"`
}

type TimelineItem struct {
	EventType    string     `json:"event_type"`
	Title        string     `json:"title"`
	Summary      string     `json:"summary"`
	Status       string     `json:"status"`
	ActivityType string     `json:"activity_type"`
	OccurredAt   time.Time  `json:"occurred_at"`
	CompletedAt  *time.Time `json:"completed_at,omitempty"`
}

type ActivityFeedItem struct {
	CollectorID  string    `json:"collector_id"`
	AgentID      string    `json:"agent_id"`
	ActivityID   string    `json:"activity_id,omitempty"`
	ActivityType string    `json:"activity_type,omitempty"`
	Status       string    `json:"status,omitempty"`
	Title        string    `json:"title,omitempty"`
	Summary      string    `json:"summary,omitempty"`
	OccurredAt   time.Time `json:"occurred_at"`
	Text         string    `json:"text"`
}

type BusinessCall struct {
	SystemType      string `json:"system_type"`
	SystemName      string `json:"system_name"`
	OperationLabel  string `json:"operation_label"`
	RiskLevel       string `json:"risk_level"`
	ExternalEventID string `json:"external_event_id,omitempty"`
	ExternalSource  string `json:"external_source,omitempty"`
}

type RealtimeEnvelope struct {
	SchemaVersion string          `json:"schema_version"`
	EventID       string          `json:"event_id"`
	EventType     string          `json:"event_type"`
	EmittedAt     time.Time       `json:"emitted_at"`
	Cursor        string          `json:"cursor"`
	Scope         RealtimeScope   `json:"scope"`
	Data          json.RawMessage `json:"data"`
}

type RealtimeScope struct {
	CollectorID string `json:"collector_id,omitempty"`
	AgentID     string `json:"agent_id,omitempty"`
	SessionID   string `json:"session_id,omitempty"`
	TurnID      string `json:"turn_id,omitempty"`
	SubAgentID  string `json:"sub_agent_id,omitempty"`
}

func BusinessCallFromMetadata(metadata map[string]string) (BusinessCall, bool) {
	systemName := firstNonEmpty(metadata["system_name"], metadata["business_system"])
	operationLabel := metadata["operation_label"]
	if systemName == "" && operationLabel == "" {
		return BusinessCall{}, false
	}

	return BusinessCall{
		SystemType:      firstNonEmpty(metadata["system_type"], "other"),
		SystemName:      systemName,
		OperationLabel:  operationLabel,
		RiskLevel:       firstNonEmpty(metadata["risk_level"], "unknown"),
		ExternalEventID: metadata["external_event_id"],
		ExternalSource:  metadata["external_source"],
	}, true
}

func AvatarLabel(displayName string, agentID string) string {
	source := strings.TrimSpace(displayName)
	if source == "" {
		source = strings.TrimSpace(agentID)
	}
	if source == "" {
		return "A"
	}
	return strings.ToUpper(string([]rune(source)[0]))
}

func DurationMillis(start time.Time, end *time.Time, now time.Time) int64 {
	stop := now
	if end != nil {
		stop = *end
	}
	if stop.Before(start) {
		return 0
	}
	return stop.Sub(start).Milliseconds()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
