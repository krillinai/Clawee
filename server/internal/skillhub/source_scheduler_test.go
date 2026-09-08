package skillhub

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestSourceSchedulerQueuesOnlyDueSources(t *testing.T) {
	now := time.Date(2026, 8, 3, 16, 0, 0, 0, time.UTC)
	store := NewMemorySourceStore()
	createScheduledSource(t, store, "source_1", SourceScheduleManual, SourceStatusActive, nil, now)
	hourAgo := now.Add(-time.Hour)
	createScheduledSource(t, store, "source_2", SourceScheduleHourly, SourceStatusActive, &hourAgo, now)
	notDue := now.Add(-59 * time.Minute)
	createScheduledSource(t, store, "source_3", SourceScheduleHourly, SourceStatusActive, &notDue, now)
	dailyAgo := now.Add(-24 * time.Hour)
	createScheduledSource(t, store, "source_4", SourceScheduleDaily, SourceStatusActive, &dailyAgo, now)
	createScheduledSource(t, store, "source_5", SourceScheduleHourly, SourceStatusDisabled, nil, now)
	createScheduledSource(t, store, "source_6", SourceScheduleDaily, SourceStatusActive, &dailyAgo, now)
	if _, err := store.CreateSyncRun(context.Background(), SourceSyncRun{RunID: "run-existing", SourceID: "source_6", Trigger: SourceSyncTriggerManual, Status: SourceSyncRunStatusQueued, RequestedBy: "admin", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}

	scheduler := newSourceScheduler(sourceSchedulerConfig{store: store, runner: sourceSyncRunnerFunc(func(context.Context, SourceSyncRun) error { return nil }), clock: func() time.Time { return now }})
	if scheduler.runTimeout != 300*time.Second {
		t.Fatalf("run timeout = %s, want 300s", scheduler.runTimeout)
	}
	if err := scheduler.queueDue(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	runs, err := store.ListSourceSyncRuns(context.Background(), "source_2", 10)
	if err != nil || len(runs) != 1 || runs[0].Trigger != SourceSyncTriggerScheduled || runs[0].RequestedBy != "system" {
		t.Fatalf("hourly runs = %#v, error = %v", runs, err)
	}
	for _, sourceID := range []string{"source_1", "source_3", "source_5"} {
		runs, err := store.ListSourceSyncRuns(context.Background(), sourceID, 10)
		if err != nil || len(runs) != 0 {
			t.Fatalf("%s runs = %#v, error = %v", sourceID, runs, err)
		}
	}
	runs, err = store.ListSourceSyncRuns(context.Background(), "source_4", 10)
	if err != nil || len(runs) != 1 || runs[0].Trigger != SourceSyncTriggerScheduled {
		t.Fatalf("daily runs = %#v, error = %v", runs, err)
	}
	runs, err = store.ListSourceSyncRuns(context.Background(), "source_6", 10)
	if err != nil || len(runs) != 1 || runs[0].RunID != "run-existing" {
		t.Fatalf("active source runs = %#v, error = %v", runs, err)
	}
}

func TestSourceSchedulerRecoversRunsAndUsesTwoWorkers(t *testing.T) {
	now := time.Date(2026, 8, 3, 16, 0, 0, 0, time.UTC)
	store := NewMemorySourceStore()
	for index := 1; index <= 4; index++ {
		sourceID := "source_" + string(rune('0'+index))
		createScheduledSource(t, store, sourceID, SourceScheduleManual, SourceStatusActive, nil, now)
		run := SourceSyncRun{RunID: "run_" + sourceID, SourceID: sourceID, Trigger: SourceSyncTriggerManual, Status: SourceSyncRunStatusQueued, RequestedBy: "admin", CreatedAt: now.Add(time.Duration(index) * time.Second)}
		if _, err := store.CreateSyncRun(context.Background(), run); err != nil {
			t.Fatal(err)
		}
	}
	claimed, ok, err := store.ClaimNextSyncRun(context.Background(), now.Add(time.Minute))
	if err != nil || !ok {
		t.Fatalf("ClaimNextSyncRun() = %#v, %v, %v", claimed, ok, err)
	}

	runner := newBlockingSourceSyncRunner()
	scheduler := newSourceScheduler(sourceSchedulerConfig{store: store, runner: runner, clock: func() time.Time { return now }})
	if err := scheduler.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(scheduler.Close)

	runner.waitForActive(t, 2)
	if max := runner.maxActiveCount(); max != 2 {
		t.Fatalf("max active = %d, want 2", max)
	}
	runs, err := store.ListSourceSyncRuns(context.Background(), claimed.SourceID, 10)
	if err != nil || len(runs) != 1 || runs[0].Status != SourceSyncRunStatusInterrupted {
		t.Fatalf("recovered runs = %#v, error = %v", runs, err)
	}
	runner.releaseAll()
}

func TestSourceSchedulerNotifyRunQueuedSignalsWorkers(t *testing.T) {
	scheduler := newSourceScheduler(sourceSchedulerConfig{workerCount: 2})
	scheduler.wake = make(chan struct{}, scheduler.workerCount)

	scheduler.NotifyRunQueued()

	if got := len(scheduler.wake); got != scheduler.workerCount {
		t.Fatalf("wake signals = %d, want %d", got, scheduler.workerCount)
	}
}

func TestSourceSchedulerCloseStopsQueueing(t *testing.T) {
	now := time.Date(2026, 8, 3, 16, 0, 0, 0, time.UTC)
	store := NewMemorySourceStore()
	createScheduledSource(t, store, "source_1", SourceScheduleHourly, SourceStatusActive, nil, now)
	scheduler := newSourceScheduler(sourceSchedulerConfig{store: store, runner: sourceSyncRunnerFunc(func(context.Context, SourceSyncRun) error { return nil }), clock: func() time.Time { return now }})
	scheduler.Close()
	if err := scheduler.queueDue(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	runs, err := store.ListSourceSyncRuns(context.Background(), "source_1", 10)
	if err != nil || len(runs) != 0 {
		t.Fatalf("runs after Close = %#v, error = %v", runs, err)
	}
}

func TestSourceSchedulerDoesNotQueueAfterCloseBegins(t *testing.T) {
	now := time.Date(2026, 8, 3, 16, 0, 0, 0, time.UTC)
	memory := NewMemorySourceStore()
	createScheduledSource(t, memory, "source_1", SourceScheduleHourly, SourceStatusActive, nil, now)
	store := &blockingDueSourceStore{SourceStore: memory, listed: make(chan struct{}), release: make(chan struct{})}
	scheduler := newSourceScheduler(sourceSchedulerConfig{store: store, runner: sourceSyncRunnerFunc(func(context.Context, SourceSyncRun) error { return nil }), clock: func() time.Time { return now }})
	done := make(chan error, 1)
	go func() { done <- scheduler.queueDue(context.Background(), now) }()
	<-store.listed
	scheduler.Close()
	close(store.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	runs, err := memory.ListSourceSyncRuns(context.Background(), "source_1", 10)
	if err != nil || len(runs) != 0 {
		t.Fatalf("runs after close began = %#v, error = %v", runs, err)
	}
}

type sourceSyncRunnerFunc func(context.Context, SourceSyncRun) error

func (f sourceSyncRunnerFunc) Run(ctx context.Context, run SourceSyncRun) error { return f(ctx, run) }

type blockingDueSourceStore struct {
	SourceStore
	listed  chan struct{}
	release chan struct{}
}

func (s *blockingDueSourceStore) ListDueSources(ctx context.Context, now time.Time, limit int) ([]GitHubSource, error) {
	sources, err := s.SourceStore.ListDueSources(ctx, now, limit)
	close(s.listed)
	<-s.release
	return sources, err
}

type blockingSourceSyncRunner struct {
	mu        sync.Mutex
	active    int
	maxActive int
	started   chan struct{}
	release   chan struct{}
	once      sync.Once
}

func newBlockingSourceSyncRunner() *blockingSourceSyncRunner {
	return &blockingSourceSyncRunner{started: make(chan struct{}, 8), release: make(chan struct{})}
}

func (r *blockingSourceSyncRunner) Run(ctx context.Context, _ SourceSyncRun) error {
	r.mu.Lock()
	r.active++
	if r.active > r.maxActive {
		r.maxActive = r.active
	}
	r.mu.Unlock()
	r.started <- struct{}{}
	select {
	case <-ctx.Done():
	case <-r.release:
	}
	r.mu.Lock()
	r.active--
	r.mu.Unlock()
	return nil
}

func (r *blockingSourceSyncRunner) waitForActive(t *testing.T, count int) {
	t.Helper()
	for index := 0; index < count; index++ {
		select {
		case <-r.started:
		case <-time.After(3 * time.Second):
			t.Fatalf("timed out waiting for %d active workers", count)
		}
	}
}

func (r *blockingSourceSyncRunner) maxActiveCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.maxActive
}

func (r *blockingSourceSyncRunner) releaseAll() { r.once.Do(func() { close(r.release) }) }

func createScheduledSource(t *testing.T, store SourceStore, sourceID, schedule, status string, lastAttempt *time.Time, now time.Time) {
	t.Helper()
	_, err := store.CreateSource(context.Background(), GitHubSource{
		SourceID: sourceID, Provider: GitHubSourceProvider, RepositoryOwner: sourceID, RepositoryName: "skills", Branch: "main", ScanRoot: ".",
		Schedule: schedule, Status: status, LastAttemptAt: lastAttempt, CreatedBy: "admin", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
}
