package collectorapi

import "time"

const SchemaVersion = "collector.v1"

const TaskSchemaVersion = "collector.task.v1"

type AgentType string

const (
	AgentTypeCodex AgentType = "codex"
)

type Status string

const (
	StatusOffline               Status = "offline"
	StatusIdle                  Status = "idle"
	StatusThinking              Status = "thinking"
	StatusSearching             Status = "searching"
	StatusCoding                Status = "coding"
	StatusReadingFiles          Status = "reading_files"
	StatusRunningCommands       Status = "running_commands"
	StatusOrganizingData        Status = "organizing_data"
	StatusSummarizing           Status = "summarizing"
	StatusCallingBusinessSystem Status = "calling_business_system"
	StatusWaitingUser           Status = "waiting_user"
	StatusBlocked               Status = "blocked"
	StatusError                 Status = "error"
)

type EventType string

const (
	EventAgentSeen             EventType = "agent_seen"
	EventSessionStarted        EventType = "session_started"
	EventSessionUpdated        EventType = "session_updated"
	EventSessionCompleted      EventType = "session_completed"
	EventTurnStarted           EventType = "turn_started"
	EventTurnUpdated           EventType = "turn_updated"
	EventTurnCompleted         EventType = "turn_completed"
	EventToolCallStarted       EventType = "tool_call_started"
	EventToolCallCompleted     EventType = "tool_call_completed"
	EventToolCallFailed        EventType = "tool_call_failed"
	EventActivityStarted       EventType = "activity_started"
	EventActivityCompleted     EventType = "activity_completed"
	EventAgentError            EventType = "agent_error"
	EventWaitingUser           EventType = "waiting_user"
	EventSubAgentCreated       EventType = "sub_agent_created"
	EventSubAgentStatusChanged EventType = "sub_agent_status_changed"
	EventSubAgentCompleted     EventType = "sub_agent_completed"
	EventSourceEventReceived   EventType = "source_event_received"
)

type ActivityType string

const (
	ActivityThinking              ActivityType = "thinking"
	ActivitySearching             ActivityType = "searching"
	ActivityCoding                ActivityType = "coding"
	ActivityReadingFiles          ActivityType = "reading_files"
	ActivityRunningCommands       ActivityType = "running_commands"
	ActivityOrganizingData        ActivityType = "organizing_data"
	ActivitySummarizing           ActivityType = "summarizing"
	ActivityCallingBusinessSystem ActivityType = "calling_business_system"
	ActivityAgentCollaboration    ActivityType = "agent_collaboration"
)

type AgentSummary struct {
	AgentID          string            `json:"agent_id"`
	AgentType        AgentType         `json:"agent_type"`
	DisplayName      string            `json:"display_name,omitempty"`
	Version          string            `json:"version,omitempty"`
	Status           Status            `json:"status"`
	WorkspaceName    string            `json:"workspace_name,omitempty"`
	CurrentSessionID string            `json:"current_session_id,omitempty"`
	CurrentTurnID    string            `json:"current_turn_id,omitempty"`
	LastSeenAt       time.Time         `json:"last_seen_at"`
	Metadata         map[string]string `json:"metadata,omitempty"`
}

type SessionSummary struct {
	SessionID     string     `json:"session_id"`
	Status        Status     `json:"status"`
	Summary       string     `json:"summary,omitempty"`
	StartedAt     time.Time  `json:"started_at"`
	EndedAt       *time.Time `json:"ended_at,omitempty"`
	WorkspaceName string     `json:"workspace_name,omitempty"`
}

