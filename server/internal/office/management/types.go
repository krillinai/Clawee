package management

import (
	"errors"
	"time"
)

const SchemaVersion = "office.v1"

const DefaultCollectorOnlineThreshold = 60 * time.Second

const (
	CollectorStatusOnline  = "online"
	CollectorStatusOffline = "offline"
	CollectorStatusNever   = "never"
	CollectorStatusRevoked = "revoked"
)

var (
	ErrCollectorNotFound       = errors.New("collector not found")
	ErrCollectorOnline         = errors.New("collector is online")
	ErrCollectorNotDisabled    = errors.New("collector is not disabled")
	ErrCollectorTokenRevoked   = errors.New("collector token is already revoked")
	ErrOfficeAgentNotFound     = errors.New("office agent not found")
	ErrOfficeAgentBound        = errors.New("office agent is bound to an mcp agent")
	ErrMCPAgentNotFound        = errors.New("mcp agent not found")
	ErrAgentOwnerMismatch      = errors.New("office agent and mcp agent owners do not match")
	ErrOfficeAgentAlreadyBound = errors.New("office agent is already bound to another mcp agent")
	ErrMCPAgentAlreadyBound    = errors.New("mcp agent is already bound to another office agent")
)

type CollectorsOverview struct {
	SchemaVersion          string                  `json:"schema_version"`
	ServerTime             time.Time               `json:"server_time"`
	OnlineThresholdSeconds int                     `json:"online_threshold_seconds"`
	RegistrationCode       RegistrationCodeSummary `json:"registration_code"`
	Summary                CollectorSummary        `json:"summary"`
	Collectors             []CollectorItem         `json:"collectors"`
}

type RegistrationCodeSummary struct {
	Exists     bool       `json:"exists"`
	Code       string     `json:"code,omitempty"`
	CreatedBy  string     `json:"created_by,omitempty"`
	CreatedAt  *time.Time `json:"created_at,omitempty"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	UsedCount  int        `json:"used_count"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	Revoked    bool       `json:"revoked"`
}

type CollectorSummary struct {
	TotalCollectors     int `json:"total_collectors"`
	OnlineCollectors    int `json:"online_collectors"`
	OfflineCollectors   int `json:"offline_collectors"`
	NeverSeenCollectors int `json:"never_seen_collectors"`
}

type CollectorItem struct {
	CollectorID          string     `json:"collector_id"`
	DeviceID             string     `json:"device_id"`
	DeviceName           string     `json:"device_name"`
	Hostname             string     `json:"hostname"`
	OS                   string     `json:"os"`
	Arch                 string     `json:"arch"`
	CollectorVersion     string     `json:"collector_version"`
	RegisteredAgentCount int        `json:"registered_agent_count"`
	RegisteredAt         *time.Time `json:"registered_at,omitempty"`
	TokenCreatedAt       time.Time  `json:"token_created_at"`
	TokenLastUsedAt      *time.Time `json:"token_last_used_at,omitempty"`
	LastSeenAt           *time.Time `json:"last_seen_at,omitempty"`
	Status               string     `json:"status"`
	UserID               string     `json:"user_id,omitempty"`
	UserName             string     `json:"user_name,omitempty"`
	UserEmail            string     `json:"user_email,omitempty"`
	TokenStatus          string     `json:"token_status"`
}

type AgentCollectorInfo struct {
	CollectorID      string     `json:"collector_id"`
	OfficeAgentID    string     `json:"office_agent_id"`
	DeviceID         string     `json:"device_id"`
	DeviceName       string     `json:"device_name"`
	Hostname         string     `json:"hostname"`
	OS               string     `json:"os"`
	Arch             string     `json:"arch"`
	CollectorVersion string     `json:"collector_version"`
	LastSeenAt       *time.Time `json:"last_seen_at,omitempty"`
	Status           string     `json:"status"`
}

type CreateRegistrationCodeRequest struct {
	UserID string `json:"user_id"`
}

type CreateRegistrationCodeResponse struct {
	RegistrationCode string     `json:"registration_code"`
	CreatedAt        time.Time  `json:"created_at"`
	ExpiresAt        *time.Time `json:"expires_at,omitempty"`
}
