package windowsuser

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/collector/codexconfig"
	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
)

func TestInstallerInstallRunsCurrentUserFlow(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.Install(context.Background(), Options{
		OfficeURL:        "http://office.local",
		RegistrationCode: "reg_123",
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Workspace:        "workspace-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Status.Installed || !result.Status.Running || !result.Status.Connected || !result.Status.CodexReady {
		t.Fatalf("status = %#v", result.Status)
	}
	joined := strings.Join(deps.steps, "\n")
	for _, want := range []string{
		"legacy.cleanup",
		"task.stop",
		"config.ensure",
		"task.create",
		"task.start",
		"codex.ensure",
		"health.wait",
		"connection.check",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("steps missing %q:\n%s", want, joined)
		}
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("DiagnosticsLog is empty")
	}
	if deps.taskRunnerBinaryPath != deps.paths.RunnerBinaryPath {
		t.Fatalf("task runner binary path = %q, want %q", deps.taskRunnerBinaryPath, deps.paths.RunnerBinaryPath)
	}
}

func TestInstallerPrepareRunsUserLevelFlowWithoutStartup(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.Prepare(context.Background(), Options{
		OfficeURL:        "http://office.local",
		RegistrationCode: "reg_123",
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Workspace:        "workspace-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Status.Prepared || result.Status.StartupInstalled || result.Status.Running || result.Status.Connected {
		t.Fatalf("status = %#v", result.Status)
	}
	joined := strings.Join(deps.steps, "\n")
	for _, want := range []string{"config.ensure", "codex.ensure"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("steps missing %q:\n%s", want, joined)
		}
	}
	for _, forbidden := range []string{"legacy.cleanup", "task.stop", "task.create", "task.start", "health.wait", "connection.check"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("prepare should not run %q:\n%s", forbidden, joined)
		}
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("DiagnosticsLog is empty")
	}
	diagnostics, err := os.ReadFile(result.DiagnosticsLog)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"collector_token", "<redacted_token_field>"} {
		if strings.Contains(string(diagnostics), forbidden) {
			t.Fatalf("diagnostics should not receive token data %q:\n%s", forbidden, diagnostics)
		}
	}
}

func TestInstallerPrepareResetIdentityDescribesCredentialRotation(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	installer := NewInstaller(deps.ToDeps())
	result, err := installer.Prepare(context.Background(), Options{
		OfficeURL: "http://office.local", RegistrationCode: "reg_123", ResetIdentity: true,
		BinaryPath: deps.paths.BinaryPath, RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath: deps.paths.ConfigPath, CodexConfigPath: deps.paths.CodexConfigPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	diagnostics, err := os.ReadFile(result.DiagnosticsLog)
	if err != nil {
		t.Fatal(err)
	}
	log := string(diagnostics)
	if !strings.Contains(log, "this device will re-register and rotate collector credentials") {
		t.Fatalf("diagnostics missing credential rotation message:\n%s", log)
	}
	if strings.Contains(log, "register as a new collector") {
		t.Fatalf("diagnostics contains obsolete new collector message:\n%s", log)
	}
}

func TestInstallerInstallStartupRunsElevatedStartupFlowWithoutRegistration(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	cfg := collectorconfig.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_1",
		DeviceID:       "device_1",
		ListenAddr:     "127.0.0.1:1905",
		PrivacyMode:    "summary_only",
	}
	if err := collectorconfig.Save(deps.paths.ConfigPath, cfg); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Elevated:         true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Status.StartupInstalled || !result.Status.Running || !result.Status.Connected || !result.Status.StartupElevated {
		t.Fatalf("status = %#v", result.Status)
	}
	joined := strings.Join(deps.steps, "\n")
	for _, want := range []string{"legacy.cleanup", "task.stop", "task.delete", "task.create", "task.start", "health.wait", "connection.check"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("steps missing %q:\n%s", want, joined)
		}
	}
	if strings.Index(joined, "task.delete") > strings.Index(joined, "task.create") {
		t.Fatalf("task.delete should happen before task.create:\n%s", joined)
	}
	for _, forbidden := range []string{"config.ensure", "codex.ensure"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("install-startup should not run %q:\n%s", forbidden, joined)
		}
	}
}

