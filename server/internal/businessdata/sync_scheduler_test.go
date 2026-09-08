package businessdata

import (
	"context"
	"sync"
	"testing"
	"time"
)

type schedulerFixtureStore struct {
	mu         sync.Mutex
	recovered  bool
	queueCalls int
	requested  string
	claimed    bool
	run        SyncRun
}

func (s *schedulerFixtureStore) QueueProviderRuns(_ context.Context, provider string, _ time.Time) (SyncRequestResult, error) {
	s.requested = provider
	return SyncRequestResult{SourceCount: 1, QueuedCount: 1}, nil
}

func (s *schedulerFixtureStore) RecoverRunningRuns(context.Context, time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recovered = true
	return nil
}
func (s *schedulerFixtureStore) QueueDueRuns(context.Context, time.Time, int) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queueCalls++
	if s.queueCalls == 1 {
		return 1, nil
	}
	return 0, nil
}
func (s *schedulerFixtureStore) ClaimNextRun(context.Context, time.Time) (SyncRun, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimed {
		return SyncRun{}, false, nil
	}
	s.claimed = true
	return s.run, true, nil
}
func (s *schedulerFixtureStore) CompleteRun(context.Context, SyncRun) error { return nil }

type schedulerFixtureRunner struct{ ran chan SyncRun }

func (r schedulerFixtureRunner) Run(_ context.Context, run SyncRun) error {
	r.ran <- run
	return nil
}

func TestSchedulerRequestsProviderSync(t *testing.T) {
	store := &schedulerFixtureStore{}
	scheduler := NewSchedulerWithConfig(SchedulerConfig{Store: store, Runner: schedulerFixtureRunner{ran: make(chan SyncRun, 1)}})
	result, err := scheduler.RequestSync(context.Background(), ProviderBilibili)
	if err != nil || result.SourceCount != 1 || result.QueuedCount != 1 || store.requested != ProviderBilibili {
		t.Fatalf("result=%#v provider=%q err=%v", result, store.requested, err)
	}
	if _, err := scheduler.RequestSync(context.Background(), "unknown"); err != ErrInvalidRequest {
		t.Fatalf("invalid provider error=%v", err)
	}
}

func TestSchedulerRecoversQueuesRunsAndCloses(t *testing.T) {
	now := time.Date(2026, 8, 14, 3, 0, 0, 0, time.UTC)
	store := &schedulerFixtureStore{run: SyncRun{RunID: "bdrun_1", SourceID: "bdsrc_1", Status: SyncRunStatusRunning}}
	runner := schedulerFixtureRunner{ran: make(chan SyncRun, 1)}
	scheduler := NewSchedulerWithConfig(SchedulerConfig{
		Store: store, Runner: runner, Clock: func() time.Time { return now },
		TickInterval: time.Hour, RunTimeout: time.Second, DueBatch: 10,
	})
	if err := scheduler.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case run := <-runner.ran:
		if run.RunID != "bdrun_1" {
			t.Fatalf("run=%#v", run)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not execute queued run")
	}
	scheduler.Close()
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.recovered || store.queueCalls == 0 {
		t.Fatalf("recovered=%v queue_calls=%d", store.recovered, store.queueCalls)
	}
}

type blockingSchedulerRunner struct {
	started chan struct{}
	exited  chan struct{}
}

func (r blockingSchedulerRunner) Run(ctx context.Context, _ SyncRun) error {
	close(r.started)
	<-ctx.Done()
	close(r.exited)
	return ctx.Err()
}

func TestSchedulerCloseCancelsAndWaitsForWorker(t *testing.T) {
	store := &schedulerFixtureStore{run: SyncRun{RunID: "bdrun_block", SourceID: "bdsrc_1", Status: SyncRunStatusRunning}}
	runner := blockingSchedulerRunner{started: make(chan struct{}), exited: make(chan struct{})}
	scheduler := NewSchedulerWithConfig(SchedulerConfig{Store: store, Runner: runner, TickInterval: time.Hour, RunTimeout: time.Hour})
	if err := scheduler.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runner.started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	closed := make(chan struct{})
	go func() {
		scheduler.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close did not wait for canceled worker")
	}
	select {
	case <-runner.exited:
	default:
		t.Fatal("Close returned before worker exited")
	}
}
