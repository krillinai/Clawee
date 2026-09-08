package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
)

func TestParseOptionsRequiresConfig(t *testing.T) {
	_, err := parseOptions([]string{})
	if err == nil || !strings.Contains(err.Error(), "--config is required") {
		t.Fatalf("err = %v, want --config is required", err)
	}
}

func TestParseOptionsAcceptsConfigAndLogDir(t *testing.T) {
	options, err := parseOptions([]string{"--config", "config.json", "--log-dir", "logs"})
	if err != nil {
		t.Fatal(err)
	}
	if options.ConfigPath != "config.json" || options.LogDir != "logs" {
		t.Fatalf("options = %#v", options)
	}
}

func TestRunRedirectsStdoutAndStderrToLogDir(t *testing.T) {
	logDir := t.TempDir()
	err := run(context.Background(), []string{"--config", "config.json", "--log-dir", logDir}, func(ctx context.Context, configPath string) error {
		os.Stdout.WriteString("stdout marker\n")
		os.Stderr.WriteString("stderr marker\n")
		if configPath != "config.json" {
			t.Fatalf("configPath = %q", configPath)
		}
		return errors.New("runtime failed")
	})
	if err == nil || !strings.Contains(err.Error(), "runtime failed") {
		t.Fatalf("err = %v, want runtime failed", err)
	}

	stdoutBody, err := os.ReadFile(filepath.Join(logDir, "collector-stdout.log"))
	if err != nil {
		t.Fatal(err)
	}
	stderrBody, err := os.ReadFile(filepath.Join(logDir, "collector-stderr.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stdoutBody), "stdout marker") {
		t.Fatalf("stdout log = %q", string(stdoutBody))
	}
	if !strings.Contains(string(stderrBody), "stderr marker") || !strings.Contains(string(stderrBody), "runtime failed") {
		t.Fatalf("stderr log = %q", string(stderrBody))
	}
}

func TestRunUsesRequestLogDirFromConfigWhenLogDirMissing(t *testing.T) {
	dir := t.TempDir()
	logDir := filepath.Join(dir, "configured-logs")
	configPath := filepath.Join(dir, "config.json")
	if err := collectorconfig.Save(configPath, collectorconfig.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "token",
		CollectorID:    "collector_1",
		DeviceID:       "device_1",
		PrivacyMode:    "summary_only",
		RequestLogDir:  logDir,
	}); err != nil {
		t.Fatal(err)
	}

	err := run(context.Background(), []string{"--config", configPath}, func(ctx context.Context, configPath string) error {
		os.Stdout.WriteString("configured stdout\n")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	stdoutBody, err := os.ReadFile(filepath.Join(logDir, "collector-stdout.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stdoutBody), "configured stdout") {
		t.Fatalf("stdout log = %q", string(stdoutBody))
	}
}
