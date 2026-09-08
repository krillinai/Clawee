package skillhub

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

var (
	errSourceSyncCredential = errors.New("source sync credential decryption failed")
	errSourceSyncWorkspace  = errors.New("source sync workspace update failed")
	errSourceSyncDiscovery  = errors.New("source sync discovery failed")
	errSourceSyncStore      = errors.New("source sync store operation failed")
	errSourceSyncCompletion = errors.New("source sync completion failed")
)

const (
	sourceSyncCompletionTimeout = 5 * time.Second
	sourceCloneFailurePrefix    = "Git Clone 失败："
)

type SourceSyncServiceConfig struct {
	Store          SourceStore
	TokenCipher    mcpgateway.TokenCipher
	Workspace      *RepositoryWorkspace
	Git            *GitClient
	Discovery      *SkillDiscovery
	PackageBuilder *SourcePackageBuilder
	VersionService *Service
	PackageRoot    string
	Clock          func() time.Time
}

type SourceSyncService struct {
	store          SourceStore
	tokenCipher    mcpgateway.TokenCipher
	workspace      *RepositoryWorkspace
	git            *GitClient
	discovery      *SkillDiscovery
	packageBuilder *SourcePackageBuilder
	versionService *Service
	packageRoot    string
	clock          func() time.Time

	locksMu sync.Mutex
	locks   map[string]*sync.Mutex
}

func NewSourceSyncService(cfg SourceSyncServiceConfig) *SourceSyncService {
	clock := cfg.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	return &SourceSyncService{
		store: cfg.Store, tokenCipher: cfg.TokenCipher, workspace: cfg.Workspace, git: cfg.Git,
		discovery: cfg.Discovery, packageBuilder: cfg.PackageBuilder, versionService: cfg.VersionService,
		packageRoot: cfg.PackageRoot, clock: clock, locks: make(map[string]*sync.Mutex),
	}
}

