package sharedfiles

import (
	"errors"
	"time"
)

const (
	MaxFileSizeBytes int64 = 1 << 30
	DefaultLimit           = 50
	MaxLimit               = 100

	ResourceTypeSharedSpace = "shared_space"
	ActionRead              = "read"
	ActionWrite             = "write"
)

var (
	ErrInvalidRequest        = errors.New("invalid request")
	ErrInvalidLogicalPath    = errors.New("invalid logical path")
	ErrInvalidDigest         = errors.New("invalid digest")
	ErrInvalidCursor         = errors.New("invalid cursor")
	ErrSharedSpaceNotFound   = errors.New("shared space not found")
	ErrSharedFileNotFound    = errors.New("shared file not found")
	ErrMemberNotFound        = errors.New("member not found")
	ErrSpaceNameConflict     = errors.New("space name conflict")
	ErrMemberAlreadyExists   = errors.New("member already exists")
	ErrFileAlreadyExists     = errors.New("file already exists")
	ErrRevisionConflict      = errors.New("revision conflict")
	ErrFileTooLarge          = errors.New("file too large")
	ErrContentLengthMismatch = errors.New("content length mismatch")
	ErrDigestMismatch        = errors.New("digest mismatch")
	ErrStorageUnavailable    = errors.New("storage unavailable")
)

type Space struct {
	SpaceID     string    `json:"space_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedBy   string    `json:"created_by,omitempty"`
	UpdatedBy   string    `json:"updated_by,omitempty"`
	CreatedAt   time.Time `json:"created_at,omitempty"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type SpaceSummary struct {
	Space
	MemberCount int64 `json:"member_count"`
	FileCount   int64 `json:"file_count"`
	SizeBytes   int64 `json:"size_bytes"`
}

type Member struct {
	UserID        string    `json:"user_id"`
	Name          string    `json:"name"`
	Email         string    `json:"email"`
	AccountStatus string    `json:"account_status"`
	GrantStatus   string    `json:"grant_status"`
	Actions       []string  `json:"actions"`
	JoinedAt      time.Time `json:"joined_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type MemberCandidate struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
}

type File struct {
	FileID           string    `json:"file_id"`
	SpaceID          string    `json:"space_id"`
	SpaceName        string    `json:"space_name,omitempty"`
	LogicalPath      string    `json:"logical_path"`
	FileName         string    `json:"file_name"`
	StorageKey       string    `json:"-"`
	SizeBytes        int64     `json:"size_bytes"`
	SHA256           string    `json:"sha256"`
	ContentType      string    `json:"content_type"`
	Revision         int64     `json:"revision"`
	CreatedByUserID  string    `json:"created_by_user_id,omitempty"`
	CreatedByAgentID string    `json:"created_by_agent_id,omitempty"`
	UpdatedByUserID  string    `json:"updated_by_user_id"`
	UpdatedByAgentID string    `json:"updated_by_agent_id"`
	CreatedAt        time.Time `json:"created_at,omitempty"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type UploadResult struct {
	FileID      string    `json:"file_id"`
	SpaceID     string    `json:"space_id"`
	LogicalPath string    `json:"logical_path"`
	FileName    string    `json:"file_name"`
	SizeBytes   int64     `json:"size_bytes"`
	SHA256      string    `json:"sha256"`
	ContentType string    `json:"content_type"`
	Revision    int64     `json:"revision"`
	Created     bool      `json:"created"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Page[T any] struct {
	Items      []T
	NextCursor string
	HasNext    bool
}

type Cursor struct {
	UpdatedAt time.Time
	ID        string
	Name      string
}

type SpaceFilter struct {
	UserID string
	Query  string
	Limit  int
	Cursor Cursor
}

type FileFilter struct {
	UserID            string
	SpaceID           string
	Query             string
	LogicalPathPrefix string
	Limit             int
	Cursor            Cursor
}

type MemberFilter struct {
	SpaceID string
	Query   string
	Limit   int
	Cursor  Cursor
}
