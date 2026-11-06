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
	ErrAmbiguousAgent      = errors.New("agent belongs to multiple employees")
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

type SkillUsage struct {
	SkillID       string `json:"skill_id"`
	SkillName     string `json:"skill_name"`
	SkillKey      string `json:"skill_key"`
	Source        string `json:"source"`
	RequestedRuns int64  `json:"requested_runs"`
	ObservedRuns  int64  `json:"observed_runs"`
	ImplicitRuns  int64  `json:"implicit_runs"`
}

type SkillContributions struct {
	CreatedCount int64 `json:"created_count"`
	UpdatedCount int64 `json:"updated_count"`
}

type SkillUsageTotals struct {
	RequestedSkillRuns int64 `json:"requested_skill_runs"`
	ObservedSkillRuns  int64 `json:"observed_skill_runs"`
	ExplicitSkillRuns  int64 `json:"explicit_skill_runs"`
	ImplicitSkillRuns  int64 `json:"implicit_skill_runs"`
}

type EmployeeSkillUsage struct {
	EmployeeID         string     `json:"employee_id"`
	EmployeeName       string     `json:"employee_name"`
	ObservedSkillCount int64      `json:"observed_skill_count"`
	RequestedSkillRuns int64      `json:"requested_skill_runs"`
	ObservedSkillRuns  int64      `json:"observed_skill_runs"`
	ExplicitSkillRuns  int64      `json:"explicit_skill_runs"`
	ImplicitSkillRuns  int64      `json:"implicit_skill_runs"`
	LastObservedAt     *time.Time `json:"last_observed_at,omitempty"`
}

type Agent struct {
	CollectorID    string     `json:"collector_id"`
	AgentID        string     `json:"agent_id"`
	Name           string     `json:"name"`
	Status         string     `json:"status"`
	EmployeeID     string     `json:"employee_id"`
	EmployeeName   string     `json:"employee_name"`
	SessionCount   int64      `json:"session_count"`
	TurnCount      int64      `json:"turn_count"`
	LastActivityAt *time.Time `json:"last_activity_at,omitempty"`
}

type PlatformActivity struct {
	ActiveUsers int64   `json:"active_users"`
	TotalUsers  int64   `json:"total_users"`
	Rate        float64 `json:"rate"`
}

type ActivitySnapshot struct {
	ActiveEmployees    int64                `json:"active_employees"`
	ActiveAgents       int64                `json:"active_agents"`
	CompletedTurns     int64                `json:"completed_turns"`
	PlatformActivity   PlatformActivity     `json:"platform_activity"`
	Agents             []Agent              `json:"agents"`
	SkillUsage         []SkillUsage         `json:"skill_usage"`
	EmployeeSkillUsage []EmployeeSkillUsage `json:"employee_skill_usage"`
	SkillContributions SkillContributions   `json:"skill_contributions"`
	SkillUsageTotals   SkillUsageTotals     `json:"skill_usage_totals"`
}

type ActivityStore interface {
	Statistics(context.Context, time.Time, time.Time) (ActivitySnapshot, error)
}

type AgentSummaryReader interface {
	AgentSummary(context.Context, string, time.Time, time.Time, AgentDetailOptions) (AgentSummary, error)
}

type AgentUsageStore interface {
	AgentUsage(context.Context, string, string, string, DateRange) (AgentUsage, error)
}

type AgentUsagePoint struct {
	BucketStart    time.Time `json:"bucket_start"`
	SessionCount   int64     `json:"session_count"`
	TurnCount      int64     `json:"turn_count"`
	CompletedTurns int64     `json:"completed_turns"`
	ToolCallCount  int64     `json:"tool_call_count"`
}