func (s *SourceSyncService) Run(ctx context.Context, run SourceSyncRun) error {
	if !s.ready() || strings.TrimSpace(run.RunID) == "" || strings.TrimSpace(run.SourceID) == "" || run.Status != SourceSyncRunStatusRunning {
		return ErrInvalidRequest
	}
	lock := s.sourceLock(run.SourceID)
	lock.Lock()
	defer lock.Unlock()

	source, err := s.store.GetSource(ctx, run.SourceID)
	if err != nil {
		return s.failRun(ctx, run, GitHubSource{SourceID: run.SourceID}, errSourceSyncStore, "读取来源失败")
	}
	if source.Status != SourceStatusActive {
		return s.failRun(ctx, run, source, ErrConflict, "来源不是启用状态")
	}

	var commitSHA string
	if run.RepositoryMode == SourceRepositoryModeLocal {
		commitSHA, err = s.workspace.UseExisting(ctx, source)
		if err != nil {
			return s.failRun(ctx, run, source, errSourceSyncWorkspace, "本地仓库校验失败："+err.Error())
		}
	} else {
		if run.RepositoryMode != "" && run.RepositoryMode != SourceRepositoryModeRemote {
			return s.failRun(ctx, run, source, ErrInvalidRequest, "仓库读取模式无效")
		}
		token := ""
		if len(source.TokenCiphertext) > 0 {
			plaintext, decryptErr := s.tokenCipher.Decrypt(source.TokenCiphertext)
			if decryptErr != nil {
				return s.failRun(ctx, run, source, errSourceSyncCredential, "来源凭据解密失败")
			}
			defer clear(plaintext)
			token = string(plaintext)
		}
		commitSHA, err = s.workspace.Update(ctx, source, token)
		if err != nil {
			summary := "仓库工作区更新失败：" + err.Error()
			var cloneErr *repositoryCloneError
			if errors.As(err, &cloneErr) {
				summary = sourceCloneFailurePrefix + cloneErr.cause.Error()
			}
			return s.failRun(ctx, run, source, errSourceSyncWorkspace, summary)
		}
	}
	run.TargetCommitSHA = stringPointer(commitSHA)
	if source.LastSyncedCommitSHA != nil && *source.LastSyncedCommitSHA == commitSHA {
		return s.completeRun(ctx, run, source, SourceSyncRunStatusSkipped, true, "")
	}

	repositoryRoot, err := s.workspace.WorkspacePath(source.SourceID)
	if err != nil {
		return s.failRun(ctx, run, source, errSourceSyncWorkspace, "仓库工作区不可用")
	}
	discovered, err := s.discovery.Discover(repositoryRoot, source.ScanRoot, source.ExcludePaths)
	if err != nil {
		return s.failRun(ctx, run, source, errSourceSyncDiscovery, "完整发现失败")
	}
	run.DiscoveredCount = len(discovered)
	existingItems, err := s.store.ListSourceItems(ctx, source.SourceID)
	if err != nil {
		return s.failRun(ctx, run, source, errSourceSyncStore, "读取来源项失败")
	}
	gitlinks, err := s.git.ListGitlinks(ctx, repositoryRoot)
	if err != nil {
		return s.failRun(ctx, run, source, errSourceSyncWorkspace, "读取仓库索引失败")
	}

	candidates := make([]sourceSyncCandidate, 0, len(discovered))
	for _, skill := range discovered {
		candidate := s.buildCandidate(repositoryRoot, skill, gitlinks)
		candidates = append(candidates, candidate)
	}
	defer func() {
		for _, candidate := range candidates {
			if candidate.packagePath != "" {
				_ = os.Remove(candidate.packagePath)
			}
		}
	}()

	nameCounts := make(map[string]int, len(candidates))
	for _, candidate := range candidates {
		if candidate.err == nil {
			nameCounts[candidate.metadata.Name]++
		}
	}
	itemsByPath := make(map[string]SourceItem, len(existingItems))
	for _, item := range existingItems {
		itemsByPath[item.SkillPath] = item
	}

	unexpectedFailure := false
	for _, candidate := range candidates {
		item := itemsByPath[candidate.skill.Path]
		if item.SourceItemID == "" {
			item = SourceItem{SourceItemID: newID("sourceitem"), SourceID: source.SourceID, SkillPath: candidate.skill.Path, CreatedAt: s.clock().UTC()}
		}
		previousContentSHA := cloneStringPointer(item.LastContentSHA256)
		item.LastSeenCommitSHA = stringPointer(commitSHA)
		item.MissingSince = nil
		item.UpdatedAt = s.clock().UTC()
		if candidate.contentSHA256 != "" {
			item.LastContentSHA256 = stringPointer(candidate.contentSHA256)
		}
		if candidate.metadata.Name != "" {
			item.DiscoveredName = candidate.metadata.Name
		}

		if candidate.err != nil {
			run.FailedCount++
			if !isInvalidSourceCandidate(candidate.err) {
				unexpectedFailure = true
				continue
			}
			item.Status = SourceItemStatusInvalid
			item.LastErrorSummary = "候选包无效"
			if err := s.upsertItem(ctx, item, run.SourceRevision); err != nil {
				if errors.Is(err, errSourceRevisionChanged) {
					return s.completeRun(ctx, run, source, SourceSyncRunStatusSuccess, false, "")
				}
				unexpectedFailure = true
			}
			continue
		}
		if nameCounts[candidate.metadata.Name] > 1 {
			item.Status = SourceItemStatusNameConflict
			item.LastErrorSummary = "同批来源项声明了相同名称"
			run.ConflictCount++
			if err := s.upsertItem(ctx, item, run.SourceRevision); err != nil {
				if errors.Is(err, errSourceRevisionChanged) {
					return s.completeRun(ctx, run, source, SourceSyncRunStatusSuccess, false, "")
				}
				unexpectedFailure = true
				run.FailedCount++
			}
			continue
		}

		version, findErr := s.store.FindVersionBySourceCommit(ctx, source.SourceID, candidate.skill.Path, commitSHA)
		if findErr == nil {
			if item.SkillID != nil && *item.SkillID != version.SkillID {
				item.Status = SourceItemStatusNameConflict
				item.LastErrorSummary = "来源 Commit 已归属其他 Skill"
				run.ConflictCount++
			} else {
				item.SkillID = stringPointer(version.SkillID)
				item.LastVersionID = stringPointer(version.VersionID)
				item.Status = SourceItemStatusActive
				item.LastErrorSummary = ""
			}
			if err := s.upsertItem(ctx, item, run.SourceRevision); err != nil {
				if errors.Is(err, errSourceRevisionChanged) {
					return s.completeRun(ctx, run, source, SourceSyncRunStatusSuccess, false, "")
				}
				unexpectedFailure = true
				run.FailedCount++
			}
			continue
		}
		if !errors.Is(findErr, ErrNotFound) {
			unexpectedFailure = true
			run.FailedCount++
			continue
		}
		if previousContentSHA != nil && *previousContentSHA == candidate.contentSHA256 && item.SkillID != nil && item.LastVersionID != nil &&
			(item.Status == SourceItemStatusActive || item.Status == SourceItemStatusMissing) {
			item.Status = SourceItemStatusActive
			item.LastErrorSummary = ""
			if err := s.upsertItem(ctx, item, run.SourceRevision); err != nil {
				if errors.Is(err, errSourceRevisionChanged) {
					return s.completeRun(ctx, run, source, SourceSyncRunStatusSuccess, false, "")
				}
				unexpectedFailure = true
				run.FailedCount++
			}
			continue
		}

		created, createErr := s.createVersion(ctx, source, item, candidate, commitSHA)
		if createErr != nil {
			switch {
			case errors.Is(createErr, ErrConflict):
				resolved, conflictErr := s.resolveVersionConflict(ctx, source, item, candidate, commitSHA)
				if conflictErr != nil {
					unexpectedFailure = true
					run.FailedCount++
					continue
				}
				item = resolved
				if item.Status == SourceItemStatusNameConflict || item.Status == SourceItemStatusNameChanged {
					run.ConflictCount++
				}
			case errors.Is(createErr, ErrPackageInvalid), errors.Is(createErr, ErrPackageTooLarge):
				item.Status = SourceItemStatusInvalid
				item.LastErrorSummary = "候选包无效"
				run.FailedCount++
			default:
				unexpectedFailure = true
				run.FailedCount++
				continue
			}
			if err := s.upsertItem(ctx, item, run.SourceRevision); err != nil {
				if errors.Is(err, errSourceRevisionChanged) {
					return s.completeRun(ctx, run, source, SourceSyncRunStatusSuccess, false, "")
				}
				unexpectedFailure = true
				if item.Status != SourceItemStatusInvalid {
					run.FailedCount++
				}
			}
			continue
		}
		run.CreatedVersionCount++
		if source.AutoPublish {
			run.PublishedCount++
		}
		item.SkillID = stringPointer(created.Skill.SkillID)
		item.LastVersionID = stringPointer(created.Version.VersionID)
		item.Status = SourceItemStatusActive
		item.LastErrorSummary = ""
		if err := s.upsertItem(ctx, item, run.SourceRevision); err != nil {
			if errors.Is(err, errSourceRevisionChanged) {
				return s.completeRun(ctx, run, source, SourceSyncRunStatusSuccess, false, "")
			}
			unexpectedFailure = true
			run.FailedCount++
		}
	}

	if unexpectedFailure {
		return s.completeRun(ctx, run, source, SourceSyncRunStatusPartial, false, "部分来源项处理失败")
	}
	if err := s.store.MarkMissingSourceItems(ctx, source.SourceID, commitSHA, s.clock().UTC(), run.SourceRevision); err != nil {
		if errors.Is(err, errSourceRevisionChanged) {
			return s.completeRun(ctx, run, source, SourceSyncRunStatusSuccess, false, "")
		}
		return s.failRun(ctx, run, source, errSourceSyncStore, "标记缺失来源项失败")
	}
	return s.completeRun(ctx, run, source, SourceSyncRunStatusSuccess, true, "")
}

