package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/adapter/codex"
	"github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/setup/unixuser"
	"github.com/krillinai/Clawee/server/internal/collector/setup/windowsuser"
	collectorversion "github.com/krillinai/Clawee/server/internal/collector/version"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestRunRegisterRequiresOfficeURL(t *testing.T) {
	err := runRegister([]string{"--code", "ABCD-1234", "--config", "config.json"}, io.Discard)
	if err == nil || err.Error() != "--office-url is required" {
		t.Fatalf("err = %v", err)
	}
}

func TestUsageListsWindowsUserTwoPhaseCommands(t *testing.T) {
	for _, want := range []string{
		"setup windows-user prepare",
		"setup windows-user cleanup-runtime",
		"setup windows-user install-startup",
		"setup windows-user uninstall-prepare",
		"setup windows-user uninstall-startup",
		"--elevated",
	} {
		if !strings.Contains(usage, want) {
			t.Fatalf("usage missing %q:\n%s", want, usage)
		}
	}
}

func TestExecuteVersionPrintsCollectorVersion(t *testing.T) {
	for _, arg := range []string{"--version", "-version"} {
		t.Run(arg, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer

			code := Execute([]string{arg}, strings.NewReader(""), &stdout, &stderr)

			if code != 0 {
				t.Fatalf("code = %d, want 0; stderr=%s", code, stderr.String())
			}
			if got := strings.TrimSpace(stdout.String()); got != collectorversion.CollectorVersion() {
				t.Fatalf("stdout = %q, want %q", got, collectorversion.CollectorVersion())
			}
			if stderr.String() != "" {
				t.Fatalf("stderr = %q, want empty", stderr.String())
			}
		})
	}
}

