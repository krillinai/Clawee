package skillhub

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

var (
	ErrSourceCredentialFailure = errors.New("github source credential operation failed")
	ErrSourceStoreFailure      = errors.New("github source store operation failed")
)

type GitHubSourceServiceConfig struct {
	Store       SourceStore
	TokenCipher mcpgateway.TokenCipher
	Workspace   *RepositoryWorkspace
	Clock       func() time.Time
	OnRunQueued func()
}

type GitHubSourceService struct {
	store       SourceStore
	tokenCipher mcpgateway.TokenCipher
	workspace   *RepositoryWorkspace
	clock       func() time.Time
	onRunQueued func()
}

type CreateGitHubSourceInput struct {
	SpaceID         string
	RepositoryOwner string
	RepositoryName  string
	Branch          string
	ScanRoot        string
	ExcludePaths    []string
	Token           string
	AutoPublish     bool
	Schedule        string
	CreatedBy       string
}

type UpdateGitHubSourceInput struct {
	RepositoryOwner string
	RepositoryName  string
	Branch          string
	ScanRoot        string
	ExcludePaths    []string
	Token           *string
	AutoPublish     bool
	Schedule        string
}

func NewGitHubSourceService(cfg GitHubSourceServiceConfig) *GitHubSourceService {
	clock := cfg.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	return &GitHubSourceService{store: cfg.Store, tokenCipher: cfg.TokenCipher, workspace: cfg.Workspace, clock: clock, onRunQueued: cfg.OnRunQueued}
}

func (s *GitHubSourceService) List(ctx context.Context) ([]GitHubSourceSummary, error) {
	if !s.ready() {
		return nil, ErrInvalidRequest
	}
	items, err := s.store.ListSources(ctx)
	if err != nil {
		return nil, safeSourceStoreError(err)
	}
	for index := range items {
		items[index].Source = publicSource(items[index].Source)
	}
	return items, nil
}

func (s *GitHubSourceService) Get(ctx context.Context, sourceID string) (GitHubSource, error) {
	source, err := s.sourceForMutation(ctx, sourceID)
	if err != nil {
		return GitHubSource{}, err
	}
	return publicSource(source), nil
}

func (s *GitHubSourceService) GetToken(ctx context.Context, sourceID string) (string, error) {
	source, err := s.sourceForMutation(ctx, sourceID)
	if err != nil {
		return "", err
	}
	if len(source.TokenCiphertext) == 0 {
		return "", nil
	}
	plaintext, err := s.tokenCipher.Decrypt(source.TokenCiphertext)
	if err != nil {
		return "", ErrSourceCredentialFailure
	}
	token := string(plaintext)
	clear(plaintext)
	return token, nil
}

