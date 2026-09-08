package httpapi

import (
	"fmt"
	"html"
	"net/http"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
)

type InstallAPI struct {
	binaryRoot string
}

func NewInstallAPI(binaryRoot string) *InstallAPI {
	return &InstallAPI{binaryRoot: binaryRoot}
}

func (api *InstallAPI) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/install", api.handleInstallPage)
	mux.HandleFunc("/office/collectors/install", api.handleInstallPage)
	mux.HandleFunc("/install.sh", api.handleInstallScript)
	mux.HandleFunc("/office/collectors/install.sh", api.handleInstallScript)
	mux.HandleFunc("/install.ps1", api.handleInstallPowerShellScript)
	mux.HandleFunc("/office/collectors/install.ps1", api.handleInstallPowerShellScript)
	mux.HandleFunc("/downloads/clawee-collector/", api.handleCollectorDownload)
	mux.HandleFunc("/office/collectors/downloads/clawee-collector/", api.handleCollectorDownload)
	return mux
}

func (api *InstallAPI) handleInstallPage(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	code, ok := installRegistrationCode(w, r)
	if !ok {
		return
	}
	baseURL := requestBaseURL(r)
	installBaseURL := baseURL + "/office/collectors"
	encodedCode := url.QueryEscape(code)
	unixScriptURL := installBaseURL + "/install.sh?code=" + encodedCode
	windowsScriptURL := installBaseURL + "/install.ps1?code=" + encodedCode
	command := "curl -fsSL " + shellQuote(unixScriptURL) + " | sh"
	windowsCommand := "irm " + powerShellSingleQuote(windowsScriptURL) + " | iex"

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>安装 Claw MCP 采集器</title></head>
<body>
  <h1>安装 Claw MCP 采集器</h1>
  <p>注册码：<code>%s</code></p>
  <section>
    <h2>一键安装</h2>
	<p>执行对应平台的一条命令，完成下载、注册、Hook 配置、后台启动和健康检查。重复执行时会复用现有采集器身份。</p>
    <p>macOS / Linux：</p>
    <pre><code>%s</code></pre>
	<p>Windows PowerShell：请在普通 PowerShell 中执行，安装器会在需要时请求 UAC 授权。</p>
    <pre><code>%s</code></pre>
  </section>
  <section>
	<h2>安装验证与排障</h2>
	<p>安装命令会输出 running、health_ok 和 heartbeat_ok 等结果。如果失败，请保留当前窗口中的诊断日志路径；重复执行同一条安装命令可修复不完整安装。</p>
	<p>采集器只管理全局 Codex Hook 受控配置，不会删除用户手写配置。</p>
	</section>
  <section>
    <h2>在 Codex CLI 中授权 Hook</h2>
    <p>Codex 桌面版可能不会显示 Hook 授权提示，也不提供 <code>/hooks</code> 命令。安装完成后，请在终端运行：</p>
    <pre><code>codex</code></pre>
    <p>进入 Codex CLI 交互界面后输入：</p>
    <pre><code>/hooks</code></pre>
    <p>在 Hook 列表中审核并信任 Claw MCP Hook。<code>/hooks</code> 是 Codex CLI 交互命令，不是 PowerShell 或 Shell 子命令，请不要执行 <code>codex /hooks</code>。未授权前，Codex 会跳过未信任的 command hook。</p>
    <p>授权完成后，退出 CLI 并重新打开 Codex 桌面版或开始新会话；采集器会通过 <code>clawee-collector hook codex</code> 上报状态摘要。</p>
  </section>
  <p>隐私边界：采集器只上传 Agent 状态摘要，不上传 prompt、回复、工具输出、文件内容或 token。</p>
</body>
</html>
`, html.EscapeString(code), html.EscapeString(command), html.EscapeString(windowsCommand))
}

func (api *InstallAPI) handleInstallScript(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	code, ok := installRegistrationCode(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	_, _ = fmt.Fprintf(w, installScriptTemplate, requestBaseURL(r), requestBaseURL(r)+"/office/collectors", shellQuote(code))
}

func (api *InstallAPI) handleInstallPowerShellScript(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	code, ok := installRegistrationCode(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = fmt.Fprintf(w, installPowerShellTemplate, powerShellSingleQuote(requestBaseURL(r)), powerShellSingleQuote(requestBaseURL(r)+"/office/collectors"), powerShellSingleQuote(code))
}

func (api *InstallAPI) handleCollectorDownload(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	prefix := "/downloads/clawee-collector/"
	if strings.HasPrefix(r.URL.Path, "/office/collectors/downloads/clawee-collector/") {
		prefix = "/office/collectors/downloads/clawee-collector/"
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, prefix), "/")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" {
		http.NotFound(w, r)
		return
	}
	if parts[0] == "windows" {
		if parts[2] != "clawee-collector.exe" && parts[2] != "clawee-collector-runner.exe" {
			http.NotFound(w, r)
			return
		}
	} else if parts[2] != "clawee-collector" {
		http.NotFound(w, r)
		return
	}
	if parts[0] != runtime.GOOS && parts[0] != "darwin" && parts[0] != "linux" && parts[0] != "windows" {
		http.NotFound(w, r)
		return
	}
	binaryPath := filepath.Join(api.binaryRoot, parts[0], parts[1], parts[2])
	http.ServeFile(w, r, binaryPath)
}

func requestBaseURL(r *http.Request) string {
	scheme := r.Header.Get("X-Forwarded-Proto")
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := r.Host
	if forwardedHost := r.Header.Get("X-Forwarded-Host"); forwardedHost != "" {
		host = forwardedHost
	}
	return scheme + "://" + host
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func powerShellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func installRegistrationCode(w http.ResponseWriter, r *http.Request) (string, bool) {
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		writeError(w, http.StatusBadRequest, "missing_registration_code", "registration code is required")
		return "", false
	}
	if !validInstallRegistrationCode(code) {
		writeError(w, http.StatusBadRequest, "invalid_registration_code", "registration code is invalid")
		return "", false
	}
	return code, true
}

func validInstallRegistrationCode(code string) bool {
	if len(code) < len("reg_")+1 || len(code) > 128 || !strings.HasPrefix(code, "reg_") {
		return false
	}
	for _, char := range code[len("reg_"):] {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '_' && char != '-' {
			return false
		}
	}
	return true
}

const installScriptTemplate = `#!/bin/sh
set -eu

OFFICE_URL="%s"
DOWNLOAD_BASE_URL="%s"
REGISTRATION_CODE=%s
install_dir="${CLAWEE_COLLECTOR_DIR:-$HOME/.clawee/collector/bin}"
config_path="${CLAWEE_COLLECTOR_CONFIG:-$HOME/.clawee/collector/config.toml}"
legacy_config_path=""
case "$config_path" in
  *.toml) legacy_config_path="${config_path%%.toml}.json" ;;
