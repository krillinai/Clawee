package windowsuser

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/codexconfig"
	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
)

type InstallerDeps struct {
	Runner       CommandRunner
	Now          func() time.Time
	ResolvePaths func(Options) (Paths, error)
	Registrar    Registrar
	Legacy       LegacyCleaner
	Task         TaskController
	Process      ProcessReleaser
	Config       ConfigEnsurer
	Hook         HookEnsurer
	Health       HealthWaiter
	Connection   ConnectionWaiter
	RemoveHooks  func(string) (bool, error)
}

type Installer struct {
	deps InstallerDeps
}

type StartupOptions struct {
	BinaryPath       string
	RunnerBinaryPath string
	ConfigPath       string
	CodexConfigPath  string
	Elevated         bool
}

func NewInstaller(deps InstallerDeps) *Installer {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	return &Installer{deps: deps}
}

type LegacyCleaner interface {
	Cleanup(context.Context) (LegacyServiceStatus, error)
}

type TaskController interface {
	Stop(context.Context) error
	Delete(context.Context) error
	CreateOrUpdate(context.Context, string, string, string) error
	Start(context.Context) error
	Query(context.Context) (TaskStatus, error)
}

type ProcessReleaser interface {
	WaitReleased(context.Context, string, string) error
}

type ConfigEnsurer interface {
	Ensure(context.Context, Options, Paths) (collectorconfig.Config, ConfigAction, error)
}

type HookEnsurer interface {
	Ensure(codexconfig.EnsureOptions) (codexconfig.EnsureResult, error)
}

type HealthWaiter interface {
	Wait(string) error
}

type ConnectionWaiter interface {
	Check(collectorconfig.Config) error
}

type configEnsurerFunc func(context.Context, Options, Paths) (collectorconfig.Config, ConfigAction, error)

func (fn configEnsurerFunc) Ensure(ctx context.Context, options Options, paths Paths) (collectorconfig.Config, ConfigAction, error) {
	return fn(ctx, options, paths)
}

type hookEnsurerFunc func(codexconfig.EnsureOptions) (codexconfig.EnsureResult, error)

func (fn hookEnsurerFunc) Ensure(options codexconfig.EnsureOptions) (codexconfig.EnsureResult, error) {
	return fn(options)
}

type healthWaiterFunc func(string) error

func (fn healthWaiterFunc) Wait(listenAddr string) error {
	return fn(listenAddr)
}

type connectionWaiterFunc func(collectorconfig.Config) error

func (fn connectionWaiterFunc) Check(cfg collectorconfig.Config) error {
	return fn(cfg)
}

type legacyCleanerFunc func(context.Context) (LegacyServiceStatus, error)

func (fn legacyCleanerFunc) Cleanup(ctx context.Context) (LegacyServiceStatus, error) {
	return fn(ctx)
}

type processReleaserFunc func(context.Context, string, string) error

func (fn processReleaserFunc) WaitReleased(ctx context.Context, binaryPath string, runnerBinaryPath string) error {
	return fn(ctx, binaryPath, runnerBinaryPath)
}

func (i *Installer) Install(ctx context.Context, options Options) (Result, error) {
	prepareResult, err := i.Prepare(ctx, options)
	if err != nil {
		return prepareResult, err
	}
	startupResult, err := i.InstallStartup(ctx, StartupOptions{
		BinaryPath:       options.BinaryPath,
		RunnerBinaryPath: options.RunnerBinaryPath,
		ConfigPath:       options.ConfigPath,
		CodexConfigPath:  options.CodexConfigPath,
	})
	if err != nil {
		if startupResult.DiagnosticsLog != "" {
			prepareResult.DiagnosticsLog = startupResult.DiagnosticsLog
		}
		prepareResult.Status.StartupElevated = startupResult.Status.StartupElevated
		prepareResult.Status.StartupErrorCode = startupResult.Status.StartupErrorCode
		prepareResult.Status.SuggestedAction = startupResult.Status.SuggestedAction
		prepareResult.Status.LegacyService = startupResult.Status.LegacyService
		return prepareResult, err
	}
	startupResult.Status.Prepared = prepareResult.Status.Prepared
	startupResult.Status.CodexReady = prepareResult.Status.CodexReady
	startupResult.Status.Installed = startupResult.Status.Prepared && startupResult.Status.StartupInstalled && startupResult.Status.Running
	return startupResult, nil
}

