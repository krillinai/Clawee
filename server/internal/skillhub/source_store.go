package skillhub

import (
	"context"
	"errors"
	"slices"
	"sort"
	"sync"
	"time"
)

var errSourceRevisionChanged = errors.New("skill source revision changed")

type TokenUpdateMode string

const (
	TokenKeep    TokenUpdateMode = "keep"
	TokenReplace TokenUpdateMode = "replace"
	TokenRemove  TokenUpdateMode = "remove"
)

type SourceStore interface {
	CreateSource(context.Context, GitHubSource) (GitHubSource, error)
	UpdateSource(context.Context, GitHubSource, TokenUpdateMode) (GitHubSource, error)
	GetSource(context.Context, string) (GitHubSource, error)
	ListSources(context.Context) ([]GitHubSourceSummary, error)

	UpsertSourceItem(context.Context, SourceItem) (SourceItem, error)
	UpsertSourceItemForSync(context.Context, SourceItem, int64) (SourceItem, error)
	GetSourceItem(context.Context, string) (SourceItem, error)
	ListSourceItems(context.Context, string) ([]SourceItem, error)
	BindSourceItem(context.Context, string, string, time.Time) (SourceItem, error)
	UnbindSourceItem(context.Context, string, time.Time) (SourceItem, error)
	MarkMissingSourceItems(context.Context, string, string, time.Time, int64) error

	CreateSyncRun(context.Context, SourceSyncRun) (SourceSyncRun, error)
	ClaimNextSyncRun(context.Context, time.Time) (SourceSyncRun, bool, error)
	CompleteSyncRun(context.Context, SourceSyncRun, GitHubSource) (SourceSyncRun, error)
	RecoverRunningSyncRuns(context.Context, time.Time) error
	ListSourceSyncRuns(context.Context, string, int) ([]SourceSyncRun, error)
	ListDueSources(context.Context, time.Time, int) ([]GitHubSource, error)

	FindVersionBySourceCommit(context.Context, string, string, string) (Version, error)
}

type MemorySourceStore struct {
	mu               sync.Mutex
	skillStore       *MemoryStore
	sources          map[string]GitHubSource
	sourceByRepo     map[string]string
	items            map[string]SourceItem
	itemBySourcePath map[string]string
	runs             map[string]SourceSyncRun
}

func NewMemorySourceStore(skillStores ...*MemoryStore) *MemorySourceStore {
	var skillStore *MemoryStore
	if len(skillStores) > 0 {
		skillStore = skillStores[0]
	}
	return &MemorySourceStore{
		skillStore: skillStore, sources: map[string]GitHubSource{}, sourceByRepo: map[string]string{},
		items: map[string]SourceItem{}, itemBySourcePath: map[string]string{}, runs: map[string]SourceSyncRun{},
	}
}

func (s *MemorySourceStore) CreateSource(_ context.Context, source GitHubSource) (GitHubSource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if source.SpaceID == "" {
		source.SpaceID = DefaultSpaceID
	}
	if s.skillStore != nil {
		s.skillStore.mu.Lock()
		_, spaceExists := s.skillStore.spaces[source.SpaceID]
		s.skillStore.mu.Unlock()
		if !spaceExists {
			return GitHubSource{}, ErrSpaceNotFound
		}
	} else if source.SpaceID != DefaultSpaceID {
		return GitHubSource{}, ErrSpaceNotFound
	}
	if source.SourceID == "" || s.sources[source.SourceID].SourceID != "" {
		return GitHubSource{}, ErrConflict
	}
	key := sourceRepositoryKey(source.RepositoryOwner, source.RepositoryName)
	if s.sourceByRepo[key] != "" {
		return GitHubSource{}, ErrConflict
	}
	source = cloneSource(source)
	source.HasToken = len(source.TokenCiphertext) > 0
	source.SyncRevision = 1
	s.sources[source.SourceID] = source
	s.sourceByRepo[key] = source.SourceID
	return cloneSource(source), nil
}

