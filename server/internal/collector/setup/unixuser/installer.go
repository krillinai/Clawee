package unixuser

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/codexconfig"
	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

type Installer struct {
	deps   InstallerDeps
	stages installStages
}

func NewInstaller(deps InstallerDeps) *Installer {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	return &Installer{deps: deps}
}

type installStages interface {
	DetectExistingInstall(context.Context, Paths, Platform, common.CommandRunner) (InstallTrace, error)
	CleanupRuntime(context.Context, RuntimeCleanupOptions) (RuntimeCleanupResult, error)
	Prepare(context.Context, Options) (Result, error)
	InstallStartup(context.Context, StartupOptions) (Result, error)
	Diagnose(context.Context, DiagnoseOptions) (DiagnoseResult, error)
}

type realInstallStages struct {
	installer *Installer
}

func (s realInstallStages) DetectExistingInstall(ctx context.Context, paths Paths, platform Platform, runner common.CommandRunner) (InstallTrace, error) {
	return DetectExistingInstall(paths, platform, runner)
}

func (s realInstallStages) CleanupRuntime(ctx context.Context, options RuntimeCleanupOptions) (RuntimeCleanupResult, error) {
	return s.installer.CleanupRuntime(ctx, options)
}

func (s realInstallStages) Prepare(ctx context.Context, options Options) (Result, error) {
	return s.installer.Prepare(ctx, options)
}

func (s realInstallStages) InstallStartup(ctx context.Context, options StartupOptions) (Result, error) {
	return s.installer.InstallStartup(ctx, options)
}

func (s realInstallStages) Diagnose(ctx context.Context, options DiagnoseOptions) (DiagnoseResult, error) {
	return s.installer.Diagnose(ctx, options)
}

func (i *Installer) Install(ctx context.Context, options Options) (Result, error) {
	paths, err := i.resolvePaths(options)
	if err != nil {
		return Result{}, err
	}
	platform, err := DetectPlatform(options.GOOS)
	if err != nil {
		return Result{}, err
	}
	stages := i.stages
	if stages == nil {
		stages = realInstallStages{installer: i}
	}

	trace, err := stages.DetectExistingInstall(ctx, paths, platform, i.runner())
	if err != nil {
		return Result{}, err
	}
	if trace.RequiresExistingBinary() {
		return Result{}, fmt.Errorf("检测到已有安装痕迹但正式二进制不存在，请先按输出命令清理半安装状态")
	}
	if trace.Any() {
		if _, err := stages.CleanupRuntime(ctx, RuntimeCleanupOptions{
			BinaryPath:      paths.BinaryPath,
			ConfigPath:      paths.ConfigPath,
			CodexConfigPath: paths.CodexConfigPath,
			GOOS:            platform.OS,
		}); err != nil {
			return Result{}, err
		}
	}

	prepareResult, err := stages.Prepare(ctx, options)
	if err != nil {
		return prepareResult, err
	}
	startupResult, err := stages.InstallStartup(ctx, StartupOptions{
		BinaryPath:      paths.BinaryPath,
		ConfigPath:      paths.ConfigPath,
		CodexConfigPath: paths.CodexConfigPath,
		GOOS:            platform.OS,
	})
	if err != nil {
		return Result{DiagnosticsLog: startupResult.DiagnosticsLog, Status: startupResult.Status}, err
	}
	diagnoseResult, err := stages.Diagnose(ctx, DiagnoseOptions{
		ConfigPath:      paths.ConfigPath,
		CodexConfigPath: paths.CodexConfigPath,
		GOOS:            platform.OS,
	})
	if err != nil {
		return Result{DiagnosticsLog: startupResult.DiagnosticsLog, Status: startupResult.Status}, err
	}

	status := diagnoseResult.Status
	status.Prepared = prepareResult.Status.Prepared
	status.StartupInstalled = startupResult.Status.StartupInstalled
	status.Installed = status.Prepared && status.StartupInstalled && status.Running && status.HealthOK && status.HeartbeatOK
	return Result{DiagnosticsLog: startupResult.DiagnosticsLog, Status: status}, nil
}

type codexHookEnsurer struct{}

func (codexHookEnsurer) Ensure(codexConfigPath string, collectorConfigPath string, binaryPath string) error {
	_, err := codexconfig.EnsureHooks(codexconfig.EnsureOptions{
		CodexConfigPath:     codexConfigPath,
		CollectorConfigPath: collectorConfigPath,
		BinaryPath:          binaryPath,
	})
	return err
}

