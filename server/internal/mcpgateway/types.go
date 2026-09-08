package mcpgateway

import (
	"context"
	"time"
)

type JSONMap map[string]any

const (
	TransportStreamableHTTP = "streamable_http"
	TransportSSE            = "sse"
	TransportStdio          = "stdio"
	TransportBuiltin        = "builtin"
	TransportCollectorPull  = "collector_pull"

	StatusPending    = "pending"
	StatusActive     = "active"
	StatusDisabled   = "disabled"
	StatusDeprecated = "deprecated"
	StatusMissing    = "missing"
	StatusSyncFailed = "sync_failed"
	StatusRevoked    = "revoked"
	StatusExpired    = "expired"

	CapabilityTool     = "tool"
	CapabilityResource = "resource"
	CapabilityPrompt   = "prompt"

	GrantTool     = "tool"
	GrantResource = "resource"
	GrantPrompt   = "prompt"
	GrantServer   = "server"

	EndpointTypeAggregate = "aggregate"
	EndpointTypeUpstream  = "upstream"

	DecisionAllowed                          = "allowed"
	DecisionNoMatchingGrant                  = "no_matching_grant"
	DecisionGrantExpired                     = "grant_expired"
	DecisionAgentDisabled                    = "agent_disabled"
	DecisionCapabilityDisabled               = "capability_disabled"
	DecisionServerDisabled                   = "server_disabled"
	DecisionInvalidInput                     = "invalid_input"
	DecisionUpstreamError                    = "upstream_error"
	DecisionInternalError                    = "internal_error"
	DecisionInvalidKnowledgeScope            = "invalid_knowledge_scope"
	DecisionNoMatchingKnowledgeScope         = "no_matching_knowledge_scope"
	DecisionCapabilityNotAvailableOnEndpoint = "capability_not_available_on_endpoint"

	ConfirmationModeAuto  = "auto"
	ConfirmationModeAsync = "async"
	ConfirmationModeSync  = "sync"

	SyncConfirmationAccepted  = "accepted"
	SyncConfirmationDeclined  = "declined"
	SyncConfirmationCancelled = "cancelled"

	GateTypeUserConfirmation = "user_confirmation"
	GateTypeAdminApproval    = "admin_approval"
	GateProviderInternal     = "internal"

	GatePending   GateStatus = "pending"
	GateAccepted  GateStatus = "accepted"
	GateRejected  GateStatus = "rejected"
	GateExpired   GateStatus = "expired"
	GateExecuting GateStatus = "executing"
	GateCompleted GateStatus = "completed"
	GateFailed    GateStatus = "failed"

	DecisionGateRequired                = "gate_required"
	DecisionConfirmationAccepted        = "confirmation_accepted"
	DecisionConfirmationRejected        = "confirmation_rejected"
	DecisionConfirmationExpired         = "confirmation_expired"
	DecisionConfirmationExecuting       = "confirmation_executing"
	DecisionConfirmationSyncRequested   = "confirmation_sync_requested"
	DecisionConfirmationSyncCancelled   = "confirmation_sync_cancelled"
	DecisionConfirmationCompleted       = "confirmation_completed"
	DecisionConfirmationExecutionFailed = "confirmation_execution_failed"
)

type GateStatus string

type StdioConfig struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	CWD     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
}

type UpstreamServer struct {
	ID                 string
	Name               string
	Domain             string
	Transport          string
	Endpoint           string
	Stdio              StdioConfig
	AuthType           string
	CredentialRef      string
	TokenCiphertext    []byte `json:"-"`
	OwnerTeam          string
	Namespace          string
	RoutingDescription string
	CollectorID        string
	Status             string
	CreatedAt          time.Time
	UpdatedAt          time.Time
	DeletedAt          *time.Time
}

type UpstreamSyncLog struct {
	ID               string
	UpstreamServerID string
	Status           string
	Message          string
	StartedAt        time.Time
	CompletedAt      time.Time
}

