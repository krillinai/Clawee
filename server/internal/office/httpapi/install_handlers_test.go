package httpapi

import (
	"fmt"
	"html"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallPageIncludesOneCommandWithRegistrationCode(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://office.local/office/collectors/install?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := html.UnescapeString(rec.Body.String())
	if !strings.Contains(body, "curl -fsSL 'https://office.local/office/collectors/install.sh?code=reg_123' | sh") {
		t.Fatalf("body missing install command: %s", body)
	}
	if !strings.Contains(body, "irm 'https://office.local/office/collectors/install.ps1?code=reg_123' | iex") {
		t.Fatalf("body missing Windows install command: %s", body)
	}
	for _, want := range []string{
		"一键安装",
		"安装验证与排障",
		"复用现有采集器身份",
		"running",
		"health_ok",
		"heartbeat_ok",
		"UAC",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install page missing %q: %s", want, body)
		}
	}
	for _, forbidden := range []string{
		"手动安装",
		"setup unix-user prepare",
		"setup windows-user prepare",
		"sc.exe stop ClaweeCollector",
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("install page should not embed implementation detail %q:\n%s", forbidden, body)
		}
	}
	if !strings.Contains(body, "注册码") || !strings.Contains(body, "采集器") {
		t.Fatalf("body missing registration/install content: %s", body)
	}
}

func TestInstallEndpointsRejectUnsafeRegistrationCode(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	for _, path := range []string{
		"/office/collectors/install?code=reg_123%3Becho%20unsafe",
		"/office/collectors/install.sh?code=reg_123%26echo%20unsafe",
		"/office/collectors/install.ps1?code=reg_123%27%3BWrite-Host%20unsafe",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		api.Handler().ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body = %s", path, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "invalid_registration_code") {
			t.Fatalf("%s missing invalid registration code error: %s", path, rec.Body.String())
		}
	}
}

func TestInstallPageIncludesCodexCLIHookTrustGuide(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://office.local/office/collectors/install?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		"全局 Codex Hook 受控配置",
		"不会删除用户手写配置",
		"在 Codex CLI 中授权 Hook",
		"在终端运行",
		"<pre><code>codex</code></pre>",
		"进入 Codex CLI 交互界面后输入",
		"<pre><code>/hooks</code></pre>",
		"不是 PowerShell 或 Shell 子命令",
		"请不要执行 <code>codex /hooks</code>",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install page missing %q: %s", want, body)
		}
	}
	for _, forbidden := range []string{
		"重启 Codex 并授权",
		"在 Codex 提示授权 hook 时选择 trust / authorize",
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("install page must not contain obsolete hook guidance %q: %s", forbidden, body)
		}
	}
	if strings.Contains(body, "项目根目录的 <code>.codex/config.toml</code>") {
		t.Fatalf("install page should not recommend project-level Codex config: %s", body)
	}
	if strings.Contains(body, "[[hooks.SessionStart]]") {
		t.Fatalf("install page should not embed full Codex hook TOML anymore: %s", body)
	}
}

func TestInstallScriptsPrintCodexCLIHookTrustNextStep(t *testing.T) {
	api := NewInstallAPI(t.TempDir())
	want := "下一步：在终端运行 codex，进入 Codex CLI 交互界面后输入 /hooks 并审核 Clawee Collector Hook。"

	for _, path := range []string{
		"https://office.local/office/collectors/install.sh?code=reg_123",
		"https://office.local/office/collectors/install.ps1?code=reg_123",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		api.Handler().ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body = %s", path, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("%s missing next step %q:\n%s", path, want, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "codex /hooks") {
			t.Fatalf("%s must not present /hooks as a shell argument:\n%s", path, rec.Body.String())
		}
	}
}

