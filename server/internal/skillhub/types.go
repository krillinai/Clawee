package skillhub

import (
	"errors"
	"io"
	"time"
)

const (
	DefaultSpaceID       = "skillspace_default"
	ResourceTypeSpace    = "skill_space"
	SpaceActionRead      = "read"
	SpaceActionWrite     = "write"
	MaxPackageSize       = int64(50 << 20)
	MaxUncompressedSize  = int64(200 << 20)
	MaxPackageEntries    = 2000
	MaxSkillMDSize       = int64(1 << 20)
	MaxFilePreviewSize   = int64(512 << 10)
	MaxDescriptionRunes  = 1000
	MaxChangelogRunes    = 2000
	MaxMultipartBodySize = MaxPackageSize + (1 << 20)
)

var (
	ErrInvalidRequest       = errors.New("invalid skillhub request")
	ErrPackageInvalid       = errors.New("invalid skill package")
	ErrPackageTooLarge      = errors.New("skill package too large")
	ErrNotFound             = errors.New("skillhub object not found")
	ErrConflict             = errors.New("skillhub operation conflict")
	ErrVersionChanged       = errors.New("skillhub current version changed")
	ErrFileNotPreviewable   = errors.New("skill file is not previewable")
	ErrStoredPackageInvalid = errors.New("stored skill package is invalid")
	ErrSpaceNotFound        = errors.New("skill space not found")
	ErrSpaceNameConflict    = errors.New("skill space name conflict")
	ErrMemberNotFound       = errors.New("skill space member not found")
	ErrMemberAlreadyExists  = errors.New("skill space member already exists")
)

type Skill struct {
	SkillID          string    `json:"skill_id"`
	SpaceID          string    `json:"space_id"`
	SpaceName        string    `json:"space_name"`
	Name             string    `json:"name"`
	Description      string    `json:"description"`
	CurrentVersionID *string   `json:"current_version_id"`
	CreatedBy        string    `json:"created_by"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type Version struct {
	VersionID         string                 `json:"version_id"`
	SkillID           string                 `json:"skill_id"`
	Version           string                 `json:"version"`
	Description       string                 `json:"description"`
	Changelog         string                 `json:"changelog"`
	PackagePath       string                 `json:"-"`
	PackageSHA256     string                 `json:"package_sha256"`
	Source            *VersionSourceEvidence `json:"source"`
	UploadedByUserID  string                 `json:"uploaded_by_user_id,omitempty"`
	UploadedByAgentID string                 `json:"uploaded_by_agent_id,omitempty"`
	CreatedAt         time.Time              `json:"created_at"`
}

type AdminDetail struct {
	Skill    Skill     `json:"skill"`
	Versions []Version `json:"versions"`
}

type MutationResult struct {
	Skill   Skill   `json:"skill"`
	Version Version `json:"version"`
}

type SkillSpaceMoveResult struct {
	TargetSpaceID  string `json:"target_space_id"`
	MovedCount     int64  `json:"moved_count"`
	UnchangedCount int64  `json:"unchanged_count"`
}

type PublishedItem struct {
	SkillID       string    `json:"skill_id"`
	SpaceID       string    `json:"space_id"`
	SpaceName     string    `json:"space_name"`
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	VersionID     string    `json:"version_id"`
	Version       string    `json:"version"`
	PackageSHA256 string    `json:"package_sha256"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type PublishedDetail struct {
	PublishedItem
	Changelog   string `json:"changelog"`
	PackagePath string `json:"-"`
}

type PackageMetadata struct {
	Name        string
	Description string
}

type UploadVersionInput struct {
	SpaceID           string
	Version           string
	Changelog         string
	Package           io.Reader
	CreatedBy         string
	UploadedByUserID  string
	UploadedByAgentID string
}

type CreateVersionInput struct {
	SpaceID           string
	Version           string
	Changelog         string
	Package           io.Reader
	CreatedBy         string
	Publish           bool
	Resolution        string
	TargetSkillID     string
	Source            *VersionSourceEvidence
	UploadedByUserID  string
	UploadedByAgentID string
}

type Space struct {
	SpaceID     string    `json:"space_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedBy   string    `json:"created_by,omitempty"`
	UpdatedBy   string    `json:"updated_by,omitempty"`
	CreatedAt   time.Time `json:"created_at,omitempty"`
	UpdatedAt   time.Time `json:"updated_at"`
	Actions     []string  `json:"actions,omitempty"`
}

type SpaceSummary struct {
	Space
	MemberCount    int64 `json:"member_count"`
	SkillCount     int64 `json:"skill_count"`
	PublishedCount int64 `json:"published_count"`
}

type SpaceMemberGrant struct {
	UserID      string    `json:"user_id"`
	Actions     []string  `json:"actions"`
	GrantStatus string    `json:"grant_status"`
	JoinedAt    time.Time `json:"joined_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

const (
	VersionResolutionByName     = "by_name"
	VersionResolutionCreateOnly = "create_only"
	VersionResolutionTarget     = "target"
)

type PackageDownload struct {
	Filename string
	Size     int64
	Reader   io.ReadCloser
	Detail   PublishedDetail
}

type PackageFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type PackageFileContent struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Content string `json:"content"`
}
