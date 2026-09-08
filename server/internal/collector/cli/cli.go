package cli

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/agentidentity"
	"github.com/krillinai/Clawee/server/internal/collector/codexconfig"
	"github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/discovery"
	"github.com/krillinai/Clawee/server/internal/collector/observability"
	"github.com/krillinai/Clawee/server/internal/collector/report"
	collectorruntime "github.com/krillinai/Clawee/server/internal/collector/runtime"
	"github.com/krillinai/Clawee/server/internal/collector/setup/unixuser"
	"github.com/krillinai/Clawee/server/internal/collector/setup/windowsuser"
	"github.com/krillinai/Clawee/server/internal/collector/version"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

const usage = "用法: clawee-collector register --office-url URL --code CODE [--config config.toml] [--clawee-agent-config config.toml] | clawee-collector ensure-registered --office-url URL --code CODE [--config config.toml] [--clawee-agent-config config.toml] | clawee-collector run [--config config.toml] | clawee-collector hook codex [--config config.toml] | clawee-collector codex hooks ensure [--codex-config config.toml] [--collector-config config.toml] [--binary clawee-collector] | clawee-collector config exists [--config config.toml] | clawee-collector setup windows-user cleanup-runtime --binary PATH --runner-binary PATH [--config config.toml] [--codex-config config.toml] [--elevated] | clawee-collector setup windows-user prepare --office-url URL --code CODE --binary PATH --runner-binary PATH [--config config.toml] [--codex-config config.toml] [--clawee-agent-config config.toml] [--workspace NAME] | clawee-collector setup windows-user install-startup --binary PATH --runner-binary PATH [--config config.toml] [--codex-config config.toml] [--elevated] | clawee-collector setup windows-user install --office-url URL --code CODE --binary PATH --runner-binary PATH [--config config.toml] [--codex-config config.toml] [--clawee-agent-config config.toml] [--workspace NAME] | clawee-collector setup windows-user uninstall-prepare [--config config.toml] [--codex-config config.toml] | clawee-collector setup windows-user uninstall-startup [--config config.toml] [--codex-config config.toml] [--purge] [--backup] | clawee-collector setup windows-user uninstall [--config config.toml] [--codex-config config.toml] [--purge] [--backup] | clawee-collector setup windows-user diagnose [--config config.toml] [--codex-config config.toml] [--json] | clawee-collector setup unix-user cleanup-runtime [--config config.toml] [--codex-config config.toml] [--binary PATH] | clawee-collector setup unix-user prepare --office-url URL --code CODE --binary PATH [--config config.toml] [--codex-config config.toml] [--clawee-agent-config config.toml] [--workspace NAME] [--reset-identity] | clawee-collector setup unix-user install-startup --binary PATH [--config config.toml] [--codex-config config.toml] | clawee-collector setup unix-user diagnose [--config config.toml] [--codex-config config.toml] [--json] | clawee-collector setup unix-user install --office-url URL --code CODE --binary PATH [--config config.toml] [--codex-config config.toml] [--clawee-agent-config config.toml] [--workspace NAME] [--reset-identity] | clawee-collector service install|start|stop|install-task|start-task [--config config.toml]"
const livenessHeartbeatInterval = 30 * time.Second
const maxHookPayloadBytes = 1 << 20
const hookCommandTimeout = 60 * time.Second
const windowsServiceName = "ClaweeCollector"

var errUsage = errors.New(usage)
var errConfigMissing = errors.New("collector config is missing")
var localIngestHTTPClient = &http.Client{Timeout: time.Second}
var runCommand = func(name string, args ...string) error {
	output, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return commandError{name: name, args: args, output: string(output), err: err}
	}
	return nil
}

func collectorVersion() string {
	return version.CollectorVersion()
}

type commandError struct {
	name   string
	args   []string
	output string
	err    error
}

func (e commandError) Error() string {
	command := strings.TrimSpace(e.name + " " + strings.Join(e.args, " "))
	output := strings.TrimSpace(e.output)
	if output == "" {
		return fmt.Sprintf("%s failed: %v", command, e.err)
	}
	return fmt.Sprintf("%s failed: %v\n%s", command, e.err, output)
}

func (e commandError) Unwrap() error {
	return e.err
}

type heartbeatReporter interface {
	PostHeartbeat(collectorapi.HeartbeatRequest) error
	PostHeartbeatSilently(collectorapi.HeartbeatRequest) error
}

func Main() int {
	return Execute(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
}

func Execute(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	if len(args) < 1 {
		_, _ = fmt.Fprintln(stderr, usage)
		return 2
	}
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-version") {
		_, _ = fmt.Fprintln(stdout, collectorVersion())
		return 0
	}

	var err error
	switch args[0] {
	case "register":
		err = runRegister(args[1:], stdout)
	case "ensure-registered":
		err = runEnsureRegistered(args[1:], stdout)
	case "run":
		err = runCollector(args[1:])
	case "hook":
		err = runHook(args[1:], stdin, stderr)
	case "codex":
		err = runCodex(args[1:], stdout)
	case "config":
		err = runConfig(args[1:])
	case "setup":
		err = runSetup(args[1:], stdout)
	case "service":
		err = runService(args[1:], stdout)
	default:
		_, _ = fmt.Fprintln(stderr, usage)
		return 2
	}
	if err != nil {
		if errors.Is(err, errUsage) {
			_, _ = fmt.Fprintln(stderr, usage)
			return 2
		}
		if errors.Is(err, errConfigMissing) {
			return 1
		}
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

var collectorRuntimeRun = func(ctx context.Context, configPath string) error {
	return collectorruntime.Run(ctx, collectorruntime.Options{ConfigPath: configPath})
}

func setCollectorRuntimeRunForTest(fn func(context.Context, string) error) func() {
	previous := collectorRuntimeRun
	collectorRuntimeRun = fn
	return func() { collectorRuntimeRun = previous }
}

func runCollector(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runCollectorWithContext(ctx, args)
}

func runCollectorWithContext(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 1 {
		return errUsage
	}
	if *configPath != "" && len(flags.Args()) > 0 {
		return errUsage
	}

	resolvedConfigPath := *configPath
	if resolvedConfigPath == "" && len(flags.Args()) == 1 {
		resolvedConfigPath = flags.Args()[0]
	}
	return collectorRuntimeRun(ctx, resolvedConfigPath)
}

func runHook(args []string, stdin io.Reader, stderr io.Writer) error {
	return runHookWithTimeout(args, stdin, hookCommandTimeout, stderr)
}

func runHookWithTimeout(args []string, stdin io.Reader, timeout time.Duration, stderr io.Writer) error {
	payload, exceeded, readErr := readHookPayload(stdin)

	ctx := context.Background()
	cancel := func() {}
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, timeout)
	}
	defer cancel()

	err := runHookOnce(ctx, args, payload, exceeded, readErr, stderr)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		_, _ = fmt.Fprintf(stderr, "clawee-collector hook command timed out after %s\n", timeout)
		return nil
	}
	return err
}