func (s *MemorySourceStore) UpdateSource(_ context.Context, source GitHubSource, tokenMode TokenUpdateMode) (GitHubSource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.sources[source.SourceID]
	if !ok {
		return GitHubSource{}, ErrNotFound
	}
	if source.RepositoryOwner != current.RepositoryOwner || source.RepositoryName != current.RepositoryName || source.Provider != current.Provider {
		return GitHubSource{}, ErrInvalidRequest
	}
	source.CreatedBy = current.CreatedBy
	source.CreatedAt = current.CreatedAt
	source.LastAttemptAt = current.LastAttemptAt
	source.LastSuccessAt = current.LastSuccessAt
	source.LastErrorSummary = current.LastErrorSummary
	configurationChanged := source.Branch != current.Branch || source.ScanRoot != current.ScanRoot || !slices.Equal(source.ExcludePaths, current.ExcludePaths)
	source.SyncRevision = current.SyncRevision
	source.LastSyncedCommitSHA = cloneStringPointer(current.LastSyncedCommitSHA)
	if configurationChanged {
		source.SyncRevision++
		source.LastSyncedCommitSHA = nil
	}
	switch tokenMode {
	case TokenKeep:
		source.TokenCiphertext = append([]byte(nil), current.TokenCiphertext...)
	case TokenReplace:
		if len(source.TokenCiphertext) == 0 {
			return GitHubSource{}, ErrInvalidRequest
		}
	case TokenRemove:
		source.TokenCiphertext = nil
	default:
		return GitHubSource{}, ErrInvalidRequest
	}
	source.HasToken = len(source.TokenCiphertext) > 0
	s.sources[source.SourceID] = cloneSource(source)
	return cloneSource(source), nil
}

func (s *MemorySourceStore) GetSource(_ context.Context, sourceID string) (GitHubSource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	source, ok := s.sources[sourceID]
	if !ok {
		return GitHubSource{}, ErrNotFound
	}
	return cloneSource(source), nil
}

func (s *MemorySourceStore) ListSources(_ context.Context) ([]GitHubSourceSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]GitHubSourceSummary, 0, len(s.sources))
	for _, source := range s.sources {
		var latest *SourceSyncRun
		discoveredCount := 0
		for _, run := range s.runs {
			if run.SourceID == source.SourceID && (latest == nil || run.CreatedAt.After(latest.CreatedAt)) {
				copy := cloneSyncRun(run)
				latest = &copy
			}
		}
		for _, item := range s.items {
			if item.SourceID == source.SourceID && item.Status != SourceItemStatusMissing {
				discoveredCount++
			}
		}
		result = append(result, GitHubSourceSummary{Source: cloneSource(source), LatestRun: latest, DiscoveredCount: discoveredCount})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Source.CreatedAt.After(result[j].Source.CreatedAt) })
	return result, nil
}

func (s *MemorySourceStore) UpsertSourceItem(_ context.Context, item SourceItem) (SourceItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.upsertSourceItemLocked(item, false)
}

func (s *MemorySourceStore) UpsertSourceItemForSync(_ context.Context, item SourceItem, sourceRevision int64) (SourceItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	source, ok := s.sources[item.SourceID]
	if !ok {
		return SourceItem{}, ErrNotFound
	}
	if source.SyncRevision != sourceRevision {
		return SourceItem{}, errSourceRevisionChanged
	}
	return s.upsertSourceItemLocked(item, true)
}