func TestInstallScriptDerivesOfficeURLAndCodeFromInviteLink(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://office.local/office/collectors/install.sh?code=reg_123", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`OFFICE_URL="https://office.local"`,
		`DOWNLOAD_BASE_URL="https://office.local/office/collectors"`,
		`REGISTRATION_CODE='reg_123'`,
		`workspace="${CLAWEE_COLLECTOR_WORKSPACE:-$(basename "$(pwd)")}"`,
		`codex_config_path="${CODEX_CONFIG:-$HOME/.codex/config.toml}"`,
		`install_dir="${CLAWEE_COLLECTOR_DIR:-$HOME/.clawee/collector/bin}"`,
		`config_path="${CLAWEE_COLLECTOR_CONFIG:-$HOME/.clawee/collector/config.toml}"`,
		`clawee_agent_config_path="${CLAWEE_AGENT_CONFIG:-$HOME/.clawee/config.toml}"`,
		`*.toml) legacy_config_path="${config_path%.toml}.json" ;;`,
		`[ -n "$legacy_config_path" ] && [ -e "$legacy_config_path" ] && has_existing_install=true`,
		`binary_path="$install_dir/clawee-collector"`,
		`$DOWNLOAD_BASE_URL/downloads/clawee-collector/${os_name}/${arch_name}/clawee-collector`,
		`"$binary_path" setup unix-user prepare \`,
		`--clawee-agent-config "$clawee_agent_config_path" \`,
		`"$binary_path" setup unix-user install-startup \`,
		`"$binary_path" setup unix-user diagnose \`,
		`mv "$HOME/.clawee-collector" "$HOME/.clawee-collector.backup-$(date +%Y%m%d-%H%M%S)"`,
		`状态: running=true health_ok=true heartbeat_ok=true 时表示安装验证通过`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("script missing %q:\n%s", want, body)
		}
	}
	for _, forbidden := range []string{
		`agent_name`,
		`--agent-name`,
		`ensure-registered`,
		`service install`,
		`service start`,
		`codex hooks ensure`,
		`/dev/tty`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("script should be a thin launcher, found %q:\n%s", forbidden, body)
		}
	}
}

func TestInstallShellScriptUsesUnixUserSetupAndNoTmpBinary(t *testing.T) {
	api := NewInstallAPI(t.TempDir())
	req := httptest.NewRequest(http.MethodGet, "/office/collectors/install.sh?code=reg_xxx", nil)
	req.Host = "office.example"
	w := httptest.NewRecorder()

	api.Handler().ServeHTTP(w, req)

	body := w.Body.String()
	for _, want := range []string{
		`setup unix-user cleanup-runtime`,
		`curl -fsSL "$download_url" -o "$binary_path"`,
		`setup unix-user prepare`,
		`setup unix-user install-startup`,
		`setup unix-user diagnose`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("script missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, ".tmp") || strings.Contains(body, `mv "$tmp_binary"`) {
		t.Fatalf("script should not use tmp binary:\n%s", body)
	}
	if strings.Index(body, "setup unix-user cleanup-runtime") > strings.Index(body, "curl -fsSL") {
		t.Fatalf("cleanup-runtime must appear before direct download:\n%s", body)
	}
}

func TestInstallShellScriptStopsWhenTraceExistsWithoutBinary(t *testing.T) {
	api := NewInstallAPI(t.TempDir())
	req := httptest.NewRequest(http.MethodGet, "/office/collectors/install.sh?code=reg_xxx", nil)
	req.Host = "office.example"
	w := httptest.NewRecorder()

	api.Handler().ServeHTTP(w, req)

	body := w.Body.String()
	for _, want := range []string{
		`has_existing_install=true`,
		`[ "$has_existing_install" = true ] && [ ! -x "$cleanup_binary_path" ]`,
		`检测到已有安装痕迹，但正式二进制不存在`,
		`exit 1`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("script missing %q:\n%s", want, body)
		}
	}
}

func TestInstallShellScriptBlocksPartialInstallBeforeDownloadAtExecution(t *testing.T) {
	script := renderInstallShellForTest(t)
	tempDir := t.TempDir()
	homeDir := filepath.Join(tempDir, "home")
	installDir := filepath.Join(tempDir, "collector-bin")
	configPath := filepath.Join(tempDir, "collector-config.json")
	codexConfigPath := filepath.Join(tempDir, "codex-config.toml")
	fakeBinDir := filepath.Join(tempDir, "fake-bin")
	eventLog := filepath.Join(tempDir, "events.log")

	if err := os.MkdirAll(homeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(fakeBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(`{"office_url":"https://office.example"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codexConfigPath, []byte("# BEGIN clawee-collector codex hooks"), 0o644); err != nil {
		t.Fatal(err)
	}

	writeExecutableFile(t, filepath.Join(fakeBinDir, "curl"), `#!/bin/sh
set -eu
echo "curl:$*" >> "$EVENT_LOG"
`)
	writeExecutableFile(t, filepath.Join(fakeBinDir, "launchctl"), `#!/bin/sh
set -eu
exit 1
`)
	writeExecutableFile(t, filepath.Join(fakeBinDir, "systemctl"), `#!/bin/sh
set -eu
exit 1
`)

	output, err := runInstallShellScript(t, script, tempDir, []string{
		"HOME=" + homeDir,
		"PATH=" + fakeBinDir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"EVENT_LOG=" + eventLog,
		"CLAWEE_COLLECTOR_DIR=" + installDir,
		"CLAWEE_COLLECTOR_CONFIG=" + configPath,
		"CODEX_CONFIG=" + codexConfigPath,
	})
	if err == nil {
		t.Fatalf("expected partial install execution to fail, output:\n%s", output)
	}
	if !strings.Contains(output, "正式二进制不存在") {
		t.Fatalf("expected partial install warning, output:\n%s", output)
	}
	if !strings.Contains(output, "请手动清理用户级启动项和 Codex 受控 hook 后重试") {
		t.Fatalf("expected manual cleanup guidance, output:\n%s", output)
	}
	if eventLogBytes, readErr := os.ReadFile(eventLog); readErr == nil && strings.Contains(string(eventLogBytes), "curl:") {
		t.Fatalf("curl should not be called before partial install exits:\n%s", string(eventLogBytes))
	}
}

