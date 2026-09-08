package windowsuser

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/collector/codexconfig"
	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/version"
)

func TestUninstallerPrepareRemovesManagedHookWithoutTouchingTask(t *testing.T) {
	deps := newFakeUninstallDeps(t)
	if err := os.WriteFile(deps.paths.CodexConfigPath, []byte(`[features]
hooks = true

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "echo user"

# BEGIN clawee-collector codex hooks
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "clawee"
# END clawee-collector codex hooks
`), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := NewUninstaller(deps.ToDeps()).Prepare(context.Background(), UninstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.HooksRemoved {
		t.Fatalf("result = %#v", result)
	}
	joined := strings.Join(deps.steps, "\n")
	for _, forbidden := range []string{"task.stop", "task.delete"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("uninstall prepare should not run %q:\n%s", forbidden, joined)
		}
	}
	body, err := os.ReadFile(deps.paths.CodexConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "clawee") {
		t.Fatalf("managed hook remained:\n%s", string(body))
	}
	if !strings.Contains(string(body), `command = "echo user"`) {
		t.Fatalf("user hook removed:\n%s", string(body))
	}
}

func TestUninstallerStartupDeletesTask(t *testing.T) {
	deps := newFakeUninstallDeps(t)

	result, err := NewUninstaller(deps.ToDeps()).UninstallStartup(context.Background(), UninstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.TaskRemoved {
		t.Fatalf("result = %#v", result)
	}
	joined := strings.Join(deps.steps, "\n")
	for _, want := range []string{"task.stop", "task.delete"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("steps missing %q:\n%s", want, joined)
		}
	}
}

func TestUninstallerRunsPrepareBeforeStartup(t *testing.T) {
	deps := newFakeUninstallDeps(t)

	if _, err := NewUninstaller(deps.ToDeps()).Uninstall(context.Background(), UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(deps.steps, "\n")
	for _, want := range []string{"task.stop", "task.delete"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("steps missing %q:\n%s", want, joined)
		}
	}
	if strings.Index(joined, "remove.hooks") > strings.Index(joined, "task.stop") {
		t.Fatalf("uninstall should prepare before startup cleanup:\n%s", joined)
	}
}

func TestUninstallerKeepsInstallDirByDefault(t *testing.T) {
	deps := newFakeUninstallDeps(t)

	if _, err := NewUninstaller(deps.ToDeps()).Uninstall(context.Background(), UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deps.paths.InstallDir); err != nil {
		t.Fatalf("install dir should remain: %v", err)
	}
}

func TestUninstallerPurgeRemovesInstallDir(t *testing.T) {
	deps := newFakeUninstallDeps(t)

	result, err := NewUninstaller(deps.ToDeps()).Uninstall(context.Background(), UninstallOptions{Purge: true})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Purged {
		t.Fatalf("result = %#v", result)
	}
	if _, err := os.Stat(deps.paths.InstallDir); !os.IsNotExist(err) {
		t.Fatalf("install dir stat err = %v, want not exist", err)
	}
}

func TestUninstallerPurgeBackupCopiesInstallDirFirst(t *testing.T) {
	deps := newFakeUninstallDeps(t)
	if err := os.WriteFile(filepath.Join(deps.paths.InstallDir, "config.json"), []byte("config"), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := NewUninstaller(deps.ToDeps()).Uninstall(context.Background(), UninstallOptions{Purge: true, Backup: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.BackupPath == "" {
		t.Fatalf("result = %#v", result)
	}
	if _, err := os.Stat(filepath.Join(result.BackupPath, "config.json")); err != nil {
		t.Fatalf("backup missing config: %v", err)
	}
}

func TestDiagnoserRedactsTokenFromTextAndJSON(t *testing.T) {
	deps := newFakeUninstallDeps(t)
	if err := collectorconfig.Save(deps.paths.ConfigPath, collectorconfig.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "secret_token",
		CollectorID:    "collector_1",
		DeviceID:       "device_1",
		ListenAddr:     "127.0.0.1:1905",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(deps.paths.CodexConfigPath, []byte("# BEGIN clawee-collector codex hooks\n# END clawee-collector codex hooks\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deps.taskStatus = TaskStatus{Exists: true, Running: true}
	deps.legacyStatus = LegacyServiceStatus{Exists: true}

	result, err := NewDiagnoser(deps.ToDeps()).Diagnose(context.Background(), DiagnoseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status.Installed != true || result.Status.Running != true {
		t.Fatalf("status = %#v", result.Status)
	}
	if result.Status.TaskUsesRunner != true {
		t.Fatalf("status task_uses_runner = %#v", result.Status.TaskUsesRunner)
	}
	text := result.Text
	jsonBody := result.JSON
	for _, forbidden := range []string{"secret_token", "collector_token", "CollectorToken", "collectorToken"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("text leaked %q:\n%s", forbidden, text)
		}
		if strings.Contains(jsonBody, forbidden) {
			t.Fatalf("json leaked %q:\n%s", forbidden, jsonBody)
		}
	}
	for _, want := range []string{"操作模式", "配置路径", "running", "health_ok", "heartbeat_ok", "runner_path", "runner_exists", "task_uses_runner", "stdout_log", "stderr_log", "collector_1", "device_1", "旧 Windows Service"} {
		if !strings.Contains(text, want) {
			t.Fatalf("diagnose text missing %q:\n%s", want, text)
		}
	}
	if !strings.Contains(text, "collector_version") {
		t.Fatalf("diagnose text missing collector_version:\n%s", text)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(jsonBody), &decoded); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, jsonBody)
	}
	if decoded["installed"] != true || decoded["running"] != true {
		t.Fatalf("decoded = %#v", decoded)
	}
	if decoded["runner_exists"] != true {
		t.Fatalf("decoded runner_exists = %#v", decoded["runner_exists"])
	}
	if decoded["task_uses_runner"] != true {
		t.Fatalf("decoded task_uses_runner = %#v", decoded["task_uses_runner"])
	}
	if decoded["health_ok"] != true {
		t.Fatalf("health_ok = %#v", decoded["health_ok"])
	}
	if decoded["heartbeat_ok"] != true {
		t.Fatalf("heartbeat_ok = %#v", decoded["heartbeat_ok"])
	}
	if decoded["collector_version"] != version.CollectorVersion() {
		t.Fatalf("collector_version = %#v, want %q", decoded["collector_version"], version.CollectorVersion())
	}
	for _, key := range []string{"prepared", "startup_installed", "startup_elevated", "startup_error_code", "suggested_action"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("diagnose json missing %q: %#v", key, decoded)
		}
	}
}

func TestDiagnoserRedactsTokenFieldNameFromConfigErrors(t *testing.T) {
	deps := newFakeUninstallDeps(t)
	if err := os.WriteFile(deps.paths.ConfigPath, []byte(`{
		"office_url": "http://office.local",
		"collector_id": "collector_1",
		"device_id": "device_1",
		"privacy_mode": "summary_only"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := NewDiagnoser(deps.ToDeps()).Diagnose(context.Background(), DiagnoseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"collector_token", "CollectorToken", "collectorToken"} {
		if strings.Contains(result.Text, forbidden) {
			t.Fatalf("text leaked %q:\n%s", forbidden, result.Text)
		}
		if strings.Contains(result.JSON, forbidden) {
			t.Fatalf("json leaked %q:\n%s", forbidden, result.JSON)
		}
	}
}

type fakeUninstallDeps struct {
	paths        Paths
	steps        []string
	taskStatus   TaskStatus
	legacyStatus LegacyServiceStatus
}

func newFakeUninstallDeps(t *testing.T) *fakeUninstallDeps {
	t.Helper()
	home := t.TempDir()
	installDir := filepath.Join(home, ".clawee-collector")
	paths := Paths{
		InstallDir:       installDir,
		BinDir:           filepath.Join(installDir, "bin"),
		BinaryPath:       filepath.Join(installDir, "bin", "clawee-collector.exe"),
		RunnerBinaryPath: filepath.Join(installDir, "bin", "clawee-collector-runner.exe"),
		ConfigPath:       filepath.Join(installDir, "config.json"),
		LogDir:           filepath.Join(installDir, "logs"),
		DiagnosticsDir:   filepath.Join(installDir, "diagnostics"),
		CodexConfigPath:  filepath.Join(home, ".codex", "config.toml"),
	}
	if err := os.MkdirAll(paths.BinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(paths.CodexConfigPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.BinaryPath, []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.RunnerBinaryPath, []byte("fake-runner"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &fakeUninstallDeps{paths: paths}
}

func (d *fakeUninstallDeps) ToDeps() MaintenanceDeps {
	taskStatus := d.taskStatus
	if taskStatus.Exists && taskStatus.Output == "" {
		taskStatus.Output = d.paths.RunnerBinaryPath
	}
	return MaintenanceDeps{
		ResolvePaths: func(Options) (Paths, error) { return d.paths, nil },
		Task: &fakeMaintenanceTask{
			steps:  &d.steps,
			status: taskStatus,
		},
		Legacy: legacyQuerierFunc(func(context.Context) (LegacyServiceStatus, error) {
			return d.legacyStatus, nil
		}),
		Health: healthWaiterFunc(func(string) error { return nil }),
		Connection: connectionWaiterFunc(func(collectorconfig.Config) error {
			return nil
		}),
		RemoveHooks: func(string) (bool, error) {
			d.steps = append(d.steps, "remove.hooks")
			return codexconfig.RemoveHooks(d.paths.CodexConfigPath)
		},
	}
}

type fakeMaintenanceTask struct {
	steps  *[]string
	status TaskStatus
}

func (t *fakeMaintenanceTask) Stop(context.Context) error {
	*t.steps = append(*t.steps, "task.stop")
	return nil
}

func (t *fakeMaintenanceTask) Delete(context.Context) error {
	*t.steps = append(*t.steps, "task.delete")
	return nil
}

func (t *fakeMaintenanceTask) Query(context.Context) (TaskStatus, error) {
	*t.steps = append(*t.steps, "task.query")
	return t.status, nil
}
