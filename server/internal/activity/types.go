package activity

import (
	"context"
	"errors"
	"time"
)

const (
	RangeToday  = "today"
	Range7Days  = "7d"
	Range30Days = "30d"
)

var (
	ErrInvalidRange        = errors.New("invalid activity range")
	ErrInvalidAgentList    = errors.New("invalid agent list request")
	ErrAgentNotFound       = errors.New("agent not found")
	ErrActivityUnavailable = errors.New("activity data unavailable")
)

const (
	SortByTurnCount      = "turn_count"
	SortBySessionCount   = "session_count"
	SortByLastActivityAt = "last_activity_at"
)

type UpstreamError struct {
	Code       string
	RetryAfter string
}

func (e *UpstreamError) Error() string { return e.Code }

type Usage struct {
	InputTokens       int64 `json:"input_tokens"`
	CachedInputTokens int64 `json:"cached_input_tokens"`
	OutputTokens      int64 `json:"output_tokens"`
	TotalTokens       int64 `json:"total_tokens"`
}

type TrendPoint struct {
	BucketStart time.Time `json:"bucket_start"`
	Usage
}

type Trend struct {
	Granularity string       `json:"granularity"`
	Points      []TrendPoint `json:"points"`
}

type ModelUsage struct {
	Model    string `json:"model"`
	Requests int64  `json:"requests"`
	Usage
	Share float64 `json:"share"`
}

type TokenUsageRank struct {
	Rank        int    `json:"rank"`
	Name        string `json:"name"`
	Requests    int64  `json:"requests"`
	TotalTokens int64  `json:"total_tokens"`
}

type MCPUsage struct {
	ID              string  `json:"id"`
	Label           string  `json:"label"`
	InvocationCount int64   `json:"invocation_count"`
	Share           float64 `json:"share"`
}

type Agent struct {
	CollectorID    string     `json:"collector_id"`
	AgentID        string     `json:"agent_id"`
	Name           string     `json:"name"`
	Status         string     `json:"status"`
	SessionCount   int64      `json:"session_count"`
	TurnCount      int64      `json:"turn_count"`
	LastActivityAt *time.Time `json:"last_activity_at,omitempty"`
}

type ActivitySnapshot struct {
	ActiveEmployees int64   `json:"active_employees"`
	ActiveAgents    int64   `json:"active_agents"`
	CompletedTurns  int64   `json:"completed_turns"`
	Agents          []Agent `json:"agents"`
}

type ActivityStore interface {
	Statistics(context.Context, time.Time, time.Time) (ActivitySnapshot, error)
}

type AgentSummaryReader interface {
	AgentSummary(context.Context, string, time.Time, time.Time) (AgentSummary, error)
}

type MCPUsageStore interface {
	MCPUsage(context.Context, time.Time, time.Time) ([]MCPUsage, error)
}

type SnapshotClient interface {
	Snapshot(context.Context, SnapshotRequest) (Snapshot, error)
}

type SnapshotRequest struct {
	StartDate   string
	EndDate     string
	Granularity string
}

type Snapshot struct {
	GeneratedAt       time.Time
	Trend             []TrendPoint
	Models            []ModelUsage
	TokenUsageRanking []TokenUsageRank
}

type Organization struct {
	Usage           Usage      `json:"usage"`
	ActiveEmployees int64      `json:"active_employees"`
	ActiveAgents    int64      `json:"active_agents"`
	CompletedTurns  int64      `json:"completed_turns"`
	MCPDistribution []MCPUsage `json:"mcp_distribution"`
}

type Statistics struct {
	Range             string            `json:"range"`
	Timezone          string            `json:"timezone"`
	StartDate         string            `json:"start_date"`
	EndDate           string            `json:"end_date"`
	GeneratedAt       time.Time         `json:"generated_at"`
	Organization      Organization      `json:"organization"`
	Trend             Trend             `json:"trend"`
	ModelDistribution []ModelUsage      `json:"model_distribution"`
	TokenUsageRanking []TokenUsageRank  `json:"token_usage_ranking"`
	Agents            []Agent           `json:"agents"`
	DataStatus        map[string]string `json:"data_status"`
}

type DateRange struct {
	Range       string
	Timezone    string
	StartDate   string
	EndDate     string
	GeneratedAt time.Time
	Start       time.Time
	End         time.Time
	Granularity string
}

type AgentListRequest struct {
	Range  string
	SortBy string
	Limit  int
}

type AgentListItem struct {
	AgentID        string     `json:"agent_id"`
	Name           string     `json:"name"`
	Status         string     `json:"status"`
	SessionCount   int64      `json:"session_count"`
	TurnCount      int64      `json:"turn_count"`
	LastActivityAt *time.Time `json:"last_activity_at"`
	Rank           int        `json:"rank"`
}

type AgentListResult struct {
	Range       string            `json:"range"`
	Timezone    string            `json:"timezone"`
	StartDate   string            `json:"start_date"`
	EndDate     string            `json:"end_date"`
	GeneratedAt time.Time         `json:"generated_at"`
	SortBy      string            `json:"sort_by"`
	Agents      []AgentListItem   `json:"agents"`
	DataStatus  map[string]string `json:"data_status"`
}

type AgentRecentActivity struct {
	OccurredAt time.Time `json:"occurred_at"`
	Type       string    `json:"type"`
	Status     string    `json:"status"`
}

type AgentSummary struct {
	AgentID            string                `json:"agent_id"`
	Name               string                `json:"name"`
	Status             string                `json:"status"`
	LastActivityAt     *time.Time            `json:"last_activity_at"`
	SessionCount       int64                 `json:"session_count"`
	TurnCount          int64                 `json:"turn_count"`
	CompletedTurnCount int64                 `json:"completed_turn_count"`
	ToolCallCount      int64                 `json:"tool_call_count"`
	MCPCallCount       int64                 `json:"mcp_call_count"`
	RecentActivities   []AgentRecentActivity `json:"recent_activities"`
}