func TestInstallShellScriptExecutesCleanupThenDirectBinaryReplacement(t *testing.T) {
	script := renderInstallShellForTest(t)
	tempDir := t.TempDir()
	homeDir := filepath.Join(tempDir, "home")
	installDir := filepath.Join(tempDir, "collector-bin")
	configPath := filepath.Join(tempDir, "collector-config.json")
	codexConfigPath := filepath.Join(tempDir, "codex-config.toml")
	binaryPath := filepath.Join(installDir, "clawee-collector")
	fakeBinDir := filepath.Join(tempDir, "fake-bin")
	eventLog := filepath.Join(tempDir, "events.log")

	if err := os.MkdirAll(homeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(fakeBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(`{"office_url":"https://office.example"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codexConfigPath, []byte("# BEGIN clawee-collector codex hooks"), 0o644); err != nil {
		t.Fatal(err)
	}

	writeExecutableFile(t, binaryPath, `#!/bin/sh
set -eu
echo "old:$*" >> "$EVENT_LOG"
`)
	writeExecutableFile(t, filepath.Join(fakeBinDir, "curl"), `#!/bin/sh
set -eu
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
echo "curl:$out:$url" >> "$EVENT_LOG"
cat > "$out" <<'EOF_BINARY'
#!/bin/sh
set -eu
echo "new:$*" >> "$EVENT_LOG"
EOF_BINARY
chmod 0755 "$out"
`)
	writeExecutableFile(t, filepath.Join(fakeBinDir, "launchctl"), `#!/bin/sh
set -eu
exit 1
`)
	writeExecutableFile(t, filepath.Join(fakeBinDir, "systemctl"), `#!/bin/sh
set -eu
exit 1
`)

	output, err := runInstallShellScript(t, script, tempDir, []string{
		"HOME=" + homeDir,
		"PATH=" + fakeBinDir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"EVENT_LOG=" + eventLog,
		"CLAWEE_COLLECTOR_DIR=" + installDir,
		"CLAWEE_COLLECTOR_CONFIG=" + configPath,
		"CODEX_CONFIG=" + codexConfigPath,
		"CLAWEE_COLLECTOR_WORKSPACE=workspace-under-test",
	})
	if err != nil {
		t.Fatalf("install script execution failed: %v\n%s", err, output)
	}

	eventBytes, readErr := os.ReadFile(eventLog)
	if readErr != nil {
		t.Fatalf("read event log: %v", readErr)
	}
	events := strings.Split(strings.TrimSpace(string(eventBytes)), "\n")
	if len(events) != 5 {
		t.Fatalf("expected 5 events, got %d:\n%s", len(events), string(eventBytes))
	}
	if !strings.Contains(events[0], "old:setup unix-user cleanup-runtime") {
		t.Fatalf("expected cleanup-runtime first, events:\n%s", string(eventBytes))
	}
	if !strings.HasPrefix(events[1], "curl:"+binaryPath+":http://office.local/office/collectors/downloads/clawee-collector/") {
		t.Fatalf("expected curl to write formal binary path, events:\n%s", string(eventBytes))
	}
	if strings.Contains(events[1], ".tmp") {
		t.Fatalf("curl should write formal binary directly, events:\n%s", string(eventBytes))
	}
	for index, want := range []string{
		"new:setup unix-user prepare",
		"new:setup unix-user install-startup",
		"new:setup unix-user diagnose",
	} {
		if !strings.Contains(events[index+2], want) {
			t.Fatalf("missing %q in event %d:\n%s", want, index+2, string(eventBytes))
		}
	}
	if !strings.Contains(output, "clawee-collector installed") {
		t.Fatalf("expected success output, got:\n%s", output)
	}
}

func TestInstallPowerShellScriptDerivesOfficeURLAndCodeFromInviteLink(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://office.local/office/collectors/install.ps1?code=reg_123", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
		`$OutputEncoding = [System.Text.Encoding]::UTF8`,
		`$OfficeUrl = 'https://office.local'`,
		`$DownloadBaseUrl = 'https://office.local/office/collectors'`,
		`$RegistrationCode = 'reg_123'`,
		`Resolve-CollectorArch`,
		`$InstallRoot = if ($env:CLAWEE_COLLECTOR_DIR)`,
		`$ConfigPath = if ($env:CLAWEE_COLLECTOR_CONFIG)`,
		`$CodexConfigPath = if ($env:CODEX_CONFIG)`,
		`$ClaweeAgentConfigPath = if ($env:CLAWEE_AGENT_CONFIG)`,
		`$DownloadBaseUrl/downloads/clawee-collector/windows/$Arch/clawee-collector.exe`,
		`$DownloadBaseUrl/downloads/clawee-collector/windows/$Arch/clawee-collector-runner.exe`,
		`Invoke-CleanupRuntimeElevated -BinaryPath $CleanupBinaryPath`,
		`$DownloadDir = Join-Path $InstallRoot ("downloads\" + [guid]::NewGuid().ToString("N"))`,
		`$DownloadBinaryPath = Join-Path $DownloadDir "clawee-collector.exe"`,
		`$DownloadRunnerBinaryPath = Join-Path $DownloadDir "clawee-collector-runner.exe"`,
		`$ProgressPreference = "SilentlyContinue"`,
		`Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $DownloadBinaryPath`,
		`Invoke-WebRequest -UseBasicParsing -Uri $RunnerDownloadUrl -OutFile $DownloadRunnerBinaryPath`,
		`cleanup completed; downloading collector binaries`,
		`downloading clawee-collector.exe`,
		`downloading clawee-collector-runner.exe`,
		`collector binaries downloaded; replacing formal binaries`,
		`$ProgressPreference = $PreviousProgressPreference`,
		`Assert-NativeCommandSucceeded $CleanupExitCode "windows current-user collector cleanup-runtime"`,
		`Move-Item -Force $DownloadBinaryPath $BinaryPath`,
		`Move-Item -Force $DownloadRunnerBinaryPath $RunnerBinaryPath`,
		`& $BinaryPath setup windows-user prepare`,
		`--runner-binary $RunnerBinaryPath`,
		`--clawee-agent-config $ClaweeAgentConfigPath`,
		`Assert-NativeCommandSucceeded $LASTEXITCODE "windows current-user collector prepare"`,
		`Start-Process -FilePath "powershell.exe"`,
		`-Verb RunAs`,
		`-EncodedCommand`,
		`setup windows-user install-startup`,
		`--elevated`,
		`Invoke-StartupInstallElevated -BinaryPath $BinaryPath`,
		`& $BinaryPath setup windows-user diagnose`,
		`Assert-NativeCommandSucceeded $LASTEXITCODE "windows current-user collector diagnose"`,
		`Move-Item -LiteralPath $CleanupInstallRoot -Destination $LegacyBackupPath`,
		`安装结果:`,
		`下一步：在终端运行 codex，进入 Codex CLI 交互界面后输入 /hooks 并审核 Clawee Collector Hook。`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("PowerShell script missing %q:\n%s", want, body)
		}
	}
	for _, forbidden := range []string{
		`$AgentName`,
		`--agent-name`,
		`Test-CollectorAdmin`,
		`Test-CollectorHealth`,
		`service", "install"`,
		`service", "install-task"`,
		`codex", "hooks", "ensure"`,
		`ensure-registered`,
		`Invoke-NativeCommand`,
		`Stop-ExistingCollectorStartup`,
		`Get-RunningCollectorRunner`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("PowerShell script should be a thin launcher, found %q:\n%s", forbidden, body)
		}
	}
}

func TestInstallPowerShellScriptCleansRuntimeBeforeReplacingFormalBinaries(t *testing.T) {
	body := renderInstallPowerShellForTest(t)

	cleanup := strings.Index(body, `Invoke-CleanupRuntimeElevated -BinaryPath $CleanupBinaryPath`)
	downloadCollector := strings.Index(body, `Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $DownloadBinaryPath`)
	downloadRunner := strings.Index(body, `Invoke-WebRequest -UseBasicParsing -Uri $RunnerDownloadUrl -OutFile $DownloadRunnerBinaryPath`)
	downloadHint := strings.Index(body, `cleanup completed; downloading collector binaries`)
	downloadDone := strings.Index(body, `collector binaries downloaded; replacing formal binaries`)
	moveCollector := strings.Index(body, `Move-Item -Force $DownloadBinaryPath $BinaryPath`)
	moveRunner := strings.Index(body, `Move-Item -Force $DownloadRunnerBinaryPath $RunnerBinaryPath`)
	prepare := strings.Index(body, `setup windows-user prepare`)
	startup := strings.Index(body, `Invoke-StartupInstallElevated -BinaryPath $BinaryPath`)
	diagnose := strings.Index(body, `setup windows-user diagnose`)
	if cleanup < 0 || downloadHint < 0 || downloadCollector < 0 || downloadRunner < 0 || downloadDone < 0 || moveCollector < 0 || moveRunner < 0 || prepare < 0 || startup < 0 || diagnose < 0 {
		t.Fatalf("script missing required stages:\n%s", body)
	}
	if !(cleanup < downloadHint && downloadHint < downloadCollector && downloadCollector < downloadRunner && downloadRunner < downloadDone && downloadDone < moveCollector && downloadDone < moveRunner && moveCollector < prepare && moveRunner < prepare && prepare < startup && startup < diagnose) {
		t.Fatalf("unexpected install order cleanup=%d downloadHint=%d downloadCollector=%d downloadRunner=%d downloadDone=%d moveCollector=%d moveRunner=%d prepare=%d startup=%d diagnose=%d", cleanup, downloadHint, downloadCollector, downloadRunner, downloadDone, moveCollector, moveRunner, prepare, startup, diagnose)
	}
	for _, want := range []string{
		`function Invoke-CleanupRuntimeElevated`,
		`Start-Process -FilePath "powershell.exe"`,
		`-Verb RunAs`,
		`安装已停止，未覆盖正式二进制`,
		`sc.exe stop ClaweeCollector`,
		`sc.exe delete ClaweeCollector`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("PowerShell script missing cleanup boundary %q:\n%s", want, body)
		}
	}
	for _, forbidden := range []string{
		`Stop-ExistingCollectorStartup`,
		`Get-RunningCollectorRunner`,
		`Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $BinaryPath`,
		`.exe.tmp`,
		`$TmpBinaryPath`,
		`$TmpRunnerBinaryPath`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("PowerShell script should not contain old reinstall path %q:\n%s", forbidden, body)
		}
	}
}