func readHookPayload(stdin io.Reader) ([]byte, bool, error) {
	payload, readErr := io.ReadAll(io.LimitReader(stdin, maxHookPayloadBytes+1))
	exceeded := len(payload) > maxHookPayloadBytes
	if exceeded || readErr != nil {
		_, drainErr := io.Copy(io.Discard, stdin)
		readErr = errors.Join(readErr, drainErr)
	}
	return payload, exceeded, readErr
}

func runHookOnce(ctx context.Context, args []string, payload []byte, exceeded bool, readErr error, stderr io.Writer) error {
	if len(args) < 1 {
		return errUsage
	}
	agentType := args[0]
	if agentType != "codex" {
		return fmt.Errorf("unsupported hook agent type: %s", agentType)
	}

	flags := flag.NewFlagSet("hook codex", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	logger := observability.NewLogger(observability.Config{
		Output: stderr,
		Debug:  cfg.Debug,
		Color:  cfg.LogColorEnabled(),
	})

	if exceeded {
		logger.Warn("codex hook payload exceeded limit", "max_bytes", maxHookPayloadBytes)
		return nil
	}
	if readErr != nil {
		logger.Warn("read codex hook payload failed", "error", readErr)
		return nil
	}
	if len(bytes.TrimSpace(payload)) == 0 {
		logger.Warn("codex hook payload is empty")
		return nil
	}

	if err := postLocalIngest(ctx, cfg.ListenAddr, "codex", payload); err != nil {
		logger.Warn("post local codex ingest failed", "error", err)
		return nil
	}
	return nil
}

func runCodex(args []string, stdout io.Writer) error {
	if len(args) < 1 {
		return errUsage
	}
	switch args[0] {
	case "hooks":
		return runCodexHooks(args[1:], stdout)
	default:
		return errUsage
	}
}

func runCodexHooks(args []string, stdout io.Writer) error {
	if len(args) < 1 {
		return errUsage
	}
	switch args[0] {
	case "ensure":
		return runCodexHooksEnsure(args[1:], stdout)
	default:
		return errUsage
	}
}

func runCodexHooksEnsure(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("codex hooks ensure", flag.ContinueOnError)
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml 路径")
	collectorConfigPath := flags.String("collector-config", "", "采集器配置路径；解析为默认路径时不会写入 hook command")
	binaryPath := flags.String("binary", "", "采集器二进制路径")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := codexconfig.EnsureHooks(codexconfig.EnsureOptions{
		CodexConfigPath:     *codexConfigPath,
		CollectorConfigPath: *collectorConfigPath,
		BinaryPath:          *binaryPath,
	})
	if err != nil {
		return err
	}
	if result.Changed {
		_, _ = fmt.Fprintf(stdout, "已更新 Codex 钩子配置: %s\n", result.CodexConfigPath)
	} else {
		_, _ = fmt.Fprintf(stdout, "Codex 钩子配置已是最新: %s\n", result.CodexConfigPath)
	}
	return nil
}

func postLocalIngest(ctx context.Context, listenAddr string, agentType string, payload []byte) error {
	endpoint := "http://" + localListenAddr(listenAddr) + "/ingest/" + agentType
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := localIngestHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("local ingest returned status %d", resp.StatusCode)
	}
	return nil
}

func localListenAddr(listenAddr string) string {
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return listenAddr
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsUnspecified() {
		return net.JoinHostPort("127.0.0.1", port)
	}
	return listenAddr
}

