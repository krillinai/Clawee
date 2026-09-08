package windowsuser

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/codexconfig"
	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/version"
)

type MaintenanceDeps struct {
	Runner       CommandRunner
	Now          func() time.Time
	ResolvePaths func(Options) (Paths, error)
	Task         MaintenanceTask
	Legacy       LegacyQuerier
	Health       HealthWaiter
	Connection   ConnectionWaiter
	RemoveHooks  func(string) (bool, error)
}

type MaintenanceTask interface {
	Stop(context.Context) error
	Delete(context.Context) error
	Query(context.Context) (TaskStatus, error)
}

type LegacyQuerier interface {
	Query(context.Context) (LegacyServiceStatus, error)
}

type legacyQuerierFunc func(context.Context) (LegacyServiceStatus, error)

func (fn legacyQuerierFunc) Query(ctx context.Context) (LegacyServiceStatus, error) {
	return fn(ctx)
}

type UninstallOptions struct {
	ConfigPath      string
	CodexConfigPath string
	Purge           bool
	Backup          bool
}

type UninstallResult struct {
	DiagnosticsLog string
	HooksRemoved   bool
	TaskRemoved    bool
	Purged         bool
	BackupPath     string
}

type Uninstaller struct {
	deps MaintenanceDeps
}

func NewUninstaller(deps MaintenanceDeps) *Uninstaller {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	return &Uninstaller{deps: deps}
}

func (u *Uninstaller) Uninstall(ctx context.Context, options UninstallOptions) (UninstallResult, error) {
	prepareResult, err := u.Prepare(ctx, options)
	if err != nil {
		return prepareResult, err
	}
	startupResult, err := u.UninstallStartup(ctx, options)
	startupResult.HooksRemoved = prepareResult.HooksRemoved
	if startupResult.DiagnosticsLog == "" {
		startupResult.DiagnosticsLog = prepareResult.DiagnosticsLog
	}
	return startupResult, err
}

func (u *Uninstaller) Prepare(ctx context.Context, options UninstallOptions) (UninstallResult, error) {
	paths, err := u.resolvePaths(Options{ConfigPath: options.ConfigPath, CodexConfigPath: options.CodexConfigPath})
	if err != nil {
		return UninstallResult{}, err
	}
	diag, err := NewDiagnosticsWriter(paths.DiagnosticsDir, u.deps.Now)
	if err != nil {
		return UninstallResult{}, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = diag.Close()
		}
	}()
	removeHooks := u.deps.RemoveHooks
	if removeHooks == nil {
		removeHooks = codexconfig.RemoveHooks
	}
	hooksRemoved, err := removeHooks(paths.CodexConfigPath)
	if err != nil {
		diag.Step("Codex hook 删除", err.Error())
		return UninstallResult{DiagnosticsLog: diag.Path()}, err
	}
	result := UninstallResult{DiagnosticsLog: diag.Path(), HooksRemoved: hooksRemoved}
	diag.Step("卸载", fmt.Sprintf("hooks_removed=%v", hooksRemoved))
	return result, nil
}

func (u *Uninstaller) UninstallStartup(ctx context.Context, options UninstallOptions) (UninstallResult, error) {
	paths, err := u.resolvePaths(Options{ConfigPath: options.ConfigPath, CodexConfigPath: options.CodexConfigPath})
	if err != nil {
		return UninstallResult{}, err
	}
	diag, err := NewDiagnosticsWriter(paths.DiagnosticsDir, u.deps.Now)
	if err != nil {
		return UninstallResult{}, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = diag.Close()
		}
	}()
	task := u.task()
	if err := task.Stop(ctx); err != nil {
		diag.Step("卸载", err.Error())
		return UninstallResult{DiagnosticsLog: diag.Path()}, err
	}
	if err := task.Delete(ctx); err != nil {
		diag.Step("卸载", err.Error())
		return UninstallResult{DiagnosticsLog: diag.Path()}, err
	}
	result := UninstallResult{DiagnosticsLog: diag.Path(), TaskRemoved: true}
	diag.Step("卸载", fmt.Sprintf("task_removed=true purge=%v backup=%v", options.Purge, options.Backup))
	if options.Purge {
		if options.Backup {
			backupPath := paths.InstallDir + ".backup-" + u.deps.Now().Format("20060102-150405")
			if err := copyDir(paths.InstallDir, backupPath); err != nil {
				diag.Step("备份", err.Error())
				return result, err
			}
			result.BackupPath = backupPath
		}
		if err := diag.Close(); err != nil {
			return result, err
		}
		closed = true
		if err := os.RemoveAll(paths.InstallDir); err != nil {
			return result, err
		}
		result.Purged = true
	}
	return result, nil
}

