package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	collectorruntime "github.com/krillinai/Clawee/server/internal/collector/runtime"
)

const (
	stdoutLogName = "collector-stdout.log"
	stderrLogName = "collector-stderr.log"
)

type runnerOptions struct {
	ConfigPath string
	LogDir     string
}

type runtimeRunFunc func(context.Context, string) error

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], func(ctx context.Context, configPath string) error {
		return collectorruntime.Run(ctx, collectorruntime.Options{ConfigPath: configPath})
	}); err != nil {
		os.Exit(1)
	}
}

func parseOptions(args []string) (runnerOptions, error) {
	flags := flag.NewFlagSet("clawee-collector-runner", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	logDir := flags.String("log-dir", "", "collector log directory")
	if err := flags.Parse(args); err != nil {
		return runnerOptions{}, err
	}
	if len(flags.Args()) > 0 {
		return runnerOptions{}, errors.New("unexpected positional arguments")
	}
	if *configPath == "" {
		return runnerOptions{}, errors.New("--config is required")
	}
	return runnerOptions{ConfigPath: *configPath, LogDir: *logDir}, nil
}

func run(ctx context.Context, args []string, runtimeRun runtimeRunFunc) error {
	options, err := parseOptions(args)
	if err != nil {
		return err
	}
	logDir := options.LogDir
	if logDir == "" {
		logDir = resolveLogDir(options.ConfigPath)
	}
	restore, err := redirectStdIO(logDir)
	if err != nil {
		return err
	}
	defer restore()

	if err := runtimeRun(ctx, options.ConfigPath); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		return err
	}
	return nil
}

func resolveLogDir(configPath string) string {
	if cfg, err := collectorconfig.Load(configPath); err == nil && cfg.RequestLogDir != "" {
		return cfg.RequestLogDir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "logs"
	}
	return filepath.Join(home, ".clawee", "collector", "logs")
}

func redirectStdIO(logDir string) (func(), error) {
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return nil, err
	}
	stdout, err := os.OpenFile(filepath.Join(logDir, stdoutLogName), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	stderr, err := os.OpenFile(filepath.Join(logDir, stderrLogName), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		_ = stdout.Close()
		return nil, err
	}

	previousStdout := os.Stdout
	previousStderr := os.Stderr
	os.Stdout = stdout
	os.Stderr = stderr
	return func() {
		os.Stdout = previousStdout
		os.Stderr = previousStderr
		_ = stdout.Close()
		_ = stderr.Close()
	}, nil
}