func runRegister(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("register", flag.ContinueOnError)
	officeURL := flags.String("office-url", "", "collector service base URL")
	code := flags.String("code", "", "registration code")
	configPath := flags.String("config", "", "config output path")
	claweeAgentConfigPath := flags.String("clawee-agent-config", "", "clawee-agent config.toml path")
	workspaceName := flags.String("workspace", filepath.Base(mustGetwd()), "workspace name for initial agent discovery")
	flags.String("agent-name", "", "deprecated; ignored")
	listenAddr := flags.String("listen-addr", config.DefaultListenAddr, "local hook server listen address")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	if *officeURL == "" {
		return errors.New("--office-url is required")
	}
	if *code == "" {
		return errors.New("--code is required")
	}
	resolvedConfigPath, err := config.ResolvePath(*configPath)
	if err != nil {
		return err
	}
	agentID, err := agentidentity.Resolve(context.Background(), agentidentity.Options{
		ClaweeAgentConfigPath: *claweeAgentConfigPath,
		CollectorConfigPath:   resolvedConfigPath,
		OfficeURL:             *officeURL,
	})
	if err != nil {
		return err
	}
	device := discovery.DeviceInfo(collectorVersion())
	registrationAgents := discovery.DiscoverAgents(*workspaceName)
	registrar := report.NewClient(report.Config{BaseURL: *officeURL})
	resp, err := registrar.RegisterCollector(collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: *code,
		AgentID:          agentID,
		DeviceName:       device.DeviceName,
		Hostname:         device.Hostname,
		OS:               device.OS,
		Arch:             device.Arch,
		CollectorVersion: device.CollectorVersion,
		Agents:           registrationAgents,
	})
	if err != nil {
		return err
	}

	privacyMode := resp.PrivacyMode
	if privacyMode == "" {
		privacyMode = "summary_only"
	}
	cfg := config.Config{
		OfficeURL:         *officeURL,
		AgentID:           agentID,
		CollectorToken:    resp.CollectorToken,
		CollectorID:       resp.CollectorID,
		DeviceID:          resp.DeviceID,
		ListenAddr:        *listenAddr,
		EnabledAgentTypes: []string{"codex"},
		PrivacyMode:       privacyMode,
	}
	if err := config.Save(resolvedConfigPath, cfg); err != nil {
		return err
	}

	reporter := report.NewClient(report.Config{
		BaseURL:        cfg.OfficeURL,
		CollectorToken: cfg.CollectorToken,
	})
	initialSeenAt := time.Now().UTC()
	initialAgent := collectorapi.AgentSummary{
		AgentID:       cfg.AgentID,
		AgentType:     collectorapi.AgentTypeCodex,
		Status:        collectorapi.StatusIdle,
		WorkspaceName: *workspaceName,
		LastSeenAt:    initialSeenAt,
		Metadata:      map[string]string{"privacy_mode": cfg.PrivacyMode},
	}
	if err := reporter.PostHeartbeat(collectorapi.HeartbeatRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		CollectorID:      resp.CollectorID,
		DeviceID:         resp.DeviceID,
		SentAt:           initialSeenAt,
		CollectorVersion: collectorVersion(),
		Agents:           []collectorapi.AgentSummary{initialAgent},
	}); err != nil {
		return fmt.Errorf("initial heartbeat failed after writing config: %w", err)
	}

	_, _ = fmt.Fprintf(stdout, "registered collector_id: %s\n", resp.CollectorID)
	_, _ = fmt.Fprintf(stdout, "device_id: %s\n", resp.DeviceID)
	return nil
}

func runEnsureRegistered(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("ensure-registered", flag.ContinueOnError)
	configPath := flags.String("config", "", "config output path")
	claweeAgentConfigPath := flags.String("clawee-agent-config", "", "clawee-agent config.toml path")
	flags.String("office-url", "", "collector service base URL")
	flags.String("code", "", "registration code")
	flags.String("workspace", filepath.Base(mustGetwd()), "workspace name for initial agent discovery")
	flags.String("agent-name", "", "main agent display name")
	flags.String("listen-addr", config.DefaultListenAddr, "local hook server listen address")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	resolvedConfigPath, err := config.ResolvePath(*configPath)
	if err != nil {
		return err
	}
	if cfg, err := config.Load(resolvedConfigPath); err == nil {
		agentID, resolveErr := agentidentity.Resolve(context.Background(), agentidentity.Options{
			ClaweeAgentConfigPath: *claweeAgentConfigPath,
			CollectorConfigPath:   resolvedConfigPath,
			OfficeURL:             cfg.OfficeURL,
		})
		if resolveErr != nil {
			return resolveErr
		}
		if cfg.AgentID != agentID {
			cfg.AgentID = agentID
			if saveErr := config.Save(resolvedConfigPath, cfg); saveErr != nil {
				return saveErr
			}
		}
		_, _ = fmt.Fprintf(stdout, "collector config already exists: %s\n", resolvedConfigPath)
		return nil
	}
	return runRegister(args, stdout)
}

func runConfig(args []string) error {
	if len(args) < 1 {
		return errUsage
	}
	switch args[0] {
	case "exists":
		flags := flag.NewFlagSet("config exists", flag.ContinueOnError)
		configPath := flags.String("config", "", "collector config path")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if len(flags.Args()) > 0 {
			return errUsage
		}
		resolvedConfigPath, err := config.ResolvePath(*configPath)
		if err != nil {
			return err
		}
		_, err = config.Load(resolvedConfigPath)
		if errors.Is(err, os.ErrNotExist) {
			return errConfigMissing
		}
		return err
	default:
		return errUsage
	}
}

func runService(args []string, stdout io.Writer) error {
	if len(args) < 1 {
		return errUsage
	}
	switch args[0] {
	case "install":
		return runServiceInstall(args[1:], stdout)
	case "start":
		return runServiceStart(args[1:], stdout)
	case "stop":
		return runServiceStop(args[1:], stdout)
	case "run":
		return runServiceRun(args[1:])
	case "install-task":
		return runServiceInstallTask(args[1:], stdout)
	case "start-task":
		return runServiceStartTask(args[1:], stdout)
	default:
		return errUsage
	}
}

type windowsUserInstaller interface {
	Install(context.Context, windowsuser.Options) (windowsuser.Result, error)
	Prepare(context.Context, windowsuser.Options) (windowsuser.Result, error)
	InstallStartup(context.Context, windowsuser.StartupOptions) (windowsuser.Result, error)
	CleanupRuntime(context.Context, windowsuser.RuntimeCleanupOptions) (windowsuser.RuntimeCleanupResult, error)
}

type windowsUserInstallerFunc struct {
	install        func(context.Context, windowsuser.Options) (windowsuser.Result, error)
	prepare        func(context.Context, windowsuser.Options) (windowsuser.Result, error)
	installStartup func(context.Context, windowsuser.StartupOptions) (windowsuser.Result, error)
	cleanupRuntime func(context.Context, windowsuser.RuntimeCleanupOptions) (windowsuser.RuntimeCleanupResult, error)
}

func (fn windowsUserInstallerFunc) Install(ctx context.Context, options windowsuser.Options) (windowsuser.Result, error) {
	return fn.install(ctx, options)
}