func (s *MemorySourceStore) upsertSourceItemLocked(item SourceItem, bindingCAS bool) (SourceItem, error) {
	if _, ok := s.sources[item.SourceID]; !ok {
		return SourceItem{}, ErrNotFound
	}
	key := sourceItemKey(item.SourceID, item.SkillPath)
	if existingID := s.itemBySourcePath[key]; existingID != "" && existingID != item.SourceItemID {
		return SourceItem{}, ErrConflict
	}
	if existing, ok := s.items[item.SourceItemID]; ok {
		item.CreatedAt = existing.CreatedAt
		if bindingCAS && existing.SkillID != nil && item.SkillID != nil && *existing.SkillID != *item.SkillID {
			return SourceItem{}, ErrConflict
		}
		if item.SkillID == nil {
			item.SkillID = cloneStringPointer(existing.SkillID)
		}
	}
	if item.SkillID != nil {
		for otherID, other := range s.items {
			if otherID != item.SourceItemID && other.SkillID != nil && *other.SkillID == *item.SkillID {
				return SourceItem{}, ErrConflict
			}
		}
	}
	item = cloneSourceItem(item)
	s.items[item.SourceItemID] = item
	s.itemBySourcePath[key] = item.SourceItemID
	return cloneSourceItem(item), nil
}

func (s *MemorySourceStore) GetSourceItem(_ context.Context, sourceItemID string) (SourceItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[sourceItemID]
	if !ok {
		return SourceItem{}, ErrNotFound
	}
	return cloneSourceItem(item), nil
}

func (s *MemorySourceStore) ListSourceItems(_ context.Context, sourceID string) ([]SourceItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sources[sourceID]; !ok {
		return nil, ErrNotFound
	}
	result := []SourceItem{}
	for _, item := range s.items {
		if item.SourceID == sourceID {
			result = append(result, cloneSourceItem(item))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].SkillPath < result[j].SkillPath })
	return result, nil
}

func (s *MemorySourceStore) BindSourceItem(_ context.Context, sourceItemID, skillID string, now time.Time) (SourceItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[sourceItemID]
	if !ok {
		return SourceItem{}, ErrNotFound
	}
	if item.Status != SourceItemStatusNameConflict || s.skillStore == nil {
		return SourceItem{}, ErrConflict
	}
	s.skillStore.mu.Lock()
	defer s.skillStore.mu.Unlock()
	skill, ok := s.skillStore.skills[skillID]
	if !ok {
		return SourceItem{}, ErrNotFound
	}
	source, ok := s.sources[item.SourceID]
	if !ok {
		return SourceItem{}, ErrNotFound
	}
	if skill.Name != item.DiscoveredName || skill.SpaceID != source.SpaceID {
		return SourceItem{}, ErrConflict
	}
	for otherID, other := range s.items {
		if otherID != sourceItemID && other.SkillID != nil && *other.SkillID == skillID {
			return SourceItem{}, ErrConflict
		}
	}
	item.SkillID = stringPointer(skillID)
	item.Status = SourceItemStatusActive
	item.MissingSince = nil
	item.UpdatedAt = now.UTC()
	s.items[sourceItemID] = item
	source.SyncRevision++
	source.LastSyncedCommitSHA = nil
	source.UpdatedAt = now.UTC()
	s.sources[item.SourceID] = source
	return cloneSourceItem(item), nil
}

func (s *MemorySourceStore) UnbindSourceItem(_ context.Context, sourceItemID string, now time.Time) (SourceItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[sourceItemID]
	if !ok {
		return SourceItem{}, ErrNotFound
	}
	item.SkillID = nil
	if item.DiscoveredName == "" {
		item.Status = SourceItemStatusInvalid
	} else {
		item.Status = SourceItemStatusNameConflict
	}
	item.UpdatedAt = now.UTC()
	s.items[sourceItemID] = item
	source := s.sources[item.SourceID]
	source.SyncRevision++
	source.LastSyncedCommitSHA = nil
	source.UpdatedAt = now.UTC()
	s.sources[item.SourceID] = source
	return cloneSourceItem(item), nil
}

func (s *MemorySourceStore) MarkMissingSourceItems(_ context.Context, sourceID, commitSHA string, now time.Time, sourceRevision int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	source, ok := s.sources[sourceID]
	if !ok {
		return ErrNotFound
	}
	if source.SyncRevision != sourceRevision {
		return errSourceRevisionChanged
	}
	for id, item := range s.items {
		if item.SourceID == sourceID && (item.LastSeenCommitSHA == nil || *item.LastSeenCommitSHA != commitSHA) {
			item.Status = SourceItemStatusMissing
			if item.MissingSince == nil {
				item.MissingSince = timePointer(now.UTC())
			}
			item.UpdatedAt = now.UTC()
			s.items[id] = item
		}
	}
	return nil
}

