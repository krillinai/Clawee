package codexrunner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	ErrBusy            = errors.New("codex runner is busy")
	ErrTimeout         = errors.New("codex execution timed out")
	ErrExecutionFailed = errors.New("codex execution failed")
)

const maxConcurrentExecutions = 4

type commandExecutor interface {
	Run(context.Context, string, []string, io.Reader) error
}

type execCommandExecutor struct{}

func (execCommandExecutor) Run(ctx context.Context, name string, args []string, stdin io.Reader) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = stdin
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("codex exec failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

type Runner struct {
	workDir  string
	executor commandExecutor
	timeout  time.Duration
	slots    chan struct{}
}

func New(workDir string) (*Runner, error) {
	if workDir == "" {
		return nil, errors.New("codex work directory is required")
	}
	if !filepath.IsAbs(workDir) {
		return nil, errors.New("codex work directory must be absolute")
	}
	absWorkDir, err := filepath.Abs(workDir)
	if err != nil {
		return nil, fmt.Errorf("resolve codex work directory: %w", err)
	}
	info, err := os.Stat(absWorkDir)
	if err != nil {
		return nil, fmt.Errorf("stat codex work directory: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("codex work directory must be a directory")
	}
	return newWithExecutor(absWorkDir, execCommandExecutor{}), nil
}

func newWithExecutor(workDir string, executor commandExecutor) *Runner {
	return newWithExecutorAndTimeout(workDir, executor, 10*time.Minute)
}

func newWithExecutorAndTimeout(workDir string, executor commandExecutor, timeout time.Duration) *Runner {
	return &Runner{workDir: workDir, executor: executor, timeout: timeout, slots: make(chan struct{}, maxConcurrentExecutions)}
}

func (r *Runner) Ask(ctx context.Context, question string) (string, error) {
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	default:
		return "", ErrBusy
	}

	outputFile, err := os.CreateTemp("", "clawee-codex-last-message-*")
	if err != nil {
		return "", fmt.Errorf("create codex result file: %w: %w", err, ErrExecutionFailed)
	}
	outputPath := outputFile.Name()
	if err := outputFile.Close(); err != nil {
		_ = os.Remove(outputPath)
		return "", fmt.Errorf("close codex result file: %w: %w", err, ErrExecutionFailed)
	}
	defer os.Remove(outputPath)

	args := []string{
		"exec", "--ephemeral", "--sandbox", "read-only",
		"-C", r.workDir,
		"--output-last-message", outputPath,
		"-",
	}
	runCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	if err := r.executor.Run(runCtx, "codex", args, strings.NewReader(strings.TrimSpace(question))); err != nil {
		switch ctx.Err() {
		case context.Canceled:
			return "", context.Canceled
		case context.DeadlineExceeded:
			return "", fmt.Errorf("codex execution: %w", ErrTimeout)
		}
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("codex execution: %w", ErrTimeout)
		}
		return "", fmt.Errorf("codex execution: %w: %w", err, ErrExecutionFailed)
	}

	answerBytes, err := os.ReadFile(outputPath)
	if err != nil {
		return "", fmt.Errorf("read codex result file: %w: %w", err, ErrExecutionFailed)
	}
	answer := strings.TrimSpace(string(answerBytes))
	if answer == "" {
		return "", fmt.Errorf("codex result file is empty: %w", ErrExecutionFailed)
	}
	return answer, nil
}
