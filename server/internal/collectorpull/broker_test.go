package collectorpull

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestBrokerDeliversAndCompletesTask(t *testing.T) {
	broker := NewBroker()
	result := make(chan Completion, 1)
	errCh := make(chan error, 1)
	go func() {
		completion, err := broker.Submit(context.Background(), Submission{
			CollectorID: "collector-1", UpstreamServerID: "codexb-dev", TraceID: "trace-1",
			Tool: "codex.ask", Arguments: map[string]any{"question": "处理问题"},
		})
		result <- completion
		errCh <- err
	}()

	pullCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	delivery, ok, err := broker.Pull(pullCtx, "collector-1")
	if err != nil || !ok {
		t.Fatalf("Pull() = (%#v, %v, %v)", delivery, ok, err)
	}
	if delivery.Tool != "codex.ask" || delivery.TraceID != "trace-1" || delivery.Arguments["question"] != "处理问题" || delivery.ClaimID == "" {
		t.Fatalf("delivery = %#v", delivery)
	}
	req := collectorapi.TaskResultRequest{
		TaskID: delivery.TaskID, ClaimID: delivery.ClaimID, Status: collectorapi.TaskResultSucceeded,
		Output: &collectorapi.TaskResultOutput{Answer: "完成"},
	}
	if err := broker.Complete("collector-1", req); err != nil {
		t.Fatal(err)
	}
	if err := broker.Complete("collector-1", req); err != nil {
		t.Fatalf("idempotent Complete() error = %v", err)
	}
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if got := <-result; got.Output == nil || got.Output.Answer != "完成" {
		t.Fatalf("completion = %#v", got)
	}
}

func TestBrokerIsolatesCollectorsAndRejectsMismatchedResult(t *testing.T) {
	broker := NewBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_, _ = broker.Submit(ctx, Submission{CollectorID: "collector-1", UpstreamServerID: "codexb-dev", Tool: "codex.ask"})
	}()

	otherCtx, otherCancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer otherCancel()
	if _, ok, err := broker.Pull(otherCtx, "collector-2"); err != nil || ok {
		t.Fatalf("other collector Pull() ok = %v, err = %v", ok, err)
	}
	delivery, ok, err := broker.Pull(context.Background(), "collector-1")
	if err != nil || !ok {
		t.Fatalf("Pull() ok = %v, err = %v", ok, err)
	}
	err = broker.Complete("collector-2", collectorapi.TaskResultRequest{
		TaskID: delivery.TaskID, ClaimID: delivery.ClaimID, Status: collectorapi.TaskResultFailed,
		Error: &collectorapi.TaskResultError{Code: "execution_failed", Message: "failed"},
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("Complete() error = %v, want conflict", err)
	}
}

func TestBrokerLimitsInFlightTasksAndRejectsLateResult(t *testing.T) {
	broker := NewBroker()
	ctx, cancel := context.WithCancel(context.Background())
	for i := 0; i < maxInFlightPerCollector; i++ {
		go func(index int) {
			_, _ = broker.Submit(ctx, Submission{
				CollectorID: "collector-1", UpstreamServerID: fmt.Sprintf("codexb-%d", index), Tool: "codex.ask",
			})
		}(i)
	}
	deadline := time.Now().Add(time.Second)
	for {
		broker.mu.Lock()
		count := broker.inFlightLocked("collector-1")
		broker.mu.Unlock()
		if count == maxInFlightPerCollector {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("in-flight tasks did not reach %d", maxInFlightPerCollector)
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := broker.Submit(context.Background(), Submission{CollectorID: "collector-1", UpstreamServerID: "extra", Tool: "codex.ask"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("fifth Submit() error = %v, want busy", err)
	}

	delivery, ok, err := broker.Pull(context.Background(), "collector-1")
	if err != nil || !ok {
		t.Fatalf("Pull() ok = %v, err = %v", ok, err)
	}
	cancel()
	deadline = time.Now().Add(time.Second)
	for {
		broker.mu.Lock()
		remainingTasks := len(broker.tasks)
		remainingPending := len(broker.pending["collector-1"])
		broker.mu.Unlock()
		if remainingTasks == 0 && remainingPending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("canceled tasks remain: tasks=%d pending=%d", remainingTasks, remainingPending)
		}
		time.Sleep(time.Millisecond)
	}
	err = broker.Complete("collector-1", collectorapi.TaskResultRequest{
		TaskID: delivery.TaskID, ClaimID: delivery.ClaimID, Status: collectorapi.TaskResultFailed,
		Error: &collectorapi.TaskResultError{Code: "execution_failed", Message: "failed"},
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("late Complete() error = %v, want not found", err)
	}
}