func (s *GitHubSourceService) ManualCloneInstructions(source GitHubSource) *ManualCloneInstructions {
	if s == nil || s.workspace == nil {
		return nil
	}
	repositoryDirectory, err := s.workspace.WorkspacePath(source.SourceID)
	if err != nil {
		return nil
	}
	repositoryURL := CanonicalGitHubURL(source.RepositoryOwner, source.RepositoryName)
	repositoryName := shellQuote(filepath.Base(repositoryDirectory))
	branch := shellQuote(source.Branch)
	cloneCommand := "git clone --progress --depth=1 --single-branch --no-tags --branch " + branch + " " + shellQuote(repositoryURL) + " " + repositoryName
	resolveCommand := "git -C " + repositoryName + " rev-parse --verify 'FETCH_HEAD^{commit}' || git -C " + repositoryName + " rev-parse --verify 'HEAD^{commit}'"
	checkoutCommand := "git -C " + repositoryName + " checkout --detach \"$(git -C " + repositoryName + " rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null || git -C " + repositoryName + " rev-parse --verify 'HEAD^{commit}')\""
	return &ManualCloneInstructions{
		WorkingDirectory:    filepath.Dir(repositoryDirectory),
		RepositoryDirectory: repositoryDirectory,
		Command:             cloneCommand,
		CommandGroups: []ManualGitCommandGroup{
			{Title: "首次同步：Clone", Commands: []string{
				"git check-ref-format --branch " + branch,
				cloneCommand,
				resolveCommand,
				checkoutCommand,
			}},
			{Title: "后续同步：Fetch", Commands: []string{
				"git -C " + repositoryName + " remote get-url origin",
				"git -C " + repositoryName + " status --porcelain=v1 --untracked-files=all --ignored=matching",
				"git check-ref-format --branch " + branch,
				"git -C " + repositoryName + " fetch --progress --prune --depth=1 origin " + branch,
				resolveCommand,
				checkoutCommand,
			}},
			{Title: "Skill 发现阶段", Commands: []string{
				"git -C " + repositoryName + " ls-files --stage -z",
			}},
		},
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func (s *GitHubSourceService) ListItems(ctx context.Context, sourceID string) ([]SourceItem, error) {
	if _, err := s.sourceForMutation(ctx, sourceID); err != nil {
		return nil, err
	}
	items, err := s.store.ListSourceItems(ctx, strings.TrimSpace(sourceID))
	if err != nil {
		return nil, safeSourceStoreError(err)
	}
	return items, nil
}

func (s *GitHubSourceService) ListSyncRuns(ctx context.Context, sourceID string, limit int) ([]SourceSyncRun, error) {
	if _, err := s.sourceForMutation(ctx, sourceID); err != nil {
		return nil, err
	}
	runs, err := s.store.ListSourceSyncRuns(ctx, strings.TrimSpace(sourceID), limit)
	if err != nil {
		return nil, safeSourceStoreError(err)
	}
	return runs, nil
}

func (s *GitHubSourceService) Create(ctx context.Context, input CreateGitHubSourceInput) (GitHubSource, error) {
	if !s.ready() {
		return GitHubSource{}, ErrInvalidRequest
	}
	owner, repository, err := normalizeRepository(input.RepositoryOwner, input.RepositoryName)
	if err != nil || strings.TrimSpace(input.CreatedBy) == "" || strings.TrimSpace(input.Token) != input.Token {
		return GitHubSource{}, ErrInvalidRequest
	}
	scanRoot, err := NormalizeRepositoryRelativePath(input.ScanRoot, true)
	if err != nil {
		return GitHubSource{}, err
	}
	excludePaths, err := NormalizeExcludePaths(input.ExcludePaths)
	if err != nil {
		return GitHubSource{}, err
	}
	schedule := input.Schedule
	if schedule == "" {
		schedule = SourceScheduleManual
	}
	if !validSourceSchedule(schedule) {
		return GitHubSource{}, ErrInvalidRequest
	}
	branch := strings.TrimSpace(input.Branch)
	if branch == "" {
		branch = "main"
	}
	if err := ValidateGitBranch(branch); err != nil {
		return GitHubSource{}, err
	}

	var ciphertext []byte
	if input.Token != "" {
		ciphertext, err = s.tokenCipher.Encrypt([]byte(input.Token))
		if err != nil || len(ciphertext) == 0 {
			return GitHubSource{}, ErrSourceCredentialFailure
		}
	}
	now := s.clock().UTC()
	source := GitHubSource{
		SourceID: newID("source"), SpaceID: firstNonEmptyString(strings.TrimSpace(input.SpaceID), DefaultSpaceID), Provider: GitHubSourceProvider, RepositoryOwner: owner, RepositoryName: repository,
		Branch: branch, ScanRoot: scanRoot, ExcludePaths: excludePaths, HasToken: len(ciphertext) > 0, TokenCiphertext: ciphertext,
		AutoPublish: input.AutoPublish, Schedule: schedule, Status: SourceStatusActive,
		CreatedBy: strings.TrimSpace(input.CreatedBy), CreatedAt: now, UpdatedAt: now,
	}
	stored, err := s.store.CreateSource(ctx, source)
	if err != nil {
		return GitHubSource{}, safeSourceStoreError(err)
	}
	return publicSource(stored), nil
}

func (s *GitHubSourceService) Update(ctx context.Context, sourceID string, input UpdateGitHubSourceInput) (GitHubSource, error) {
	if !s.ready() || strings.TrimSpace(sourceID) == "" {
		return GitHubSource{}, ErrInvalidRequest
	}
	current, err := s.store.GetSource(ctx, strings.TrimSpace(sourceID))
	if err != nil {
		return GitHubSource{}, safeSourceStoreError(err)
	}
	if input.RepositoryOwner != "" || input.RepositoryName != "" {
		owner := input.RepositoryOwner
		repository := input.RepositoryName
		if owner == "" {
			owner = current.RepositoryOwner
		}
		if repository == "" {
			repository = current.RepositoryName
		}
		owner, repository, err = normalizeRepository(owner, repository)
		if err != nil || owner != current.RepositoryOwner || repository != current.RepositoryName {
			return GitHubSource{}, ErrInvalidRequest
		}
	}
	branch := strings.TrimSpace(input.Branch)
	if branch == "" {
		branch = current.Branch
	}
	if err := ValidateGitBranch(branch); err != nil {
		return GitHubSource{}, err
	}
	scanRoot, err := NormalizeRepositoryRelativePath(input.ScanRoot, true)
	if err != nil {
		return GitHubSource{}, err
	}
	excludePaths, err := NormalizeExcludePaths(input.ExcludePaths)
	if err != nil {
		return GitHubSource{}, err
	}
	schedule := input.Schedule
	if schedule == "" {
		schedule = current.Schedule
	}
	if !validSourceSchedule(schedule) {
		return GitHubSource{}, ErrInvalidRequest
	}

	tokenMode := TokenKeep
	if input.Token != nil {
		if strings.TrimSpace(*input.Token) != *input.Token {
			return GitHubSource{}, ErrInvalidRequest
		}
		if *input.Token == "" {
			current.TokenCiphertext = nil
			current.HasToken = false
			tokenMode = TokenRemove
		} else {
			current.TokenCiphertext, err = s.tokenCipher.Encrypt([]byte(*input.Token))
			if err != nil || len(current.TokenCiphertext) == 0 {
				return GitHubSource{}, ErrSourceCredentialFailure
			}
			tokenMode = TokenReplace
		}
	}
	current.Branch = branch
	current.ScanRoot = scanRoot
	current.ExcludePaths = excludePaths
	current.AutoPublish = input.AutoPublish
	current.Schedule = schedule
	current.UpdatedAt = s.clock().UTC()
	stored, err := s.store.UpdateSource(ctx, current, tokenMode)
	if err != nil {
		return GitHubSource{}, safeSourceStoreError(err)
	}
	return publicSource(stored), nil
}

func (s *GitHubSourceService) RemoveToken(ctx context.Context, sourceID string) (GitHubSource, error) {
	current, err := s.sourceForMutation(ctx, sourceID)
	if err != nil {
		return GitHubSource{}, err
	}
	current.TokenCiphertext = nil
	current.HasToken = false
	current.UpdatedAt = s.clock().UTC()
	stored, err := s.store.UpdateSource(ctx, current, TokenRemove)
	if err != nil {
		return GitHubSource{}, safeSourceStoreError(err)
	}
	return publicSource(stored), nil
}

func (s *GitHubSourceService) Disable(ctx context.Context, sourceID string) (GitHubSource, error) {
	return s.changeStatus(ctx, sourceID, SourceStatusDisabled)
}

func (s *GitHubSourceService) Enable(ctx context.Context, sourceID string) (GitHubSource, error) {
	return s.changeStatus(ctx, sourceID, SourceStatusActive)
}

func (s *GitHubSourceService) BindItem(ctx context.Context, sourceItemID, skillID string) (SourceItem, error) {
	if !s.ready() || strings.TrimSpace(sourceItemID) == "" || strings.TrimSpace(skillID) == "" {
		return SourceItem{}, ErrInvalidRequest
	}
	item, err := s.store.BindSourceItem(ctx, strings.TrimSpace(sourceItemID), strings.TrimSpace(skillID), s.clock().UTC())
	if err != nil {
		return SourceItem{}, safeSourceStoreError(err)
	}
	return item, nil
}

func (s *GitHubSourceService) UnbindItem(ctx context.Context, sourceItemID string) (SourceItem, error) {
	if !s.ready() || strings.TrimSpace(sourceItemID) == "" {
		return SourceItem{}, ErrInvalidRequest
	}
	item, err := s.store.UnbindSourceItem(ctx, strings.TrimSpace(sourceItemID), s.clock().UTC())
	if err != nil {
		return SourceItem{}, safeSourceStoreError(err)
	}
	return item, nil
}

func (s *GitHubSourceService) QueueSync(ctx context.Context, sourceID, requestedBy string) (SourceSyncRun, error) {
	return s.queueSync(ctx, sourceID, requestedBy, SourceRepositoryModeRemote)
}

func (s *GitHubSourceService) QueueLocalScan(ctx context.Context, sourceID, requestedBy string) (SourceSyncRun, error) {
	return s.queueSync(ctx, sourceID, requestedBy, SourceRepositoryModeLocal)
}

func (s *GitHubSourceService) queueSync(ctx context.Context, sourceID, requestedBy, repositoryMode string) (SourceSyncRun, error) {
	current, err := s.sourceForMutation(ctx, sourceID)
	if err != nil {
		return SourceSyncRun{}, err
	}
	if current.Status != SourceStatusActive {
		return SourceSyncRun{}, ErrConflict
	}
	requestedBy = strings.TrimSpace(requestedBy)
	if requestedBy == "" {
		return SourceSyncRun{}, ErrInvalidRequest
	}
	run := SourceSyncRun{
		RunID: newID("sourcerun"), SourceID: current.SourceID, Trigger: SourceSyncTriggerManual,
		RepositoryMode: repositoryMode, Status: SourceSyncRunStatusQueued, RequestedBy: requestedBy,
		BeforeCommitSHA: cloneStringPointer(current.LastSyncedCommitSHA), CreatedAt: s.clock().UTC(),
	}
	stored, err := s.store.CreateSyncRun(ctx, run)
	if err != nil {
		return SourceSyncRun{}, safeSourceStoreError(err)
	}
	if s.onRunQueued != nil {
		s.onRunQueued()
	}
	return stored, nil
}

func (s *GitHubSourceService) changeStatus(ctx context.Context, sourceID, status string) (GitHubSource, error) {
	current, err := s.sourceForMutation(ctx, sourceID)
	if err != nil {
		return GitHubSource{}, err
	}
	current.Status = status
	current.UpdatedAt = s.clock().UTC()
	stored, err := s.store.UpdateSource(ctx, current, TokenKeep)
	if err != nil {
		return GitHubSource{}, safeSourceStoreError(err)
	}
	return publicSource(stored), nil
}

func (s *GitHubSourceService) sourceForMutation(ctx context.Context, sourceID string) (GitHubSource, error) {
	if !s.ready() || strings.TrimSpace(sourceID) == "" {
		return GitHubSource{}, ErrInvalidRequest
	}
	source, err := s.store.GetSource(ctx, strings.TrimSpace(sourceID))
	if err != nil {
		return GitHubSource{}, safeSourceStoreError(err)
	}
	return source, nil
}

func (s *GitHubSourceService) ready() bool {
	return s != nil && s.store != nil && s.tokenCipher != nil
}

func normalizeRepository(owner, repository string) (string, string, error) {
	owner = strings.ToLower(strings.TrimSpace(owner))
	repository = strings.ToLower(strings.TrimSpace(repository))
	if ValidateGitHubRepositoryPart(owner) != nil || ValidateGitHubRepositoryPart(repository) != nil {
		return "", "", ErrInvalidRequest
	}
	return owner, repository, nil
}

func validSourceSchedule(value string) bool {
	return value == SourceScheduleManual || value == SourceScheduleHourly || value == SourceScheduleDaily
}

func publicSource(source GitHubSource) GitHubSource {
	source.HasToken = len(source.TokenCiphertext) > 0 || source.HasToken
	source.TokenCiphertext = nil
	return source
}

func safeSourceStoreError(err error) error {
	for _, known := range []error{ErrInvalidRequest, ErrNotFound, ErrConflict} {
		if errors.Is(err, known) {
			return known
		}
	}
	return ErrSourceStoreFailure
}
