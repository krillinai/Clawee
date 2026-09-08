package unixuser

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"

	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

func TestInstallRunsStagesInOrder(t *testing.T) {
	stages := &fakeInstallStages{
		trace: InstallTrace{BinaryExists: true, ConfigExists: true},
	}
	installer := NewInstaller(InstallerDeps{
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				BinaryPath:     "/tmp/clawee-collector",
				ConfigPath:     "/tmp/config.json",
				DiagnosticsDir: "/tmp/diag",
			}, nil
		},
	})
	installer.stages = stages

	_, err := installer.Install(context.Background(), Options{GOOS: "linux"})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"preflight", "cleanup-runtime", "prepare", "install-startup", "diagnose"}
	if !reflect.DeepEqual(stages.steps, want) {
		t.Fatalf("steps = %#v, want %#v", stages.steps, want)
	}
}

func TestInstallStopsWhenCleanupRuntimeFails(t *testing.T) {
	errBoom := errors.New("cleanup failed")
	stages := &fakeInstallStages{
		trace:      InstallTrace{BinaryExists: true, ConfigExists: true},
		cleanupErr: errBoom,
	}
	installer := NewInstaller(InstallerDeps{
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				BinaryPath:     "/tmp/clawee-collector",
				ConfigPath:     "/tmp/config.json",
				DiagnosticsDir: "/tmp/diag",
			}, nil
		},
	})
	installer.stages = stages

	_, err := installer.Install(context.Background(), Options{GOOS: "linux"})
	if !errors.Is(err, errBoom) {
		t.Fatalf("err = %v, want %v", err, errBoom)
	}
	if slices.Contains(stages.steps, "prepare") || slices.Contains(stages.steps, "install-startup") {
		t.Fatalf("install continued after cleanup failure: %#v", stages.steps)
	}
}

func TestInstallStopsWhenExistingTraceNeedsBinary(t *testing.T) {
	stages := &fakeInstallStages{
		trace: InstallTrace{ConfigExists: true, BinaryExists: false},
	}
	installer := NewInstaller(InstallerDeps{
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				BinaryPath:     "/tmp/clawee-collector",
				ConfigPath:     "/tmp/config.json",
				DiagnosticsDir: "/tmp/diag",
			}, nil
		},
	})
	installer.stages = stages

	_, err := installer.Install(context.Background(), Options{GOOS: "linux"})
	if err == nil {
		t.Fatal("expected missing binary error")
	}
	if slices.Contains(stages.steps, "cleanup-runtime") || slices.Contains(stages.steps, "prepare") || slices.Contains(stages.steps, "install-startup") {
		t.Fatalf("install continued after missing binary: %#v", stages.steps)
	}
}

type fakeInstallStages struct {
	steps      []string
	trace      InstallTrace
	cleanupErr error
}

func (s *fakeInstallStages) DetectExistingInstall(ctx context.Context, paths Paths, platform Platform, runner common.CommandRunner) (InstallTrace, error) {
	s.steps = append(s.steps, "preflight")
	return s.trace, nil
}

func (s *fakeInstallStages) CleanupRuntime(ctx context.Context, options RuntimeCleanupOptions) (RuntimeCleanupResult, error) {
	s.steps = append(s.steps, "cleanup-runtime")
	return RuntimeCleanupResult{StartupRemoved: true, HooksRemoved: true}, s.cleanupErr
}

func (s *fakeInstallStages) Prepare(ctx context.Context, options Options) (Result, error) {
	s.steps = append(s.steps, "prepare")
	return Result{Status: StatusSummary{Prepared: true, CodexReady: true}}, nil
}

func (s *fakeInstallStages) InstallStartup(ctx context.Context, options StartupOptions) (Result, error) {
	s.steps = append(s.steps, "install-startup")
	return Result{Status: StatusSummary{StartupInstalled: true, Running: true, HealthOK: true, HeartbeatOK: true}}, nil
}

func (s *fakeInstallStages) Diagnose(ctx context.Context, options DiagnoseOptions) (DiagnoseResult, error) {
	s.steps = append(s.steps, "diagnose")
	return DiagnoseResult{Status: StatusSummary{Running: true, HealthOK: true, HeartbeatOK: true}}, nil
}