func (s *MemorySourceStore) CreateSyncRun(_ context.Context, run SourceSyncRun) (SourceSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run.RepositoryMode == "" {
		run.RepositoryMode = SourceRepositoryModeRemote
	}
	if run.RepositoryMode != SourceRepositoryModeRemote && run.RepositoryMode != SourceRepositoryModeLocal {
		return SourceSyncRun{}, ErrInvalidRequest
	}
	if _, ok := s.sources[run.SourceID]; !ok {
		return SourceSyncRun{}, ErrNotFound
	}
	if _, ok := s.runs[run.RunID]; ok {
		return SourceSyncRun{}, ErrConflict
	}
	for _, existing := range s.runs {
		if existing.SourceID == run.SourceID && activeRunStatus(existing.Status) {
			return SourceSyncRun{}, ErrConflict
		}
	}
	run = cloneSyncRun(run)
	s.runs[run.RunID] = run
	return cloneSyncRun(run), nil
}

func (s *MemorySourceStore) ClaimNextSyncRun(_ context.Context, now time.Time) (SourceSyncRun, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var selected *SourceSyncRun
	for _, run := range s.runs {
		source := s.sources[run.SourceID]
		if run.Status == SourceSyncRunStatusQueued && source.Status == SourceStatusActive && (selected == nil || run.CreatedAt.Before(selected.CreatedAt)) {
			copy := run
			selected = &copy
		}
	}
	if selected == nil {
		return SourceSyncRun{}, false, nil
	}
	selected.Status = SourceSyncRunStatusRunning
	selected.StartedAt = timePointer(now.UTC())
	source := s.sources[selected.SourceID]
	selected.SourceRevision = source.SyncRevision
	s.runs[selected.RunID] = *selected
	source.LastAttemptAt = timePointer(now.UTC())
	source.UpdatedAt = now.UTC()
	s.sources[source.SourceID] = source
	return cloneSyncRun(*selected), true, nil
}

func (s *MemorySourceStore) CompleteSyncRun(_ context.Context, run SourceSyncRun, source GitHubSource) (SourceSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.runs[run.RunID]
	if !ok || current.Status != SourceSyncRunStatusRunning || run.SourceID != current.SourceID || source.SourceID != current.SourceID {
		return SourceSyncRun{}, ErrConflict
	}
	storedSource, ok := s.sources[run.SourceID]
	if !ok {
		return SourceSyncRun{}, ErrNotFound
	}
	run.CreatedAt = current.CreatedAt
	run.StartedAt = cloneTimePointer(current.StartedAt)
	run.SourceRevision = current.SourceRevision
	s.runs[run.RunID] = cloneSyncRun(run)
	if successfulSourceSyncRun(run.Status) {
		storedSource.LastSuccessAt = cloneTimePointer(source.LastSuccessAt)
		if storedSource.SyncRevision == current.SourceRevision {
			storedSource.LastSyncedCommitSHA = cloneStringPointer(source.LastSyncedCommitSHA)
		}
	}
	storedSource.LastErrorSummary = source.LastErrorSummary
	storedSource.UpdatedAt = source.UpdatedAt.UTC()
	s.sources[storedSource.SourceID] = storedSource
	return cloneSyncRun(run), nil
}

func successfulSourceSyncRun(status string) bool {
	return status == SourceSyncRunStatusSuccess || status == SourceSyncRunStatusSkipped
}

func (s *MemorySourceStore) RecoverRunningSyncRuns(_ context.Context, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, run := range s.runs {
		if run.Status == SourceSyncRunStatusRunning {
			run.Status = SourceSyncRunStatusInterrupted
			run.ErrorSummary = "同步进程中断"
			run.FinishedAt = timePointer(now.UTC())
			s.runs[id] = run
		}
	}
	return nil
}

