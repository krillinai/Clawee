package windowsuser

import (
	"context"
	"fmt"
	"strings"
)

type ProcessManager struct {
	runner CommandRunner
}

func NewProcessManager(runner CommandRunner) *ProcessManager {
	if runner == nil {
		runner = ExecCommandRunner{}
	}
	return &ProcessManager{runner: runner}
}

func (m *ProcessManager) WaitReleased(ctx context.Context, binaryPath string, runnerBinaryPath string) error {
	script := fmt.Sprintf(`
$ErrorActionPreference = "Stop"
$runnerBinaryPath = %s
function Get-CollectorRunnerProcess {
  @(Get-Process -Name "clawee-collector-runner" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $runnerBinaryPath } catch { $false }
  })
}
$deadline = (Get-Date).AddSeconds(8)
do {
  $running = Get-CollectorRunnerProcess
  if ($running.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 200
} while ((Get-Date) -lt $deadline)
$running | Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(3)
do {
  $running = Get-CollectorRunnerProcess
  if ($running.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 200
} while ((Get-Date) -lt $deadline)
Write-Output "collector processes still running after cleanup-runtime"
exit 1
`, quotePowerShellString(runnerBinaryPath))
	result := m.runner.Run(ctx, "powershell.exe",
		"-NoProfile",
		"-ExecutionPolicy", "Bypass",
		"-Command", script,
	)
	if result.OK() {
		return nil
	}
	return fmt.Errorf("等待旧采集器进程释放失败: %s", result.Output)
}

func quotePowerShellString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
