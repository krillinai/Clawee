package skillhub

import (
	"context"
	"errors"
	"sync"
	"time"

	"go.uber.org/zap"
)

const (
	sourceScheduleInterval = time.Minute
	sourceRunTimeout       = 300 * time.Second
	sourceWorkerCount      = 2
	sourceDueBatchSize     = 100
)

type sourceSyncRunner interface {
	Run(context.Context, SourceSyncRun) error
}

type sourceSchedulerConfig struct {
	store        SourceStore
	runner       sourceSyncRunner
	logger       *zap.Logger
	clock        func() time.Time
	tickInterval time.Duration
	runTimeout   time.Duration
	workerCount  int
}

type SourceScheduler struct {
	store        SourceStore
	runner       sourceSyncRunner
	logger       *zap.Logger
	clock        func() time.Time
	tickInterval time.Duration
	runTimeout   time.Duration
	workerCount  int

	mu      sync.Mutex
	started bool
	closing bool
	cancel  context.CancelFunc
	wake    chan struct{}
	wg      sync.WaitGroup
}

func NewSourceScheduler(store SourceStore, runner *SourceSyncService, logger *zap.Logger) *SourceScheduler {
	return newSourceScheduler(sourceSchedulerConfig{store: store, runner: runner, logger: logger})
}

func newSourceScheduler(cfg sourceSchedulerConfig) *SourceScheduler {
	if cfg.clock == nil {
		cfg.clock = func() time.Time { return time.Now().UTC() }
	}
	if cfg.tickInterval <= 0 {
		cfg.tickInterval = sourceScheduleInterval
	}
	if cfg.runTimeout <= 0 {
		cfg.runTimeout = sourceRunTimeout
	}
	if cfg.workerCount <= 0 {
		cfg.workerCount = sourceWorkerCount
	}
	return &SourceScheduler{
		store: cfg.store, runner: cfg.runner, logger: cfg.logger, clock: cfg.clock,
		tickInterval: cfg.tickInterval, runTimeout: cfg.runTimeout, workerCount: cfg.workerCount,
	}
}

func (s *SourceScheduler) Start(ctx context.Context) error {
	if s == nil || s.store == nil || s.runner == nil {
		return ErrInvalidRequest
	}
	s.mu.Lock()
	if s.started || s.closing {
		s.mu.Unlock()
		return ErrConflict
	}
	s.mu.Unlock()
	if err := s.store.RecoverRunningSyncRuns(ctx, s.clock().UTC()); err != nil {
		return err
	}

	runContext, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	if s.started || s.closing {
		s.mu.Unlock()
		cancel()
		return ErrConflict
	}
	s.started = true
	s.cancel = cancel
	s.wake = make(chan struct{}, s.workerCount)
	s.mu.Unlock()

	s.wg.Add(1 + s.workerCount)
	go s.scheduleLoop(runContext)
	for index := 0; index < s.workerCount; index++ {
		go s.worker(runContext)
	}
	s.signalWorkers()
	return nil
}

func (s *SourceScheduler) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.closing {
		cancel := s.cancel
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		s.wg.Wait()
		return
	}
	s.closing = true
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.wg.Wait()
}

func (s *SourceScheduler) NotifyRunQueued() {
	if s != nil {
		s.signalWorkers()
	}
}

func (s *SourceScheduler) scheduleLoop(ctx context.Context) {
	defer s.wg.Done()
	if err := s.queueDue(ctx, s.clock().UTC()); err != nil {
		s.logError("queue due github skill sources", err)
	}
	s.signalWorkers()
	ticker := time.NewTicker(s.tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if err := s.queueDue(ctx, now.UTC()); err != nil {
				s.logError("queue due github skill sources", err)
			}
			s.signalWorkers()
		}
	}
}

func (s *SourceScheduler) queueDue(ctx context.Context, now time.Time) error {
	if s.isClosing() {
		return nil
	}
	sources, err := s.store.ListDueSources(ctx, now.UTC(), sourceDueBatchSize)
	if err != nil {
		return err
	}
	for _, source := range sources {
		if s.isClosing() {
			return nil
		}
		run := SourceSyncRun{
			RunID: newID("sourcerun"), SourceID: source.SourceID, Trigger: SourceSyncTriggerScheduled,
			RepositoryMode: SourceRepositoryModeRemote, Status: SourceSyncRunStatusQueued, RequestedBy: "system", CreatedAt: now.UTC(),
		}
		if _, err := s.store.CreateSyncRun(ctx, run); err != nil && !errors.Is(err, ErrConflict) {
			return err
		}
	}
	return nil
}

func (s *SourceScheduler) worker(ctx context.Context) {
	defer s.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		}
		for {
			if ctx.Err() != nil || s.isClosing() {
				return
			}
			run, ok, err := s.store.ClaimNextSyncRun(ctx, s.clock().UTC())
			if err != nil {
				s.logError("claim github skill source sync", err)
				break
			}
			if !ok {
				break
			}
			runContext, cancel := context.WithTimeout(ctx, s.runTimeout)
			err = s.runner.Run(runContext, run)
			cancel()
			if err != nil {
				s.logError("run github skill source sync", err)
			}
		}
	}
}

func (s *SourceScheduler) isClosing() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closing
}

func (s *SourceScheduler) signalWorkers() {
	s.mu.Lock()
	wake := s.wake
	closing := s.closing
	workers := s.workerCount
	s.mu.Unlock()
	if wake == nil || closing {
		return
	}
	for index := 0; index < workers; index++ {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
}

func (s *SourceScheduler) logError(message string, err error) {
	if s.logger != nil {
		s.logger.Error(message, zap.Error(err))
	}
}