func (fn windowsUserInstallerFunc) Prepare(ctx context.Context, options windowsuser.Options) (windowsuser.Result, error) {
	return fn.prepare(ctx, options)
}

func (fn windowsUserInstallerFunc) InstallStartup(ctx context.Context, options windowsuser.StartupOptions) (windowsuser.Result, error) {
	return fn.installStartup(ctx, options)
}

func (fn windowsUserInstallerFunc) CleanupRuntime(ctx context.Context, options windowsuser.RuntimeCleanupOptions) (windowsuser.RuntimeCleanupResult, error) {
	return fn.cleanupRuntime(ctx, options)
}

var newWindowsUserInstaller = func() windowsUserInstaller {
	return windowsuser.NewInstaller(windowsuser.InstallerDeps{})
}

type unixUserInstaller interface {
	Install(context.Context, unixuser.Options) (unixuser.Result, error)
	Prepare(context.Context, unixuser.Options) (unixuser.Result, error)
	InstallStartup(context.Context, unixuser.StartupOptions) (unixuser.Result, error)
	CleanupRuntime(context.Context, unixuser.RuntimeCleanupOptions) (unixuser.RuntimeCleanupResult, error)
	Diagnose(context.Context, unixuser.DiagnoseOptions) (unixuser.DiagnoseResult, error)
}

type unixUserInstallerFunc struct {
	install        func(context.Context, unixuser.Options) (unixuser.Result, error)
	prepare        func(context.Context, unixuser.Options) (unixuser.Result, error)
	installStartup func(context.Context, unixuser.StartupOptions) (unixuser.Result, error)
	cleanupRuntime func(context.Context, unixuser.RuntimeCleanupOptions) (unixuser.RuntimeCleanupResult, error)
	diagnose       func(context.Context, unixuser.DiagnoseOptions) (unixuser.DiagnoseResult, error)
}

func (fn unixUserInstallerFunc) Install(ctx context.Context, options unixuser.Options) (unixuser.Result, error) {
	return fn.install(ctx, options)
}

func (fn unixUserInstallerFunc) Prepare(ctx context.Context, options unixuser.Options) (unixuser.Result, error) {
	return fn.prepare(ctx, options)
}

func (fn unixUserInstallerFunc) InstallStartup(ctx context.Context, options unixuser.StartupOptions) (unixuser.Result, error) {
	return fn.installStartup(ctx, options)
}

func (fn unixUserInstallerFunc) CleanupRuntime(ctx context.Context, options unixuser.RuntimeCleanupOptions) (unixuser.RuntimeCleanupResult, error) {
	return fn.cleanupRuntime(ctx, options)
}

func (fn unixUserInstallerFunc) Diagnose(ctx context.Context, options unixuser.DiagnoseOptions) (unixuser.DiagnoseResult, error) {
	return fn.diagnose(ctx, options)
}

var newUnixUserInstaller = func() unixUserInstaller {
	return unixuser.NewInstaller(unixuser.InstallerDeps{})
}

type windowsUserUninstaller interface {
	Uninstall(context.Context, windowsuser.UninstallOptions) (windowsuser.UninstallResult, error)
	Prepare(context.Context, windowsuser.UninstallOptions) (windowsuser.UninstallResult, error)
	UninstallStartup(context.Context, windowsuser.UninstallOptions) (windowsuser.UninstallResult, error)
}

type windowsUserUninstallerFunc struct {
	uninstall func(context.Context, windowsuser.UninstallOptions) (windowsuser.UninstallResult, error)
	prepare   func(context.Context, windowsuser.UninstallOptions) (windowsuser.UninstallResult, error)
	startup   func(context.Context, windowsuser.UninstallOptions) (windowsuser.UninstallResult, error)
}

func (fn windowsUserUninstallerFunc) Uninstall(ctx context.Context, options windowsuser.UninstallOptions) (windowsuser.UninstallResult, error) {
	return fn.uninstall(ctx, options)
}

func (fn windowsUserUninstallerFunc) Prepare(ctx context.Context, options windowsuser.UninstallOptions) (windowsuser.UninstallResult, error) {
	return fn.prepare(ctx, options)
}

func (fn windowsUserUninstallerFunc) UninstallStartup(ctx context.Context, options windowsuser.UninstallOptions) (windowsuser.UninstallResult, error) {
	return fn.startup(ctx, options)
}

var newWindowsUserUninstaller = func() windowsUserUninstaller {
	return windowsuser.NewUninstaller(windowsuser.MaintenanceDeps{})
}

type windowsUserDiagnoser interface {
	Diagnose(context.Context, windowsuser.DiagnoseOptions) (windowsuser.DiagnoseResult, error)
}

type windowsUserDiagnoserFunc func(context.Context, windowsuser.DiagnoseOptions) (windowsuser.DiagnoseResult, error)

func (fn windowsUserDiagnoserFunc) Diagnose(ctx context.Context, options windowsuser.DiagnoseOptions) (windowsuser.DiagnoseResult, error) {
	return fn(ctx, options)
}

var newWindowsUserDiagnoser = func() windowsUserDiagnoser {
	return windowsuser.NewDiagnoser(windowsuser.MaintenanceDeps{})
}

func setWindowsUserInstallerFactoryForTest(factory func() windowsUserInstaller) func() {
	previous := newWindowsUserInstaller
	newWindowsUserInstaller = factory
	return func() { newWindowsUserInstaller = previous }
}

func setUnixUserInstallerFactoryForTest(factory func() unixUserInstaller) func() {
	previous := newUnixUserInstaller
	newUnixUserInstaller = factory
	return func() { newUnixUserInstaller = previous }
}

func setWindowsUserUninstallerFactoryForTest(factory func() windowsUserUninstaller) func() {
	previous := newWindowsUserUninstaller
	newWindowsUserUninstaller = factory
	return func() { newWindowsUserUninstaller = previous }
}

