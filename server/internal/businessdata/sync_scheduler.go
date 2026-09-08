package businessdata

import (
	"context"
	"sync"
	"time"

	"go.uber.org/zap"
)

const (
	defaultTickInterval = time.Minute
	defaultRunTimeout   = 5 * time.Minute
	defaultDueBatch     = 100
)

type syncRunner interface {
	Run(context.Context, SyncRun) error
}

type SchedulerConfig struct {
	Store        SyncRunStore
	Runner       syncRunner
	Logger       *zap.Logger
	Clock        func() time.Time
	TickInterval time.Duration
	RunTimeout   time.Duration
	DueBatch     int
}

type Scheduler struct {
	store        SyncRunStore
	runner       syncRunner
	logger       *zap.Logger
	clock        func() time.Time
	tickInterval time.Duration
	runTimeout   time.Duration
	dueBatch     int

	mu      sync.Mutex
	started bool
	closing bool
	cancel  context.CancelFunc
	wake    chan struct{}
	wg      sync.WaitGroup
}

func NewScheduler(store SyncRunStore, runner *SyncService, logger *zap.Logger) *Scheduler {
	return NewSchedulerWithConfig(SchedulerConfig{Store: store, Runner: runner, Logger: logger})
}

func NewSchedulerWithConfig(cfg SchedulerConfig) *Scheduler {
	if cfg.Clock == nil {
		cfg.Clock = func() time.Time { return time.Now().UTC() }
	}
	if cfg.TickInterval <= 0 {
		cfg.TickInterval = defaultTickInterval
	}
	if cfg.RunTimeout <= 0 {
		cfg.RunTimeout = defaultRunTimeout
	}
	if cfg.DueBatch <= 0 {
		cfg.DueBatch = defaultDueBatch
	}
	return &Scheduler{store: cfg.Store, runner: cfg.Runner, logger: cfg.Logger, clock: cfg.Clock, tickInterval: cfg.TickInterval, runTimeout: cfg.RunTimeout, dueBatch: cfg.DueBatch}
}

func (s *Scheduler) Start(ctx context.Context) error {
	if s == nil || s.store == nil || s.runner == nil {
		return ErrInvalidRequest
	}
	s.mu.Lock()
	if s.started || s.closing {
		s.mu.Unlock()
		return ErrInvalidRequest
	}
	s.mu.Unlock()
	if err := s.store.RecoverRunningRuns(ctx, s.clock().UTC()); err != nil {
		return err
	}
	runContext, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	if s.started || s.closing {
		s.mu.Unlock()
		cancel()
		return ErrInvalidRequest
	}
	s.started = true
	s.cancel = cancel
	s.wake = make(chan struct{}, 1)
	s.mu.Unlock()
	s.wg.Add(2)
	go s.scheduleLoop(runContext)
	go s.worker(runContext)
	s.signalWorker()
	return nil
}

func (s *Scheduler) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.closing = true
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.wg.Wait()
}

func (s *Scheduler) RequestSync(ctx context.Context, provider string) (SyncRequestResult, error) {
	if s == nil || s.store == nil || !validProvider(provider) {
		return SyncRequestResult{}, ErrInvalidRequest
	}
	result, err := s.store.QueueProviderRuns(ctx, provider, s.clock().UTC())
	if err != nil {
		return SyncRequestResult{}, err
	}
	if result.QueuedCount > 0 {
		s.signalWorker()
	}
	return result, nil
}

func (s *Scheduler) NotifyQueuedRuns() {
	if s != nil {
		s.signalWorker()
	}
}

func (s *Scheduler) scheduleLoop(ctx context.Context) {
	defer s.wg.Done()
	s.queueDue(ctx, s.clock().UTC())
	ticker := time.NewTicker(s.tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.queueDue(ctx, now.UTC())
		}
	}
}

func (s *Scheduler) queueDue(ctx context.Context, now time.Time) {
	queued, err := s.store.QueueDueRuns(ctx, now, s.dueBatch)
	if err != nil {
		s.logStoreError("queue due business data runs")
		return
	}
	if queued > 0 {
		s.signalWorker()
	}
}

func (s *Scheduler) worker(ctx context.Context) {
	defer s.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		}
		for {
			if ctx.Err() != nil {
				return
			}
			run, ok, err := s.store.ClaimNextRun(ctx, s.clock().UTC())
			if err != nil {
				s.logStoreError("claim business data run")
				break
			}
			if !ok {
				break
			}
			runContext, cancel := context.WithTimeout(ctx, s.runTimeout)
			_ = s.runner.Run(runContext, run)
			cancel()
		}
	}
}

func (s *Scheduler) signalWorker() {
	s.mu.Lock()
	wake := s.wake
	closing := s.closing
	s.mu.Unlock()
	if wake == nil || closing {
		return
	}
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (s *Scheduler) logStoreError(message string) {
	if s.logger != nil {
		s.logger.Error(message, zap.String("error_code", "store_failed"))
	}
}
