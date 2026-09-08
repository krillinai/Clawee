package skillhub

import "time"

const (
	GitHubSourceProvider = "github"

	SourceScheduleManual = "manual"
	SourceScheduleHourly = "hourly"
	SourceScheduleDaily  = "daily"

	SourceStatusActive   = "active"
	SourceStatusDisabled = "disabled"

	SourceItemStatusActive       = "active"
	SourceItemStatusNameConflict = "name_conflict"
	SourceItemStatusNameChanged  = "name_changed"
	SourceItemStatusInvalid      = "invalid"
	SourceItemStatusMissing      = "missing"

	SourceSyncTriggerManual    = "manual"
	SourceSyncTriggerScheduled = "scheduled"

	SourceRepositoryModeRemote = "remote"
	SourceRepositoryModeLocal  = "local"

	SourceSyncRunStatusQueued      = "queued"
	SourceSyncRunStatusRunning     = "running"
	SourceSyncRunStatusSuccess     = "success"
	SourceSyncRunStatusPartial     = "partial"
	SourceSyncRunStatusFailed      = "failed"
	SourceSyncRunStatusSkipped     = "skipped"
	SourceSyncRunStatusInterrupted = "interrupted"
)

type GitHubSource struct {
	SourceID            string     `json:"source_id"`
	SpaceID             string     `json:"space_id"`
	Provider            string     `json:"provider"`
	RepositoryOwner     string     `json:"repository_owner"`
	RepositoryName      string     `json:"repository_name"`
	Branch              string     `json:"branch"`
	ScanRoot            string     `json:"scan_root"`
	ExcludePaths        []string   `json:"exclude_paths"`
	HasToken            bool       `json:"has_token"`
	TokenCiphertext     []byte     `json:"-"`
	AutoPublish         bool       `json:"auto_publish"`
	Schedule            string     `json:"schedule"`
	Status              string     `json:"status"`
	LastAttemptAt       *time.Time `json:"last_attempt_at"`
	LastSuccessAt       *time.Time `json:"last_success_at"`
	LastSyncedCommitSHA *string    `json:"last_synced_commit_sha"`
	SyncRevision        int64      `json:"-"`
	LastErrorSummary    string     `json:"last_error_summary"`
	CreatedBy           string     `json:"created_by"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}

type SourceItem struct {
	SourceItemID      string     `json:"source_item_id"`
	SourceID          string     `json:"source_id"`
	SkillPath         string     `json:"skill_path"`
	DiscoveredName    string     `json:"discovered_name"`
	SkillID           *string    `json:"skill_id"`
	Status            string     `json:"status"`
	LastSeenCommitSHA *string    `json:"last_seen_commit_sha"`
	LastContentSHA256 *string    `json:"last_content_sha256"`
	LastVersionID     *string    `json:"last_version_id"`
	LastErrorSummary  string     `json:"last_error_summary"`
	MissingSince      *time.Time `json:"missing_since"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type SourceSyncRun struct {
	RunID               string     `json:"run_id"`
	SourceID            string     `json:"source_id"`
	Trigger             string     `json:"trigger"`
	RepositoryMode      string     `json:"repository_mode"`
	Status              string     `json:"status"`
	RequestedBy         string     `json:"requested_by"`
	SourceRevision      int64      `json:"-"`
	BeforeCommitSHA     *string    `json:"before_commit_sha"`
	TargetCommitSHA     *string    `json:"target_commit_sha"`
	DiscoveredCount     int        `json:"discovered_count"`
	CreatedVersionCount int        `json:"created_version_count"`
	PublishedCount      int        `json:"published_count"`
	ConflictCount       int        `json:"conflict_count"`
	FailedCount         int        `json:"failed_count"`
	ErrorSummary        string     `json:"error_summary"`
	StartedAt           *time.Time `json:"started_at"`
	FinishedAt          *time.Time `json:"finished_at"`
	CreatedAt           time.Time  `json:"created_at"`
}

type VersionSourceEvidence struct {
	SourceID        string `json:"source_id"`
	RepositoryOwner string `json:"repository_owner"`
	RepositoryName  string `json:"repository_name"`
	Path            string `json:"path"`
	CommitSHA       string `json:"commit_sha"`
	ContentSHA256   string `json:"content_sha256"`
}

type GitHubSourceSummary struct {
	Source          GitHubSource   `json:"source"`
	LatestRun       *SourceSyncRun `json:"latest_run"`
	DiscoveredCount int            `json:"discovered_count"`
}

type ManualCloneInstructions struct {
	WorkingDirectory    string                  `json:"working_directory"`
	RepositoryDirectory string                  `json:"repository_directory"`
	Command             string                  `json:"command"`
	CommandGroups       []ManualGitCommandGroup `json:"command_groups"`
}

type ManualGitCommandGroup struct {
	Title    string   `json:"title"`
	Commands []string `json:"commands"`
}