type AgentUsage struct {
	CollectorID      string            `json:"collector_id"`
	AgentID          string            `json:"agent_id"`
	Range            string            `json:"range"`
	Timezone         string            `json:"timezone"`
	StartDate        string            `json:"start_date"`
	EndDate          string            `json:"end_date"`
	GeneratedAt      time.Time         `json:"generated_at"`
	SessionCount     int64             `json:"session_count"`
	TurnCount        int64             `json:"turn_count"`
	CompletedTurns   int64             `json:"completed_turns"`
	ToolCallCount    int64             `json:"tool_call_count"`
	Granularity      string            `json:"granularity"`
	Points           []AgentUsagePoint `json:"points"`
	MCPDistribution  []MCPUsage        `json:"mcp_distribution"`
	MCPStatus        string            `json:"mcp_status"`
	SkillUsage       []SkillUsage      `json:"skill_usage"`
	SkillUsageTotals SkillUsageTotals  `json:"skill_usage_totals"`
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
	Usage              Usage                `json:"usage"`
	ActiveEmployees    int64                `json:"active_employees"`
	ActiveAgents       int64                `json:"active_agents"`
	CompletedTurns     int64                `json:"completed_turns"`
	PlatformActivity   PlatformActivity     `json:"platform_activity"`
	MCPDistribution    []MCPUsage           `json:"mcp_distribution"`
	SkillUsage         []SkillUsage         `json:"skill_usage"`
	EmployeeSkillUsage []EmployeeSkillUsage `json:"employee_skill_usage"`
	SkillContributions SkillContributions   `json:"skill_contributions"`
	SkillUsageTotals   SkillUsageTotals     `json:"skill_usage_totals"`
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
	Range      string
	SortBy     string
	EmployeeID string
	Limit      int
	Offset     int
}

type AgentListItem struct {
	AgentID        string     `json:"agent_id"`
	Name           string     `json:"name"`
	Status         string     `json:"status"`
	EmployeeID     string     `json:"employee_id"`
	EmployeeName   string     `json:"employee_name"`
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
	Total       int               `json:"total"`
	Limit       int               `json:"limit"`
	Offset      int               `json:"offset"`
	HasMore     bool              `json:"has_more"`
	NextOffset  *int              `json:"next_offset"`
}

const MaxConversationTextChars = 8000

type AgentDetailOptions struct {
	EmployeeID     string
	IncludeContent bool
	SessionID      string
	Limit          int
	Offset         int
}

// ConversationContent 只覆盖查询周期内已上报的轮次，不代表完整本地会话历史。
type ConversationContent struct {
	Scope         string                `json:"scope"`
	Note          string                `json:"note"`
	TotalTurns    int                   `json:"total_turns"`
	ReturnedTurns int                   `json:"returned_turns"`
	Limit         int                   `json:"limit"`
	Offset        int                   `json:"offset"`
	HasMore       bool                  `json:"has_more"`
	NextOffset    *int                  `json:"next_offset"`
	Sessions      []ConversationSession `json:"sessions"`
}

type ConversationSession struct {
	CollectorID   string             `json:"collector_id"`
	SessionID     string             `json:"session_id"`
	WorkspaceName string             `json:"workspace_name"`
	Turns         []ConversationTurn `json:"turns"`
}

type ConversationTurn struct {
	TurnID                        string     `json:"turn_id"`
	Status                        string     `json:"status"`
	StartedAt                     time.Time  `json:"started_at"`
	CompletedAt                   *time.Time `json:"completed_at"`
	UserPrompt                    string     `json:"user_prompt"`
	LastAssistantMessage          string     `json:"last_assistant_message"`
	UserPromptMissing             bool       `json:"user_prompt_missing"`
	LastAssistantMessageMissing   bool       `json:"last_assistant_message_missing"`
	UserPromptTruncated           bool       `json:"user_prompt_truncated"`
	LastAssistantMessageTruncated bool       `json:"last_assistant_message_truncated"`
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
	EmployeeID         string                `json:"employee_id"`
	EmployeeName       string                `json:"employee_name"`
	LastActivityAt     *time.Time            `json:"last_activity_at"`
	SessionCount       int64                 `json:"session_count"`
	TurnCount          int64                 `json:"turn_count"`
	CompletedTurnCount int64                 `json:"completed_turn_count"`
	ToolCallCount      int64                 `json:"tool_call_count"`
	MCPCallCount       int64                 `json:"mcp_call_count"`
	RecentActivities   []AgentRecentActivity `json:"recent_activities"`
	Content            *ConversationContent  `json:"content,omitempty"`
}