func setWindowsUserDiagnoserFactoryForTest(factory func() windowsUserDiagnoser) func() {
	previous := newWindowsUserDiagnoser
	newWindowsUserDiagnoser = factory
	return func() { newWindowsUserDiagnoser = previous }
}

func runSetup(args []string, stdout io.Writer) error {
	if len(args) < 1 {
		return errUsage
	}
	switch args[0] {
	case "windows-user":
		return runSetupWindowsUser(args[1:], stdout)
	case "unix-user":
		return runSetupUnixUser(args[1:], stdout)
	default:
		return errUsage
	}
}

func runSetupUnixUser(args []string, stdout io.Writer) error {
	if len(args) < 1 {
		return errUsage
	}
	switch args[0] {
	case "install":
		return runSetupUnixUserInstall(args[1:], stdout)
	case "cleanup-runtime":
		return runSetupUnixUserCleanupRuntime(args[1:], stdout)
	case "prepare":
		return runSetupUnixUserPrepare(args[1:], stdout)
	case "install-startup":
		return runSetupUnixUserInstallStartup(args[1:], stdout)
	case "diagnose":
		return runSetupUnixUserDiagnose(args[1:], stdout)
	default:
		return errUsage
	}
}

func runSetupWindowsUser(args []string, stdout io.Writer) error {
	if len(args) < 1 {
		return errUsage
	}
	switch args[0] {
	case "install":
		return runSetupWindowsUserInstall(args[1:], stdout)
	case "cleanup-runtime":
		return runSetupWindowsUserCleanupRuntime(args[1:], stdout)
	case "prepare":
		return runSetupWindowsUserPrepare(args[1:], stdout)
	case "install-startup":
		return runSetupWindowsUserInstallStartup(args[1:], stdout)
	case "uninstall":
		return runSetupWindowsUserUninstall(args[1:], stdout)
	case "uninstall-prepare":
		return runSetupWindowsUserUninstallPrepare(args[1:], stdout)
	case "uninstall-startup":
		return runSetupWindowsUserUninstallStartup(args[1:], stdout)
	case "diagnose":
		return runSetupWindowsUserDiagnose(args[1:], stdout)
	default:
		return errUsage
	}
}

func runSetupWindowsUserInstall(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup windows-user install", flag.ContinueOnError)
	officeURL := flags.String("office-url", "", "Office base URL")
	code := flags.String("code", "", "registration code")
	binaryPath := flags.String("binary", "", "collector binary path")
	runnerBinaryPath := flags.String("runner-binary", "", "collector runner binary path")
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	claweeAgentConfigPath := flags.String("clawee-agent-config", "", "clawee-agent config.toml path")
	workspace := flags.String("workspace", filepath.Base(mustGetwd()), "workspace name")
	flags.String("agent-name", "", "deprecated; ignored")
	jsonOutput := flags.Bool("json", false, "write JSON summary")
	resetIdentity := flags.Bool("reset-identity", false, "reset collector identity")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	installer := newWindowsUserInstaller()
	result, err := installer.Install(context.Background(), windowsuser.Options{
		OfficeURL:             *officeURL,
		RegistrationCode:      *code,
		BinaryPath:            *binaryPath,
		RunnerBinaryPath:      *runnerBinaryPath,
		ConfigPath:            *configPath,
		CodexConfigPath:       *codexConfigPath,
		ClaweeAgentConfigPath: *claweeAgentConfigPath,
		Workspace:             *workspace,
		JSON:                  *jsonOutput,
		ResetIdentity:         *resetIdentity,
	})
	if err != nil {
		_, _ = fmt.Fprintf(stdout, "状态: prepared=%v running=%v connected=%v\n", result.Status.Prepared, result.Status.Running, result.Status.Connected)
		if result.Status.StartupErrorCode != "" {
			_, _ = fmt.Fprintf(stdout, "startup_error_code=%s\n", result.Status.StartupErrorCode)
		}
		if result.Status.SuggestedAction != "" {
			_, _ = fmt.Fprintf(stdout, "suggested_action=%s\n", result.Status.SuggestedAction)
		}
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "安装失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	if *resetIdentity {
		_, _ = fmt.Fprintln(stdout, "本机将重新注册并轮换采集器凭据")
	}
	_, _ = fmt.Fprintln(stdout, "Windows 当前用户采集器安装完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: installed=%v startup_installed=%v running=%v health_ok=%v heartbeat_ok=%v task_uses_runner=%v codex_ready=%v\n", result.Status.Installed, result.Status.StartupInstalled, result.Status.Running, result.Status.Running, result.Status.Connected, result.Status.TaskUsesRunner, result.Status.CodexReady)
	return nil
}

func runSetupWindowsUserCleanupRuntime(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup windows-user cleanup-runtime", flag.ContinueOnError)
	binaryPath := flags.String("binary", "", "collector binary path")
	runnerBinaryPath := flags.String("runner-binary", "", "collector runner binary path")
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	elevated := flags.Bool("elevated", false, "cleanup stage is running elevated")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newWindowsUserInstaller().CleanupRuntime(context.Background(), windowsuser.RuntimeCleanupOptions{
		BinaryPath:       *binaryPath,
		RunnerBinaryPath: *runnerBinaryPath,
		ConfigPath:       *configPath,
		CodexConfigPath:  *codexConfigPath,
		Elevated:         *elevated,
	})
	if err != nil {
		_, _ = fmt.Fprintln(stdout, "安装已停止，未覆盖正式二进制")
		if result.LegacyService.Exists || strings.Contains(strings.ToLower(err.Error()), "access is denied") {
			_, _ = fmt.Fprintln(stdout, "请使用管理员 PowerShell 执行:")
			_, _ = fmt.Fprintln(stdout, "sc.exe stop ClaweeCollector")
			_, _ = fmt.Fprintln(stdout, "sc.exe delete ClaweeCollector")
		}
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Windows 当前用户采集器旧运行面清理完成 cleanup-runtime")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: task_removed=%v legacy_exists=%v legacy_cleaned=%v hooks_removed=%v\n", result.TaskRemoved, result.LegacyService.Exists, result.LegacyService.Cleaned, result.HooksRemoved)
	return nil
}