func (u *Uninstaller) resolvePaths(options Options) (Paths, error) {
	resolvePaths := u.deps.ResolvePaths
	if resolvePaths == nil {
		resolvePaths = ResolvePaths
	}
	return resolvePaths(options)
}

func (u *Uninstaller) task() MaintenanceTask {
	if u.deps.Task != nil {
		return u.deps.Task
	}
	return NewTaskManager(u.deps.Runner)
}

type DiagnoseOptions struct {
	ConfigPath      string
	CodexConfigPath string
	JSON            bool
}

type DiagnoseResult struct {
	Status StatusSummary
	Text   string
	JSON   string
}

type Diagnoser struct {
	deps MaintenanceDeps
}

func NewDiagnoser(deps MaintenanceDeps) *Diagnoser {
	return &Diagnoser{deps: deps}
}

func (d *Diagnoser) Diagnose(ctx context.Context, options DiagnoseOptions) (DiagnoseResult, error) {
	paths, err := d.resolvePaths(Options{ConfigPath: options.ConfigPath, CodexConfigPath: options.CodexConfigPath})
	if err != nil {
		return DiagnoseResult{}, err
	}
	taskStatus, taskErr := d.task().Query(ctx)
	legacyStatus := LegacyServiceStatus{}
	if legacy := d.legacy(); legacy != nil {
		legacyStatus, _ = legacy.Query(ctx)
	}
	cfg, cfgErr := collectorconfig.Load(paths.ConfigPath)
	healthOK := false
	healthErr := ""
	connected := false
	connectionErr := ""
	if cfgErr == nil {
		if err := d.health().Wait(cfg.ListenAddr); err != nil {
			healthErr = err.Error()
		} else {
			healthOK = true
		}
		if err := d.connection().Check(cfg); err != nil {
			connectionErr = err.Error()
		} else {
			connected = true
		}
	}
	codexReady := hookBlockExists(paths.CodexConfigPath)
	runnerExists := fileExists(paths.RunnerBinaryPath)
	taskUsesRunner := taskStatus.UsesRunner || strings.Contains(strings.ToLower(taskStatus.Output), "clawee-collector-runner.exe")
	prepared := (fileExists(paths.BinaryPath) || runnerExists) && fileExists(paths.ConfigPath) && codexReady
	startupInstalled := taskStatus.Exists && taskUsesRunner
	status := StatusSummary{
		Installed:        prepared && startupInstalled,
		Prepared:         prepared,
		StartupInstalled: startupInstalled,
		StartupElevated:  false,
		Running:          taskStatus.Running && healthOK,
		Connected:        connected,
		TaskUsesRunner:   taskUsesRunner,
		CodexReady:       codexReady,
		LegacyService:    legacyStatus,
	}
	payload := map[string]any{
		"mode":               "diagnose",
		"collector_version":  version.CollectorVersion(),
		"binary_path":        paths.BinaryPath,
		"runner_path":        paths.RunnerBinaryPath,
		"runner_exists":      runnerExists,
		"config_path":        paths.ConfigPath,
		"installed":          status.Installed,
		"prepared":           status.Prepared,
		"startup_installed":  status.StartupInstalled,
		"startup_elevated":   status.StartupElevated,
		"startup_error_code": status.StartupErrorCode,
		"suggested_action":   status.SuggestedAction,
		"running":            status.Running,
		"connected":          status.Connected,
		"codex_ready":        status.CodexReady,
		"task_uses_runner":   taskUsesRunner,
		"task":               taskStatus,
		"legacy_service":     legacyStatus,
		"stdout_log":         filepath.Join(paths.LogDir, "collector-stdout.log"),
		"stderr_log":         filepath.Join(paths.LogDir, "collector-stderr.log"),
		"config":             configSummary(cfg, cfgErr),
		"config_error":       safeErr(cfgErr),
		"task_error":         safeErr(taskErr),
		"health_ok":          healthOK,
		"health_error":       RedactSensitive(healthErr),
		"heartbeat_ok":       connected,
		"heartbeat_error":    RedactSensitive(connectionErr),
	}
	jsonBytes, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return DiagnoseResult{}, err
	}
	text := buildDiagnoseText(paths, status, taskStatus, legacyStatus, cfg, cfgErr, healthOK, healthErr, connected, connectionErr, codexReady, runnerExists, taskUsesRunner)
	return DiagnoseResult{Status: status, Text: RedactSensitive(text), JSON: RedactSensitive(string(jsonBytes))}, nil
}

