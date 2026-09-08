package businessdata

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type syncFixtureStore struct {
	mu          sync.Mutex
	source      Source
	getErr      error
	upsertErr   error
	upserted    int64
	batches     []Batch
	completions []SyncRun
}

func (s *syncFixtureStore) GetSource(context.Context, string) (Source, error) {
	return s.source, s.getErr
}
func (s *syncFixtureStore) UpsertBatch(_ context.Context, _, _ string, batch Batch, _ time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.upsertErr != nil {
		return 0, s.upsertErr
	}
	s.batches = append(s.batches, batch)
	if s.upserted != 0 {
		return s.upserted, nil
	}
	return batch.RecordCount(), nil
}
func (s *syncFixtureStore) CompleteRun(_ context.Context, run SyncRun) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completions = append(s.completions, run)
	return nil
}
func (s *syncFixtureStore) QueueDueRuns(context.Context, time.Time, int) (int, error) {
	return 0, nil
}
func (s *syncFixtureStore) QueueProviderRuns(context.Context, string, time.Time) (SyncRequestResult, error) {
	return SyncRequestResult{}, nil
}
func (s *syncFixtureStore) ClaimNextRun(context.Context, time.Time) (SyncRun, bool, error) {
	return SyncRun{}, false, nil
}
func (s *syncFixtureStore) RecoverRunningRuns(context.Context, time.Time) error { return nil }

func TestSyncServiceSuccessAndHistoricalCorrection(t *testing.T) {
	location, _ := time.LoadLocation(Timezone)
	date := time.Date(2026, 8, 14, 0, 0, 0, 0, location)
	store := &syncFixtureStore{source: Source{SourceID: "bdsrc_1", Provider: ProviderXiaohongshu, Status: SourceStatusActive}}
	value := int64(10)
	connector := fixtureConnector{provider: ProviderXiaohongshu, pull: func(context.Context, Source, PullRequest) (Batch, error) {
		return Batch{
			Contents:            []Content{{ExternalContentID: "note_1", Title: "测试"}},
			ContentDailyMetrics: []ContentDailyMetric{{ExternalContentID: "note_1", StatDate: date, ExposureCount: value}},
		}, nil
	}}
	registry := NewConnectorRegistry()
	if err := registry.Register(connector); err != nil {
		t.Fatal(err)
	}
	now := date.Add(12 * time.Hour)
	service := newSyncService(store, store, store, registry, nil, func() time.Time { return now })
	for index, exposure := range []int64{10, 25} {
		value = exposure
		run := SyncRun{RunID: newID("bdrun"), SourceID: store.source.SourceID, StartDate: date, EndDate: date, Status: SyncRunStatusRunning}
		if err := service.Run(context.Background(), run); err != nil {
			t.Fatalf("run %d: %v", index, err)
		}
	}
	if len(store.batches) != 2 || store.batches[1].ContentDailyMetrics[0].ExposureCount != 25 {
		t.Fatalf("historical correction not passed to store: %#v", store.batches)
	}
	if len(store.completions) != 2 || store.completions[1].Status != SyncRunStatusSuccess || store.completions[1].FetchedCount != 2 || store.completions[1].UpsertedCount != 2 {
		t.Fatalf("unexpected completion: %#v", store.completions)
	}
}

func TestSyncServiceFailureCodes(t *testing.T) {
	location, _ := time.LoadLocation(Timezone)
	date := time.Date(2026, 8, 14, 0, 0, 0, 0, location)
	tests := []struct {
		name      string
		connector fixtureConnector
		storeErr  error
		wantCode  string
	}{
		{name: "connector", connector: fixtureConnector{provider: ProviderXiaohongshu, pull: func(context.Context, Source, PullRequest) (Batch, error) {
			return Batch{}, errors.New("secret upstream response")
		}}, wantCode: "connector_failed"},
		{name: "bilibili reauth", connector: fixtureConnector{provider: ProviderBilibili, pull: func(context.Context, Source, PullRequest) (Batch, error) {
			return Batch{}, ErrBilibiliReauthRequired
		}}, wantCode: "bilibili_reauth_required"},
		{name: "bilibili rate limited", connector: fixtureConnector{provider: ProviderBilibili, pull: func(context.Context, Source, PullRequest) (Batch, error) {
			return Batch{}, ErrBilibiliRateLimited
		}}, wantCode: "bilibili_rate_limited"},
		{name: "batch", connector: fixtureConnector{provider: ProviderXiaohongshu, pull: func(context.Context, Source, PullRequest) (Batch, error) {
			return Batch{ContentDailyMetrics: []ContentDailyMetric{{ExternalContentID: "note", StatDate: date, ExposureCount: -1}}}, nil
		}}, wantCode: "batch_invalid"},
		{name: "store", connector: fixtureConnector{provider: ProviderXiaohongshu}, storeErr: errors.New("database detail"), wantCode: "store_failed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &syncFixtureStore{source: Source{SourceID: "bdsrc_1", Provider: tt.connector.provider, Status: SourceStatusActive}, upsertErr: tt.storeErr}
			registry := NewConnectorRegistry()
			if err := registry.Register(tt.connector); err != nil {
				t.Fatal(err)
			}
			service := newSyncService(store, store, store, registry, nil, func() time.Time { return date })
			run := SyncRun{RunID: "bdrun_1", SourceID: store.source.SourceID, StartDate: date, EndDate: date, Status: SyncRunStatusRunning}
			if err := service.Run(context.Background(), run); err == nil {
				t.Fatal("expected error")
			}
			completed := store.completions[0]
			if completed.Status != SyncRunStatusFailed || completed.ErrorCode != tt.wantCode {
				t.Fatalf("completion=%#v", completed)
			}
			if completed.ErrorSummary == "secret upstream response" || completed.ErrorSummary == "database detail" {
				t.Fatalf("unsanitized summary: %q", completed.ErrorSummary)
			}
		})
	}
}

func TestSyncServiceConnectorHonorsTimeoutAndCompletesRun(t *testing.T) {
	date := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	store := &syncFixtureStore{source: Source{SourceID: "bdsrc_1", Provider: ProviderXiaohongshu, Status: SourceStatusActive}}
	connector := fixtureConnector{provider: ProviderXiaohongshu, pull: func(ctx context.Context, _ Source, _ PullRequest) (Batch, error) {
		<-ctx.Done()
		return Batch{}, ctx.Err()
	}}
	registry := NewConnectorRegistry()
	_ = registry.Register(connector)
	service := newSyncService(store, store, store, registry, nil, func() time.Time { return date })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	err := service.Run(ctx, SyncRun{RunID: "bdrun_1", SourceID: store.source.SourceID, StartDate: date, EndDate: date, Status: SyncRunStatusRunning})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v", err)
	}
	if len(store.completions) != 1 || store.completions[0].ErrorCode != "connector_failed" {
		t.Fatalf("completion=%#v", store.completions)
	}
}