func runSetupWindowsUserPrepare(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup windows-user prepare", flag.ContinueOnError)
	officeURL := flags.String("office-url", "", "Office base URL")
	code := flags.String("code", "", "registration code")
	binaryPath := flags.String("binary", "", "collector binary path")
	runnerBinaryPath := flags.String("runner-binary", "", "collector runner binary path")
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	claweeAgentConfigPath := flags.String("clawee-agent-config", "", "clawee-agent config.toml path")
	workspace := flags.String("workspace", filepath.Base(mustGetwd()), "workspace name")
	flags.String("agent-name", "", "deprecated; ignored")
	resetIdentity := flags.Bool("reset-identity", false, "reset collector identity")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newWindowsUserInstaller().Prepare(context.Background(), windowsuser.Options{
		OfficeURL:             *officeURL,
		RegistrationCode:      *code,
		BinaryPath:            *binaryPath,
		RunnerBinaryPath:      *runnerBinaryPath,
		ConfigPath:            *configPath,
		CodexConfigPath:       *codexConfigPath,
		ClaweeAgentConfigPath: *claweeAgentConfigPath,
		Workspace:             *workspace,
		ResetIdentity:         *resetIdentity,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "准备阶段失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Windows 当前用户采集器准备阶段完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: prepared=%v codex-ready=%v\n", result.Status.Prepared, result.Status.CodexReady)
	return nil
}

func runSetupWindowsUserInstallStartup(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup windows-user install-startup", flag.ContinueOnError)
	binaryPath := flags.String("binary", "", "collector binary path")
	runnerBinaryPath := flags.String("runner-binary", "", "collector runner binary path")
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	elevated := flags.Bool("elevated", false, "startup stage is running elevated")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newWindowsUserInstaller().InstallStartup(context.Background(), windowsuser.StartupOptions{
		BinaryPath:       *binaryPath,
		RunnerBinaryPath: *runnerBinaryPath,
		ConfigPath:       *configPath,
		CodexConfigPath:  *codexConfigPath,
		Elevated:         *elevated,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "启动项安装失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		if result.Status.StartupErrorCode != "" {
			_, _ = fmt.Fprintf(stdout, "startup_error_code=%s\n", result.Status.StartupErrorCode)
		}
		if result.Status.SuggestedAction != "" {
			_, _ = fmt.Fprintf(stdout, "suggested_action=%s\n", result.Status.SuggestedAction)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Windows 采集器启动项安装完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: running=%v health_ok=%v heartbeat_ok=%v task_uses_runner=%v startup_installed=%v startup_elevated=%v\n", result.Status.Running, result.Status.Running, result.Status.Connected, result.Status.TaskUsesRunner, result.Status.StartupInstalled, result.Status.StartupElevated)
	return nil
}

func runSetupWindowsUserUninstall(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup windows-user uninstall", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	purge := flags.Bool("purge", false, "remove current-user install dir")
	backup := flags.Bool("backup", false, "backup install dir before purge")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newWindowsUserUninstaller().Uninstall(context.Background(), windowsuser.UninstallOptions{
		ConfigPath:      *configPath,
		CodexConfigPath: *codexConfigPath,
		Purge:           *purge,
		Backup:          *backup,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "卸载失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Windows 当前用户采集器卸载完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	if result.BackupPath != "" {
		_, _ = fmt.Fprintf(stdout, "备份目录: %s\n", result.BackupPath)
	}
	return nil
}

func runSetupWindowsUserUninstallPrepare(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup windows-user uninstall-prepare", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newWindowsUserUninstaller().Prepare(context.Background(), windowsuser.UninstallOptions{
		ConfigPath:      *configPath,
		CodexConfigPath: *codexConfigPath,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "卸载准备阶段失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Windows 当前用户采集器卸载准备阶段完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: hooks-removed=%v\n", result.HooksRemoved)
	return nil
}

func runSetupWindowsUserUninstallStartup(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup windows-user uninstall-startup", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	purge := flags.Bool("purge", false, "remove current-user install dir")
	backup := flags.Bool("backup", false, "backup install dir before purge")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newWindowsUserUninstaller().UninstallStartup(context.Background(), windowsuser.UninstallOptions{
		ConfigPath:      *configPath,
		CodexConfigPath: *codexConfigPath,
		Purge:           *purge,
		Backup:          *backup,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "卸载启动项阶段失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Windows 当前用户采集器启动项卸载完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	if result.BackupPath != "" {
		_, _ = fmt.Fprintf(stdout, "备份目录: %s\n", result.BackupPath)
	}
	_, _ = fmt.Fprintf(stdout, "状态: task-removed=%v purged=%v\n", result.TaskRemoved, result.Purged)
	return nil
}

func runSetupWindowsUserDiagnose(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup windows-user diagnose", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	jsonOutput := flags.Bool("json", false, "write JSON diagnostics")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newWindowsUserDiagnoser().Diagnose(context.Background(), windowsuser.DiagnoseOptions{
		ConfigPath:      *configPath,
		CodexConfigPath: *codexConfigPath,
		JSON:            *jsonOutput,
	})
	if err != nil {
		return err
	}
	if *jsonOutput {
		_, _ = fmt.Fprintln(stdout, result.JSON)
		return nil
	}
	_, _ = fmt.Fprint(stdout, result.Text)
	return nil
}

func runSetupUnixUserInstall(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup unix-user install", flag.ContinueOnError)
	officeURL := flags.String("office-url", "", "Office base URL")
	code := flags.String("code", "", "registration code")
	binaryPath := flags.String("binary", "", "collector binary path")
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	claweeAgentConfigPath := flags.String("clawee-agent-config", "", "clawee-agent config.toml path")
	workspace := flags.String("workspace", filepath.Base(mustGetwd()), "workspace name")
	flags.String("agent-name", "", "deprecated; ignored")
	resetIdentity := flags.Bool("reset-identity", false, "reset collector identity")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newUnixUserInstaller().Install(context.Background(), unixuser.Options{
		OfficeURL:             *officeURL,
		RegistrationCode:      *code,
		BinaryPath:            *binaryPath,
		ConfigPath:            *configPath,
		CodexConfigPath:       *codexConfigPath,
		ClaweeAgentConfigPath: *claweeAgentConfigPath,
		Workspace:             *workspace,
		ResetIdentity:         *resetIdentity,
		GOOS:                  runtime.GOOS,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "安装失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	if *resetIdentity {
		_, _ = fmt.Fprintln(stdout, "本机将重新注册并轮换采集器凭据")
	}
	_, _ = fmt.Fprintln(stdout, "Unix 当前用户采集器安装完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: running=%v health_ok=%v heartbeat_ok=%v startup_installed=%v\n", result.Status.Running, result.Status.HealthOK, result.Status.HeartbeatOK, result.Status.StartupInstalled)
	return nil
}

func runSetupUnixUserCleanupRuntime(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup unix-user cleanup-runtime", flag.ContinueOnError)
	binaryPath := flags.String("binary", "", "collector binary path")
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newUnixUserInstaller().CleanupRuntime(context.Background(), unixuser.RuntimeCleanupOptions{
		BinaryPath:      *binaryPath,
		ConfigPath:      *configPath,
		CodexConfigPath: *codexConfigPath,
		GOOS:            runtime.GOOS,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "清理失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Unix 当前用户采集器旧运行面清理完成 cleanup-runtime")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: startup_removed=%v hooks_removed=%v\n", result.StartupRemoved, result.HooksRemoved)
	return nil
}

func runSetupUnixUserPrepare(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup unix-user prepare", flag.ContinueOnError)
	officeURL := flags.String("office-url", "", "Office base URL")
	code := flags.String("code", "", "registration code")
	binaryPath := flags.String("binary", "", "collector binary path")
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	claweeAgentConfigPath := flags.String("clawee-agent-config", "", "clawee-agent config.toml path")
	workspace := flags.String("workspace", filepath.Base(mustGetwd()), "workspace name")
	flags.String("agent-name", "", "deprecated; ignored")
	resetIdentity := flags.Bool("reset-identity", false, "reset collector identity")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newUnixUserInstaller().Prepare(context.Background(), unixuser.Options{
		OfficeURL:             *officeURL,
		RegistrationCode:      *code,
		BinaryPath:            *binaryPath,
		ConfigPath:            *configPath,
		CodexConfigPath:       *codexConfigPath,
		ClaweeAgentConfigPath: *claweeAgentConfigPath,
		Workspace:             *workspace,
		ResetIdentity:         *resetIdentity,
		GOOS:                  runtime.GOOS,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "准备阶段失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Unix 当前用户采集器准备阶段完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: prepared=%v codex-ready=%v\n", result.Status.Prepared, result.Status.CodexReady)
	return nil
}

func runSetupUnixUserInstallStartup(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup unix-user install-startup", flag.ContinueOnError)
	binaryPath := flags.String("binary", "", "collector binary path")
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newUnixUserInstaller().InstallStartup(context.Background(), unixuser.StartupOptions{
		BinaryPath:      *binaryPath,
		ConfigPath:      *configPath,
		CodexConfigPath: *codexConfigPath,
		GOOS:            runtime.GOOS,
	})
	if err != nil {
		if result.DiagnosticsLog != "" {
			_, _ = fmt.Fprintf(stdout, "启动项安装失败，诊断日志: %s\n", result.DiagnosticsLog)
		}
		return err
	}
	_, _ = fmt.Fprintln(stdout, "Unix 采集器启动项安装完成")
	_, _ = fmt.Fprintf(stdout, "诊断日志: %s\n", result.DiagnosticsLog)
	_, _ = fmt.Fprintf(stdout, "状态: running=%v health_ok=%v heartbeat_ok=%v startup_installed=%v\n", result.Status.Running, result.Status.HealthOK, result.Status.HeartbeatOK, result.Status.StartupInstalled)
	return nil
}

func runSetupUnixUserDiagnose(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("setup unix-user diagnose", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	codexConfigPath := flags.String("codex-config", "", "Codex config.toml path")
	jsonOutput := flags.Bool("json", false, "write JSON diagnostics")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	result, err := newUnixUserInstaller().Diagnose(context.Background(), unixuser.DiagnoseOptions{
		ConfigPath:      *configPath,
		CodexConfigPath: *codexConfigPath,
		JSON:            *jsonOutput,
		GOOS:            runtime.GOOS,
	})
	if err != nil {
		return err
	}
	if *jsonOutput {
		_, _ = fmt.Fprintln(stdout, result.JSON)
		return nil
	}
	_, _ = fmt.Fprint(stdout, result.Text)
	return nil
}

func runServiceInstall(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("service install", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	binaryPath := flags.String("binary", "", "collector binary path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	resolvedConfigPath, err := config.ResolvePath(*configPath)
	if err != nil {
		return err
	}
	if _, err := config.Load(resolvedConfigPath); err != nil {
		return err
	}
	resolvedBinaryPath := *binaryPath
	if resolvedBinaryPath == "" {
		resolvedBinaryPath, err = os.Executable()
		if err != nil {
			return err
		}
	}

	switch runtime.GOOS {
	case "darwin":
		return installLaunchAgent(resolvedBinaryPath, resolvedConfigPath, stdout)
	case "linux":
		return installSystemdUserService(resolvedBinaryPath, resolvedConfigPath, stdout)
	case "windows":
		return installWindowsService(resolvedBinaryPath, resolvedConfigPath, stdout)
	default:
		return fmt.Errorf("service install is not implemented for %s", runtime.GOOS)
	}
}

func installLaunchAgent(binaryPath string, configPath string, stdout io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	logDir := filepath.Join(home, "Library", "Logs", "clawee-collector")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return err
	}
	launchAgentsDir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(launchAgentsDir, 0o755); err != nil {
		return err
	}
	plistPath := filepath.Join(launchAgentsDir, "com.clawee.collector.plist")
	plist := buildLaunchAgentPlist(binaryPath, configPath, logDir)
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "installed launch agent: %s\n", plistPath)
	return nil
}

func installSystemdUserService(binaryPath string, configPath string, stdout io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	serviceDir := filepath.Join(home, ".config", "systemd", "user")
	if err := os.MkdirAll(serviceDir, 0o755); err != nil {
		return err
	}
	servicePath := filepath.Join(serviceDir, "clawee-collector.service")
	if err := os.WriteFile(servicePath, []byte(buildSystemdUserService(binaryPath, configPath)), 0o644); err != nil {
		return err
	}
	if err := runCommand("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	if err := runCommand("systemctl", "--user", "enable", "clawee-collector.service"); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "installed systemd user service: %s\n", servicePath)
	return nil
}

func installWindowsScheduledTask(binaryPath string, configPath string, stdout io.Writer) error {
	taskCommand := windowsScheduledTaskCommand(binaryPath, configPath)
	if err := runCommand("schtasks", "/Create", "/TN", windowsServiceName, "/TR", taskCommand, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"); err != nil {
		return fmt.Errorf("current user scheduled task could not be installed: %w", err)
	}
	_, _ = fmt.Fprintf(stdout, "installed scheduled task: %s\n", windowsServiceName)
	return nil
}

func runServiceStart(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("service start", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	if _, err := config.ResolvePath(*configPath); err != nil {
		return err
	}
	switch runtime.GOOS {
	case "darwin":
		return startLaunchAgent(stdout)
	case "linux":
		return startSystemdUserService(stdout)
	case "windows":
		return startWindowsService(stdout)
	default:
		return fmt.Errorf("service start is not implemented for %s", runtime.GOOS)
	}
}

func runServiceStop(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("service stop", flag.ContinueOnError)
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	switch runtime.GOOS {
	case "windows":
		return stopWindowsService(stdout)
	default:
		return fmt.Errorf("service stop is not implemented for %s", runtime.GOOS)
	}
}

func runServiceRun(args []string) error {
	flags := flag.NewFlagSet("service run", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	resolvedConfigPath, err := config.ResolvePath(*configPath)
	if err != nil {
		return err
	}
	return runWindowsService(resolvedConfigPath)
}

func runServiceInstallTask(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("service install-task", flag.ContinueOnError)
	configPath := flags.String("config", "", "collector config path")
	binaryPath := flags.String("binary", "", "collector binary path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	resolvedBinaryPath := *binaryPath
	if resolvedBinaryPath == "" {
		var err error
		resolvedBinaryPath, err = os.Executable()
		if err != nil {
			return err
		}
	}
	resolvedConfigPath, err := config.ResolvePath(*configPath)
	if err != nil {
		return err
	}
	return installWindowsScheduledTask(resolvedBinaryPath, resolvedConfigPath, stdout)
}

func runServiceStartTask(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("service start-task", flag.ContinueOnError)
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) > 0 {
		return errUsage
	}
	return startWindowsScheduledTask(stdout)
}

func startLaunchAgent(stdout io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	plistPath := filepath.Join(home, "Library", "LaunchAgents", "com.clawee.collector.plist")
	uid := fmt.Sprintf("gui/%d", os.Getuid())
	if err := runCommand("launchctl", "bootout", uid, plistPath); err != nil {
		observability.NewLogger(observability.Config{Color: true}).Warn("launchctl bootout ignored", "error", err)
	}
	if err := runCommand("launchctl", "bootstrap", uid, plistPath); err != nil {
		return err
	}
	if err := runCommand("launchctl", "kickstart", "-k", uid+"/com.clawee.collector"); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "started launch agent: %s\n", plistPath)
	return nil
}

func startSystemdUserService(stdout io.Writer) error {
	if err := runCommand("systemctl", "--user", "restart", "clawee-collector.service"); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(stdout, "started systemd user service: clawee-collector.service")
	return nil
}

func startWindowsScheduledTask(stdout io.Writer) error {
	if err := runCommand("schtasks", "/Run", "/TN", windowsServiceName); err != nil {
		return fmt.Errorf("current user scheduled task could not be started: %w", err)
	}
	_, _ = fmt.Fprintf(stdout, "started scheduled task: %s\n", windowsServiceName)
	return nil
}

func buildLaunchAgentPlist(binaryPath string, configPath string, logDir string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.clawee.collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>run</string>
    <string>--config</string>
    <string>%s</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`, binaryPath, configPath, filepath.Join(logDir, "stdout.log"), filepath.Join(logDir, "stderr.log"))
}

func buildSystemdUserService(binaryPath string, configPath string) string {
	return fmt.Sprintf(`[Unit]
Description=Clawee Collector
After=network-online.target

[Service]
Type=simple
ExecStart=%s run --config %s
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`, binaryPath, configPath)
}

func windowsScheduledTaskCommand(binaryPath string, configPath string) string {
	return fmt.Sprintf(`"%s" run --config "%s"`, binaryPath, configPath)
}

func postCollectorLivenessHeartbeat(reporter heartbeatReporter, cfg config.Config, sentAt time.Time) error {
	req := collectorapi.HeartbeatRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		CollectorID:      cfg.CollectorID,
		DeviceID:         cfg.DeviceID,
		SentAt:           sentAt,
		CollectorVersion: collectorVersion(),
		Agents:           []collectorapi.AgentSummary{},
	}
	if cfg.Debug {
		return reporter.PostHeartbeat(req)
	}
	return reporter.PostHeartbeatSilently(req)
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "workspace"
	}
	return wd
}