type TurnSummary struct {
	TurnID               string            `json:"turn_id"`
	SessionID            string            `json:"session_id"`
	SubAgentID           string            `json:"sub_agent_id,omitempty"`
	ParentAgentID        string            `json:"parent_agent_id,omitempty"`
	ParentTurnID         string            `json:"parent_turn_id,omitempty"`
	SpawnToolCallID      string            `json:"spawn_tool_call_id,omitempty"`
	Title                string            `json:"title,omitempty"`
	UserPrompt           string            `json:"user_prompt,omitempty"`
	AssistantSummary     string            `json:"assistant_summary,omitempty"`
	LastAssistantMessage string            `json:"last_assistant_message,omitempty"`
	Status               Status            `json:"status"`
	StartedAt            time.Time         `json:"started_at"`
	UpdatedAt            time.Time         `json:"updated_at"`
	CompletedAt          *time.Time        `json:"completed_at,omitempty"`
	Metadata             map[string]string `json:"metadata,omitempty"`
}

type ToolCallSummary struct {
	ToolCallID         string            `json:"tool_call_id"`
	ExternalToolCallID string            `json:"external_tool_call_id,omitempty"`
	SessionID          string            `json:"session_id,omitempty"`
	TurnID             string            `json:"turn_id,omitempty"`
	SubAgentID         string            `json:"sub_agent_id,omitempty"`
	ToolName           string            `json:"tool_name"`
	ToolType           string            `json:"tool_type"`
	Status             string            `json:"status"`
	Input              map[string]any    `json:"input,omitempty"`
	Response           any               `json:"response,omitempty"`
	ResponseText       string            `json:"response_text,omitempty"`
	StartedAt          time.Time         `json:"started_at"`
	CompletedAt        *time.Time        `json:"completed_at,omitempty"`
	DurationMS         int64             `json:"duration_ms,omitempty"`
	Metadata           map[string]string `json:"metadata,omitempty"`
}

type SubAgentSummary struct {
	SubAgentID      string            `json:"sub_agent_id"`
	ParentAgentID   string            `json:"parent_agent_id"`
	SessionID       string            `json:"session_id,omitempty"`
	ParentTurnID    string            `json:"parent_turn_id,omitempty"`
	SpawnToolCallID string            `json:"spawn_tool_call_id,omitempty"`
	Name            string            `json:"name,omitempty"`
	Nickname        string            `json:"nickname,omitempty"`
	Role            string            `json:"role,omitempty"`
	Status          Status            `json:"status"`
	CurrentActivity string            `json:"current_activity,omitempty"`
	StartedAt       time.Time         `json:"started_at"`
	UpdatedAt       time.Time         `json:"updated_at"`
	CompletedAt     *time.Time        `json:"completed_at,omitempty"`
	Metadata        map[string]string `json:"metadata,omitempty"`
}

type ActivitySummary struct {
	ActivityID   string            `json:"activity_id"`
	SessionID    string            `json:"session_id,omitempty"`
	TurnID       string            `json:"turn_id,omitempty"`
	SubAgentID   string            `json:"sub_agent_id,omitempty"`
	ActivityType ActivityType      `json:"activity_type"`
	ToolCallID   string            `json:"tool_call_id,omitempty"`
	Title        string            `json:"title,omitempty"`
	Summary      string            `json:"summary,omitempty"`
	StartedAt    time.Time         `json:"started_at"`
	CompletedAt  *time.Time        `json:"completed_at,omitempty"`
	Metadata     map[string]string `json:"metadata,omitempty"`
}

type SourceEventSummary struct {
	SourceEventID   string         `json:"source_event_id"`
	SourceType      string         `json:"source_type"`
	SourceEventType string         `json:"source_event_type"`
	RawPayload      map[string]any `json:"raw_payload,omitempty"`
	ParsedPayload   map[string]any `json:"parsed_payload,omitempty"`
	ParseStatus     string         `json:"parse_status,omitempty"`
	ParseError      string         `json:"parse_error,omitempty"`
}