func (s *MemorySourceStore) ListSourceSyncRuns(_ context.Context, sourceID string, limit int) ([]SourceSyncRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sources[sourceID]; !ok {
		return nil, ErrNotFound
	}
	result := []SourceSyncRun{}
	for _, run := range s.runs {
		if run.SourceID == sourceID {
			result = append(result, cloneSyncRun(run))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (s *MemorySourceStore) ListDueSources(_ context.Context, now time.Time, limit int) ([]GitHubSource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := []GitHubSource{}
	for _, source := range s.sources {
		if !sourceDue(source, now) || s.sourceHasActiveRun(source.SourceID) {
			continue
		}
		result = append(result, cloneSource(source))
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].LastAttemptAt == nil {
			return result[j].LastAttemptAt != nil
		}
		return result[j].LastAttemptAt != nil && result[i].LastAttemptAt.Before(*result[j].LastAttemptAt)
	})
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (s *MemorySourceStore) FindVersionBySourceCommit(_ context.Context, sourceID, sourcePath, commitSHA string) (Version, error) {
	if s.skillStore == nil {
		return Version{}, ErrNotFound
	}
	s.skillStore.mu.Lock()
	defer s.skillStore.mu.Unlock()
	for _, versions := range s.skillStore.versions {
		for _, version := range versions {
			if version.Source != nil && version.Source.SourceID == sourceID && version.Source.Path == sourcePath && version.Source.CommitSHA == commitSHA {
				return version, nil
			}
		}
	}
	return Version{}, ErrNotFound
}

func (s *MemorySourceStore) sourceHasActiveRun(sourceID string) bool {
	for _, run := range s.runs {
		if run.SourceID == sourceID && activeRunStatus(run.Status) {
			return true
		}
	}
	return false
}

func activeRunStatus(status string) bool {
	return status == SourceSyncRunStatusQueued || status == SourceSyncRunStatusRunning
}

func sourceDue(source GitHubSource, now time.Time) bool {
	if source.Status != SourceStatusActive || source.Schedule == SourceScheduleManual {
		return false
	}
	if source.LastAttemptAt == nil {
		return true
	}
	interval := time.Hour
	if source.Schedule == SourceScheduleDaily {
		interval = 24 * time.Hour
	}
	return !source.LastAttemptAt.Add(interval).After(now)
}

func sourceRepositoryKey(owner, repository string) string { return owner + "\x00" + repository }
func sourceItemKey(sourceID, skillPath string) string     { return sourceID + "\x00" + skillPath }

func cloneSource(source GitHubSource) GitHubSource {
	source.ExcludePaths = append([]string(nil), source.ExcludePaths...)
	source.TokenCiphertext = append([]byte(nil), source.TokenCiphertext...)
	source.LastAttemptAt = cloneTimePointer(source.LastAttemptAt)
	source.LastSuccessAt = cloneTimePointer(source.LastSuccessAt)
	source.LastSyncedCommitSHA = cloneStringPointer(source.LastSyncedCommitSHA)
	return source
}

func cloneSourceItem(item SourceItem) SourceItem {
	item.SkillID = cloneStringPointer(item.SkillID)
	item.LastSeenCommitSHA = cloneStringPointer(item.LastSeenCommitSHA)
	item.LastContentSHA256 = cloneStringPointer(item.LastContentSHA256)
	item.LastVersionID = cloneStringPointer(item.LastVersionID)
	item.MissingSince = cloneTimePointer(item.MissingSince)
	return item
}

func cloneSyncRun(run SourceSyncRun) SourceSyncRun {
	run.BeforeCommitSHA = cloneStringPointer(run.BeforeCommitSHA)
	run.TargetCommitSHA = cloneStringPointer(run.TargetCommitSHA)
	run.StartedAt = cloneTimePointer(run.StartedAt)
	run.FinishedAt = cloneTimePointer(run.FinishedAt)
	return run
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := value.UTC()
	return &copy
}

func stringPointer(value string) *string { return &value }
func timePointer(value time.Time) *time.Time {
	value = value.UTC()
	return &value
}