esac
codex_config_path="${CODEX_CONFIG:-$HOME/.codex/config.toml}"
clawee_agent_config_path="${CLAWEE_AGENT_CONFIG:-$HOME/.clawee/config.toml}"
workspace="${CLAWEE_COLLECTOR_WORKSPACE:-$(basename "$(pwd)")}"

case "$install_dir" in
  /*) ;;
  *) install_dir="$(pwd)/$install_dir" ;;
esac

case "$config_path" in
  /*) ;;
  *) config_path="$(pwd)/$config_path" ;;
esac

case "$codex_config_path" in
  /*) ;;
  *) codex_config_path="$(pwd)/$codex_config_path" ;;
esac

case "$clawee_agent_config_path" in
  /*) ;;
  *) clawee_agent_config_path="$(pwd)/$clawee_agent_config_path" ;;
esac

binary_path="$install_dir/clawee-collector"
cleanup_binary_path="$binary_path"
cleanup_config_path="$config_path"
migrating_legacy_layout=false
if [ -z "${CLAWEE_COLLECTOR_DIR:-}" ] && [ ! -x "$binary_path" ] && [ -x "$HOME/.clawee-collector/bin/clawee-collector" ]; then
  cleanup_binary_path="$HOME/.clawee-collector/bin/clawee-collector"
  cleanup_config_path="$HOME/.clawee-collector/config.toml"
  [ -e "$cleanup_config_path" ] || cleanup_config_path="$HOME/.clawee-collector/config.json"
  migrating_legacy_layout=true
fi

os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch_name="$(uname -m)"
case "$arch_name" in
  x86_64) arch_name="amd64" ;;
  arm64|aarch64) arch_name="arm64" ;;
esac

has_existing_install=false
[ -e "$config_path" ] && has_existing_install=true
[ -n "$legacy_config_path" ] && [ -e "$legacy_config_path" ] && has_existing_install=true
[ -e "$binary_path" ] && has_existing_install=true
[ -x "$cleanup_binary_path" ] && has_existing_install=true
if [ "$os_name" = "darwin" ]; then
  [ -e "$HOME/Library/LaunchAgents/com.clawee.collector.plist" ] && has_existing_install=true
  launchctl print "gui/$(id -u)/com.clawee.collector" >/dev/null 2>&1 && has_existing_install=true
fi
if [ "$os_name" = "linux" ]; then
  [ -e "$HOME/.config/systemd/user/clawee-collector.service" ] && has_existing_install=true
  systemctl --user status clawee-collector.service >/dev/null 2>&1 && has_existing_install=true
fi
if [ -e "$codex_config_path" ] && grep -q "BEGIN clawee-collector codex hooks" "$codex_config_path"; then
  has_existing_install=true
fi

if [ "$has_existing_install" = true ] && [ ! -x "$cleanup_binary_path" ]; then
  echo "检测到已有安装痕迹，但正式二进制不存在。安装已停止，未下载覆盖正式二进制。"
  echo "请手动清理用户级启动项和 Codex 受控 hook 后重试。"
  echo "macOS: launchctl bootout gui/$(id -u) $HOME/Library/LaunchAgents/com.clawee.collector.plist"
  echo "Linux: systemctl --user stop clawee-collector.service && systemctl --user disable clawee-collector.service"
  exit 1
fi

if [ "$has_existing_install" = true ]; then
  "$cleanup_binary_path" setup unix-user cleanup-runtime --binary "$cleanup_binary_path" --config "$cleanup_config_path" --codex-config "$codex_config_path"
fi

mkdir -p "$install_dir"
download_url="$DOWNLOAD_BASE_URL/downloads/clawee-collector/${os_name}/${arch_name}/clawee-collector"
curl -fsSL "$download_url" -o "$binary_path"
chmod 0755 "$binary_path"

"$binary_path" setup unix-user prepare \
  --office-url "$OFFICE_URL" \
  --code "$REGISTRATION_CODE" \
  --binary "$binary_path" \
  --config "$config_path" \
  --codex-config "$codex_config_path" \
  --clawee-agent-config "$clawee_agent_config_path" \
  --workspace "$workspace"

"$binary_path" setup unix-user install-startup \
  --binary "$binary_path" \
  --config "$config_path" \
  --codex-config "$codex_config_path"

"$binary_path" setup unix-user diagnose \
  --config "$config_path" \
  --codex-config "$codex_config_path"

if [ "$migrating_legacy_layout" = true ] && [ -d "$HOME/.clawee-collector" ]; then
  mv "$HOME/.clawee-collector" "$HOME/.clawee-collector.backup-$(date +%%Y%%m%%d-%%H%%M%%S)"
fi

echo "clawee-collector installed"
echo "状态: running=true health_ok=true heartbeat_ok=true 时表示安装验证通过"
echo "下一步：在终端运行 codex，进入 Codex CLI 交互界面后输入 /hooks 并审核 Claw MCP Hook。"
`

const installPowerShellTemplate = `$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$OfficeUrl = %s
$DownloadBaseUrl = %s
$RegistrationCode = %s
$InstallRoot = if ($env:CLAWEE_COLLECTOR_DIR) { $env:CLAWEE_COLLECTOR_DIR } else { Join-Path $env:USERPROFILE ".clawee\collector" }
$InstallDir = Join-Path $InstallRoot "bin"
$ConfigPath = if ($env:CLAWEE_COLLECTOR_CONFIG) { $env:CLAWEE_COLLECTOR_CONFIG } else { Join-Path $InstallRoot "config.toml" }
$CodexConfigPath = if ($env:CODEX_CONFIG) { $env:CODEX_CONFIG } else { Join-Path $env:USERPROFILE ".codex\config.toml" }
$ClaweeAgentConfigPath = if ($env:CLAWEE_AGENT_CONFIG) { $env:CLAWEE_AGENT_CONFIG } else { Join-Path $env:USERPROFILE ".clawee\config.toml" }
$WorkspaceName = if ($env:CLAWEE_COLLECTOR_WORKSPACE) { $env:CLAWEE_COLLECTOR_WORKSPACE } else { Split-Path -Leaf (Get-Location) }

function Resolve-CollectorArch {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { return "amd64" }
    "ARM64" { return "arm64" }
    default { throw "unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE" }
  }
}

function Assert-NativeCommandSucceeded {
  param([int]$ExitCode, [string]$Step)
  if ($ExitCode -ne 0) {
    throw "$Step failed with exit code $ExitCode"
  }
}

function ConvertTo-PowerShellSingleQuoted {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Write-CollectorDiagnosticsSummary {
  param([string]$DiagnosticsDir)

  if (-not (Test-Path -LiteralPath $DiagnosticsDir)) {
    Write-Host "diagnostics_log="
    return
  }
  $LatestDiagnostics = Get-ChildItem -LiteralPath $DiagnosticsDir -Filter "install-*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $LatestDiagnostics) {
    Write-Host "diagnostics_log="
    return
  }
  Write-Host "diagnostics_log=$($LatestDiagnostics.FullName)"
  Write-Host "diagnostics_tail:"
  try {
    Get-Content -LiteralPath $LatestDiagnostics.FullName -Tail 12 -ErrorAction Stop
  } catch {
    Write-Host "diagnostics_tail_unavailable=$($_.Exception.Message)"
  }
}

function Read-CollectorDiagnosticsText {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return ""
  }
  try {
    $Bytes = [System.IO.File]::ReadAllBytes($Path)
    $Utf8Text = [System.Text.Encoding]::UTF8.GetString($Bytes)
    $DefaultText = [System.Text.Encoding]::Default.GetString($Bytes)
    return $Utf8Text + [Environment]::NewLine + $DefaultText
  } catch {
    return ""
  }
}

function Test-CleanupRuntimeMissingTaskFailure {
  param([string]$DiagnosticsDir)

  if (-not (Test-Path -LiteralPath $DiagnosticsDir)) {
    return $false
  }
  $LatestDiagnostics = Get-ChildItem -LiteralPath $DiagnosticsDir -Filter "install-*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $LatestDiagnostics) {
    return $false
  }
  $DiagnosticsText = Read-CollectorDiagnosticsText -Path $LatestDiagnostics.FullName
  $CleanupTaskFailed = $DiagnosticsText.Contains("cleanup_runtime_task_stop") -or $DiagnosticsText.Contains("cleanup_runtime_task_delete")
  $ChineseSystemCannotFindFile = -join @([char]0x7cfb, [char]0x7edf, [char]0x627e, [char]0x4e0d, [char]0x5230, [char]0x6307, [char]0x5b9a, [char]0x7684, [char]0x6587, [char]0x4ef6)
  $ChineseCannotFind = -join @([char]0x627e, [char]0x4e0d, [char]0x5230)
  $ChineseNotExist = -join @([char]0x4e0d, [char]0x5b58, [char]0x5728)
  $ChineseAccessDenied = -join @([char]0x62d2, [char]0x7edd, [char]0x8bbf, [char]0x95ee)
  $MissingTask = $false
  foreach ($Marker in @(
    "The system cannot find the file specified",
    $ChineseSystemCannotFindFile,
    $ChineseCannotFind,
    $ChineseNotExist
  )) {
    if ($DiagnosticsText.Contains($Marker)) {
      $MissingTask = $true
      break
    }
  }
  $AccessDenied = $false
  foreach ($Marker in @(
    "Access is denied",
    $ChineseAccessDenied
  )) {
    if ($DiagnosticsText.Contains($Marker)) {
      $AccessDenied = $true
      break
    }
  }
  return $CleanupTaskFailed -and $MissingTask -and -not $AccessDenied
}

function Invoke-StartupInstallElevated {
  param(
    [string]$BinaryPath,
    [string]$RunnerBinaryPath,
    [string]$ConfigPath,
    [string]$CodexConfigPath,
    [string]$InstallRoot
  )

  $DiagnosticsDir = Join-Path $InstallRoot "diagnostics"
  $RepairCommand = "& " + (ConvertTo-PowerShellSingleQuoted $BinaryPath) +
    " setup windows-user install-startup" +
    " --binary " + (ConvertTo-PowerShellSingleQuoted $BinaryPath) +
    " --runner-binary " + (ConvertTo-PowerShellSingleQuoted $RunnerBinaryPath) +
    " --config " + (ConvertTo-PowerShellSingleQuoted $ConfigPath) +
    " --codex-config " + (ConvertTo-PowerShellSingleQuoted $CodexConfigPath) +
    " --elevated"
  $StartupCommand = $RepairCommand + "; exit " + '$LASTEXITCODE'
  $StartupEncodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($StartupCommand))
  $StartupArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $StartupEncodedCommand)

  try {
    Write-Host "waiting for UAC approval: install startup task"
    $startupProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $StartupArgs -Verb RunAs -Wait -PassThru
    Write-Host "startup elevation stage completed"
  } catch {
    Write-Host "已完成用户级准备，但后台自启动未安装。"
    Write-Host "状态: prepared=true running=false connected=false"
    Write-Host "诊断日志目录: $DiagnosticsDir"
    Write-Host "创建或删除 ONLOGON 计划任务需要管理员权限。请在管理员 PowerShell 中执行以下修复命令："
    Write-Host $RepairCommand
    Write-Host "状态: prepared=true startup_installed=false running=false connected=false"
    Write-CollectorDiagnosticsSummary -DiagnosticsDir $DiagnosticsDir
    throw
  }

  if ($null -eq $startupProcess -or $startupProcess.ExitCode -ne 0) {
    Write-Host "已完成用户级准备，但后台自启动未安装。"
    Write-Host "状态: prepared=true running=false connected=false"
    Write-Host "诊断日志目录: $DiagnosticsDir"
    Write-Host "创建或删除 ONLOGON 计划任务需要管理员权限。请在管理员 PowerShell 中执行以下修复命令："
    Write-Host $RepairCommand
    Write-Host "状态: prepared=true startup_installed=false running=false connected=false"
    Write-CollectorDiagnosticsSummary -DiagnosticsDir $DiagnosticsDir
    if ($null -eq $startupProcess) {
      throw "windows collector startup install failed: UAC was cancelled or no child process was returned"
    }
    throw "windows collector startup install failed with exit code $($startupProcess.ExitCode)"
  }
}

function Invoke-CleanupRuntimeElevated {
  param(
    [string]$BinaryPath,
    [string]$RunnerBinaryPath,
    [string]$ConfigPath,
    [string]$CodexConfigPath,
    [string]$InstallRoot
  )

  if (-not (Test-Path -LiteralPath $BinaryPath)) {
    return 0
  }

  $DiagnosticsDir = Join-Path $InstallRoot "diagnostics"
  $CleanupCommand = "& " + (ConvertTo-PowerShellSingleQuoted $BinaryPath) +
    " setup windows-user cleanup-runtime" +
    " --binary " + (ConvertTo-PowerShellSingleQuoted $BinaryPath) +
    " --runner-binary " + (ConvertTo-PowerShellSingleQuoted $RunnerBinaryPath) +
    " --config " + (ConvertTo-PowerShellSingleQuoted $ConfigPath) +
    " --codex-config " + (ConvertTo-PowerShellSingleQuoted $CodexConfigPath) +
    " --elevated"
  $CleanupEncodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($CleanupCommand + "; exit " + '$LASTEXITCODE'))
  $CleanupArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $CleanupEncodedCommand)

  try {
    Write-Host "waiting for UAC approval: cleanup old runtime"
    $cleanupProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $CleanupArgs -Verb RunAs -Wait -PassThru
    Write-Host "cleanup elevation stage completed"
  } catch {
    Write-Host "安装已停止，未覆盖正式二进制"
    Write-Host "清理旧运行面失败，未下载新二进制"
    Write-Host "诊断日志目录: $DiagnosticsDir"
    Write-Host "清理旧运行面需要管理员权限。请在管理员 PowerShell 中执行以下修复命令："
    Write-Host $CleanupCommand
    Write-Host "状态: cleanup_runtime=false formal_binaries_replaced=false"
    Write-CollectorDiagnosticsSummary -DiagnosticsDir $DiagnosticsDir
    throw
  }

  if ($null -eq $cleanupProcess -or $cleanupProcess.ExitCode -ne 0) {
    if (Test-CleanupRuntimeMissingTaskFailure -DiagnosticsDir $DiagnosticsDir) {
      Write-Host "旧计划任务不存在，继续覆盖正式二进制"
      Write-CollectorDiagnosticsSummary -DiagnosticsDir $DiagnosticsDir
      return 0
    }
    Write-Host "安装已停止，未覆盖正式二进制"
    Write-Host "清理旧运行面失败，未下载新二进制"
    Write-Host "诊断日志目录: $DiagnosticsDir"
    Write-Host "请使用管理员 PowerShell 执行:"
    Write-Host "sc.exe stop ClaweeCollector"
    Write-Host "sc.exe delete ClaweeCollector"
    Write-Host "状态: cleanup_runtime=false formal_binaries_replaced=false"
    Write-CollectorDiagnosticsSummary -DiagnosticsDir $DiagnosticsDir
    if ($null -eq $cleanupProcess) {
      throw "windows current-user collector cleanup-runtime failed: UAC was cancelled or no child process was returned"
    }
    throw "windows current-user collector cleanup-runtime failed with exit code $($cleanupProcess.ExitCode)"
  }

  return $cleanupProcess.ExitCode
}

New-Item -ItemType Directory -Force $InstallDir | Out-Null
$BinaryPath = Join-Path $InstallDir "clawee-collector.exe"
$RunnerBinaryPath = Join-Path $InstallDir "clawee-collector-runner.exe"
$CleanupInstallRoot = $InstallRoot
$CleanupBinaryPath = $BinaryPath
$CleanupRunnerBinaryPath = $RunnerBinaryPath
$CleanupConfigPath = $ConfigPath
$MigratingLegacyLayout = $false
if (-not $env:CLAWEE_COLLECTOR_DIR -and -not (Test-Path -LiteralPath $BinaryPath)) {
  $LegacyInstallRoot = Join-Path $env:USERPROFILE ".clawee-collector"
  $LegacyBinaryPath = Join-Path $LegacyInstallRoot "bin\clawee-collector.exe"
  if (Test-Path -LiteralPath $LegacyBinaryPath) {
    $CleanupInstallRoot = $LegacyInstallRoot
    $CleanupBinaryPath = $LegacyBinaryPath
    $CleanupRunnerBinaryPath = Join-Path $LegacyInstallRoot "bin\clawee-collector-runner.exe"
    $CleanupConfigPath = Join-Path $LegacyInstallRoot "config.toml"
    if (-not (Test-Path -LiteralPath $CleanupConfigPath)) {
      $CleanupConfigPath = Join-Path $LegacyInstallRoot "config.json"
    }
    $MigratingLegacyLayout = $true
  }
}
$DownloadDir = Join-Path $InstallRoot ("downloads\" + [guid]::NewGuid().ToString("N"))
$DownloadBinaryPath = Join-Path $DownloadDir "clawee-collector.exe"
$DownloadRunnerBinaryPath = Join-Path $DownloadDir "clawee-collector-runner.exe"
$Arch = Resolve-CollectorArch
$DownloadUrl = "$DownloadBaseUrl/downloads/clawee-collector/windows/$Arch/clawee-collector.exe"
$RunnerDownloadUrl = "$DownloadBaseUrl/downloads/clawee-collector/windows/$Arch/clawee-collector-runner.exe"

$PreviousProgressPreference = $ProgressPreference
$ProgressPreference = "SilentlyContinue"
try {
$CleanupResult = Invoke-CleanupRuntimeElevated -BinaryPath $CleanupBinaryPath -RunnerBinaryPath $CleanupRunnerBinaryPath -ConfigPath $CleanupConfigPath -CodexConfigPath $CodexConfigPath -InstallRoot $CleanupInstallRoot
$CleanupExitCode = @($CleanupResult)[-1]
Assert-NativeCommandSucceeded $CleanupExitCode "windows current-user collector cleanup-runtime"

New-Item -ItemType Directory -Force $DownloadDir | Out-Null
Write-Host "cleanup completed; downloading collector binaries. Slow networks can take a few minutes. Keep this window open."
Write-Host "downloading clawee-collector.exe: $DownloadUrl"
Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $DownloadBinaryPath
Write-Host "downloading clawee-collector-runner.exe: $RunnerDownloadUrl"
Invoke-WebRequest -UseBasicParsing -Uri $RunnerDownloadUrl -OutFile $DownloadRunnerBinaryPath
Write-Host "collector binaries downloaded; replacing formal binaries"
} finally {
  $ProgressPreference = $PreviousProgressPreference
}

Move-Item -Force $DownloadBinaryPath $BinaryPath
Move-Item -Force $DownloadRunnerBinaryPath $RunnerBinaryPath

& $BinaryPath setup windows-user prepare ` + "`" + `
  --office-url $OfficeUrl ` + "`" + `
  --code $RegistrationCode ` + "`" + `
  --binary $BinaryPath ` + "`" + `
  --runner-binary $RunnerBinaryPath ` + "`" + `
  --config $ConfigPath ` + "`" + `
  --codex-config $CodexConfigPath ` + "`" + `
  --clawee-agent-config $ClaweeAgentConfigPath ` + "`" + `
  --workspace $WorkspaceName
Assert-NativeCommandSucceeded $LASTEXITCODE "windows current-user collector prepare"

Invoke-StartupInstallElevated -BinaryPath $BinaryPath -RunnerBinaryPath $RunnerBinaryPath -ConfigPath $ConfigPath -CodexConfigPath $CodexConfigPath -InstallRoot $InstallRoot

Write-Host "安装结果:"
& $BinaryPath setup windows-user diagnose ` + "`" + `
  --config $ConfigPath ` + "`" + `
  --codex-config $CodexConfigPath
Assert-NativeCommandSucceeded $LASTEXITCODE "windows current-user collector diagnose"

if ($MigratingLegacyLayout -and (Test-Path -LiteralPath $CleanupInstallRoot)) {
  $LegacyBackupPath = "$CleanupInstallRoot.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Move-Item -LiteralPath $CleanupInstallRoot -Destination $LegacyBackupPath
}

Write-Host "clawee-collector installed for current Windows user"
Write-Host "下一步：在终端运行 codex，进入 Codex CLI 交互界面后输入 /hooks 并审核 Claw MCP Hook。 ".TrimEnd()
`