func TestInstallPowerShellScriptShowsElevationProgress(t *testing.T) {
	body := renderInstallPowerShellForTest(t)

	for _, want := range []string{
		`waiting for UAC approval: cleanup old runtime`,
		`cleanup elevation stage completed`,
		`waiting for UAC approval: install startup task`,
		`startup elevation stage completed`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("PowerShell script missing elevation progress %q:\n%s", want, body)
		}
	}
}

func TestInstallPowerShellStartupRepairCommandUsesInstallStartup(t *testing.T) {
	body := renderInstallPowerShellForTest(t)

	for _, want := range []string{
		`$RepairCommand = "& " + (ConvertTo-PowerShellSingleQuoted $BinaryPath) +`,
		`" setup windows-user install-startup" +`,
		`" --binary " + (ConvertTo-PowerShellSingleQuoted $BinaryPath) +`,
		`" --runner-binary " + (ConvertTo-PowerShellSingleQuoted $RunnerBinaryPath) +`,
		`" --elevated"`,
		`$StartupCommand = $RepairCommand + "; exit " + '$LASTEXITCODE'`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("PowerShell startup repair command missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, `" setup windows-user install" + "-startup"`) {
		t.Fatalf("PowerShell startup repair command should not hide install-startup from tests:\n%s", body)
	}
}

func TestInstallPowerShellScriptPrintsRecentDiagnosticsOnElevatedFailure(t *testing.T) {
	body := renderInstallPowerShellForTest(t)

	for _, want := range []string{
		`function Write-CollectorDiagnosticsSummary`,
		`Get-ChildItem -LiteralPath $DiagnosticsDir -Filter "install-*.log"`,
		`Sort-Object LastWriteTime -Descending`,
		`Select-Object -First 1`,
		`Get-Content -LiteralPath $LatestDiagnostics.FullName -Tail 12`,
		`-ErrorAction Stop`,
		`diagnostics_tail_unavailable=`,
		`startup_installed=false`,
		`Write-CollectorDiagnosticsSummary -DiagnosticsDir $DiagnosticsDir`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("PowerShell script missing diagnostics summary %q:\n%s", want, body)
		}
	}
	for _, forbidden := range []string{
		`-RedirectStandardOutput`,
		`-RedirectStandardError`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("PowerShell script should not redirect elevated process stdio, found %q:\n%s", forbidden, body)
		}
	}
}

