package businessdata

import (
	"context"
	"errors"
	"testing"
	"time"
)

type bilibiliSourceStoreFixture struct {
	items       []BilibiliSourceItem
	result      SyncRequestResult
	change      BilibiliSourceChange
	err         error
	sourceID    string
	enabled     bool
	operationAt time.Time
	deleteCalls int
}

func (s *bilibiliSourceStoreFixture) ListBilibiliSources(context.Context) ([]BilibiliSourceItem, error) {
	return s.items, s.err
}

func (s *bilibiliSourceStoreFixture) QueueBilibiliSourceRun(_ context.Context, sourceID string, now time.Time) (SyncRequestResult, error) {
	s.sourceID, s.operationAt = sourceID, now
	return s.result, s.err
}

func (s *bilibiliSourceStoreFixture) SetBilibiliSourceSyncEnabled(_ context.Context, sourceID string, enabled bool, now time.Time) (BilibiliSourceChange, error) {
	s.sourceID, s.enabled, s.operationAt = sourceID, enabled, now
	return s.change, s.err
}

func (s *bilibiliSourceStoreFixture) DeleteBilibiliSource(_ context.Context, sourceID string) error {
	s.sourceID = sourceID
	s.deleteCalls++
	return s.err
}

type bilibiliNotifierFixture struct{ calls int }

func (n *bilibiliNotifierFixture) NotifyQueuedRuns() { n.calls++ }

func TestBilibiliSourceServiceNormalizesAndNotifies(t *testing.T) {
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	store := &bilibiliSourceStoreFixture{result: SyncRequestResult{SourceCount: 1, QueuedCount: 1}}
	notifier := &bilibiliNotifierFixture{}
	service := NewBilibiliSourceService(store, notifier)
	service.clock = func() time.Time { return now }

	items, err := service.List(context.Background())
	if err != nil || items == nil || len(items) != 0 {
		t.Fatalf("List() = %#v, %v", items, err)
	}
	result, err := service.RequestSync(context.Background(), "  bdsrc_1  ")
	if err != nil || result.QueuedCount != 1 || store.sourceID != "bdsrc_1" || !store.operationAt.Equal(now) || notifier.calls != 1 {
		t.Fatalf("RequestSync() = %#v, source=%q notify=%d err=%v", result, store.sourceID, notifier.calls, err)
	}
	store.change = BilibiliSourceChange{Source: BilibiliSourceItem{SourceID: "bdsrc_1"}, QueuedCount: 1}
	change, err := service.SetSyncEnabled(context.Background(), "bdsrc_1", true)
	if err != nil || change.QueuedCount != 1 || !store.enabled || notifier.calls != 2 {
		t.Fatalf("SetSyncEnabled() = %#v, notify=%d err=%v", change, notifier.calls, err)
	}
	if err := service.Delete(context.Background(), "  bdsrc_delete  "); err != nil || store.sourceID != "bdsrc_delete" || store.deleteCalls != 1 || notifier.calls != 2 {
		t.Fatalf("Delete() source=%q calls=%d notify=%d err=%v", store.sourceID, store.deleteCalls, notifier.calls, err)
	}
}

func TestBilibiliSourceServiceDoesNotNotifyWithoutQueuedRun(t *testing.T) {
	store := &bilibiliSourceStoreFixture{}
	notifier := &bilibiliNotifierFixture{}
	service := NewBilibiliSourceService(store, notifier)
	if _, err := service.RequestSync(context.Background(), "bdsrc_1"); err != nil {
		t.Fatal(err)
	}
	store.err = errors.New("store unavailable")
	if _, err := service.SetSyncEnabled(context.Background(), "bdsrc_1", false); err == nil {
		t.Fatal("expected store error")
	}
	if notifier.calls != 0 {
		t.Fatalf("notify calls=%d", notifier.calls)
	}
}

func TestBilibiliSourceServiceRejectsEmptySourceID(t *testing.T) {
	service := NewBilibiliSourceService(&bilibiliSourceStoreFixture{}, nil)
	if _, err := service.RequestSync(context.Background(), " "); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("RequestSync error=%v", err)
	}
	if _, err := service.SetSyncEnabled(context.Background(), "", false); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("SetSyncEnabled error=%v", err)
	}
	if err := service.Delete(context.Background(), "\t"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Delete error=%v", err)
	}
}

func TestBilibiliSourceServiceDeleteReturnsStoreErrorWithoutNotifying(t *testing.T) {
	storeErr := errors.New("store unavailable")
	store := &bilibiliSourceStoreFixture{err: storeErr}
	notifier := &bilibiliNotifierFixture{}
	service := NewBilibiliSourceService(store, notifier)

	if err := service.Delete(context.Background(), "bdsrc_1"); !errors.Is(err, storeErr) {
		t.Fatalf("Delete error=%v", err)
	}
	if notifier.calls != 0 {
		t.Fatalf("notify calls=%d", notifier.calls)
	}
}