func TestExecuteSetupWindowsUserCleanupRuntimePassesOptions(t *testing.T) {
	dir := t.TempDir()
	var got windowsuser.RuntimeCleanupOptions
	restore := setWindowsUserInstallerFactoryForTest(func() windowsUserInstaller {
		return windowsUserInstallerFunc{
			cleanupRuntime: func(ctx context.Context, options windowsuser.RuntimeCleanupOptions) (windowsuser.RuntimeCleanupResult, error) {
				got = options
				return windowsuser.RuntimeCleanupResult{
					DiagnosticsLog: filepath.Join(dir, "cleanup.log"),
					TaskRemoved:    true,
					LegacyService:  windowsuser.LegacyServiceStatus{Exists: true, Cleaned: true},
					HooksRemoved:   true,
				}, nil
			},
		}
	})
	defer restore()

	var stdout bytes.Buffer
	code := Execute([]string{
		"setup", "windows-user", "cleanup-runtime",
		"--binary", filepath.Join(dir, "clawee-collector.exe"),
		"--runner-binary", filepath.Join(dir, "clawee-collector-runner.exe"),
		"--config", filepath.Join(dir, "config.json"),
		"--codex-config", filepath.Join(dir, "config.toml"),
		"--elevated",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d stdout=%s", code, stdout.String())
	}
	if !got.Elevated {
		t.Fatalf("options = %#v", got)
	}
	if !strings.HasSuffix(got.RunnerBinaryPath, "clawee-collector-runner.exe") {
		t.Fatalf("options = %#v", got)
	}
	for _, want := range []string{"cleanup-runtime", "cleanup.log", "task_removed=true", "legacy_exists=true", "legacy_cleaned=true", "hooks_removed=true"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("stdout missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestExecuteSetupWindowsUserCleanupRuntimeReportsLegacyServiceRepair(t *testing.T) {
	dir := t.TempDir()
	diagPath := filepath.Join(dir, "cleanup.log")
	restore := setWindowsUserInstallerFactoryForTest(func() windowsUserInstaller {
		return windowsUserInstallerFunc{
			cleanupRuntime: func(ctx context.Context, options windowsuser.RuntimeCleanupOptions) (windowsuser.RuntimeCleanupResult, error) {
				return windowsuser.RuntimeCleanupResult{
					DiagnosticsLog: diagPath,
					TaskRemoved:    true,
					LegacyService:  windowsuser.LegacyServiceStatus{Exists: true, Error: "Access is denied."},
				}, errors.New("Access is denied.")
			},
		}
	})
	defer restore()

	var stdout bytes.Buffer
	code := Execute([]string{
		"setup", "windows-user", "cleanup-runtime",
		"--binary", filepath.Join(dir, "clawee-collector.exe"),
		"--runner-binary", filepath.Join(dir, "clawee-collector-runner.exe"),
		"--config", filepath.Join(dir, "config.json"),
		"--codex-config", filepath.Join(dir, "config.toml"),
		"--elevated",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 1 {
		t.Fatalf("code = %d stdout=%s", code, stdout.String())
	}
	for _, want := range []string{
		"安装已停止，未覆盖正式二进制",
		"请使用管理员 PowerShell 执行:",
		"sc.exe stop ClaweeCollector",
		"sc.exe delete ClaweeCollector",
		diagPath,
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("stdout missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestExecuteSetupWindowsUserInstallPassesOptionsToInstaller(t *testing.T) {
	var got windowsuser.Options
	restore := setWindowsUserInstallerFactoryForTest(func() windowsUserInstaller {
		return windowsUserInstallerFunc{
			install: func(ctx context.Context, options windowsuser.Options) (windowsuser.Result, error) {
				got = options
				return windowsuser.Result{
					DiagnosticsLog: filepath.Join(t.TempDir(), "install.log"),
					Status: windowsuser.StatusSummary{
						Installed:        true,
						StartupInstalled: true,
						Running:          true,
						Connected:        true,
						TaskUsesRunner:   true,
						CodexReady:       true,
					},
				}, nil
			},
		}
	})
	defer restore()

	var stdout bytes.Buffer
	code := Execute([]string{
		"setup", "windows-user", "install",
		"--office-url", "http://office.local",
		"--code", "reg_123",
		"--binary", filepath.Join(t.TempDir(), "clawee-collector.exe"),
		"--runner-binary", filepath.Join(t.TempDir(), "clawee-collector-runner.exe"),
		"--config", filepath.Join(t.TempDir(), "config.json"),
		"--codex-config", filepath.Join(t.TempDir(), "config.toml"),
		"--workspace", "workspace-a",
		"--agent-name", "Codex Windows",
		"--reset-identity",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if got.OfficeURL != "http://office.local" || got.RegistrationCode != "reg_123" {
		t.Fatalf("options = %#v", got)
	}
	if !strings.HasSuffix(got.RunnerBinaryPath, "clawee-collector-runner.exe") {
		t.Fatalf("options = %#v", got)
	}
	if got.Workspace != "workspace-a" {
		t.Fatalf("options = %#v", got)
	}
	if !got.ResetIdentity || !strings.Contains(stdout.String(), "本机将重新注册并轮换采集器凭据") {
		t.Fatalf("reset output/options mismatch: options=%#v stdout=%s", got, stdout.String())
	}
	for _, want := range []string{"installed=true", "startup_installed=true", "running=true", "heartbeat_ok=true", "task_uses_runner=true", "codex_ready=true"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("stdout missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestExecuteSetupWindowsUserPreparePassesOptionsToInstaller(t *testing.T) {
	var got windowsuser.Options
	restore := setWindowsUserInstallerFactoryForTest(func() windowsUserInstaller {
		return windowsUserInstallerFunc{
			prepare: func(ctx context.Context, options windowsuser.Options) (windowsuser.Result, error) {
				got = options
				return windowsuser.Result{
					DiagnosticsLog: filepath.Join(t.TempDir(), "prepare.log"),
					Status:         windowsuser.StatusSummary{Prepared: true, CodexReady: true},
				}, nil
			},
		}
	})
	defer restore()

	code := Execute([]string{
		"setup", "windows-user", "prepare",
		"--office-url", "http://office.local",
		"--code", "reg_123",
		"--binary", filepath.Join(t.TempDir(), "clawee-collector.exe"),
		"--runner-binary", filepath.Join(t.TempDir(), "clawee-collector-runner.exe"),
		"--config", filepath.Join(t.TempDir(), "config.json"),
		"--codex-config", filepath.Join(t.TempDir(), "config.toml"),
		"--workspace", "workspace-a",
		"--agent-name", "Codex Windows",
	}, strings.NewReader(""), io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if got.OfficeURL != "http://office.local" || got.RegistrationCode != "reg_123" {
		t.Fatalf("options = %#v", got)
	}
	if got.Workspace != "workspace-a" {
		t.Fatalf("options = %#v", got)
	}
}

func TestExecuteSetupWindowsUserInstallStartupPassesOptionsToInstaller(t *testing.T) {
	var got windowsuser.StartupOptions
	restore := setWindowsUserInstallerFactoryForTest(func() windowsUserInstaller {
		return windowsUserInstallerFunc{
			installStartup: func(ctx context.Context, options windowsuser.StartupOptions) (windowsuser.Result, error) {
				got = options
				return windowsuser.Result{
					DiagnosticsLog: filepath.Join(t.TempDir(), "startup.log"),
					Status:         windowsuser.StatusSummary{StartupInstalled: true, StartupElevated: true, Running: true, Connected: true, TaskUsesRunner: true},
				}, nil
			},
		}
	})
	defer restore()

	code := Execute([]string{
		"setup", "windows-user", "install-startup",
		"--binary", filepath.Join(t.TempDir(), "clawee-collector.exe"),
		"--runner-binary", filepath.Join(t.TempDir(), "clawee-collector-runner.exe"),
		"--config", filepath.Join(t.TempDir(), "config.json"),
		"--codex-config", filepath.Join(t.TempDir(), "config.toml"),
		"--elevated",
	}, strings.NewReader(""), io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if !got.Elevated {
		t.Fatalf("options = %#v, want elevated", got)
	}
	if !strings.HasSuffix(got.RunnerBinaryPath, "clawee-collector-runner.exe") {
		t.Fatalf("options = %#v", got)
	}
}

func TestExecuteSetupWindowsUserInstallStartupReportsVerificationFields(t *testing.T) {
	restore := setWindowsUserInstallerFactoryForTest(func() windowsUserInstaller {
		return windowsUserInstallerFunc{
			installStartup: func(ctx context.Context, options windowsuser.StartupOptions) (windowsuser.Result, error) {
				return windowsuser.Result{
					DiagnosticsLog: filepath.Join(t.TempDir(), "startup.log"),
					Status:         windowsuser.StatusSummary{StartupInstalled: true, StartupElevated: true, Running: true, Connected: true, TaskUsesRunner: true},
				}, nil
			},
		}
	})
	defer restore()

	var stdout bytes.Buffer
	code := Execute([]string{
		"setup", "windows-user", "install-startup",
		"--binary", filepath.Join(t.TempDir(), "clawee-collector.exe"),
		"--runner-binary", filepath.Join(t.TempDir(), "clawee-collector-runner.exe"),
		"--config", filepath.Join(t.TempDir(), "config.json"),
		"--codex-config", filepath.Join(t.TempDir(), "config.toml"),
		"--elevated",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d stdout=%s", code, stdout.String())
	}
	for _, want := range []string{"状态:", "running=true", "health_ok=true", "heartbeat_ok=true", "task_uses_runner=true"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("stdout missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestRunSetupUnixUserPrepareParsesFlags(t *testing.T) {
	var got unixuser.Options
	restore := setUnixUserInstallerFactoryForTest(func() unixUserInstaller {
		return unixUserInstallerFunc{
			prepare: func(ctx context.Context, options unixuser.Options) (unixuser.Result, error) {
				got = options
				return unixuser.Result{Status: unixuser.StatusSummary{Prepared: true, CodexReady: true}, DiagnosticsLog: "/tmp/diag.log"}, nil
			},
		}
	})
	defer restore()
	var out bytes.Buffer

	err := runSetup([]string{"unix-user", "prepare", "--office-url", "https://office.example", "--code", "reg_xxx", "--binary", "/tmp/clawee-collector", "--config", "/tmp/config.json", "--codex-config", "/tmp/config.toml", "--workspace", "repo", "--agent-name", "Codex Local", "--reset-identity"}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if got.OfficeURL != "https://office.example" || got.RegistrationCode != "reg_xxx" || got.BinaryPath != "/tmp/clawee-collector" || got.ConfigPath != "/tmp/config.json" || got.Workspace != "repo" {
		t.Fatalf("options = %#v", got)
	}
	if got.CodexConfigPath != "/tmp/config.toml" || !got.ResetIdentity {
		t.Fatalf("options = %#v", got)
	}
	if !strings.Contains(out.String(), "Unix 当前用户采集器准备阶段完成") {
		t.Fatalf("output = %s", out.String())
	}
}

func TestRunSetupUnixUserInstallStartupPrintsHealthHeartbeat(t *testing.T) {
	var got unixuser.StartupOptions
	restore := setUnixUserInstallerFactoryForTest(func() unixUserInstaller {
		return unixUserInstallerFunc{
			installStartup: func(ctx context.Context, options unixuser.StartupOptions) (unixuser.Result, error) {
				got = options
				return unixuser.Result{DiagnosticsLog: "/tmp/diag.log", Status: unixuser.StatusSummary{Running: true, HealthOK: true, HeartbeatOK: true, StartupInstalled: true}}, nil
			},
		}
	})
	defer restore()
	var out bytes.Buffer

	err := runSetup([]string{"unix-user", "install-startup", "--binary", "/tmp/clawee-collector", "--config", "/tmp/config.json", "--codex-config", "/tmp/config.toml"}, &out)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"running=true", "health_ok=true", "heartbeat_ok=true"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in output:\n%s", want, out.String())
		}
	}
	if got.CodexConfigPath != "/tmp/config.toml" || got.BinaryPath != "/tmp/clawee-collector" {
		t.Fatalf("options = %#v", got)
	}
}

func TestExecuteSetupUnixUserInstallPassesOptionsToInstaller(t *testing.T) {
	var got unixuser.Options
	restore := setUnixUserInstallerFactoryForTest(func() unixUserInstaller {
		return unixUserInstallerFunc{
			install: func(ctx context.Context, options unixuser.Options) (unixuser.Result, error) {
				got = options
				return unixuser.Result{
					DiagnosticsLog: filepath.Join(t.TempDir(), "install.log"),
					Status:         unixuser.StatusSummary{Running: true, HealthOK: true, HeartbeatOK: true, StartupInstalled: true},
				}, nil
			},
		}
	})
	defer restore()

	var stdout bytes.Buffer
	code := Execute([]string{
		"setup", "unix-user", "install",
		"--office-url", "https://office.example",
		"--code", "reg_xxx",
		"--binary", "/tmp/clawee-collector",
		"--config", "/tmp/config.json",
		"--codex-config", "/tmp/config.toml",
		"--workspace", "repo",
		"--agent-name", "Codex Local",
		"--reset-identity",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d stdout=%s", code, stdout.String())
	}
	if got.OfficeURL != "https://office.example" || got.RegistrationCode != "reg_xxx" || got.BinaryPath != "/tmp/clawee-collector" || got.ConfigPath != "/tmp/config.json" {
		t.Fatalf("options = %#v", got)
	}
	if got.CodexConfigPath != "/tmp/config.toml" || got.Workspace != "repo" || !got.ResetIdentity {
		t.Fatalf("options = %#v", got)
	}
	if !strings.Contains(stdout.String(), "startup_installed=true") {
		t.Fatalf("stdout missing startup summary:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "本机将重新注册并轮换采集器凭据") {
		t.Fatalf("stdout missing reset credentials message:\n%s", stdout.String())
	}
}

func TestExecuteSetupUnixUserCleanupRuntimePassesOptionsToInstaller(t *testing.T) {
	var got unixuser.RuntimeCleanupOptions
	restore := setUnixUserInstallerFactoryForTest(func() unixUserInstaller {
		return unixUserInstallerFunc{
			cleanupRuntime: func(ctx context.Context, options unixuser.RuntimeCleanupOptions) (unixuser.RuntimeCleanupResult, error) {
				got = options
				return unixuser.RuntimeCleanupResult{
					DiagnosticsLog: filepath.Join(t.TempDir(), "cleanup.log"),
					StartupRemoved: true,
					HooksRemoved:   true,
				}, nil
			},
		}
	})
	defer restore()

	var stdout bytes.Buffer
	code := Execute([]string{
		"setup", "unix-user", "cleanup-runtime",
		"--binary", "/tmp/clawee-collector",
		"--config", "/tmp/config.json",
		"--codex-config", "/tmp/config.toml",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d stdout=%s", code, stdout.String())
	}
	if got.BinaryPath != "/tmp/clawee-collector" || got.ConfigPath != "/tmp/config.json" || got.CodexConfigPath != "/tmp/config.toml" {
		t.Fatalf("options = %#v", got)
	}
	if !strings.Contains(stdout.String(), "Unix 当前用户采集器旧运行面清理完成 cleanup-runtime") {
		t.Fatalf("stdout missing cleanup summary:\n%s", stdout.String())
	}
}

func TestExecuteSetupUnixUserDiagnoseWritesJSON(t *testing.T) {
	var got unixuser.DiagnoseOptions
	restore := setUnixUserInstallerFactoryForTest(func() unixUserInstaller {
		return unixUserInstallerFunc{
			diagnose: func(ctx context.Context, options unixuser.DiagnoseOptions) (unixuser.DiagnoseResult, error) {
				got = options
				return unixuser.DiagnoseResult{JSON: `{"installed":true}`, Text: "text"}, nil
			},
		}
	})
	defer restore()

	var stdout bytes.Buffer
	code := Execute([]string{
		"setup", "unix-user", "diagnose",
		"--config", "/tmp/config.json",
		"--codex-config", "/tmp/config.toml",
		"--json",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d stdout=%s", code, stdout.String())
	}
	if !got.JSON {
		t.Fatalf("options = %#v", got)
	}
	if strings.TrimSpace(stdout.String()) != `{"installed":true}` {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestExecuteSetupUnixUserInstallReportsDiagnosticsOnFailure(t *testing.T) {
	diagPath := filepath.Join(t.TempDir(), "install.log")
	restore := setUnixUserInstallerFactoryForTest(func() unixUserInstaller {
		return unixUserInstallerFunc{
			install: func(ctx context.Context, options unixuser.Options) (unixuser.Result, error) {
				return unixuser.Result{DiagnosticsLog: diagPath}, errors.New("boom")
			},
		}
	})
	defer restore()

	var stdout bytes.Buffer
	code := Execute([]string{
		"setup", "unix-user", "install",
		"--office-url", "https://office.example",
		"--code", "reg_xxx",
		"--binary", "/tmp/clawee-collector",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	if !strings.Contains(stdout.String(), diagPath) {
		t.Fatalf("stdout missing diagnostics path:\n%s", stdout.String())
	}
}

func TestExecuteSetupWindowsUserInstallRejectsUnknownAction(t *testing.T) {
	code := Execute([]string{"setup", "windows-user", "repair"}, strings.NewReader(""), io.Discard, io.Discard)
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
}

func TestExecuteSetupWindowsUserInstallReportsDiagnosticsOnFailure(t *testing.T) {
	diagPath := filepath.Join(t.TempDir(), "install.log")
	restore := setWindowsUserInstallerFactoryForTest(func() windowsUserInstaller {
		return windowsUserInstallerFunc{
			install: func(ctx context.Context, options windowsuser.Options) (windowsuser.Result, error) {
				return windowsuser.Result{DiagnosticsLog: diagPath}, errors.New("boom")
			},
		}
	})
	defer restore()
	var stdout bytes.Buffer

	code := Execute([]string{
		"setup", "windows-user", "install",
		"--office-url", "http://office.local",
		"--code", "reg_123",
		"--binary", filepath.Join(t.TempDir(), "clawee-collector.exe"),
		"--runner-binary", filepath.Join(t.TempDir(), "clawee-collector-runner.exe"),
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	if !strings.Contains(stdout.String(), diagPath) {
		t.Fatalf("stdout missing diagnostics path: %s", stdout.String())
	}
}

func TestExecuteSetupWindowsUserInstallReportsKnownStartupAccessDenied(t *testing.T) {
	diagPath := filepath.Join(t.TempDir(), "startup.log")
	restore := setWindowsUserInstallerFactoryForTest(func() windowsUserInstaller {
		return windowsUserInstallerFunc{
			install: func(ctx context.Context, options windowsuser.Options) (windowsuser.Result, error) {
				return windowsuser.Result{
					DiagnosticsLog: diagPath,
					Status: windowsuser.StatusSummary{
						Prepared:         true,
						StartupErrorCode: "onlogon_task_access_denied",
						SuggestedAction:  "请使用管理员 PowerShell 重新执行 setup windows-user install-startup",
					},
				}, errors.New("ERROR: Access is denied.")
			},
		}
	})
	defer restore()
	var stdout bytes.Buffer

	code := Execute([]string{
		"setup", "windows-user", "install",
		"--office-url", "http://office.local",
		"--code", "reg_123",
		"--binary", filepath.Join(t.TempDir(), "clawee-collector.exe"),
		"--runner-binary", filepath.Join(t.TempDir(), "clawee-collector-runner.exe"),
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 1 {
		t.Fatalf("code = %d, want 1", code)
	}
	for _, want := range []string{diagPath, "prepared=true running=false connected=false", "onlogon_task_access_denied", "install-startup"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("stdout missing %q: %s", want, stdout.String())
		}
	}
}

func TestExecuteSetupWindowsUserUninstallPassesOptionsToUninstaller(t *testing.T) {
	var got windowsuser.UninstallOptions
	restore := setWindowsUserUninstallerFactoryForTest(func() windowsUserUninstaller {
		return windowsUserUninstallerFunc{
			uninstall: func(ctx context.Context, options windowsuser.UninstallOptions) (windowsuser.UninstallResult, error) {
				got = options
				return windowsuser.UninstallResult{DiagnosticsLog: filepath.Join(t.TempDir(), "install.log"), HooksRemoved: true, TaskRemoved: true, Purged: true}, nil
			},
		}
	})
	defer restore()

	code := Execute([]string{
		"setup", "windows-user", "uninstall",
		"--config", "collector.json",
		"--codex-config", "config.toml",
		"--purge",
		"--backup",
	}, strings.NewReader(""), io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if got.ConfigPath != "collector.json" || got.CodexConfigPath != "config.toml" || !got.Purge || !got.Backup {
		t.Fatalf("options = %#v", got)
	}
}

func TestExecuteSetupWindowsUserUninstallPreparePassesOptionsToUninstaller(t *testing.T) {
	var got windowsuser.UninstallOptions
	restore := setWindowsUserUninstallerFactoryForTest(func() windowsUserUninstaller {
		return windowsUserUninstallerFunc{
			prepare: func(ctx context.Context, options windowsuser.UninstallOptions) (windowsuser.UninstallResult, error) {
				got = options
				return windowsuser.UninstallResult{DiagnosticsLog: filepath.Join(t.TempDir(), "prepare.log"), HooksRemoved: true}, nil
			},
		}
	})
	defer restore()

	code := Execute([]string{
		"setup", "windows-user", "uninstall-prepare",
		"--config", "collector.json",
		"--codex-config", "config.toml",
	}, strings.NewReader(""), io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if got.ConfigPath != "collector.json" || got.CodexConfigPath != "config.toml" {
		t.Fatalf("options = %#v", got)
	}
	if got.Purge || got.Backup {
		t.Fatalf("prepare should not set purge/backup: %#v", got)
	}
}

func TestExecuteSetupWindowsUserUninstallStartupPassesOptionsToUninstaller(t *testing.T) {
	var got windowsuser.UninstallOptions
	restore := setWindowsUserUninstallerFactoryForTest(func() windowsUserUninstaller {
		return windowsUserUninstallerFunc{
			startup: func(ctx context.Context, options windowsuser.UninstallOptions) (windowsuser.UninstallResult, error) {
				got = options
				return windowsuser.UninstallResult{DiagnosticsLog: filepath.Join(t.TempDir(), "startup.log"), TaskRemoved: true, Purged: true}, nil
			},
		}
	})
	defer restore()

	code := Execute([]string{
		"setup", "windows-user", "uninstall-startup",
		"--config", "collector.json",
		"--codex-config", "config.toml",
		"--purge",
		"--backup",
	}, strings.NewReader(""), io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if got.ConfigPath != "collector.json" || got.CodexConfigPath != "config.toml" || !got.Purge || !got.Backup {
		t.Fatalf("options = %#v", got)
	}
}

func TestExecuteSetupWindowsUserDiagnoseWritesJSON(t *testing.T) {
	restore := setWindowsUserDiagnoserFactoryForTest(func() windowsUserDiagnoser {
		return windowsUserDiagnoserFunc(func(ctx context.Context, options windowsuser.DiagnoseOptions) (windowsuser.DiagnoseResult, error) {
			return windowsuser.DiagnoseResult{JSON: `{"installed":true}`, Text: "text"}, nil
		})
	})
	defer restore()
	var stdout bytes.Buffer

	code := Execute([]string{"setup", "windows-user", "diagnose", "--json"}, strings.NewReader(""), &stdout, io.Discard)
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if strings.TrimSpace(stdout.String()) != `{"installed":true}` {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func setTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOMEDRIVE", "")
	t.Setenv("HOMEPATH", home)
	return home
}

func setTestClaweeAgentConfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "clawee-agent", "config.toml")
	t.Setenv("CLAWEE_AGENT_CONFIG", path)
	return path
}

func TestRunCodexHooksEnsureWritesConfig(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	codexConfigPath := filepath.Join(dir, "config.toml")
	var stdout bytes.Buffer

	code := Execute([]string{
		"codex", "hooks", "ensure",
		"--codex-config", codexConfigPath,
		"--binary", "/opt/clawee/clawee-collector",
	}, strings.NewReader(""), &stdout, io.Discard)
	if code != 0 {
		t.Fatalf("Execute code = %d, want 0", code)
	}

	bodyBytes, err := os.ReadFile(codexConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	if !strings.Contains(body, `command = "\"/opt/clawee/clawee-collector\" hook codex"`) {
		t.Fatalf("config missing default hook command:\n%s", body)
	}
	if strings.Contains(body, "--config") {
		t.Fatalf("default command should not include --config:\n%s", body)
	}
	if got := stdout.String(); !strings.Contains(got, "已更新 Codex 钩子配置:") {
		t.Fatalf("stdout = %q, want Chinese success message", got)
	}
}

func TestRunCodexHooksEnsureIncludesExplicitCollectorConfig(t *testing.T) {
	home := setTestHome(t)
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	codexConfigPath := filepath.Join(dir, "config.toml")
	customCollectorConfig := filepath.Join(home, "custom", "config.json")

	code := Execute([]string{
		"codex", "hooks", "ensure",
		"--codex-config", codexConfigPath,
		"--collector-config", customCollectorConfig,
		"--binary", "/opt/clawee/clawee-collector",
	}, strings.NewReader(""), io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("Execute code = %d, want 0", code)
	}

	bodyBytes, err := os.ReadFile(codexConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	if !strings.Contains(body, "--config") {
		t.Fatalf("config missing explicit collector config:\n%s", body)
	}
	if !strings.Contains(body, customCollectorConfig) && !strings.Contains(body, tomlEscapedPath(customCollectorConfig)) {
		t.Fatalf("config missing explicit collector config path:\n%s", body)
	}
}

func TestPostCollectorLivenessHeartbeatUsesSilentReport(t *testing.T) {
	reporter := &fakeHeartbeatReporter{}
	sentAt := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	cfg := config.Config{
		CollectorID: "collector_123",
		DeviceID:    "device_123",
	}

	if err := postCollectorLivenessHeartbeat(reporter, cfg, sentAt); err != nil {
		t.Fatal(err)
	}

	if len(reporter.heartbeats) != 0 {
		t.Fatalf("regular heartbeats = %d, want 0", len(reporter.heartbeats))
	}
	if len(reporter.silentHeartbeats) != 1 {
		t.Fatalf("silent heartbeats = %d, want 1", len(reporter.silentHeartbeats))
	}
	got := reporter.silentHeartbeats[0]
	if got.CollectorID != "collector_123" {
		t.Fatalf("CollectorID = %q", got.CollectorID)
	}
	if got.DeviceID != "device_123" {
		t.Fatalf("DeviceID = %q", got.DeviceID)
	}
	if !got.SentAt.Equal(sentAt) {
		t.Fatalf("SentAt = %s, want %s", got.SentAt, sentAt)
	}
	if len(got.Agents) != 0 {
		t.Fatalf("Agents = %#v, want empty", got.Agents)
	}
}

func TestPostCollectorLivenessHeartbeatUsesLoggedReportInDebug(t *testing.T) {
	reporter := &fakeHeartbeatReporter{}
	sentAt := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	cfg := config.Config{
		CollectorID: "collector_123",
		DeviceID:    "device_123",
		Debug:       true,
	}

	if err := postCollectorLivenessHeartbeat(reporter, cfg, sentAt); err != nil {
		t.Fatal(err)
	}

	if len(reporter.heartbeats) != 1 {
		t.Fatalf("regular heartbeats = %d, want 1", len(reporter.heartbeats))
	}
	if len(reporter.silentHeartbeats) != 0 {
		t.Fatalf("silent heartbeats = %d, want 0", len(reporter.silentHeartbeats))
	}
}

func TestRunHookCodexPostsStdinToLocalIngest(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_LISTEN_ADDR", "")
	t.Setenv("AGENT_OFFICE_LISTEN_ADDR", "")

	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ingest/codex" {
			t.Fatalf("path = %s, want /ingest/codex", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		gotBody = string(body)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		ListenAddr:     strings.TrimPrefix(server.URL, "http://"),
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	payload := `{"hook_event_name":"SessionStart","session_id":"s1"}`
	err := runHook([]string{"codex", "--config", configPath}, strings.NewReader(payload), io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	if gotBody != payload {
		t.Fatalf("body = %q, want %q", gotBody, payload)
	}
}

func TestPostLocalIngestUsesLoopbackWhenListeningOnAllInterfaces(t *testing.T) {
	previousClient := localIngestHTTPClient
	var gotHost string
	localIngestHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotHost = req.URL.Host
		return &http.Response{
			StatusCode: http.StatusAccepted,
			Body:       io.NopCloser(strings.NewReader("")),
			Header:     make(http.Header),
		}, nil
	})}
	t.Cleanup(func() {
		localIngestHTTPClient = previousClient
	})

	err := postLocalIngest(context.Background(), "0.0.0.0:1905", "codex", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if gotHost != "127.0.0.1:1905" {
		t.Fatalf("request Host = %q, want 127.0.0.1:1905", gotHost)
	}
}

func TestHookCodexCommandWorksWithCodexIngestHandler(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_LISTEN_ADDR", "")
	t.Setenv("AGENT_OFFICE_LISTEN_ADDR", "")

	eventsReceived := make(chan []collectorapi.CollectorEvent, 1)
	sink := eventSinkFunc(func(events []collectorapi.CollectorEvent) {
		eventsReceived <- events
	})
	server := httptest.NewServer(codex.NewHookServer(codex.MapperConfig{
		DeviceID: "device_123",
		Now:      time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC),
	}, sink, nil).Handler())
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		ListenAddr:     strings.TrimPrefix(server.URL, "http://"),
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	payload := `{
		"hook_event_name":"PreToolUse",
		"session_id":"session-1",
		"turn_id":"turn-1",
		"tool_use_id":"tool-read",
		"tool_name":"Read"
	}`
	if err := runHook([]string{"codex", "--config", configPath}, strings.NewReader(payload), io.Discard); err != nil {
		t.Fatal(err)
	}

	select {
	case events := <-eventsReceived:
		if len(events) != 1 {
			t.Fatalf("events length = %d, want 1", len(events))
		}
		if events[0].Status != collectorapi.StatusReadingFiles {
			t.Fatalf("status = %q, want %q", events[0].Status, collectorapi.StatusReadingFiles)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("timed out waiting for codex ingest events")
	}
}

func TestRunHookCodexReturnsNilWhenDaemonUnavailable(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_LISTEN_ADDR", "")
	t.Setenv("AGENT_OFFICE_LISTEN_ADDR", "")

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		ListenAddr:     "127.0.0.1:1",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	err := runHook([]string{"codex", "--config", configPath}, strings.NewReader(`{"hook_event_name":"SessionStart"}`), io.Discard)
	if err != nil {
		t.Fatalf("runHook returned %v, want nil so Codex is not interrupted", err)
	}
}

func TestRunHookCodexDrainsPipeBeforeReturning(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_LISTEN_ADDR", "")
	t.Setenv("AGENT_OFFICE_LISTEN_ADDR", "")

	var ingestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ingestCount.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		ListenAddr:     strings.TrimPrefix(server.URL, "http://"),
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name       string
		size       int
		wantIngest bool
	}{
		{name: "117 KB", size: 117 * 1024, wantIngest: true},
		{name: "limit minus one", size: maxHookPayloadBytes - 1, wantIngest: true},
		{name: "limit", size: maxHookPayloadBytes, wantIngest: true},
		{name: "limit plus one", size: maxHookPayloadBytes + 1, wantIngest: false},
		{name: "4 MiB", size: 4 << 20, wantIngest: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := ingestCount.Load()
			var stderr bytes.Buffer
			writeErr, hookErr := runHookThroughPipe(
				t,
				[]string{"codex", "--config", configPath},
				hookPayloadWithSize(t, tt.size),
				&stderr,
			)
			if writeErr != nil {
				t.Fatalf("pipe writer failed: %v", writeErr)
			}
			if hookErr != nil {
				t.Fatalf("hook failed: %v", hookErr)
			}
			gotIngest := ingestCount.Load() == before+1
			if gotIngest != tt.wantIngest {
				t.Fatalf("ingest = %v, want %v", gotIngest, tt.wantIngest)
			}
			if !tt.wantIngest && !strings.Contains(stderr.String(), "codex hook payload exceeded limit") {
				t.Fatalf("stderr missing payload limit warning: %s", stderr.String())
			}
		})
	}
}

func TestRunHookCodexDrainsPipeOnEarlyReturnPaths(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_LISTEN_ADDR", "")
	t.Setenv("AGENT_OFFICE_LISTEN_ADDR", "")

	server := httptest.NewServer(codex.NewHookServer(codex.MapperConfig{
		DeviceID: "device_123",
		Now:      time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC),
	}, eventSinkFunc(func([]collectorapi.CollectorEvent) {}), nil).Handler())
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		ListenAddr:     strings.TrimPrefix(server.URL, "http://"),
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}
	unavailableConfigPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(unavailableConfigPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		ListenAddr:     "127.0.0.1:1",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}
	invalidConfigPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(invalidConfigPath, []byte(`{"office_url":`), 0o600); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name        string
		args        []string
		payload     []byte
		wantHookErr bool
	}{
		{name: "invalid JSON", args: []string{"codex", "--config", configPath}, payload: []byte(`{"hook_event_name":`)},
		{name: "unsupported event", args: []string{"codex", "--config", configPath}, payload: []byte(`{"hook_event_name":"FutureEvent"}`)},
		{name: "ingest failure", args: []string{"codex", "--config", unavailableConfigPath}, payload: hookPayloadWithSize(t, 117*1024)},
		{name: "missing config", args: []string{"codex", "--config", filepath.Join(t.TempDir(), "missing.json")}, payload: hookPayloadWithSize(t, 117*1024), wantHookErr: true},
		{name: "invalid config", args: []string{"codex", "--config", invalidConfigPath}, payload: hookPayloadWithSize(t, 117*1024), wantHookErr: true},
		{name: "unsupported agent", args: []string{"unknown"}, payload: hookPayloadWithSize(t, 117*1024), wantHookErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			writeErr, hookErr := runHookThroughPipe(t, tt.args, tt.payload, io.Discard)
			if writeErr != nil {
				t.Fatalf("pipe writer failed: %v", writeErr)
			}
			if (hookErr != nil) != tt.wantHookErr {
				t.Fatalf("hook error = %v, want error %v", hookErr, tt.wantHookErr)
			}
		})
	}
}

func TestRunHookTimeoutCancelsProcessingAfterStdinIsDrained(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_LISTEN_ADDR", "")
	t.Setenv("AGENT_OFFICE_LISTEN_ADDR", "")

	requestStarted := make(chan struct{})
	requestCanceled := make(chan struct{})
	releaseRequest := make(chan struct{})
	previousClient := localIngestHTTPClient
	localIngestHTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		close(requestStarted)
		select {
		case <-req.Context().Done():
			close(requestCanceled)
			return nil, req.Context().Err()
		case <-releaseRequest:
			return nil, errors.New("request released by test cleanup")
		}
	})}
	t.Cleanup(func() {
		localIngestHTTPClient = previousClient
		close(releaseRequest)
	})

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		ListenAddr:     "127.0.0.1:1905",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	err := runHookWithTimeout(
		[]string{"codex", "--config", configPath},
		strings.NewReader(`{"hook_event_name":"PostToolUse"}`),
		10*time.Millisecond,
		io.Discard,
	)
	if err != nil {
		t.Fatalf("runHookWithTimeout returned %v, want nil so Codex is not interrupted", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("runHookWithTimeout took %s, want it to stop after the timeout", elapsed)
	}
	select {
	case <-requestStarted:
	default:
		t.Fatal("local ingest request did not start")
	}
	select {
	case <-requestCanceled:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for local ingest request cancellation")
	}
}

func TestRunHookRejectsUnknownAgentType(t *testing.T) {
	err := runHook([]string{"unknown"}, strings.NewReader(`{}`), io.Discard)
	if err == nil || err.Error() != "unsupported hook agent type: unknown" {
		t.Fatalf("err = %v", err)
	}
}

func runHookThroughPipe(t *testing.T, args []string, payload []byte, stderr io.Writer) (error, error) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}

	hookDone := make(chan error, 1)
	go func() {
		hookErr := runHook(args, reader, stderr)
		_ = reader.Close()
		hookDone <- hookErr
	}()

	writeDone := make(chan error, 1)
	go func() {
		_, writeErr := writer.Write(payload)
		if closeErr := writer.Close(); writeErr == nil {
			writeErr = closeErr
		}
		writeDone <- writeErr
	}()

	var writeErr error
	select {
	case writeErr = <-writeDone:
	case <-time.After(3 * time.Second):
		_ = writer.Close()
		_ = reader.Close()
		t.Fatal("timed out waiting for pipe writer")
	}

	select {
	case hookErr := <-hookDone:
		return writeErr, hookErr
	case <-time.After(3 * time.Second):
		_ = reader.Close()
		t.Fatal("timed out waiting for hook")
		return nil, nil
	}
}

func hookPayloadWithSize(t *testing.T, size int) []byte {
	t.Helper()
	prefix := []byte(`{"hook_event_name":"PostToolUse","tool_response":"`)
	suffix := []byte(`"}`)
	if size < len(prefix)+len(suffix) {
		t.Fatalf("payload size %d is too small", size)
	}
	payload := make([]byte, 0, size)
	payload = append(payload, prefix...)
	payload = append(payload, bytes.Repeat([]byte("x"), size-len(prefix)-len(suffix))...)
	payload = append(payload, suffix...)
	return payload
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type fakeHeartbeatReporter struct {
	heartbeats       []collectorapi.HeartbeatRequest
	silentHeartbeats []collectorapi.HeartbeatRequest
}

type eventSinkFunc func([]collectorapi.CollectorEvent)

func (f eventSinkFunc) Accept(events []collectorapi.CollectorEvent) {
	f(events)
}

func (r *fakeHeartbeatReporter) PostHeartbeat(req collectorapi.HeartbeatRequest) error {
	r.heartbeats = append(r.heartbeats, req)
	return nil
}

func (r *fakeHeartbeatReporter) PostHeartbeatSilently(req collectorapi.HeartbeatRequest) error {
	r.silentHeartbeats = append(r.silentHeartbeats, req)
	return nil
}

func TestRunRegisterRequiresCode(t *testing.T) {
	err := runRegister([]string{"--office-url", "http://office.local", "--config", "config.json"}, io.Discard)
	if err == nil || err.Error() != "--code is required" {
		t.Fatalf("err = %v", err)
	}
}

func TestRunRegisterDefaultsConfigPathToClaweeCollector(t *testing.T) {
	home := setTestHome(t)
	setTestClaweeAgentConfig(t)
	t.Setenv("CLAWEE_COLLECTOR_CONFIG", "")
	t.Setenv("AO_COLLECTOR_CONFIG", "")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/collector/register":
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(collectorapi.RegistrationResponse{
				CollectorID:    "collector_123",
				CollectorToken: "collector_token",
				DeviceID:       "device_123",
				PrivacyMode:    "summary_only",
			})
		case "/api/v1/collector/heartbeat":
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{Accepted: true})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	err := runRegister([]string{
		"--office-url", server.URL,
		"--code", "ABCD-1234",
		"--workspace", "workspace-a",
		"--agent-name", "徐刚的Mini Codex",
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	configPath := filepath.Join(home, ".clawee", "collector", "config.toml")
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CollectorID != "collector_123" {
		t.Fatalf("CollectorID = %q", cfg.CollectorID)
	}
}

func TestRunRegisterIgnoresDeprecatedAgentNameEnv(t *testing.T) {
	setTestClaweeAgentConfig(t)
	t.Setenv("CLAWEE_AGENT_NAME", "Env Codex")

	var gotRegister collectorapi.RegistrationRequest
	var gotHeartbeat collectorapi.HeartbeatRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/collector/register":
			if err := json.NewDecoder(r.Body).Decode(&gotRegister); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(collectorapi.RegistrationResponse{
				CollectorID:    "collector_123",
				CollectorToken: "collector_token",
				DeviceID:       "device_123",
				PrivacyMode:    "summary_only",
			})
		case "/api/v1/collector/heartbeat":
			if err := json.NewDecoder(r.Body).Decode(&gotHeartbeat); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{Accepted: true})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	err := runRegister([]string{
		"--office-url", server.URL,
		"--code", "ABCD-1234",
		"--config", configPath,
		"--workspace", "workspace-a",
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "agent_display_name") {
		t.Fatalf("config contains deprecated agent_display_name: %s", body)
	}
	if gotRegister.Agents[0].DisplayName != "" || gotHeartbeat.Agents[0].DisplayName != "" {
		t.Fatalf("collector sent display name: register=%q heartbeat=%q", gotRegister.Agents[0].DisplayName, gotHeartbeat.Agents[0].DisplayName)
	}
}

func TestRunCollectorRejectsExtraArgs(t *testing.T) {
	err := runCollector([]string{"config.json", "extra"})
	if err == nil || err.Error() != usage {
		t.Fatalf("err = %v", err)
	}
}

func TestRunCollectorDelegatesToRuntime(t *testing.T) {
	var gotConfigPath string
	restore := setCollectorRuntimeRunForTest(func(ctx context.Context, configPath string) error {
		gotConfigPath = configPath
		return nil
	})
	defer restore()

	err := runCollector([]string{"--config", "config.json"})
	if err != nil {
		t.Fatal(err)
	}
	if gotConfigPath != "config.json" {
		t.Fatalf("configPath = %q, want config.json", gotConfigPath)
	}
}

func TestRunCollectorWithContextPassesCancellationToRuntime(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	restore := setCollectorRuntimeRunForTest(func(gotCtx context.Context, _ string) error {
		return gotCtx.Err()
	})
	defer restore()

	err := runCollectorWithContext(ctx, []string{"--config", "config.json"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestRunCollectorConfigPathRejectsPositionalAndFlagTogether(t *testing.T) {
	err := runCollector([]string{"--config", "a.json", "b.json"})
	if err == nil || err.Error() != usage {
		t.Fatalf("err = %v, want usage", err)
	}
}

func TestRunRegisterRejectsExtraArgs(t *testing.T) {
	err := runRegister([]string{
		"--office-url", "http://office.local",
		"--code", "ABCD-1234",
		"--config", "config.json",
		"extra",
	}, io.Discard)
	if err == nil || !errors.Is(err, errUsage) {
		t.Fatalf("err = %v", err)
	}
}

func TestRunRegisterSavesConfigAndPostsInitialWorkspace(t *testing.T) {
	setTestClaweeAgentConfig(t)
	var gotRegister collectorapi.RegistrationRequest
	var gotHeartbeat collectorapi.HeartbeatRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/collector/register":
			if err := json.NewDecoder(r.Body).Decode(&gotRegister); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(collectorapi.RegistrationResponse{
				CollectorID:    "collector_123",
				CollectorToken: "collector_token",
				DeviceID:       "device_123",
				PrivacyMode:    "summary_only",
			})
		case "/api/v1/collector/heartbeat":
			if err := json.NewDecoder(r.Body).Decode(&gotHeartbeat); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{Accepted: true})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	err := runRegister([]string{
		"--office-url", server.URL,
		"--code", "ABCD-1234",
		"--config", configPath,
		"--workspace", "workspace-a",
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CollectorID != "collector_123" {
		t.Fatalf("CollectorID = %q", cfg.CollectorID)
	}
	if cfg.CollectorToken != "collector_token" {
		t.Fatalf("CollectorToken = %q", cfg.CollectorToken)
	}
	if cfg.DeviceID != "device_123" {
		t.Fatalf("DeviceID = %q", cfg.DeviceID)
	}
	if gotRegister.AgentID == "" || gotRegister.AgentID != cfg.AgentID {
		t.Fatalf("registration agent_id = %q, config agent_id = %q", gotRegister.AgentID, cfg.AgentID)
	}
	if len(gotRegister.Agents) != 1 || gotRegister.Agents[0].WorkspaceName != "workspace-a" {
		t.Fatalf("registration agents = %#v", gotRegister.Agents)
	}
	if len(gotHeartbeat.Agents) != 1 {
		t.Fatalf("heartbeat agents = %#v", gotHeartbeat.Agents)
	}
	if gotHeartbeat.Agents[0].WorkspaceName != "workspace-a" {
		t.Fatalf("heartbeat WorkspaceName = %q", gotHeartbeat.Agents[0].WorkspaceName)
	}
	if gotHeartbeat.Agents[0].DisplayName != "" {
		t.Fatalf("heartbeat DisplayName = %q, want empty", gotHeartbeat.Agents[0].DisplayName)
	}
}

func TestRunRegisterDefaultsListenAddrToPort1905(t *testing.T) {
	setTestClaweeAgentConfig(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/collector/register":
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(collectorapi.RegistrationResponse{
				CollectorID:    "collector_123",
				CollectorToken: "collector_token",
				DeviceID:       "device_123",
				PrivacyMode:    "summary_only",
			})
		case "/api/v1/collector/heartbeat":
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{Accepted: true})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	err := runRegister([]string{
		"--office-url", server.URL,
		"--code", "ABCD-1234",
		"--config", configPath,
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != "127.0.0.1:1905" {
		t.Fatalf("ListenAddr = %q, want 127.0.0.1:1905", cfg.ListenAddr)
	}
}

func TestRunRegisterAcceptsAndIgnoresDeprecatedAgentNameFlag(t *testing.T) {
	setTestClaweeAgentConfig(t)
	var gotRegister collectorapi.RegistrationRequest
	var gotHeartbeat collectorapi.HeartbeatRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/collector/register":
			if err := json.NewDecoder(r.Body).Decode(&gotRegister); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(collectorapi.RegistrationResponse{
				CollectorID:    "collector_123",
				CollectorToken: "collector_token",
				DeviceID:       "device_123",
				PrivacyMode:    "summary_only",
			})
		case "/api/v1/collector/heartbeat":
			if err := json.NewDecoder(r.Body).Decode(&gotHeartbeat); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{Accepted: true})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	err := runRegister([]string{
		"--office-url", server.URL,
		"--code", "ABCD-1234",
		"--config", configPath,
		"--workspace", "workspace-a",
		"--agent-name", "Codex Desk",
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "agent_display_name") {
		t.Fatalf("config contains deprecated agent_display_name: %s", body)
	}
	if len(gotRegister.Agents) != 1 {
		t.Fatalf("registration agents = %#v", gotRegister.Agents)
	}
	if gotRegister.Agents[0].DisplayName != "" {
		t.Fatalf("registration DisplayName = %q, want empty", gotRegister.Agents[0].DisplayName)
	}
	if len(gotHeartbeat.Agents) != 1 {
		t.Fatalf("heartbeat agents = %#v", gotHeartbeat.Agents)
	}
	if gotHeartbeat.Agents[0].DisplayName != "" {
		t.Fatalf("heartbeat DisplayName = %q, want empty", gotHeartbeat.Agents[0].DisplayName)
	}
}

func TestRunConfigExistsReturnsNilForValidConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	if err := runConfig([]string{"exists", "--config", configPath}); err != nil {
		t.Fatal(err)
	}
}

func TestRunConfigExistsFailsWhenConfigMissing(t *testing.T) {
	err := runConfig([]string{"exists", "--config", filepath.Join(t.TempDir(), "missing.json")})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestExecuteConfigExistsMissingConfigIsQuiet(t *testing.T) {
	var stderr bytes.Buffer

	code := Execute([]string{
		"config", "exists",
		"--config", filepath.Join(t.TempDir(), "missing.json"),
	}, strings.NewReader(""), io.Discard, &stderr)

	if code != 1 {
		t.Fatalf("Execute code = %d, want 1", code)
	}
	if stderr.String() != "" {
		t.Fatalf("stderr = %q, want empty output for missing config probe", stderr.String())
	}
}

func TestRunEnsureRegisteredSkipsRegistrationWhenConfigExists(t *testing.T) {
	setTestClaweeAgentConfig(t)
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://old-office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	registerCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/collector/register" {
			registerCalls++
		}
		t.Fatalf("unexpected request: %s", r.URL.Path)
	}))
	defer server.Close()

	err := runEnsureRegistered([]string{
		"--office-url", server.URL,
		"--code", "reg_new",
		"--config", configPath,
		"--agent-name", "New Codex",
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if registerCalls != 0 {
		t.Fatalf("registerCalls = %d, want 0", registerCalls)
	}

}

func TestBuildLaunchAgentPlistUsesBinaryConfigAndLogPaths(t *testing.T) {
	logDir := filepath.Join(string(filepath.Separator), "Users", "me", "Library", "Logs", "clawee-collector")
	plist := buildLaunchAgentPlist("/opt/clawee/clawee-collector", "/Users/me/.clawee-collector/config.json", logDir)

	for _, want := range []string{
		"<string>com.clawee.collector</string>",
		"<string>/opt/clawee/clawee-collector</string>",
		"<string>run</string>",
		"<string>--config</string>",
		"<string>/Users/me/.clawee-collector/config.json</string>",
		"<key>RunAtLoad</key>",
		"<key>KeepAlive</key>",
		"<string>" + filepath.Join(logDir, "stdout.log") + "</string>",
	} {
		if !strings.Contains(plist, want) {
			t.Fatalf("plist missing %q:\n%s", want, plist)
		}
	}
}

func tomlEscapedPath(path string) string {
	return strings.ReplaceAll(path, `\`, `\\\\`)
}

func TestBuildSystemdUserServiceUsesBinaryAndConfigPaths(t *testing.T) {
	unit := buildSystemdUserService("/opt/clawee/clawee-collector", "/home/me/.clawee-collector/config.json")

	for _, want := range []string{
		"Description=Clawee Collector",
		"ExecStart=/opt/clawee/clawee-collector run --config /home/me/.clawee-collector/config.json",
		"Restart=always",
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("unit missing %q:\n%s", want, unit)
		}
	}
}

func TestWindowsScheduledTaskCommandUsesBinaryAndConfigPaths(t *testing.T) {
	command := windowsScheduledTaskCommand(`C:\Users\me\.clawee-collector\bin\clawee-collector.exe`, `C:\Users\me\.clawee-collector\config.json`)

	for _, want := range []string{
		`"C:\Users\me\.clawee-collector\bin\clawee-collector.exe"`,
		"run",
		"--config",
		`"C:\Users\me\.clawee-collector\config.json"`,
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("scheduled task command missing %q:\n%s", want, command)
		}
	}
}

func TestRunServiceInstallTaskCreatesWindowsScheduledTask(t *testing.T) {
	var calls []string
	oldRunCommand := runCommand
	runCommand = func(name string, args ...string) error {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return nil
	}
	t.Cleanup(func() { runCommand = oldRunCommand })

	err := runService([]string{
		"install-task",
		"--config", `C:\Users\me\.clawee-collector\config.json`,
		"--binary", `C:\Users\me\.clawee-collector\bin\clawee-collector.exe`,
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	if len(calls) != 1 {
		t.Fatalf("calls = %#v, want one schtasks call", calls)
	}
	for _, want := range []string{
		"schtasks /Create",
		"/TN ClaweeCollector",
		"/SC ONLOGON",
		"/RL LIMITED",
		`"C:\Users\me\.clawee-collector\bin\clawee-collector.exe" run --config "C:\Users\me\.clawee-collector\config.json"`,
	} {
		if !strings.Contains(calls[0], want) {
			t.Fatalf("scheduled task call missing %q:\n%#v", want, calls)
		}
	}
}

func TestRunServiceInstallTaskIncludesCommandOutputWhenScheduledTaskFails(t *testing.T) {
	oldRunCommand := runCommand
	runCommand = func(name string, args ...string) error {
		return commandError{
			name:   name,
			args:   args,
			output: "ERROR: Access is denied.",
			err:    errors.New("exit status 1"),
		}
	}
	t.Cleanup(func() { runCommand = oldRunCommand })

	err := runService([]string{
		"install-task",
		"--config", `C:\Users\me\.clawee-collector\config.json`,
		"--binary", `C:\Users\me\.clawee-collector\bin\clawee-collector.exe`,
	}, io.Discard)
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		`schtasks /Create`,
		`ERROR: Access is denied.`,
		`current user scheduled task could not be installed`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("error missing %q:\n%s", want, got)
		}
	}
}

func TestRunServiceStartTaskIncludesCommandOutputWhenScheduledTaskFails(t *testing.T) {
	oldRunCommand := runCommand
	runCommand = func(name string, args ...string) error {
		return commandError{
			name:   name,
			args:   args,
			output: "ERROR: The system cannot find the file specified.",
			err:    errors.New("exit status 1"),
		}
	}
	t.Cleanup(func() { runCommand = oldRunCommand })

	err := runService([]string{"start-task"}, io.Discard)
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		`schtasks /Run`,
		`ERROR: The system cannot find the file specified.`,
		`current user scheduled task could not be started`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("error missing %q:\n%s", want, got)
		}
	}
}

func TestRunServiceStartTaskRunsWindowsScheduledTask(t *testing.T) {
	var calls []string
	oldRunCommand := runCommand
	runCommand = func(name string, args ...string) error {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return nil
	}
	t.Cleanup(func() { runCommand = oldRunCommand })

	err := runService([]string{"start-task"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}

	if len(calls) != 1 || !strings.Contains(calls[0], "schtasks /Run /TN ClaweeCollector") {
		t.Fatalf("calls = %#v, want schtasks run", calls)
	}
}

func TestRunServiceStartBootstrapsLaunchAgent(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd service start is only implemented on macOS")
	}

	home := setTestHome(t)

	configPath := filepath.Join(home, ".clawee-collector", "config.json")
	if err := config.Save(configPath, config.Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	var calls []string
	oldRunCommand := runCommand
	runCommand = func(name string, args ...string) error {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return nil
	}
	t.Cleanup(func() { runCommand = oldRunCommand })

	if err := runServiceStart([]string{"--config", configPath}, io.Discard); err != nil {
		t.Fatal(err)
	}

	plistPath := filepath.Join(home, "Library", "LaunchAgents", "com.clawee.collector.plist")
	wantCalls := []string{
		"launchctl bootout gui/",
		"launchctl bootstrap gui/",
		"launchctl kickstart -k gui/",
	}
	if len(calls) != 3 {
		t.Fatalf("calls = %#v, want 3 launchctl calls", calls)
	}
	for i, want := range wantCalls {
		if !strings.Contains(calls[i], want) {
			t.Fatalf("calls[%d] = %q, want contains %q", i, calls[i], want)
		}
	}
	if !strings.Contains(calls[1], plistPath) {
		t.Fatalf("bootstrap call = %q, want plist path %q", calls[1], plistPath)
	}
}
