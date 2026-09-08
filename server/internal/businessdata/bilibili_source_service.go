package businessdata

import (
	"context"
	"strings"
	"time"
)

type queuedRunNotifier interface {
	NotifyQueuedRuns()
}

type BilibiliSourceService struct {
	store    BilibiliSourceManagementStore
	notifier queuedRunNotifier
	clock    func() time.Time
}

func NewBilibiliSourceService(store BilibiliSourceManagementStore, notifier queuedRunNotifier) *BilibiliSourceService {
	return &BilibiliSourceService{store: store, notifier: notifier, clock: time.Now}
}

func (s *BilibiliSourceService) List(ctx context.Context) ([]BilibiliSourceItem, error) {
	if s == nil || s.store == nil {
		return nil, ErrInvalidRequest
	}
	items, err := s.store.ListBilibiliSources(ctx)
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []BilibiliSourceItem{}
	}
	return items, nil
}

func (s *BilibiliSourceService) RequestSync(ctx context.Context, sourceID string) (SyncRequestResult, error) {
	if s == nil || s.store == nil || strings.TrimSpace(sourceID) == "" {
		return SyncRequestResult{}, ErrInvalidRequest
	}
	result, err := s.store.QueueBilibiliSourceRun(ctx, strings.TrimSpace(sourceID), s.clock().UTC())
	if err == nil && result.QueuedCount > 0 && s.notifier != nil {
		s.notifier.NotifyQueuedRuns()
	}
	return result, err
}

func (s *BilibiliSourceService) SetSyncEnabled(ctx context.Context, sourceID string, enabled bool) (BilibiliSourceChange, error) {
	if s == nil || s.store == nil || strings.TrimSpace(sourceID) == "" {
		return BilibiliSourceChange{}, ErrInvalidRequest
	}
	result, err := s.store.SetBilibiliSourceSyncEnabled(ctx, strings.TrimSpace(sourceID), enabled, s.clock().UTC())
	if err == nil && result.QueuedCount > 0 && s.notifier != nil {
		s.notifier.NotifyQueuedRuns()
	}
	return result, err
}

func (s *BilibiliSourceService) Delete(ctx context.Context, sourceID string) error {
	if s == nil || s.store == nil || strings.TrimSpace(sourceID) == "" {
		return ErrInvalidRequest
	}
	return s.store.DeleteBilibiliSource(ctx, strings.TrimSpace(sourceID))
}