type sourceSyncCandidate struct {
	skill         DiscoveredSkill
	metadata      PackageMetadata
	contentSHA256 string
	packagePath   string
	err           error
}

func (s *SourceSyncService) buildCandidate(repositoryRoot string, skill DiscoveredSkill, gitlinks []string) sourceSyncCandidate {
	candidate := sourceSyncCandidate{skill: skill}
	raw, err := os.CreateTemp(s.packageRoot, ".source-candidate-*.zip")
	if err != nil {
		candidate.err = err
		return candidate
	}
	rawPath := raw.Name()
	defer os.Remove(rawPath)
	packageMetadata, buildErr := s.packageBuilder.Build(repositoryRoot, skill, gitlinks, raw)
	closeErr := raw.Close()
	if buildErr != nil {
		candidate.err = buildErr
		return candidate
	}
	if closeErr != nil {
		candidate.err = closeErr
		return candidate
	}
	candidate.contentSHA256 = packageMetadata.ContentSHA256

	raw, err = os.Open(rawPath)
	if err != nil {
		candidate.err = err
		return candidate
	}
	info, statErr := raw.Stat()
	if statErr != nil {
		_ = raw.Close()
		candidate.err = statErr
		return candidate
	}
	normalized, err := os.CreateTemp(s.packageRoot, ".source-normalized-*.zip")
	if err != nil {
		_ = raw.Close()
		candidate.err = err
		return candidate
	}
	candidate.packagePath = normalized.Name()
	candidate.metadata, err = NormalizePackage(raw, info.Size(), normalized)
	rawCloseErr := raw.Close()
	normalizedCloseErr := normalized.Close()
	if err != nil {
		candidate.err = err
	} else if rawCloseErr != nil {
		candidate.err = rawCloseErr
	} else if normalizedCloseErr != nil {
		candidate.err = normalizedCloseErr
	}
	return candidate
}

