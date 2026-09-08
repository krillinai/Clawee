package taskworker

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type fakeTaskAPI struct {
	mu       sync.Mutex
	delivery *collectorapi.TaskDelivery
	results  chan collectorapi.TaskResultRequest
}

func (a *fakeTaskAPI) Pull(ctx context.Context) (*collectorapi.TaskDelivery, error) {
	a.mu.Lock()
	if a.delivery != nil {
		delivery := a.delivery
		a.delivery = nil
		a.mu.Unlock()
		return delivery, nil
	}
	a.mu.Unlock()
	<-ctx.Done()
	return nil, ctx.Err()
}

func (a *fakeTaskAPI) Complete(_ context.Context, result collectorapi.TaskResultRequest) error {
	a.results <- result
	return nil
}

type fakeQuestionRunner struct {
	answer   string
	err      error
	question string
}

func (r *fakeQuestionRunner) Ask(_ context.Context, question string) (string, error) {
	r.question = question
	return r.answer, r.err
}

func TestWorkerExecutesTaskAndUploadsResult(t *testing.T) {
	api := &fakeTaskAPI{
		delivery: &collectorapi.TaskDelivery{
			SchemaVersion: collectorapi.TaskSchemaVersion, TaskID: "task-1", ClaimID: "claim-1",
			Tool: "codex.ask", Arguments: map[string]any{"question": " 请处理 "},
		},
		results: make(chan collectorapi.TaskResultRequest, 1),
	}
	runner := &fakeQuestionRunner{answer: "完成"}
	worker := New(api, runner, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		worker.Run(ctx)
		close(done)
	}()
	select {
	case result := <-api.results:
		if result.Status != collectorapi.TaskResultSucceeded || result.Output == nil || result.Output.Answer != "完成" || runner.question != "请处理" {
			t.Fatalf("result=%#v question=%q", result, runner.question)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not upload result")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}
}

func TestWorkerRejectsInvalidTaskWithoutCallingRunner(t *testing.T) {
	runner := &fakeQuestionRunner{answer: "must-not-run"}
	worker := New(nil, runner, nil)
	result := worker.execute(context.Background(), collectorapi.TaskDelivery{
		SchemaVersion: collectorapi.TaskSchemaVersion, TaskID: "task-1", ClaimID: "claim-1", Tool: "other",
	})
	if result.Status != collectorapi.TaskResultFailed || result.Error == nil || result.Error.Code != "invalid_task" || runner.question != "" {
		t.Fatalf("result=%#v runner=%#v", result, runner)
	}
}
