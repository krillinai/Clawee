package unixuser

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

type callRunner struct {
	calls []string
	fail  string
}

func (r *callRunner) Run(ctx context.Context, name string, args ...string) common.CommandResult {
	call := name
	if len(args) > 0 {
		call += " " + strings.Join(args, " ")
	}
	r.calls = append(r.calls, call)
	if r.fail != "" && strings.Contains(call, r.fail) {
		return common.CommandResult{ExitCode: 1, Output: "boom", Err: os.ErrPermission}
	}
	return common.CommandResult{ExitCode: 0, Output: "ok"}
}

func TestCleanupRuntimeDarwinBootoutFailureStopsBeforeRemovingHook(t *testing.T) {
	home := t.TempDir()
	paths := Paths{
		ConfigPath:      filepath.Join(home, ".clawee-collector", "config.json"),
		CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
		LaunchAgentPath: filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist"),
		DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.LaunchAgentPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.LaunchAgentPath, []byte("old plist"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &callRunner{fail: "bootout"}
	hookCalled := false

	_, err := CleanupRuntime(context.Background(), paths, Platform{OS: "darwin"}, runner, func(path string) (bool, error) {
		hookCalled = true
		return true, nil
	})

	if err == nil {
		t.Fatal("expected bootout failure")
	}
	if hookCalled {
		t.Fatal("hook removal should not run after startup cleanup failure")
	}
	if _, statErr := os.Stat(paths.LaunchAgentPath); statErr != nil {
		t.Fatalf("plist should remain on failure: %v", statErr)
	}
}

func TestCleanupRuntimeDarwinMissingBootoutStillRemovesPlistAndHook(t *testing.T) {
	home := t.TempDir()
	paths := Paths{
		ConfigPath:      filepath.Join(home, ".clawee-collector", "config.json"),
		CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
		LaunchAgentPath: filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist"),
		DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.LaunchAgentPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.LaunchAgentPath, []byte("old plist"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &scriptedRunner{
		results: map[string]common.CommandResult{
			"launchctl bootout": {ExitCode: 1, Output: "launchctl: service not found", Err: os.ErrNotExist},
		},
	}
	hookCalled := false

	result, err := CleanupRuntime(context.Background(), paths, Platform{OS: "darwin"}, runner, func(path string) (bool, error) {
		hookCalled = true
		return true, nil
	})

	if err != nil {
		t.Fatal(err)
	}
	if !result.StartupRemoved || !result.HooksRemoved {
		t.Fatalf("result = %#v", result)
	}
	if !hookCalled {
		t.Fatal("hook removal should run after missing bootout output")
	}
	if _, statErr := os.Stat(paths.LaunchAgentPath); !os.IsNotExist(statErr) {
		t.Fatalf("plist should be removed, err=%v", statErr)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "launchctl bootout gui/") {
		t.Fatalf("missing bootout call in:\n%s", joined)
	}
}

func TestCleanupRuntimeLinuxStopsDisablesRemovesUnitAndHook(t *testing.T) {
	home := t.TempDir()
	paths := Paths{
		SystemdUnitPath: filepath.Join(home, ".config", "systemd", "user", SystemdUnitName),
		CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
		DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.SystemdUnitPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.SystemdUnitPath, []byte("old unit"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &callRunner{}
	hooksRemoved := false

	result, err := CleanupRuntime(context.Background(), paths, Platform{OS: "linux"}, runner, func(path string) (bool, error) {
		hooksRemoved = true
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.StartupRemoved || !result.HooksRemoved || !hooksRemoved {
		t.Fatalf("result = %#v hooksRemoved=%v", result, hooksRemoved)
	}
	if _, err := os.Stat(paths.SystemdUnitPath); !os.IsNotExist(err) {
		t.Fatalf("unit should be removed, err=%v", err)
	}
	joined := strings.Join(runner.calls, "\n")
	for _, want := range []string{
		"systemctl --user stop clawee-collector.service",
		"systemctl --user disable clawee-collector.service",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in calls:\n%s", want, joined)
		}
	}
}

func TestCleanupRuntimeLinuxMissingServiceStillRemovesUnitAndHook(t *testing.T) {
	home := t.TempDir()
	paths := Paths{
		SystemdUnitPath: filepath.Join(home, ".config", "systemd", "user", SystemdUnitName),
		CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
		DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.SystemdUnitPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.SystemdUnitPath, []byte("old unit"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &scriptedRunner{
		results: map[string]common.CommandResult{
			"systemctl --user stop":    {ExitCode: 1, Output: "Unit clawee-collector.service not loaded.", Err: os.ErrNotExist},
			"systemctl --user disable": {ExitCode: 1, Output: "Unit clawee-collector.service could not be found.", Err: os.ErrNotExist},
		},
	}
	hooksRemoved := false

	result, err := CleanupRuntime(context.Background(), paths, Platform{OS: "linux"}, runner, func(path string) (bool, error) {
		hooksRemoved = true
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.StartupRemoved || !result.HooksRemoved || !hooksRemoved {
		t.Fatalf("result = %#v hooksRemoved=%v", result, hooksRemoved)
	}
	if _, err := os.Stat(paths.SystemdUnitPath); !os.IsNotExist(err) {
		t.Fatalf("unit should be removed, err=%v", err)
	}
}

func TestCleanupRuntimeReturnsStartupRemovedWhenHookRemovalFails(t *testing.T) {
	home := t.TempDir()
	paths := Paths{
		SystemdUnitPath: filepath.Join(home, ".config", "systemd", "user", SystemdUnitName),
		CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
		DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.SystemdUnitPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.SystemdUnitPath, []byte("old unit"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &callRunner{}
	hookCalled := false

	result, err := CleanupRuntime(context.Background(), paths, Platform{OS: "linux"}, runner, func(path string) (bool, error) {
		hookCalled = true
		return false, os.ErrPermission
	})

	if err == nil {
		t.Fatal("expected hook removal failure")
	}
	if !result.StartupRemoved {
		t.Fatalf("result = %#v", result)
	}
	if !hookCalled {
		t.Fatal("hook removal should run before returning error")
	}
}

func TestInstallerCleanupRuntimeWritesDiagnosticsLog(t *testing.T) {
	home := t.TempDir()
	unitPath := filepath.Join(home, ".config", "systemd", "user", SystemdUnitName)
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unitPath, []byte("old unit"), 0o644); err != nil {
		t.Fatal(err)
	}

	installer := NewInstaller(InstallerDeps{
		Now: func() time.Time { return time.Date(2026, 7, 7, 10, 11, 12, 0, time.Local) },
		ResolvePaths: func(Options) (Paths, error) {
			return Paths{
				SystemdUnitPath: unitPath,
				CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
				DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
			}, nil
		},
		Runner: &callRunner{},
		RemoveHooks: func(path string) (bool, error) {
			return true, nil
		},
	})

	result, err := installer.CleanupRuntime(context.Background(), RuntimeCleanupOptions{GOOS: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("expected diagnostics log path")
	}
	body, readErr := os.ReadFile(result.DiagnosticsLog)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(body) == 0 {
		t.Fatal("expected non-empty diagnostics log")
	}
	if !strings.Contains(string(body), "cleanup_runtime") {
		t.Fatalf("unexpected diagnostics log:\n%s", string(body))
	}
}

type callRunnerMissingOutput struct {
	callRunner
}

type scriptedRunner struct {
	calls   []string
	results map[string]common.CommandResult
}

func (r *scriptedRunner) Run(ctx context.Context, name string, args ...string) common.CommandResult {
	call := name
	if len(args) > 0 {
		call += " " + strings.Join(args, " ")
	}
	r.calls = append(r.calls, call)
	for key, result := range r.results {
		if strings.Contains(call, key) {
			return result
		}
	}
	return common.CommandResult{ExitCode: 0, Output: "ok"}
}