func (d *Diagnoser) resolvePaths(options Options) (Paths, error) {
	resolvePaths := d.deps.ResolvePaths
	if resolvePaths == nil {
		resolvePaths = ResolvePaths
	}
	return resolvePaths(options)
}

func (d *Diagnoser) task() MaintenanceTask {
	if d.deps.Task != nil {
		return d.deps.Task
	}
	return NewTaskManager(d.deps.Runner)
}

func (d *Diagnoser) legacy() LegacyQuerier {
	if d.deps.Legacy != nil {
		return d.deps.Legacy
	}
	return NewLegacyServiceManager(d.deps.Runner)
}

func (d *Diagnoser) health() HealthWaiter {
	if d.deps.Health != nil {
		return d.deps.Health
	}
	return HealthChecker{Timeout: time.Second}
}

func (d *Diagnoser) connection() ConnectionWaiter {
	if d.deps.Connection != nil {
		return d.deps.Connection
	}
	return connectionWaiterFunc(func(cfg collectorconfig.Config) error {
		return NewConnectionChecker(cfg).Check(cfg)
	})
}

func configSummary(cfg collectorconfig.Config, err error) map[string]string {
	if err != nil {
		return nil
	}
	return map[string]string{
		"office_url":   cfg.OfficeURL,
		"collector_id": cfg.CollectorID,
		"device_id":    cfg.DeviceID,
		"listen_addr":  cfg.ListenAddr,
		"privacy_mode": cfg.PrivacyMode,
	}
}

func safeErr(err error) string {
	if err == nil {
		return ""
	}
	return RedactSensitive(err.Error())
}

func buildDiagnoseText(paths Paths, status StatusSummary, task TaskStatus, legacy LegacyServiceStatus, cfg collectorconfig.Config, cfgErr error, healthOK bool, healthErr string, connected bool, connectionErr string, codexReady bool, runnerExists bool, taskUsesRunner bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "操作模式: diagnose\n")
	fmt.Fprintf(&b, "collector_version: %s\n", version.CollectorVersion())
	fmt.Fprintf(&b, "二进制路径: %s\n", paths.BinaryPath)
	fmt.Fprintf(&b, "runner_path: %s\n", paths.RunnerBinaryPath)
	fmt.Fprintf(&b, "runner_exists: %v\n", runnerExists)
	fmt.Fprintf(&b, "配置路径: %s\n", paths.ConfigPath)
	fmt.Fprintf(&b, "计划任务: exists=%v running=%v task_uses_runner=%v\n", task.Exists, task.Running, taskUsesRunner)
	fmt.Fprintf(&b, "stdout_log: %s\n", filepath.Join(paths.LogDir, "collector-stdout.log"))
	fmt.Fprintf(&b, "stderr_log: %s\n", filepath.Join(paths.LogDir, "collector-stderr.log"))
	if cfgErr != nil {
		fmt.Fprintf(&b, "配置摘要: error=%s\n", cfgErr)
	} else {
		fmt.Fprintf(&b, "配置摘要: office_url=%s collector_id=%s device_id=%s listen_addr=%s privacy_mode=%s\n", cfg.OfficeURL, cfg.CollectorID, cfg.DeviceID, cfg.ListenAddr, cfg.PrivacyMode)
	}
	fmt.Fprintf(&b, "health_ok: %v error=%s\n", healthOK, healthErr)
	fmt.Fprintf(&b, "heartbeat_ok: %v error=%s\n", connected, connectionErr)
	fmt.Fprintf(&b, "codex_ready: %v\n", codexReady)
	fmt.Fprintf(&b, "旧 Windows Service: exists=%v cleaned=%v error=%s\n", legacy.Exists, legacy.Cleaned, legacy.Error)
	fmt.Fprintf(&b, "状态: installed=%v running=%v connected=%v codex_ready=%v\n", status.Installed, status.Running, status.Connected, status.CodexReady)
	return b.String()
}

func hookBlockExists(path string) bool {
	body, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.Contains(string(body), "# BEGIN clawee-collector codex hooks")
}

func copyDir(src string, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("备份源不是目录: %s", src)
	}
	return filepath.WalkDir(src, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, body, info.Mode().Perm())
	})
}
