package codexrunner

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type executorFunc func(context.Context, string, []string, io.Reader) error

func (f executorFunc) Run(ctx context.Context, name string, args []string, stdin io.Reader) error {
	return f(ctx, name, args, stdin)
}

func TestRunnerUsesFixedCodexExecArgumentsAndStdin(t *testing.T) {
	workDir := t.TempDir()
	question := "question ' ;\nsecond line"
	runner := newWithExecutor(workDir, executorFunc(func(_ context.Context, name string, args []string, stdin io.Reader) error {
		if name != "codex" {
			t.Fatalf("name = %q, want codex", name)
		}
		outputPath := args[7]
		wantArgs := []string{"exec", "--ephemeral", "--sandbox", "read-only", "-C", workDir, "--output-last-message", outputPath, "-"}
		if len(args) != len(wantArgs) {
			t.Fatalf("args = %q, want %q", args, wantArgs)
		}
		for i := range wantArgs {
			if args[i] != wantArgs[i] {
				t.Fatalf("args[%d] = %q, want %q", i, args[i], wantArgs[i])
			}
		}
		for _, arg := range args {
			if strings.Contains(arg, question) {
				t.Fatalf("question appeared in args: %q", arg)
			}
		}
		body, err := io.ReadAll(stdin)
		if err != nil {
			return err
		}
		if string(body) != question {
			t.Fatalf("stdin = %q, want %q", body, question)
		}
		return os.WriteFile(outputPath, []byte("final answer"), 0o600)
	}))

	answer, err := runner.Ask(context.Background(), question)
	if err != nil {
		t.Fatal(err)
	}
	if answer != "final answer" {
		t.Fatalf("answer = %q, want final answer", answer)
	}
}

func TestRunnerRemovesLastMessageFile(t *testing.T) {
	var outputPath string
	runner := newWithExecutor(t.TempDir(), executorFunc(func(_ context.Context, _ string, args []string, _ io.Reader) error {
		outputPath = args[7]
		return os.WriteFile(outputPath, []byte("answer"), 0o600)
	}))

	if _, err := runner.Ask(context.Background(), "question"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(outputPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("result file stat error = %v, want not exist", err)
	}
}

func TestRunnerReturnsBusyWithoutQueueing(t *testing.T) {
	started := make(chan struct{}, maxConcurrentExecutions)
	release := make(chan struct{})
	var calls atomic.Int32
	runner := newWithExecutor(t.TempDir(), executorFunc(func(_ context.Context, _ string, args []string, _ io.Reader) error {
		if err := os.WriteFile(args[7], []byte("answer"), 0o600); err != nil {
			return err
		}
		calls.Add(1)
		started <- struct{}{}
		<-release
		return nil
	}))

	done := make(chan error, maxConcurrentExecutions)
	for i := 0; i < maxConcurrentExecutions; i++ {
		go func() {
			_, err := runner.Ask(context.Background(), "question")
			done <- err
		}()
	}
	for i := 0; i < maxConcurrentExecutions; i++ {
		<-started
	}

	fifthDone := make(chan error, 1)
	go func() {
		_, err := runner.Ask(context.Background(), "fifth")
		fifthDone <- err
	}()
	select {
	case err := <-fifthDone:
		if !errors.Is(err, ErrBusy) {
			t.Fatalf("fifth error = %v, want ErrBusy", err)
		}
	case <-time.After(time.Second):
		t.Fatal("fifth call queued behind running calls")
	}

	close(release)
	for i := 0; i < maxConcurrentExecutions; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != maxConcurrentExecutions {
		t.Fatalf("executor calls = %d, want %d", calls.Load(), maxConcurrentExecutions)
	}
	if _, err := runner.Ask(context.Background(), "after release"); err != nil {
		t.Fatalf("call after release: %v", err)
	}
}

func TestRunnerCancellationTakesPriority(t *testing.T) {
	runner := newWithExecutor(t.TempDir(), executorFunc(func(ctx context.Context, _ string, _ []string, _ io.Reader) error {
		<-ctx.Done()
		return ctx.Err()
	}))

	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runner.Ask(canceledCtx, "question"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled error = %v, want context.Canceled", err)
	}
}

func TestRunnerDeadlineReturnsTimeout(t *testing.T) {
	runner := newWithExecutorAndTimeout(t.TempDir(), executorFunc(func(ctx context.Context, _ string, _ []string, _ io.Reader) error {
		<-ctx.Done()
		return ctx.Err()
	}), time.Millisecond)

	if _, err := runner.Ask(context.Background(), "question"); !errors.Is(err, ErrTimeout) {
		t.Fatalf("timeout error = %v, want ErrTimeout", err)
	}
}

func TestRunnerFailurePathsRemoveLastMessageFileAndWrapExecutionFailure(t *testing.T) {
	executorErr := errors.New("codex exited unsuccessfully")
	for _, test := range []struct {
		name    string
		execute func(string) error
	}{
		{
			name: "command failure",
			execute: func(_ string) error {
				return executorErr
			},
		},
		{
			name: "missing result file",
			execute: func(outputPath string) error {
				return os.Remove(outputPath)
			},
		},
		{
			name: "empty result file",
			execute: func(_ string) error {
				return nil
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var outputPath string
			runner := newWithExecutor(t.TempDir(), executorFunc(func(_ context.Context, _ string, args []string, _ io.Reader) error {
				outputPath = args[7]
				return test.execute(outputPath)
			}))

			_, err := runner.Ask(context.Background(), "question")
			if !errors.Is(err, ErrExecutionFailed) {
				t.Fatalf("error = %v, want ErrExecutionFailed", err)
			}
			if _, statErr := os.Stat(outputPath); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("result file stat error = %v, want not exist", statErr)
			}
		})
	}
}

func TestNewRejectsInvalidWorkDir(t *testing.T) {
	if _, err := New("."); err == nil {
		t.Fatal("New(relative directory) succeeded, want error")
	}
	for _, workDir := range []string{"", filepath.Join(t.TempDir(), "missing")} {
		if _, err := New(workDir); err == nil {
			t.Fatalf("New(%q) succeeded, want error", workDir)
		}
	}
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(file); err == nil {
		t.Fatal("New(file) succeeded, want error")
	}
}