func (s *SourceSyncService) createVersion(ctx context.Context, source GitHubSource, item SourceItem, candidate sourceSyncCandidate, commitSHA string) (MutationResult, error) {
	file, err := os.Open(candidate.packagePath)
	if err != nil {
		return MutationResult{}, err
	}
	defer file.Close()
	resolution := VersionResolutionCreateOnly
	targetSkillID := ""
	if item.SkillID != nil {
		resolution = VersionResolutionTarget
		targetSkillID = *item.SkillID
	}
	return s.versionService.CreateVersionFromPackage(ctx, CreateVersionInput{
		SpaceID: source.SpaceID, Version: "git-" + commitSHA, Package: file, CreatedBy: source.CreatedBy, Publish: source.AutoPublish,
		Resolution: resolution, TargetSkillID: targetSkillID,
		Source: &VersionSourceEvidence{
			SourceID: source.SourceID, RepositoryOwner: source.RepositoryOwner, RepositoryName: source.RepositoryName,
			Path: candidate.skill.Path, CommitSHA: commitSHA, ContentSHA256: candidate.contentSHA256,
		},
	})
}

func (s *SourceSyncService) resolveVersionConflict(ctx context.Context, source GitHubSource, item SourceItem, candidate sourceSyncCandidate, commitSHA string) (SourceItem, error) {
	version, err := s.store.FindVersionBySourceCommit(ctx, source.SourceID, candidate.skill.Path, commitSHA)
	if err == nil {
		if item.SkillID != nil && *item.SkillID != version.SkillID {
			return SourceItem{}, ErrConflict
		}
		item.SkillID = stringPointer(version.SkillID)
		item.LastVersionID = stringPointer(version.VersionID)
		item.Status = SourceItemStatusActive
		item.LastErrorSummary = ""
		return item, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return SourceItem{}, err
	}
	if item.SkillID != nil {
		detail, detailErr := s.versionService.GetAdmin(ctx, *item.SkillID)
		if detailErr != nil || detail.Skill.Name == candidate.metadata.Name {
			return SourceItem{}, ErrConflict
		}
		item.Status = SourceItemStatusNameChanged
		item.LastErrorSummary = "已绑定 Skill 与来源名称不一致"
		return item, nil
	}
	skills, listErr := s.versionService.ListAdmin(ctx)
	if listErr != nil {
		return SourceItem{}, listErr
	}
	for _, skill := range skills {
		if skill.Name == candidate.metadata.Name {
			item.Status = SourceItemStatusNameConflict
			item.LastErrorSummary = "Skill 名称已存在"
			return item, nil
		}
	}
	return SourceItem{}, ErrConflict
}

func isInvalidSourceCandidate(err error) bool {
	return errors.Is(err, errSourcePackageInvalid) || errors.Is(err, ErrPackageInvalid) || errors.Is(err, ErrPackageTooLarge)
}

func (s *SourceSyncService) upsertItem(ctx context.Context, item SourceItem, sourceRevision int64) error {
	_, err := s.store.UpsertSourceItemForSync(ctx, item, sourceRevision)
	return err
}

func (s *SourceSyncService) failRun(ctx context.Context, run SourceSyncRun, source GitHubSource, returned error, summary string) error {
	completionContext := ctx
	cancel := func() {}
	if ctx.Err() != nil {
		completionContext, cancel = context.WithTimeout(context.WithoutCancel(ctx), sourceSyncCompletionTimeout)
	}
	defer cancel()
	if err := s.completeRun(completionContext, run, source, SourceSyncRunStatusFailed, false, summary); err != nil {
		return err
	}
	return returned
}

func (s *SourceSyncService) completeRun(ctx context.Context, run SourceSyncRun, source GitHubSource, status string, commitCursor bool, summary string) error {
	now := s.clock().UTC()
	run.Status = status
	run.ErrorSummary = summary
	run.FinishedAt = timePointer(now)
	if successfulSourceSyncRun(status) {
		source.LastSuccessAt = timePointer(now)
		if commitCursor {
			source.LastSyncedCommitSHA = cloneStringPointer(run.TargetCommitSHA)
		}
		source.LastErrorSummary = ""
	} else {
		source.LastErrorSummary = summary
	}
	source.UpdatedAt = now
	if _, err := s.store.CompleteSyncRun(ctx, run, source); err != nil {
		return errSourceSyncCompletion
	}
	return nil
}

func (s *SourceSyncService) sourceLock(sourceID string) *sync.Mutex {
	s.locksMu.Lock()
	defer s.locksMu.Unlock()
	lock := s.locks[sourceID]
	if lock == nil {
		lock = &sync.Mutex{}
		s.locks[sourceID] = lock
	}
	return lock
}

func (s *SourceSyncService) ready() bool {
	return s != nil && s.store != nil && s.tokenCipher != nil && s.workspace != nil && s.git != nil && s.discovery != nil &&
		s.packageBuilder != nil && s.versionService != nil && strings.TrimSpace(s.packageRoot) != "" && s.clock != nil
}
