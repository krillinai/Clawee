package skillhub

import (
	"context"
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
	ErrInvalidRequest           = errors.New("invalid skillhub request")
	ErrPackageInvalid           = errors.New("invalid skill package")
	ErrPackageTooLarge          = errors.New("skill package too large")
	ErrNotFound                 = errors.New("skillhub object not found")
	ErrConflict                 = errors.New("skillhub operation conflict")
	ErrVersionChanged           = errors.New("skillhub current version changed")
	ErrFileNotPreviewable       = errors.New("skill file is not previewable")
	ErrStoredPackageInvalid     = errors.New("stored skill package is invalid")
	ErrSpaceNotFound            = errors.New("skill space not found")
	ErrSpaceNameConflict        = errors.New("skill space name conflict")
	ErrMemberNotFound           = errors.New("skill space member not found")
	ErrMemberAlreadyExists      = errors.New("skill space member already exists")
	ErrApprovalRequired         = errors.New("skill version approval required")
	ErrReviewForbidden          = errors.New("skill space reviewer required")
	ErrSelfPublishForbidden     = errors.New("only the uploader can publish without approval")
	ErrExternalApprovalConflict = errors.New("external approval request conflicts with existing request")
)

type Skill struct {
	SkillID          string              `json:"skill_id"`
	SpaceID          string              `json:"space_id"`
	SpaceName        string              `json:"space_name"`
	Name             string              `json:"name"`
	Description      string              `json:"description"`
	CurrentVersionID *string             `json:"current_version_id"`
	CreatedBy        string              `json:"created_by"`
	CreatedByUserID  string              `json:"-"`
	CreatedAt        time.Time           `json:"created_at"`
	UpdatedAt        time.Time           `json:"updated_at"`
	LatestVersion    *SkillLatestVersion `json:"latest_version,omitempty"`
}

type SkillLatestVersion struct {
	LocalApproval    *LocalApproval `json:"local_approval,omitempty"`
	PackageSHA256    string         `json:"-"`
	VersionID        string         `json:"version_id"`
	Version          string         `json:"version"`
	ApprovalStatus   string         `json:"approval_status"`
	UploadedByUserID string         `json:"uploaded_by_user_id"`
}

type OwnPendingVersion struct {
	SkillID          string            `json:"skill_id"`
	SpaceID          string            `json:"space_id"`
	Name             string            `json:"name"`
	VersionID        string            `json:"version_id"`
	Version          string            `json:"version"`
	CreatedAt        time.Time         `json:"created_at"`
	ApprovalProvider string            `json:"approval_provider,omitempty"`
	ApprovalInstance *ApprovalInstance `json:"approval_instance"`
}

type ApprovalInstance struct {
	ID                      string    `json:"id"`
	VersionID               string    `json:"-"`
	SpaceID                 string    `json:"-"`
	PackageSHA256           string    `json:"-"`
	TemplateID              string    `json:"-"`
	ProviderInstanceID      string    `json:"provider_instance_id"`
	InitiatorUserID         string    `json:"-"`
	InitiatorExternalUserID string    `json:"-"`
	Status                  string    `json:"status"`
	Decision                string    `json:"decision"`
	CreatedAt               time.Time `json:"-"`
	UpdatedAt               time.Time `json:"-"`
}

type Version struct {
	LocalApproval     *LocalApproval         `json:"local_approval,omitempty"`
	SkillName         string                 `json:"skill_name"`
	ApprovalStatus    string                 `json:"approval_status"`
	ApprovedSpaceID   string                 `json:"-"`
	ReviewedBy        string                 `json:"reviewed_by"`
	ReviewedAt        *time.Time             `json:"reviewed_at"`
	ReviewComment     string                 `json:"review_comment"`
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
	UploadedByName    string                 `json:"-"`
	CreatedAt         time.Time              `json:"created_at"`
	ApprovalInstance  *ApprovalInstance      `json:"approval_instance"`
}

type Approver struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
}

type ApprovalRole struct {
	RoleID string `json:"role_id"`
	Name   string `json:"name"`
}

type ApprovalRoleLookup func(context.Context, string) (ApprovalRole, []Approver, error)

type ApprovalDecision struct {
	Approver
	Scores    *ReviewScores `json:"scores,omitempty"`
	Status    string        `json:"status"`
	Comment   string        `json:"comment"`
	DecidedAt *time.Time    `json:"decided_at"`
}

type LocalApproval struct {
	AIReview               *AIReview          `json:"ai_review,omitempty"`
	RequestID              string             `json:"request_id"`
	ContentDigest          string             `json:"content_digest"`
	ScoringStandardVersion string             `json:"scoring_standard_version,omitempty"`
	ScoreSummary           *ScoreSummary      `json:"score_summary,omitempty"`
	Status                 string             `json:"status"`
	Total                  int                `json:"total"`
	Approved               int                `json:"approved"`
	Approvers              []ApprovalDecision `json:"approvers"`
}

type ReviewScores struct {
	ScenarioValue       *int `json:"scenario_value,omitempty"`
	ResultEffectiveness *int `json:"result_effectiveness,omitempty"`
	EaseOfUse           *int `json:"ease_of_use,omitempty"`
	ReuseValue          *int `json:"reuse_value,omitempty"`
}

type ScoreSummary struct {
	ScenarioValue       float64 `json:"scenario_value"`
	ResultEffectiveness float64 `json:"result_effectiveness"`
	EaseOfUse           float64 `json:"ease_of_use"`
	ReuseValue          float64 `json:"reuse_value"`
	Total               float64 `json:"total"`
}

type ReviewInput struct {
	RequestID string
	Scores    *ReviewScores
}

type AdminDetail struct {
	CanReview bool      `json:"can_review"`
	Skill     Skill     `json:"skill"`
	Versions  []Version `json:"versions"`
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
	SkillID       string             `json:"skill_id"`
	SpaceID       string             `json:"space_id"`
	SpaceName     string             `json:"space_name"`
	Name          string             `json:"name"`
	Description   string             `json:"description"`
	VersionID     string             `json:"version_id"`
	Version       string             `json:"version"`
	PackageSHA256 string             `json:"package_sha256"`
	UpdatedAt     time.Time          `json:"updated_at"`
	Creator       *SkillParticipant  `json:"creator,omitempty"`
	Contributors  []SkillParticipant `json:"contributors,omitempty"`
}

type SkillParticipant struct {
	UserID    string `json:"user_id,omitempty"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url,omitempty"`
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
	TargetSkillID     string
	SpaceID           string
	Version           string
	Changelog         string
	Package           io.Reader
	CreatedBy         string
	UploadedByUserID  string
	UploadedByAgentID string
	Origin            string
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
	Origin            string
}

type Space struct {
	ApproverRoleIDs            []string       `json:"approver_role_ids"`
	ApproverRoles              []ApprovalRole `json:"approver_roles"`
	Approvers                  []Approver     `json:"approvers"`
	ApprovalProvider           string         `json:"approval_provider"`
	ExternalApprovalTemplateID string         `json:"external_approval_template_id"`
	SpaceID                    string         `json:"space_id"`
	Name                       string         `json:"name"`
	Description                string         `json:"description"`
	CreatedBy                  string         `json:"created_by,omitempty"`
	UpdatedBy                  string         `json:"updated_by,omitempty"`
	CreatedAt                  time.Time      `json:"created_at,omitempty"`
	UpdatedAt                  time.Time      `json:"updated_at"`
	Actions                    []string       `json:"actions,omitempty"`
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
	VersionResolutionReplace    = "replace"
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
