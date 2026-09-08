package businessdata

import (
	"context"
	"errors"
	"time"

	"go.uber.org/zap"
)

const syncCompletionTimeout = 5 * time.Second

type SyncService struct {
	sources  SourceStore
	runs     SyncRunStore
	metrics  MetricStore
	registry *ConnectorRegistry
	logger   *zap.Logger
	clock    func() time.Time
}

func NewSyncService(store Store, registry *ConnectorRegistry, logger *zap.Logger) *SyncService {
	return &SyncService{
		sources: store, runs: store, metrics: store, registry: registry, logger: logger,
		clock: func() time.Time { return time.Now().UTC() },
	}
}

func newSyncService(sources SourceStore, runs SyncRunStore, metrics MetricStore, registry *ConnectorRegistry, logger *zap.Logger, clock func() time.Time) *SyncService {
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	return &SyncService{sources: sources, runs: runs, metrics: metrics, registry: registry, logger: logger, clock: clock}
}

func (s *SyncService) Run(ctx context.Context, run SyncRun) error {
	if s == nil || s.sources == nil || s.runs == nil || s.metrics == nil || s.registry == nil || run.RunID == "" || run.SourceID == "" || run.Status != SyncRunStatusRunning {
		return ErrInvalidRequest
	}
	started := s.clock().UTC()
	source, err := s.sources.GetSource(ctx, run.SourceID)
	if err != nil {
		return s.fail(run, "store_failed", "source lookup failed", err, started)
	}
	if source.Status != SourceStatusActive {
		if source.Provider == ProviderBilibili {
			return s.fail(run, BilibiliSyncDisabledCode, "bilibili sync is disabled", ErrBilibiliSourceDisabled, started)
		}
		return s.fail(run, "connector_unavailable", "business data source is disabled", ErrInvalidRequest, started)
	}
	connector, ok := s.registry.Get(source.Provider)
	if !ok {
		return s.fail(run, "connector_unavailable", "connector is unavailable", ErrInvalidRequest, started)
	}
	batch, err := connector.Pull(ctx, source, PullRequest{SourceID: source.SourceID, StartDate: run.StartDate, EndDate: run.EndDate})
	if err != nil {
		code, summary := "connector_failed", "connector pull failed"
		if errors.Is(err, ErrBilibiliReauthRequired) {
			code, summary = "bilibili_reauth_required", "bilibili authorization is required"
		} else if errors.Is(err, ErrBilibiliRateLimited) {
			code, summary = "bilibili_rate_limited", "bilibili request was rate limited"
		}
		return s.fail(run, code, summary, err, started)
	}
	run.FetchedCount = batch.RecordCount()
	if err := validateBatch(source.Provider, run.StartDate, run.EndDate, &batch); err != nil {
		return s.fail(run, "batch_invalid", "connector batch is invalid", err, started)
	}
	upserted, err := s.metrics.UpsertBatch(ctx, source.SourceID, run.RunID, batch, s.clock().UTC())
	if err != nil {
		code, summary := "store_failed", "business data write failed"
		if errors.Is(err, ErrInvalidBatch) {
			code, summary = "batch_invalid", "connector batch is invalid"
		} else if errors.Is(err, ErrBilibiliSourceDisabled) {
			code, summary = BilibiliSyncDisabledCode, "bilibili sync is disabled"
		}
		return s.fail(run, code, summary, err, started)
	}
	finished := s.clock().UTC()
	run.Status = SyncRunStatusSuccess
	run.UpsertedCount = upserted
	run.ErrorCode = ""
	run.ErrorSummary = ""
	run.FinishedAt = &finished
	completionContext, cancel := context.WithTimeout(context.Background(), syncCompletionTimeout)
	defer cancel()
	if err := s.runs.CompleteRun(completionContext, run); err != nil {
		s.log(run, source.Provider, "store_failed", started, err)
		return err
	}
	s.log(run, source.Provider, "", started, nil)
	return nil
}

func (s *SyncService) fail(run SyncRun, code, summary string, cause error, started time.Time) error {
	finished := s.clock().UTC()
	run.Status = SyncRunStatusFailed
	run.ErrorCode = code
	run.ErrorSummary = summary
	run.FinishedAt = &finished
	completionContext, cancel := context.WithTimeout(context.Background(), syncCompletionTimeout)
	defer cancel()
	completionErr := s.runs.CompleteRun(completionContext, run)
	s.log(run, "", code, started, cause)
	if completionErr != nil {
		return completionErr
	}
	return cause
}

func (s *SyncService) log(run SyncRun, provider, code string, started time.Time, cause error) {
	if s.logger == nil {
		return
	}
	fields := []zap.Field{
		zap.String("source_id", run.SourceID), zap.String("provider", provider), zap.String("run_id", run.RunID),
		zap.String("status", run.Status), zap.String("start_date", dateKey(run.StartDate)), zap.String("end_date", dateKey(run.EndDate)),
		zap.Int64("fetched_count", run.FetchedCount), zap.Int64("upserted_count", run.UpsertedCount),
		zap.String("error_code", code), zap.Int64("duration_ms", s.clock().Sub(started).Milliseconds()),
	}
	if cause != nil {
		s.logger.Error("business data sync completed", fields...)
		return
	}
	s.logger.Info("business data sync completed", fields...)
}
