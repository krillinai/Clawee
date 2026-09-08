package state

import (
	"context"
	"encoding/json"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type Store interface {
	UpsertDevice(context.Context, DeviceHeartbeat) error
	UpsertAgent(context.Context, AgentState) error
	UpsertSession(context.Context, SessionState) error
	ApplySourceEvent(context.Context, SourceEventState, func(context.Context, Store) error) (bool, error)
	CloseOpenActivities(context.Context, ActivityScope, time.Time) error
	UpsertActivity(context.Context, ActivityState) error
	CompleteActivity(context.Context, ActivityCompletion) error
	UpsertSubAgent(context.Context, SubAgentState) error
	CompleteSubAgent(context.Context, SubAgentCompletion) error
	UpsertTurn(context.Context, TurnState) error
	CompleteTurn(context.Context, TurnCompletion) error
	UpsertToolCall(context.Context, ToolCallState) error
	CompleteToolCall(context.Context, ToolCallCompletion) error
}

type DeviceHeartbeat struct {
	CollectorID      string
	DeviceID         string
	CollectorVersion string
	LastSeenAt       time.Time
}

type AgentState struct {
	CollectorID      string
	DeviceID         string
	AgentID          string
	AgentType        collectorapi.AgentType
	DisplayName      string
	Version          string
	Status           collectorapi.Status
	WorkspaceName    string
	CurrentSessionID string
	CurrentTurnID    string
	LastSeenAt       time.Time
	Metadata         map[string]string
}

type SourceEventState struct {
	CollectorID       string
	SourceEventID     string
	SourceType        string
	SourceEventType   string
	StandardEventType collectorapi.EventType
	AgentID           string
	SessionID         string
	TurnID            string
	SubAgentID        string
	ToolCallID        string
	OccurredAt        time.Time
	ReceivedAt        time.Time
	RawPayload        json.RawMessage
	StandardPayload   json.RawMessage
	ParseStatus       string
	ParseError        string
}

type SessionState struct {
	CollectorID     string
	AgentID         string
	SessionID       string
	Status          collectorapi.Status
	Summary         string
	StartedAt       time.Time
	UpdateStartedAt bool
	EndedAt         *time.Time
	WorkspaceName   string
	UpdatedAt       time.Time
}

type TurnState struct {
	CollectorID          string
	AgentID              string
	TurnID               string
	SessionID            string
	SubAgentID           string
	ParentAgentID        string
	ParentTurnID         string
	SpawnToolCallID      string
	Title                string
	UserPrompt           string
	AssistantSummary     string
	LastAssistantMessage string
	Status               collectorapi.Status
	StartedAt            time.Time
	UpdatedAt            time.Time
	CompletedAt          *time.Time
	Metadata             map[string]string
}

type ActivityScope struct {
	CollectorID string
	AgentID     string
	SubAgentID  string
	SessionID   string
	TurnID      string
}

type ActivityState struct {
	CollectorID  string
	ActivityID   string
	AgentID      string
	SubAgentID   string
	SessionID    string
	TurnID       string
	ToolCallID   string
	ActivityType collectorapi.ActivityType
	Status       collectorapi.Status
	Title        string
	Summary      string
	StartedAt    time.Time
	CompletedAt  *time.Time
	Metadata     map[string]string
}

type ActivityCompletion struct {
	ActivityID   string
	Scope        ActivityScope
	ActivityType collectorapi.ActivityType
	CompletedAt  time.Time
}

type SubAgentState struct {
	CollectorID     string
	ParentAgentID   string
	SubAgentID      string
	SessionID       string
	ParentTurnID    string
	SpawnToolCallID string
	Name            string
	Nickname        string
	Role            string
	Status          collectorapi.Status
	CurrentActivity string
	StartedAt       time.Time
	UpdatedAt       time.Time
	CompletedAt     *time.Time
	Metadata        map[string]string
}

type SubAgentCompletion struct {
	CollectorID   string
	ParentAgentID string
	SubAgentID    string
	Status        collectorapi.Status
	CompletedAt   time.Time
}

type TurnCompletion struct {
	CollectorID string
	AgentID     string
	TurnID      string
	CompletedAt time.Time
}

type ToolCallState struct {
	CollectorID        string
	AgentID            string
	ToolCallID         string
	ExternalToolCallID string
	SessionID          string
	TurnID             string
	SubAgentID         string
	ToolName           string
	ToolType           string
	Status             string
	Input              json.RawMessage
	Response           json.RawMessage
	ResponseText       string
	StartedAt          time.Time
	CompletedAt        *time.Time
	DurationMS         int64
	SourceEventStartID string
	SourceEventEndID   string
	Metadata           map[string]string
}

type ToolCallCompletion struct {
	CollectorID      string
	AgentID          string
	ToolCallID       string
	Status           string
	Response         json.RawMessage
	ResponseText     string
	CompletedAt      time.Time
	DurationMS       int64
	SourceEventEndID string
	Metadata         map[string]string
}