func TestInstallPowerShellScriptContinuesOldCleanupMissingTaskFailure(t *testing.T) {
	body := renderInstallPowerShellForTest(t)

	for _, want := range []string{
		`function Test-CleanupRuntimeMissingTaskFailure`,
		`Read-CollectorDiagnosticsText -Path $LatestDiagnostics.FullName`,
		`cleanup_runtime_task_stop`,
		`cleanup_runtime_task_delete`,
		`$ChineseSystemCannotFindFile = -join @(`,
		`[char]0x7cfb`,
		`旧计划任务不存在，继续覆盖正式二进制`,
		`if (Test-CleanupRuntimeMissingTaskFailure -DiagnosticsDir $DiagnosticsDir)`,
		`$CleanupExitCode = @($CleanupResult)[-1]`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("PowerShell script missing old cleanup missing-task compatibility %q:\n%s", want, body)
		}
	}
}

func TestInstallPowerShellScriptParsesOnWindowsPowerShell(t *testing.T) {
	powerShellPath, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("powershell.exe is required for install.ps1 parser test")
	}

	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://office.local/office/collectors/install.ps1?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	scriptPath := filepath.Join(t.TempDir(), "install.ps1")
	if err := os.WriteFile(scriptPath, rec.Body.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(powerShellPath, "-NoProfile", "-NonInteractive", "-Command", `$Tokens = $null; $Errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile($env:CLAWEE_INSTALL_PS1_UNDER_TEST, [ref]$Tokens, [ref]$Errors); if ($Errors.Count -gt 0) { $Errors | ForEach-Object { Write-Host $_.Message }; exit 1 }`)
	cmd.Env = append(os.Environ(), "CLAWEE_INSTALL_PS1_UNDER_TEST="+scriptPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("install.ps1 parser failed: %v\n%s", err, string(output))
	}
}