func (i *Installer) Prepare(ctx context.Context, options Options) (Result, error) {
	paths, err := i.resolvePaths(options)
	if err != nil {
		return Result{}, err
	}

	diag, err := common.NewDiagnosticsWriter(paths.DiagnosticsDir, i.deps.Now)
	if err != nil {
		return Result{}, err
	}
	defer diag.Close()

	if err := os.MkdirAll(paths.InstallDir, 0o755); err != nil {
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	if err := os.MkdirAll(paths.LogDir, 0o755); err != nil {
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	if _, err := os.Stat(paths.BinaryPath); err != nil {
		return Result{DiagnosticsLog: diag.Path()}, fmt.Errorf("collector binary does not exist: %s", paths.BinaryPath)
	}

	cfg, action, err := common.EnsureCollectorConfig(ctx, common.ConfigOptions{
		OfficeURL:             options.OfficeURL,
		RegistrationCode:      options.RegistrationCode,
		Workspace:             options.Workspace,
		ClaweeAgentConfigPath: options.ClaweeAgentConfigPath,
		ResetIdentity:         options.ResetIdentity,
	}, common.ConfigPaths{
		ConfigPath: paths.ConfigPath,
		LogDir:     paths.LogDir,
	}, i.deps.Registrar)
	if err != nil {
		diag.Step("config", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	diag.Step("config", fmt.Sprintf("action=%s collector_id=%s device_id=%s", action, cfg.CollectorID, cfg.DeviceID))

	hook := i.deps.Hook
	if hook == nil {
		hook = codexHookEnsurer{}
	}
	if err := hook.Ensure(paths.CodexConfigPath, paths.ConfigPath, paths.BinaryPath); err != nil {
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

func (i *Installer) CleanupRuntime(ctx context.Context, options RuntimeCleanupOptions) (RuntimeCleanupResult, error) {
	paths, err := i.resolvePaths(Options{
		BinaryPath:      options.BinaryPath,
		ConfigPath:      options.ConfigPath,
		CodexConfigPath: options.CodexConfigPath,
		GOOS:            options.GOOS,
	})
	if err != nil {
		return RuntimeCleanupResult{}, err
	}

	diag, err := common.NewDiagnosticsWriter(paths.DiagnosticsDir, i.deps.Now)
	if err != nil {
		return RuntimeCleanupResult{}, err
	}
	defer diag.Close()

	platform, err := DetectPlatform(options.GOOS)
	if err != nil {
		return RuntimeCleanupResult{DiagnosticsLog: diag.Path()}, err
	}

	result, err := CleanupRuntime(ctx, paths, platform, i.deps.Runner, i.deps.RemoveHooks)
	result.DiagnosticsLog = diag.Path()
	if err != nil {
		diag.Step("cleanup_runtime", err.Error())
		return result, err
	}

	diag.Step("cleanup_runtime", fmt.Sprintf("startup_removed=%v hooks_removed=%v", result.StartupRemoved, result.HooksRemoved))
	return result, nil
}

func (i *Installer) InstallStartup(ctx context.Context, options StartupOptions) (Result, error) {
	paths, err := i.resolvePaths(Options{
		BinaryPath:      options.BinaryPath,
		ConfigPath:      options.ConfigPath,
		CodexConfigPath: options.CodexConfigPath,
		GOOS:            options.GOOS,
	})
	if err != nil {
		return Result{}, err
	}

	diag, err := common.NewDiagnosticsWriter(paths.DiagnosticsDir, i.deps.Now)
	if err != nil {
		return Result{}, err
	}
	defer diag.Close()

	cfg, err := collectorconfig.Load(paths.ConfigPath)
	if err != nil {
		diag.Step("config", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	if err := common.ValidateReusableConfig(cfg); err != nil {
		diag.Step("config", err.Error())
		return Result{DiagnosticsLog: diag.Path()}, err
	}

	platform, err := DetectPlatform(options.GOOS)
	if err != nil {
		return Result{DiagnosticsLog: diag.Path()}, err
	}
	if err := installStartup(ctx, paths, platform, i.runner()); err != nil {
		diag.Step("startup", err.Error())
		return Result{
			DiagnosticsLog: diag.Path(),
			Status:         StatusSummary{StartupInstalled: false},
		}, err
	}

	health := i.deps.Health
	if health == nil {
		health = common.HealthChecker{}
	}
	if err := health.Wait(cfg.ListenAddr); err != nil {
		diag.Step("health", err.Error())
		return Result{
			DiagnosticsLog: diag.Path(),
			Status:         StatusSummary{StartupInstalled: true},
		}, err
	}

	connection := i.deps.Connection
	if connection == nil {
		connection = common.NewConnectionChecker(cfg)
	}
	if err := connection.Check(cfg); err != nil {
		diag.Step("heartbeat", err.Error())
		return Result{
			DiagnosticsLog: diag.Path(),
			Status: StatusSummary{
				StartupInstalled: true,
				Running:          true,
				HealthOK:         true,
			},
		}, err
	}

	diag.Step("complete", "startup_installed=true running=true health_ok=true heartbeat_ok=true")
	return Result{
		DiagnosticsLog: diag.Path(),
		Status: StatusSummary{
			StartupInstalled: true,
			Running:          true,
			HealthOK:         true,
			HeartbeatOK:      true,
		},
	}, nil
}

func (i *Installer) resolvePaths(options Options) (Paths, error) {
	resolvePaths := i.deps.ResolvePaths
	if resolvePaths == nil {
		resolvePaths = ResolvePaths
	}
	return resolvePaths(options)
}

func (i *Installer) runner() common.CommandRunner {
	if i.deps.Runner != nil {
		return i.deps.Runner
	}
	return common.ExecCommandRunner{}
}
