package sharedfiles

import (
	"errors"
	"time"
)

const (
	MaxFileSizeBytes      int64 = 1 << 30
	DefaultLimit                = 50
	MaxLimit                    = 100
	LocalDefaultProfileID       = "shared_files_local_default"

	ResourceTypeSharedSpace = "shared_space"
	ActionRead              = "read"
	ActionWrite             = "write"
)

var (
	ErrInvalidRequest               = errors.New("invalid request")
	ErrInvalidLogicalPath           = errors.New("invalid logical path")
	ErrInvalidDigest                = errors.New("invalid digest")
	ErrInvalidCursor                = errors.New("invalid cursor")
	ErrSharedSpaceNotFound          = errors.New("shared space not found")
	ErrSharedFileNotFound           = errors.New("shared file not found")
	ErrMemberNotFound               = errors.New("member not found")
	ErrSpaceNameConflict            = errors.New("space name conflict")
	ErrMemberAlreadyExists          = errors.New("member already exists")
	ErrFileAlreadyExists            = errors.New("file already exists")
	ErrRevisionConflict             = errors.New("revision conflict")
	ErrFileTooLarge                 = errors.New("file too large")
	ErrContentLengthMismatch        = errors.New("content length mismatch")
	ErrDigestMismatch               = errors.New("digest mismatch")
	ErrStorageUnavailable           = errors.New("storage unavailable")
	ErrInvalidStorageConfiguration  = errors.New("invalid storage configuration")
	ErrStorageProbeFailed           = errors.New("storage probe failed")
	ErrStorageProbeDeleteFailed     = errors.New("storage probe delete failed")
	ErrStorageConfigurationConflict = errors.New("storage configuration conflict")
	ErrStorageProfileInUse          = errors.New("storage profile in use")
	ErrStorageMigrationRunning      = errors.New("storage migration running")
	ErrStorageProfileNotFound       = errors.New("storage profile not found")
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
	StorageProfileID string    `json:"-"`
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

type ObjectRef struct {
	StorageProfileID string
	StorageKey       string
}

type StorageProfile struct {
	ProfileID                 string     `json:"profile_id"`
	Name                      string     `json:"name"`
	Provider                  string     `json:"provider"`
	Endpoint                  string     `json:"endpoint,omitempty"`
	Region                    string     `json:"region,omitempty"`
	Bucket                    string     `json:"bucket,omitempty"`
	ObjectPrefix              string     `json:"object_prefix,omitempty"`
	CredentialMode            string     `json:"credential_mode,omitempty"`
	AccessKeyIDCiphertext     []byte     `json:"-"`
	AccessKeySecretCiphertext []byte     `json:"-"`
	AccessKeyIDHint           string     `json:"access_key_id_hint,omitempty"`
	CredentialsConfigured     bool       `json:"credentials_configured"`
	Status                    string     `json:"status"`
	LastProbeStatus           string     `json:"last_probe_status"`
	Health                    string     `json:"health"`
	LastProbeAt               *time.Time `json:"last_probe_at,omitempty"`
	CreatedBy                 string     `json:"-"`
	UpdatedBy                 string     `json:"-"`
	CreatedAt                 time.Time  `json:"created_at"`
	UpdatedAt                 time.Time  `json:"updated_at"`
	FileCount                 int64      `json:"file_count"`
	SizeBytes                 int64      `json:"size_bytes"`
}

type StorageSettings struct {
	ActiveProfileID string    `json:"active_profile_id"`
	Revision        int64     `json:"revision"`
	UpdatedBy       string    `json:"-"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type StorageState struct {
	ActiveProfileID string           `json:"active_profile_id"`
	Revision        int64            `json:"revision"`
	Profiles        []StorageProfile `json:"profiles"`
}

type StorageMigration struct {
	MigrationID         string                    `json:"migration_id"`
	SourceProfileID     string                    `json:"source_profile_id"`
	TargetProfileID     string                    `json:"target_profile_id"`
	Status              string                    `json:"status"`
	TotalCount          int64                     `json:"total_count"`
	SuccessCount        int64                     `json:"success_count"`
	FailedCount         int64                     `json:"failed_count"`
	SkippedCount        int64                     `json:"skipped_count"`
	CleanupPendingCount int64                     `json:"cleanup_pending_count"`
	CreatedBy           string                    `json:"created_by"`
	CreatedAt           time.Time                 `json:"created_at"`
	StartedAt           *time.Time                `json:"started_at,omitempty"`
	FinishedAt          *time.Time                `json:"finished_at,omitempty"`
	FailedItems         []StorageMigrationFailure `json:"failed_items"`
}

type StorageMigrationFailure struct {
	FileID       string `json:"file_id"`
	AttemptCount int    `json:"attempt_count"`
	ErrorCode    string `json:"error_code"`
	ErrorMessage string `json:"error_message"`
}

type StorageMigrationItem struct {
	MigrationID      string
	FileID           string
	SourceProfileID  string
	SourceStorageKey string
	SourceRevision   int64
	SourceSizeBytes  int64
	SourceSHA256     string
	TargetStorageKey string
	AttemptCount     int
}

type OSSProfileInput struct {
	ProfileID        string `json:"profile_id,omitempty"`
	Name             string `json:"name"`
	Endpoint         string `json:"endpoint"`
	Region           string `json:"region"`
	Bucket           string `json:"bucket"`
	ObjectPrefix     string `json:"object_prefix"`
	CredentialMode   string `json:"credential_mode"`
	CredentialAction string `json:"credential_action,omitempty"`
	AccessKeyID      string `json:"access_key_id,omitempty"`
	AccessKeySecret  string `json:"access_key_secret,omitempty"`
}

type StorageAudit struct {
	AuditID        string
	RequestID      string
	OperatorUserID string
	Action         string
	ObjectID       string
	Result         string
	Details        map[string]any
	CreatedAt      time.Time
}

type CleanupTask struct {
	CleanupID        string
	StorageProfileID string
	StorageKey       string
	Source           string
	FileID           string
	MigrationID      string
	AttemptCount     int
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