func TestInstallPowerShellScriptIgnoresMissingScheduledTaskOnFirstInstall(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://office.local/office/collectors/install.ps1?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := html.UnescapeString(rec.Body.String())
	for _, forbidden := range []string{
		`Ignore-MissingScheduledTaskError`,
		`Stop-ExistingCollectorStartup`,
		`Get-RunningCollectorRunner`,
		`schtasks.exe /Create`,
		`schtasks.exe /Delete`,
		`schtasks.exe /Run`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("PowerShell script should delegate startup task cleanup to cleanup-runtime, found %q:\n%s", forbidden, body)
		}
	}
	if !strings.Contains(body, `setup windows-user cleanup-runtime`) {
		t.Fatalf("PowerShell script missing cleanup-runtime stage:\n%s", body)
	}
	if !strings.Contains(body, `setup windows-user install-startup`) {
		t.Fatalf("PowerShell script missing install-startup stage:\n%s", body)
	}
}

func TestInstallPageExplainsIdempotentReinstall(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://office.local/office/collectors/install?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := html.UnescapeString(rec.Body.String())
	for _, want := range []string{
		`重复执行时会复用现有采集器身份`,
		`重复执行同一条安装命令可修复不完整安装`,
		`irm 'https://office.local/office/collectors/install.ps1?code=reg_123' | iex`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install page missing reinstall recovery %q:\n%s", want, body)
		}
	}
}