func TestInstallerInstallStartupWritesFailedStepDiagnostics(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	deps.taskStopErr = testError("ERROR: Access is denied.")
	cfg := collectorconfig.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_1",
		DeviceID:       "device_1",
		ListenAddr:     "127.0.0.1:1905",
		PrivacyMode:    "summary_only",
	}
	if err := collectorconfig.Save(deps.paths.ConfigPath, cfg); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Elevated:         true,
	})
	if err == nil {
		t.Fatal("expected task stop error")
	}
	logBytes, readErr := os.ReadFile(result.DiagnosticsLog)
	if readErr != nil {
		t.Fatal(readErr)
	}
	log := string(logBytes)
	for _, want := range []string{"failed_step=task_stop", "startup_elevated=true", "Access is denied", "[task_stop]"} {
		if !strings.Contains(log, want) {
			t.Fatalf("diagnostics missing %q:\n%s", want, log)
		}
	}
	if result.Status.StartupErrorCode != "onlogon_task_access_denied" {
		t.Fatalf("StartupErrorCode = %q", result.Status.StartupErrorCode)
	}
}

func TestInstallerInstallStartupMapsChineseAccessDeniedToStartupErrorCode(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	deps.taskStopErr = testError("停止当前用户计划任务失败: 错误: 拒绝访问。")
	cfg := collectorconfig.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_1",
		DeviceID:       "device_1",
		ListenAddr:     "127.0.0.1:1905",
		PrivacyMode:    "summary_only",
	}
	if err := collectorconfig.Save(deps.paths.ConfigPath, cfg); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Elevated:         true,
	})
	if err == nil {
		t.Fatal("expected task stop error")
	}
	if result.Status.StartupErrorCode != "onlogon_task_access_denied" {
		t.Fatalf("StartupErrorCode = %q", result.Status.StartupErrorCode)
	}
	if result.Status.SuggestedAction == "" {
		t.Fatalf("SuggestedAction is empty: %#v", result.Status)
	}
}

func TestInstallerInstallStartupWritesFailedStepForMissingRunnerBinary(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	if err := os.Remove(deps.paths.RunnerBinaryPath); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Elevated:         true,
	})
	if err == nil {
		t.Fatal("expected runner binary missing error")
	}
	logBytes, readErr := os.ReadFile(result.DiagnosticsLog)
	if readErr != nil {
		t.Fatal(readErr)
	}
	log := string(logBytes)
	for _, want := range []string{"failed_step=runner_binary", "collector runner binary does not exist"} {
		if !strings.Contains(log, want) {
			t.Fatalf("diagnostics missing %q:\n%s", want, log)
		}
	}
}

func TestInstallerInstallStartupTaskErrorCanBeSetAfterDepsCreated(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	cfg := collectorconfig.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_1",
		DeviceID:       "device_1",
		ListenAddr:     "127.0.0.1:1905",
		PrivacyMode:    "summary_only",
	}
	if err := collectorconfig.Save(deps.paths.ConfigPath, cfg); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(deps.ToDeps())
	deps.taskStopErr = testError("late task stop failure")

	result, err := installer.InstallStartup(context.Background(), StartupOptions{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Elevated:         true,
	})
	if err == nil || !strings.Contains(err.Error(), "late task stop failure") {
		t.Fatalf("err = %v", err)
	}
	logBytes, readErr := os.ReadFile(result.DiagnosticsLog)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !strings.Contains(string(logBytes), "failed_step=task_stop") {
		t.Fatalf("diagnostics missing failed task stop:\n%s", string(logBytes))
	}
}

func TestWriteStartupFailureIgnoresNilInputs(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("writeStartupFailure panicked: %v", r)
		}
	}()

	writeStartupFailure(nil, "task_stop", testError("task failed"))
	writeStartupFailure(nil, "task_stop", nil)
}

func TestInstallerCleanupRuntimeRunsBeforeBinaryReplacementBoundary(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.CleanupRuntime(context.Background(), RuntimeCleanupOptions{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Elevated:         true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.TaskRemoved || !result.HooksRemoved {
		t.Fatalf("result = %#v", result)
	}
	joined := strings.Join(deps.steps, "\n")
	for _, want := range []string{"task.stop", "task.delete", "legacy.cleanup", "process.wait-release", "remove.hooks"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("steps missing %q:\n%s", want, joined)
		}
	}
	if !(strings.Index(joined, "task.delete") < strings.Index(joined, "legacy.cleanup") && strings.Index(joined, "legacy.cleanup") < strings.Index(joined, "process.wait-release")) {
		t.Fatalf("cleanup should stop task and legacy service before waiting for process release:\n%s", joined)
	}
	if strings.Index(joined, "process.wait-release") > strings.Index(joined, "remove.hooks") {
		t.Fatalf("cleanup should release runner before hook removal:\n%s", joined)
	}
	for _, forbidden := range []string{"config.ensure", "codex.ensure", "task.create", "task.start", "health.wait", "connection.check"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("cleanup-runtime should not run %q:\n%s", forbidden, joined)
		}
	}
}