type CollectorEvent struct {
	EventID         string              `json:"event_id"`
	EventType       EventType           `json:"event_type"`
	SourceType      string              `json:"source_type,omitempty"`
	SourceEventType string              `json:"source_event_type,omitempty"`
	OccurredAt      time.Time           `json:"occurred_at"`
	AgentID         string              `json:"agent_id"`
	AgentType       AgentType           `json:"agent_type"`
	SessionID       string              `json:"session_id,omitempty"`
	TurnID          string              `json:"turn_id,omitempty"`
	SubAgentID      *string             `json:"sub_agent_id,omitempty"`
	Status          Status              `json:"status"`
	Session         *SessionSummary     `json:"session,omitempty"`
	Turn            *TurnSummary        `json:"turn,omitempty"`
	ToolCall        *ToolCallSummary    `json:"tool_call,omitempty"`
	Activity        *ActivitySummary    `json:"activity,omitempty"`
	SubAgent        *SubAgentSummary    `json:"sub_agent,omitempty"`
	SourceEvent     *SourceEventSummary `json:"source_event,omitempty"`
	Metadata        map[string]string   `json:"metadata,omitempty"`
}

type RegistrationAgent struct {
	AgentType     AgentType         `json:"agent_type"`
	AgentID       string            `json:"agent_id,omitempty"`
	DisplayName   string            `json:"display_name,omitempty"`
	Version       string            `json:"version,omitempty"`
	WorkspaceName string            `json:"workspace_name,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

type RegistrationRequest struct {
	SchemaVersion    string              `json:"schema_version"`
	RegistrationCode string              `json:"registration_code"`
	AgentID          string              `json:"agent_id"`
	DeviceName       string              `json:"device_name,omitempty"`
	Hostname         string              `json:"hostname,omitempty"`
	OS               string              `json:"os"`
	Arch             string              `json:"arch"`
	CollectorVersion string              `json:"collector_version"`
	Agents           []RegistrationAgent `json:"agents,omitempty"`
}

type RegistrationResponse struct {
	CollectorID    string     `json:"collector_id"`
	CollectorToken string     `json:"collector_token"`
	DeviceID       string     `json:"device_id"`
	PrivacyMode    string     `json:"privacy_mode"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
}

type HeartbeatRequest struct {
	SchemaVersion    string         `json:"schema_version"`
	CollectorID      string         `json:"collector_id"`
	DeviceID         string         `json:"device_id"`
	SentAt           time.Time      `json:"sent_at"`
	CollectorVersion string         `json:"collector_version"`
	Agents           []AgentSummary `json:"agents"`
}

type EventsRequest struct {
	SchemaVersion string           `json:"schema_version"`
	CollectorID   string           `json:"collector_id"`
	DeviceID      string           `json:"device_id"`
	SentAt        time.Time        `json:"sent_at"`
	Events        []CollectorEvent `json:"events"`
}

type AcceptedResponse struct {
	Accepted       bool      `json:"accepted"`
	ServerTime     time.Time `json:"server_time"`
	ReceivedEvents int       `json:"received_events,omitempty"`
	ReceivedAgents int       `json:"received_agents,omitempty"`
}

type ErrorResponse struct {
	Error ErrorBody `json:"error"`
}

type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type TaskPullRequest struct {
	SchemaVersion string `json:"schema_version"`
	CollectorID   string `json:"collector_id"`
	DeviceID      string `json:"device_id"`
}

type TaskDelivery struct {
	SchemaVersion    string         `json:"schema_version"`
	TaskID           string         `json:"task_id"`
	ClaimID          string         `json:"claim_id"`
	TraceID          string         `json:"trace_id"`
	UpstreamServerID string         `json:"upstream_server_id"`
	Tool             string         `json:"tool"`
	Arguments        map[string]any `json:"arguments"`
}

type TaskResultStatus string

const (
	TaskResultSucceeded TaskResultStatus = "succeeded"
	TaskResultFailed    TaskResultStatus = "failed"
)

type TaskResultOutput struct {
	Answer string `json:"answer"`
}

type TaskResultError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type TaskResultRequest struct {
	SchemaVersion string            `json:"schema_version"`
	CollectorID   string            `json:"collector_id"`
	DeviceID      string            `json:"device_id"`
	TaskID        string            `json:"task_id"`
	ClaimID       string            `json:"claim_id"`
	Status        TaskResultStatus  `json:"status"`
	Output        *TaskResultOutput `json:"output,omitempty"`
	Error         *TaskResultError  `json:"error,omitempty"`
}