func TestInstallPageExplainsDiagnosticsSummary(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://office.local/office/collectors/install?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := html.UnescapeString(rec.Body.String())
	for _, want := range []string{
		`安装验证与排障`,
		`诊断日志路径`,
		`running`,
		`health_ok`,
		`heartbeat_ok`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install page missing Windows diagnostics recovery text %q:\n%s", want, body)
		}
	}
}

func TestInstallPageExplainsWindowsCurrentUserInstall(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://office.local/office/collectors/install?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := html.UnescapeString(rec.Body.String())
	for _, want := range []string{
		`Windows PowerShell`,
		`普通 PowerShell`,
		`UAC`,
		`复用现有采集器身份`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install page missing Windows strategy text %q:\n%s", want, body)
		}
	}
	for _, forbidden := range []string{
		`默认重新注册`,
		`默认删除 config.json`,
		`默认切换为 Windows Service`,
		`删除用户手写 Codex 配置`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("install page should not imply forbidden behavior %q:\n%s", forbidden, body)
		}
	}
}

func renderInstallPowerShellForTest(t *testing.T) string {
	t.Helper()
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://office.local/office/collectors/install.ps1?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	return rec.Body.String()
}

func renderInstallShellForTest(t *testing.T) string {
	t.Helper()
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://office.local/office/collectors/install.sh?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	return rec.Body.String()
}