func TestInstallerCleanupRuntimeStopsWhenRunnerReleaseFails(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	deps.processErr = testError("runner still holds binary")
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.CleanupRuntime(context.Background(), RuntimeCleanupOptions{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Elevated:         true,
	})
	if err == nil {
		t.Fatal("expected runner release error")
	}
	if !strings.Contains(err.Error(), "runner still holds binary") {
		t.Fatalf("err = %v", err)
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("DiagnosticsLog is empty")
	}
	joined := strings.Join(deps.steps, "\n")
	for _, want := range []string{"task.stop", "task.delete", "legacy.cleanup", "process.wait-release"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("steps missing %q:\n%s", want, joined)
		}
	}
	for _, forbidden := range []string{"remove.hooks"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("cleanup should stop before %q when runner release fails:\n%s", forbidden, joined)
		}
	}
}

func TestInstallerCleanupRuntimeStopsWhenLegacyServiceCleanupFails(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	deps.legacyErr = testError("Access is denied.")
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.CleanupRuntime(context.Background(), RuntimeCleanupOptions{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
		CodexConfigPath:  deps.paths.CodexConfigPath,
		Elevated:         true,
	})
	if err == nil {
		t.Fatal("expected cleanup error")
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("DiagnosticsLog is empty")
	}
	joined := strings.Join(deps.steps, "\n")
	if strings.Contains(joined, "remove.hooks") {
		t.Fatalf("cleanup should stop before hook rebuild/removal follow-up when legacy cleanup fails:\n%s", joined)
	}
}

func TestInstallerFailsWhenRunnerBinaryMissing(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	if err := os.Remove(deps.paths.RunnerBinaryPath); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.Install(context.Background(), Options{
		BinaryPath:       deps.paths.BinaryPath,
		RunnerBinaryPath: deps.paths.RunnerBinaryPath,
		ConfigPath:       deps.paths.ConfigPath,
	})
	if err == nil {
		t.Fatal("expected runner missing error")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "runner") {
		t.Fatalf("err = %v, want runner missing", err)
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("DiagnosticsLog is empty")
	}
	joined := strings.Join(deps.steps, "\n")
	if strings.Contains(joined, "task.create") {
		t.Fatalf("installer should stop before task.create:\n%s", joined)
	}
}