func (i *Installer) Prepare(ctx context.Context, options Options) (Result, error) {
	paths, err := i.resolvePaths(options)
	if err != nil {
		return Result{}, err
	}
	diag, err := NewDiagnosticsWriter(paths.DiagnosticsDir, i.deps.Now)
	if err != nil {
		return Result{}, err
	}
	defer diag.Close()
	diag.Step("paths", fmt.Sprintf("binary=%s runner=%s config=%s codex_config=%s", paths.BinaryPath, paths.RunnerBinaryPath, paths.ConfigPath, paths.CodexConfigPath))
	if options.ResetIdentity {
		diag.Step("reset_identity", "this device will re-register and rotate collector credentials")
	}

	if err := os.MkdirAll(paths.BinDir, 0o755); err != nil {
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	if err := os.MkdirAll(paths.LogDir, 0o755); err != nil {
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	if _, err := os.Stat(paths.BinaryPath); err != nil {
		return Result{DiagnosticsLog: diag.Path()}, fmt.Errorf("collector binary does not exist: %s", paths.BinaryPath)
	}
	if _, err := os.Stat(paths.RunnerBinaryPath); err != nil {
		return Result{DiagnosticsLog: diag.Path()}, fmt.Errorf("collector runner binary does not exist: %s", paths.RunnerBinaryPath)
	}

	configEnsurer := i.deps.Config
	if configEnsurer == nil {
		configEnsurer = configEnsurerFunc(func(ctx context.Context, options Options, paths Paths) (collectorconfig.Config, ConfigAction, error) {
			return EnsureCollectorConfig(ctx, options, paths, i.deps.Registrar)
		})
	}
	cfg, action, err := configEnsurer.Ensure(ctx, options, paths)
	if err != nil {
		diag.Step("config", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	diag.Step("config", fmt.Sprintf("action=%s collector_id=%s device_id=%s", action, cfg.CollectorID, cfg.DeviceID))

	hook := i.deps.Hook
	if hook == nil {
		hook = hookEnsurerFunc(codexconfig.EnsureHooks)
	}
	if _, err := hook.Ensure(codexconfig.EnsureOptions{
		CodexConfigPath:     paths.CodexConfigPath,
		CollectorConfigPath: paths.ConfigPath,
		BinaryPath:          paths.BinaryPath,
	}); err != nil {
		diag.Step("codex_hook", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	diag.Step("complete", "prepared=true codex_ready=true")
	return Result{
		DiagnosticsLog: diag.Path(),
		Status: StatusSummary{
			Prepared:   true,
			CodexReady: true,
		},
	}, nil
}

func (i *Installer) InstallStartup(ctx context.Context, options StartupOptions) (Result, error) {
	paths, err := i.resolvePaths(Options{
		BinaryPath:       options.BinaryPath,
		RunnerBinaryPath: options.RunnerBinaryPath,
		ConfigPath:       options.ConfigPath,
		CodexConfigPath:  options.CodexConfigPath,
	})
	if err != nil {
		return Result{}, err
	}
	diag, err := NewDiagnosticsWriter(paths.DiagnosticsDir, i.deps.Now)
	if err != nil {
		return Result{}, err
	}
	defer diag.Close()
	diag.Step("paths", fmt.Sprintf("binary=%s runner=%s config=%s codex_config=%s", paths.BinaryPath, paths.RunnerBinaryPath, paths.ConfigPath, paths.CodexConfigPath))
	diag.Step("startup", fmt.Sprintf("startup_elevated=%v", options.Elevated))

	if err := os.MkdirAll(paths.LogDir, 0o755); err != nil {
		writeStartupFailure(diag, "log_dir", err)
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	if _, err := os.Stat(paths.RunnerBinaryPath); err != nil {
		err := fmt.Errorf("collector runner binary does not exist: %s", paths.RunnerBinaryPath)
		writeStartupFailure(diag, "runner_binary", err)
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	cfg, err := collectorconfig.Load(paths.ConfigPath)
	if err != nil {
		writeStartupFailure(diag, "config", err)
		diag.Step("config", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	if err := ValidateReusableConfig(cfg); err != nil {
		writeStartupFailure(diag, "config", err)
		diag.Step("config", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}

	legacy := i.deps.Legacy
	if legacy == nil {
		legacy = NewLegacyServiceManager(i.deps.Runner)
	}
	legacyStatus, err := legacy.Cleanup(ctx)
	if err != nil {
		writeStartupFailure(diag, "legacy_service_cleanup", err)
		diag.Step("legacy_service_cleanup", err.Error())
		return Result{DiagnosticsLog: diag.Path(), Status: StatusSummary{StartupElevated: options.Elevated, LegacyService: legacyStatus}}, err
	}
	diag.Step("legacy_service_cleanup", fmt.Sprintf("exists=%v cleaned=%v", legacyStatus.Exists, legacyStatus.Cleaned))

	task := i.deps.Task
	if task == nil {
		task = NewTaskManager(i.deps.Runner)
	}
	if err := task.Stop(ctx); err != nil {
		writeStartupFailure(diag, "task_stop", err)
		diag.Step("task_stop", err.Error())
		return Result{DiagnosticsLog: diag.Path(), Status: startupFailureStatus(options.Elevated, legacyStatus, err)}, err
	}
	if err := task.Delete(ctx); err != nil {
		writeStartupFailure(diag, "task_delete", err)
		diag.Step("task_delete", err.Error())
		return Result{DiagnosticsLog: diag.Path(), Status: startupFailureStatus(options.Elevated, legacyStatus, err)}, err
	}
	if err := task.CreateOrUpdate(ctx, paths.RunnerBinaryPath, paths.ConfigPath, paths.LogDir); err != nil {
		writeStartupFailure(diag, "task_create", err)
		diag.Step("task_create", err.Error())
		return Result{DiagnosticsLog: diag.Path(), Status: startupFailureStatus(options.Elevated, legacyStatus, err)}, err
	}
	if err := task.Start(ctx); err != nil {
		writeStartupFailure(diag, "task_start", err)
		diag.Step("task_start", err.Error())
		return Result{DiagnosticsLog: diag.Path(), Status: startupFailureStatus(options.Elevated, legacyStatus, err)}, err
	}
	taskStatus, err := task.Query(ctx)
	if err != nil {
		writeStartupFailure(diag, "task_query", err)
		diag.Step("task_query", err.Error())
		return Result{DiagnosticsLog: diag.Path(), Status: startupFailureStatus(options.Elevated, legacyStatus, err)}, err
	}
	taskUsesRunner := taskStatus.UsesRunner || strings.Contains(strings.ToLower(taskStatus.Output), "clawee-collector-runner.exe")

	health := i.deps.Health
	if health == nil {
		health = HealthChecker{}
	}
	if err := health.Wait(cfg.ListenAddr); err != nil {
		writeStartupFailure(diag, "health", err)
		diag.Step("health", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}

	connection := i.deps.Connection
	if connection == nil {
		connection = NewConnectionChecker(cfg)
	}
	if err := connection.Check(cfg); err != nil {
		writeStartupFailure(diag, "heartbeat", err)
		diag.Step("heartbeat", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	diag.Step("complete", fmt.Sprintf("startup_installed=true running=true connected=true task_uses_runner=%v", taskUsesRunner))
	return Result{
		DiagnosticsLog: diag.Path(),
		Status: StatusSummary{
			Installed:        true,
			StartupInstalled: true,
			StartupElevated:  options.Elevated,
			Running:          true,
			Connected:        true,
			TaskUsesRunner:   taskUsesRunner,
			LegacyService:    legacyStatus,
		},
	}, nil
}

func writeStartupFailure(diag *DiagnosticsWriter, step string, err error) {
	if diag == nil || err == nil {
		return
	}
	diag.Step("failed_step", fmt.Sprintf("failed_step=%s error=%s", step, err.Error()))
}

func (i *Installer) CleanupRuntime(ctx context.Context, options RuntimeCleanupOptions) (RuntimeCleanupResult, error) {
	paths, err := i.resolvePaths(Options{
		BinaryPath:       options.BinaryPath,
		RunnerBinaryPath: options.RunnerBinaryPath,
		ConfigPath:       options.ConfigPath,
		CodexConfigPath:  options.CodexConfigPath,
	})
	if err != nil {
		return RuntimeCleanupResult{}, err
	}
	diag, err := NewDiagnosticsWriter(paths.DiagnosticsDir, i.deps.Now)
	if err != nil {
		return RuntimeCleanupResult{}, err
	}
	defer diag.Close()
	diag.Step("cleanup_runtime_paths", fmt.Sprintf("binary=%s runner=%s config=%s codex_config=%s elevated=%v", paths.BinaryPath, paths.RunnerBinaryPath, paths.ConfigPath, paths.CodexConfigPath, options.Elevated))

	task := i.deps.Task
	if task == nil {
		task = NewTaskManager(i.deps.Runner)
	}
	if err := task.Stop(ctx); err != nil {
		diag.Step("cleanup_runtime_task_stop", err.Error())
		return RuntimeCleanupResult{DiagnosticsLog: diag.Path()}, err
	}
	if err := task.Delete(ctx); err != nil {
		diag.Step("cleanup_runtime_task_delete", err.Error())
		return RuntimeCleanupResult{DiagnosticsLog: diag.Path()}, err
	}

	legacy := i.deps.Legacy
	if legacy == nil {
		legacy = NewLegacyServiceManager(i.deps.Runner)
	}
	legacyStatus, err := legacy.Cleanup(ctx)
	if err != nil {
		diag.Step("cleanup_runtime_legacy_service", err.Error())
		return RuntimeCleanupResult{DiagnosticsLog: diag.Path(), TaskRemoved: true, LegacyService: legacyStatus}, err
	}

	process := i.deps.Process
	if process == nil {
		process = NewProcessManager(i.deps.Runner)
	}
	if err := process.WaitReleased(ctx, paths.BinaryPath, paths.RunnerBinaryPath); err != nil {
		diag.Step("cleanup_runtime_process_release", err.Error())
		return RuntimeCleanupResult{DiagnosticsLog: diag.Path(), TaskRemoved: true, LegacyService: legacyStatus}, err
	}

	removeHooks := i.deps.RemoveHooks
	if removeHooks == nil {
		removeHooks = codexconfig.RemoveHooks
	}
	hooksRemoved, err := removeHooks(paths.CodexConfigPath)
	if err != nil {
		diag.Step("cleanup_runtime_codex_hook", err.Error())
		return RuntimeCleanupResult{DiagnosticsLog: diag.Path(), TaskRemoved: true, LegacyService: legacyStatus}, err
	}

	diag.Step("cleanup_runtime_complete", fmt.Sprintf("task_removed=true legacy_exists=%v legacy_cleaned=%v hooks_removed=%v", legacyStatus.Exists, legacyStatus.Cleaned, hooksRemoved))
	return RuntimeCleanupResult{
		DiagnosticsLog: diag.Path(),
		TaskRemoved:    true,
		LegacyService:  legacyStatus,
		HooksRemoved:   hooksRemoved,
	}, nil
}

func (i *Installer) resolvePaths(options Options) (Paths, error) {
	resolvePaths := i.deps.ResolvePaths
	if resolvePaths == nil {
		resolvePaths = ResolvePaths
	}
	return resolvePaths(options)
}

func startupFailureStatus(elevated bool, legacyStatus LegacyServiceStatus, err error) StatusSummary {
	status := StatusSummary{
		StartupElevated: elevated,
		LegacyService:   legacyStatus,
	}
	if isAccessDenied(err) {
		status.StartupErrorCode = "onlogon_task_access_denied"
		status.SuggestedAction = "请使用管理员 PowerShell 重新执行 setup windows-user install-startup"
	}
	return status
}

func isAccessDenied(err error) bool {
	return err != nil && taskAccessDenied(err.Error())
}