func runInstallShellScript(t *testing.T, script, workDir string, env []string) (string, error) {
	t.Helper()
	shellPath, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is required for install.sh execution test")
	}
	scriptPath := filepath.Join(workDir, "install.sh")
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(shellPath, scriptPath)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(), env...)
	output, err := cmd.CombinedOutput()
	return string(output), err
}

func writeExecutableFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write %s: %v\n%s", path, err, fmt.Sprintf("content:\n%s", content))
	}
}

func TestInstallPowerShellScriptFailsStagesExplicitly(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://office.local/office/collectors/install.ps1?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`Assert-NativeCommandSucceeded $LASTEXITCODE "windows current-user collector prepare"`,
		`Invoke-StartupInstallElevated -BinaryPath $BinaryPath`,
		`throw "windows collector startup install failed with exit code $($startupProcess.ExitCode)"`,
		`throw "$Step failed with exit code $ExitCode"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("PowerShell script missing explicit failure handling %q:\n%s", want, body)
		}
	}
	for _, forbidden := range []string{
		`Invoke-NativeCommand`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("PowerShell script should throw stage errors instead of exiting directly, found %q:\n%s", forbidden, body)
		}
	}
}

func TestInstallPowerShellScriptExplainsStartupElevationFailure(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://office.local/office/collectors/install.ps1?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`Invoke-StartupInstallElevated`,
		`已完成用户级准备，但后台自启动未安装`,
		`管理员 PowerShell`,
		`创建或删除 ONLOGON 计划任务需要管理员权限`,
		`setup windows-user install-startup`,
		`--elevated`,
		`Join-Path $InstallRoot "diagnostics"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("PowerShell script missing startup elevation guidance %q:\n%s", want, body)
		}
	}
}

func TestInstallPageKeepsWindowsElevationGuidanceConcise(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://office.local/office/collectors/install?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := html.UnescapeString(rec.Body.String())
	for _, want := range []string{
		`请在普通 PowerShell 中执行`,
		`需要时请求 UAC 授权`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install page missing elevation boundary %q:\n%s", want, body)
		}
	}
}

func TestInstallPageDoesNotEmbedWindowsManualImplementation(t *testing.T) {
	api := NewInstallAPI(t.TempDir())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "https://office.local/office/collectors/install?code=reg_123", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := html.UnescapeString(rec.Body.String())
	for _, forbidden := range []string{
		`$BinaryPath = Join-Path $InstallDir "clawee-collector.exe"`,
		`$RunnerBinaryPath = Join-Path $InstallDir "clawee-collector-runner.exe"`,
		`setup windows-user cleanup-runtime`,
		`$Arch = switch ($env:PROCESSOR_ARCHITECTURE)`,
		`setup windows-user install-startup`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("install page should not embed Windows implementation %q:\n%s", forbidden, body)
		}
	}
}

func TestInstallDownloadServesCollectorBinary(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "darwin", "arm64")
	if err := os.MkdirAll(binaryPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binaryPath, "clawee-collector"), []byte("collector-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	api := NewInstallAPI(dir)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/office/collectors/downloads/clawee-collector/darwin/arm64/clawee-collector", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "collector-binary" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestInstallDownloadServesWindowsCollectorBinary(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "windows", "amd64")
	if err := os.MkdirAll(binaryPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binaryPath, "clawee-collector.exe"), []byte("collector-windows-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	api := NewInstallAPI(dir)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/office/collectors/downloads/clawee-collector/windows/amd64/clawee-collector.exe", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "collector-windows-binary" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestInstallDownloadServesWindowsRunnerBinary(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "windows", "amd64")
	if err := os.MkdirAll(binaryPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binaryPath, "clawee-collector-runner.exe"), []byte("collector-runner-windows-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	api := NewInstallAPI(dir)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/office/collectors/downloads/clawee-collector/windows/amd64/clawee-collector-runner.exe", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "collector-runner-windows-binary" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}
