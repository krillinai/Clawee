package taskworker

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/codexrunner"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

const (
	workerCount       = 4
	resultMaxAttempts = 3
)

type TaskAPI interface {
	Pull(context.Context) (*collectorapi.TaskDelivery, error)
	Complete(context.Context, collectorapi.TaskResultRequest) error
}

type QuestionRunner interface {
	Ask(context.Context, string) (string, error)
}

type Logger interface {
	Info(string, ...any)
	Warn(string, ...any)
}

type Worker struct {
	api    TaskAPI
	runner QuestionRunner
	logger Logger
}

func New(api TaskAPI, runner QuestionRunner, logger Logger) *Worker {
	if logger == nil {
		logger = slog.Default()
	}
	return &Worker{api: api, runner: runner, logger: logger}
}

func (w *Worker) Run(ctx context.Context) {
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for i := 0; i < workerCount; i++ {
		go func() {
			defer workers.Done()
			w.runOne(ctx)
		}()
	}
	workers.Wait()
}

func (w *Worker) runOne(ctx context.Context) {
	for ctx.Err() == nil {
		delivery, err := w.api.Pull(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			w.logger.Warn("collector task pull failed", "error", err)
			if !waitContext(ctx, pullRetryDelay(err)) {
				return
			}
			continue
		}
		if delivery == nil {
			continue
		}
		result := w.execute(ctx, *delivery)
		if err := w.completeWithRetry(ctx, result); err != nil && ctx.Err() == nil {
			w.logger.Warn("collector task result upload failed", "task_id", delivery.TaskID, "error", err)
		}
	}
}

func (w *Worker) execute(ctx context.Context, delivery collectorapi.TaskDelivery) collectorapi.TaskResultRequest {
	result := collectorapi.TaskResultRequest{TaskID: delivery.TaskID, ClaimID: delivery.ClaimID}
	question, ok := delivery.Arguments["question"].(string)
	question = strings.TrimSpace(question)
	if delivery.SchemaVersion != collectorapi.TaskSchemaVersion || delivery.Tool != "codex.ask" || !ok || question == "" || w.runner == nil {
		result.Status = collectorapi.TaskResultFailed
		result.Error = &collectorapi.TaskResultError{Code: "invalid_task", Message: "任务格式无效"}
		return result
	}
	answer, err := w.runner.Ask(ctx, question)
	if err == nil {
		result.Status = collectorapi.TaskResultSucceeded
		result.Output = &collectorapi.TaskResultOutput{Answer: answer}
		return result
	}
	result.Status = collectorapi.TaskResultFailed
	result.Error = taskExecutionError(err)
	return result
}

func (w *Worker) completeWithRetry(ctx context.Context, result collectorapi.TaskResultRequest) error {
	var lastErr error
	for attempt := 0; attempt < resultMaxAttempts; attempt++ {
		if err := w.api.Complete(ctx, result); err == nil {
			return nil
		} else {
			lastErr = err
			var statusErr *StatusError
			if errors.As(err, &statusErr) && statusErr.StatusCode < http.StatusInternalServerError {
				return err
			}
		}
		if attempt+1 < resultMaxAttempts && !waitContext(ctx, time.Duration(attempt+1)*100*time.Millisecond) {
			return ctx.Err()
		}
	}
	return lastErr
}

func taskExecutionError(err error) *collectorapi.TaskResultError {
	switch {
	case errors.Is(err, codexrunner.ErrBusy):
		return &collectorapi.TaskResultError{Code: "busy", Message: "Codex B 正忙"}
	case errors.Is(err, codexrunner.ErrTimeout):
		return &collectorapi.TaskResultError{Code: "timeout", Message: "执行超时"}
	case errors.Is(err, context.Canceled):
		return &collectorapi.TaskResultError{Code: "canceled", Message: "执行已取消"}
	default:
		return &collectorapi.TaskResultError{Code: "execution_failed", Message: "执行失败"}
	}
}

func pullRetryDelay(err error) time.Duration {
	var statusErr *StatusError
	if errors.As(err, &statusErr) && (statusErr.StatusCode == http.StatusUnauthorized || statusErr.StatusCode == http.StatusForbidden) {
		return time.Minute
	}
	return 5 * time.Second
}

func waitContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