type AgentRegistration struct {
	AgentID        string
	ClientID       string
	Name           string
	TenantID       string
	ActorID        string
	Status         string
	CreationSource string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type AccountToken struct {
	ID              string
	UserID          string
	TokenHash       string
	TokenCiphertext []byte
	Fingerprint     string
	Status          string
	ExpiresAt       *time.Time
	LastUsedAt      *time.Time
	Issuer          string
	Scopes          []string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type Capability struct {
	ID               string
	UpstreamServerID string
	Type             string
	UpstreamName     string
	ExposedName      string
	Title            string
	Description      string
	InputSchema      JSONMap
	OutputSchema     JSONMap
	Annotations      JSONMap
	RiskLevel        string
	ReadOnly         bool
	Destructive      bool
	Idempotent       bool
	ApprovalRequired bool
	ConfirmRequired  bool
	ConfirmTemplate  string
	Status           string
	SchemaHash       string
	Version          string
	LastSyncedAt     time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type AccountGrant struct {
	ID           string
	UserID       string
	CapabilityID string
	GrantType    string
	DataScope    JSONMap
	ExpiresAt    *time.Time
	CreatedBy    string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type CapabilityFilter struct {
	ID               string
	UpstreamServerID string
	Type             string
	Status           string
	Domain           string
	RiskLevel        string
}

type GrantFilter struct {
	UserID       string
	CapabilityID string
	GrantType    string
}

type AgentFilter struct {
	AgentID string
	Status  string
}

type GrantDecision struct {
	Allowed bool
	Reason  string
	Grant   *AccountGrant
}

type AgentIdentity struct {
	UserID   string
	Subject  string
	ClientID string
	AgentID  string
	Issuer   string
	TokenID  string
	Scopes   []string
}

type ToolCatalogUpstream struct {
	ID        string
	Name      string
	Domain    string
	Transport string
	Namespace string
	Status    string
	Tools     []ToolCatalogTool
}

type ToolCatalogTool struct {
	ID                     string
	UpstreamName           string
	Name                   string
	ExposedName            string
	Title                  string
	Description            string
	RiskLevel              string
	ConfirmRequired        bool
	Status                 string
	Authorized             bool
	AuthorizationExpiresAt *time.Time
}

type UserConfirmationElicitor interface {
	SupportsUserConfirmation() bool
	ElicitUserConfirmation(context.Context, SyncConfirmationInput) (SyncConfirmationDecision, error)
}

type SyncConfirmationInput struct {
	Gate       GateRequest
	Capability Capability
	Timeout    time.Duration
}

type SyncConfirmationDecision struct {
	Action string
	Reason string
}

type ProxyAuditRecord struct {
	ID                       string
	TraceID                  string
	RequestID                string
	InboundSessionID         string
	UpstreamSessionID        string
	AgentID                  string
	UserID                   string
	ActorID                  string
	TenantID                 string
	TokenID                  string
	TokenHash                string
	EndpointType             string
	EndpointUpstreamServerID string
	UpstreamServerID         string
	CapabilityID             string
	CapabilityType           string
	ExposedName              string
	UpstreamName             string
	RequestHeaders           JSONMap
	RequestBody              JSONMap
	ResponseHeaders          JSONMap
	ResponseBody             JSONMap
	ResolvedDataScope        JSONMap
	Decision                 string
	DecisionReason           string
	Error                    string
	DurationMS               int64
	CreatedAt                time.Time
	CompletedAt              time.Time
}

type GateSummary struct {
	System      string          `json:"system"`
	Action      string          `json:"action"`
	Object      string          `json:"object"`
	Tool        string          `json:"tool"`
	RiskLevel   string          `json:"risk_level"`
	Destructive bool            `json:"destructive"`
	ReadOnly    bool            `json:"read_only"`
	Parameters  []GateParameter `json:"parameters"`
	Risks       []string        `json:"risks"`
}

type GateParameter struct {
	Path      string `json:"path"`
	Label     string `json:"label"`
	Value     string `json:"value"`
	Sensitive bool   `json:"sensitive"`
}

type GateRequest struct {
	ID                       string
	Type                     string
	Provider                 string
	TraceID                  string
	RequestAuditID           string
	ExecutionAuditID         string
	TenantID                 string
	UserID                   string
	AgentID                  string
	ActorID                  string
	TokenID                  string
	TokenHash                string
	EndpointType             string
	EndpointUpstreamServerID string
	CapabilityID             string
	CapabilityType           string
	UpstreamServerID         string
	InboundSessionID         string
	UpstreamSessionID        string
	ExposedName              string
	UpstreamName             string
	RequestHeaders           JSONMap
	RequestBody              JSONMap
	ArgumentsHash            string
	SchemaHash               string
	GateSummary              GateSummary
	Status                   GateStatus
	ConfirmURL               string
	DecidedBy                string
	DecisionReason           string
	DecidedAt                *time.Time
	ExpiresAt                time.Time
	ResponseHeaders          JSONMap
	ResponseBody             JSONMap
	Error                    string
	CreatedAt                time.Time
	UpdatedAt                time.Time
	CompletedAt              *time.Time
}

type GateFilter struct {
	Limit        int
	Type         string
	Status       string
	AgentID      string
	ActorID      string
	TenantID     string
	CapabilityID string
	CreatedFrom  time.Time
	CreatedTo    time.Time
}

type GateDecisionUpdate struct {
	ID        string
	From      GateStatus
	To        GateStatus
	DecidedBy string
	Reason    string
	DecidedAt time.Time
	Error     string
	UpdatedAt time.Time
}

type GateExecutionUpdate struct {
	ID               string
	From             GateStatus
	To               GateStatus
	ExecutionAuditID string
	ResponseHeaders  JSONMap
	ResponseBody     JSONMap
	Error            string
	UpdatedAt        time.Time
	CompletedAt      time.Time
}

type ProxyAuditFilter struct {
	Limit            int
	ID               string
	Decision         string
	AgentID          string
	UpstreamServerID string
	Tool             string
	CreatedFrom      time.Time
	CreatedTo        time.Time
	ErrorOnly        bool
}

type ListAuditRecord struct {
	ID                       string
	TraceID                  string
	AgentID                  string
	UserID                   string
	ActorID                  string
	TenantID                 string
	EndpointType             string
	EndpointUpstreamServerID string
	CapabilityType           string
	Decision                 string
	DecisionReason           string
	ReturnedCount            int
	FilteredCount            int
	CreatedAt                time.Time
}