func TestInstallerStopsWhenLegacyServiceCleanupFails(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	deps.legacyErr = testError("Access is denied.")
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.Install(context.Background(), Options{BinaryPath: deps.paths.BinaryPath, ConfigPath: deps.paths.ConfigPath})
	if err == nil {
		t.Fatal("expected error")
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("DiagnosticsLog is empty")
	}
	joined := strings.Join(deps.steps, "\n")
	for _, want := range []string{"config.ensure", "codex.ensure", "legacy.cleanup"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("steps missing %q:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "task.create") {
		t.Fatalf("installer continued after legacy failure:\n%s", joined)
	}
}

func TestInstallerReturnsHealthFailureWithDiagnostics(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	deps.healthErr = testError("health failed")
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.Install(context.Background(), Options{BinaryPath: deps.paths.BinaryPath, ConfigPath: deps.paths.ConfigPath})
	if err == nil || !strings.Contains(err.Error(), "health failed") {
		t.Fatalf("err = %v", err)
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("DiagnosticsLog is empty")
	}
}

func TestInstallerReturnsHeartbeatFailureWithDiagnostics(t *testing.T) {
	deps := newFakeInstallerDeps(t)
	deps.connectionErr = testError("heartbeat failed")
	installer := NewInstaller(deps.ToDeps())

	result, err := installer.Install(context.Background(), Options{BinaryPath: deps.paths.BinaryPath, ConfigPath: deps.paths.ConfigPath})
	if err == nil || !strings.Contains(err.Error(), "heartbeat failed") {
		t.Fatalf("err = %v", err)
	}
	if result.DiagnosticsLog == "" {
		t.Fatal("DiagnosticsLog is empty")
	}
}

type installerFakeDeps struct {
	paths                Paths
	steps                []string
	legacyErr            error
	processErr           error
	configErr            error
	healthErr            error
	connectionErr        error
	taskStopErr          error
	taskDeleteErr        error
	taskCreateErr        error
	taskStartErr         error
	taskQueryErr         error
	taskRunnerBinaryPath string
}

func newFakeInstallerDeps(t *testing.T) *installerFakeDeps {
	t.Helper()
	home := t.TempDir()
	binaryPath := filepath.Join(home, ".clawee-collector", "bin", "clawee-collector.exe")
	runnerBinaryPath := filepath.Join(home, ".clawee-collector", "bin", "clawee-collector-runner.exe")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binaryPath, []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(runnerBinaryPath, []byte("fake-runner"), 0o755); err != nil {
		t.Fatal(err)
	}
	paths := Paths{
		InstallDir:       filepath.Join(home, ".clawee-collector"),
		BinDir:           filepath.Dir(binaryPath),
		BinaryPath:       binaryPath,
		RunnerBinaryPath: runnerBinaryPath,
		ConfigPath:       filepath.Join(home, ".clawee-collector", "config.json"),
		LogDir:           filepath.Join(home, ".clawee-collector", "logs"),
		DiagnosticsDir:   filepath.Join(home, ".clawee-collector", "diagnostics"),
		CodexConfigPath:  filepath.Join(home, ".codex", "config.toml"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.CodexConfigPath), 0o755); err != nil {
		t.Fatal(err)
	}
	return &installerFakeDeps{paths: paths}
}

func (d *installerFakeDeps) ToDeps() InstallerDeps {
	return InstallerDeps{
		ResolvePaths: func(Options) (Paths, error) {
			return d.paths, nil
		},
		Legacy: legacyCleanerFunc(func(context.Context) (LegacyServiceStatus, error) {
			d.steps = append(d.steps, "legacy.cleanup")
			if d.legacyErr != nil {
				return LegacyServiceStatus{Exists: true, Error: d.legacyErr.Error()}, d.legacyErr
			}
			return LegacyServiceStatus{}, nil
		}),
		Process: processReleaserFunc(func(context.Context, string, string) error {
			d.steps = append(d.steps, "process.wait-release")
			return d.processErr
		}),
		Task: &fakeTaskController{deps: d},
		Config: configEnsurerFunc(func(context.Context, Options, Paths) (collectorconfig.Config, ConfigAction, error) {
			d.steps = append(d.steps, "config.ensure")
			if d.configErr != nil {
				return collectorconfig.Config{}, "", d.configErr
			}
			cfg := collectorconfig.Config{
				OfficeURL:      "http://office.local",
				CollectorToken: "collector_token",
				CollectorID:    "collector_1",
				DeviceID:       "device_1",
				ListenAddr:     "127.0.0.1:1905",
				PrivacyMode:    "summary_only",
				RequestLogDir:  d.paths.LogDir,
			}
			if err := collectorconfig.Save(d.paths.ConfigPath, cfg); err != nil {
				return collectorconfig.Config{}, "", err
			}
			return cfg, ConfigRegistered, nil
		}),
		Hook: hookEnsurerFunc(func(codexconfig.EnsureOptions) (codexconfig.EnsureResult, error) {
			d.steps = append(d.steps, "codex.ensure")
			return codexconfig.EnsureResult{Changed: true}, nil
		}),
		Health: healthWaiterFunc(func(string) error {
			d.steps = append(d.steps, "health.wait")
			return d.healthErr
		}),
		Connection: connectionWaiterFunc(func(collectorconfig.Config) error {
			d.steps = append(d.steps, "connection.check")
			return d.connectionErr
		}),
		RemoveHooks: func(string) (bool, error) {
			d.steps = append(d.steps, "remove.hooks")
			return true, nil
		},
	}
}

type fakeTaskController struct {
	deps *installerFakeDeps
}

func (t *fakeTaskController) Stop(context.Context) error {
	t.deps.steps = append(t.deps.steps, "task.stop")
	return t.deps.taskStopErr
}

func (t *fakeTaskController) Delete(context.Context) error {
	t.deps.steps = append(t.deps.steps, "task.delete")
	return t.deps.taskDeleteErr
}

func (t *fakeTaskController) CreateOrUpdate(_ context.Context, runnerBinaryPath string, _ string, _ string) error {
	t.deps.steps = append(t.deps.steps, "task.create")
	t.deps.taskRunnerBinaryPath = runnerBinaryPath
	return t.deps.taskCreateErr
}

func (t *fakeTaskController) Start(context.Context) error {
	t.deps.steps = append(t.deps.steps, "task.start")
	return t.deps.taskStartErr
}

func (t *fakeTaskController) Query(context.Context) (TaskStatus, error) {
	t.deps.steps = append(t.deps.steps, "task.query")
	if t.deps.taskQueryErr != nil {
		return TaskStatus{}, t.deps.taskQueryErr
	}
	return TaskStatus{Exists: true, Running: true, UsesRunner: true, Output: "clawee-collector-runner.exe"}, nil
}

type testError string

func (e testError) Error() string { return string(e) }
