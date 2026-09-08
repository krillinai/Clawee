package windowsuser

import (
	"context"
	"encoding/xml"
	"fmt"
	"os"
	"strings"
	"unicode/utf16"
)

type TaskManager struct {
	runner CommandRunner
}

type TaskStatus struct {
	Exists     bool   `json:"exists"`
	Running    bool   `json:"running"`
	UsesRunner bool   `json:"uses_runner"`
	Output     string `json:"-"`
}

type taskCommandResultKind int

const (
	taskCommandResultOK taskCommandResultKind = iota
	taskCommandResultMissing
	taskCommandResultNotRunning
	taskCommandResultAccessDenied
	taskCommandResultOther
)

func NewTaskManager(runner CommandRunner) *TaskManager {
	if runner == nil {
		runner = ExecCommandRunner{}
	}
	return &TaskManager{runner: runner}
}

func (m *TaskManager) Stop(ctx context.Context) error {
	result := m.runner.Run(ctx, "schtasks.exe", "/End", "/TN", TaskName)
	switch classifyTaskCommandResult(result) {
	case taskCommandResultOK, taskCommandResultMissing, taskCommandResultNotRunning:
		return nil
	}
	return fmt.Errorf("停止当前用户计划任务失败: %s", result.Output)
}

func (m *TaskManager) CreateOrUpdate(ctx context.Context, runnerBinaryPath string, configPath string, logDir string) error {
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp("", "clawee-collector-task-*.xml")
	if err != nil {
		return err
	}
	xmlPath := file.Name()
	defer os.Remove(xmlPath)
	if _, err := file.Write(BuildScheduledTaskXMLFileBytes(runnerBinaryPath, configPath, logDir)); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	result := m.runner.Run(ctx, "schtasks.exe", "/Create", "/TN", TaskName, "/XML", xmlPath, "/F")
	if result.OK() {
		return nil
	}
	if classifyTaskCommandResult(result) == taskCommandResultAccessDenied {
		fallback := m.runner.Run(ctx, "schtasks.exe", "/Create", "/TN", TaskName, "/SC", "ONLOGON", "/TR", BuildScheduledTaskCommand(runnerBinaryPath, configPath, logDir), "/RL", "LIMITED", "/F")
		if fallback.OK() {
			return nil
		}
		return fmt.Errorf("创建当前用户计划任务失败: %s", fallback.Output)
	}
	return fmt.Errorf("创建当前用户计划任务失败: %s", result.Output)
}

func (m *TaskManager) Start(ctx context.Context) error {
	result := m.runner.Run(ctx, "schtasks.exe", "/Run", "/TN", TaskName)
	if !result.OK() {
		return fmt.Errorf("启动当前用户计划任务失败: %s", result.Output)
	}
	return nil
}

func (m *TaskManager) Delete(ctx context.Context) error {
	result := m.runner.Run(ctx, "schtasks.exe", "/Delete", "/TN", TaskName, "/F")
	switch classifyTaskCommandResult(result) {
	case taskCommandResultOK, taskCommandResultMissing:
		return nil
	}
	return fmt.Errorf("删除当前用户计划任务失败: %s", result.Output)
}

func (m *TaskManager) Query(ctx context.Context) (TaskStatus, error) {
	result := m.runner.Run(ctx, "schtasks.exe", "/Query", "/TN", TaskName, "/FO", "LIST", "/V")
	switch classifyTaskCommandResult(result) {
	case taskCommandResultMissing:
		return TaskStatus{}, nil
	case taskCommandResultOK:
	default:
		return TaskStatus{}, fmt.Errorf("查询当前用户计划任务失败: %s", result.Output)
	}
	return TaskStatus{
		Exists:     true,
		Running:    taskOutputRunning(result.Output),
		UsesRunner: taskOutputUsesRunner(result.Output),
		Output:     result.Output,
	}, nil
}

func taskOutputRunning(output string) bool {
	for _, line := range strings.FieldsFunc(output, func(r rune) bool { return r == '\r' || r == '\n' }) {
		normalized := strings.ToLower(strings.TrimSpace(line))
		if strings.HasPrefix(normalized, "status:") || strings.HasPrefix(normalized, "状态:") || strings.HasPrefix(normalized, "鐘舵€:") {
			return outputContainsAny(normalized, []string{
				"running",
				"正在运行",
				"姝ｅ湪杩愯",
			})
		}
	}
	return false
}

func taskOutputUsesRunner(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "clawee-collector-runner.exe")
}

func classifyTaskCommandResult(result CommandResult) taskCommandResultKind {
	if result.OK() {
		return taskCommandResultOK
	}
	output := strings.ToLower(result.Output)
	if taskAccessDenied(output) {
		return taskCommandResultAccessDenied
	}
	if result.ExitCode != 1 {
		return taskCommandResultOther
	}
	switch {
	case outputContainsAny(output, []string{
		"cannot find",
		"does not exist",
		"no scheduled task",
		"找不到",
		"不存在",
		"鎵句笉鍒",
		"涓嶅瓨鍦",
		"系统找不到指定的文件",
	}):
		return taskCommandResultMissing
	case outputContainsAny(output, []string{
		"not currently running",
		"has not been started",
		"未运行",
		"没有运行",
		"鏈繍琛",
		"娌℃湁杩愯",
	}):
		return taskCommandResultNotRunning
	default:
		return taskCommandResultOther
	}
}

func taskAccessDenied(output string) bool {
	return outputContainsAny(strings.ToLower(output), []string{
		"access is denied",
		"拒绝访问",
		"存取被拒",
	})
}

func outputContainsAny(output string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(output, marker) {
			return true
		}
	}
	return false
}

func taskMissing(result CommandResult) bool {
	return classifyTaskCommandResult(result) == taskCommandResultMissing
}

func taskNotRunning(result CommandResult) bool {
	return classifyTaskCommandResult(result) == taskCommandResultNotRunning
}

func BuildScheduledTaskXML(runnerBinaryPath string, configPath string, logDir string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%s</Command>
      <Arguments>--config &quot;%s&quot; --log-dir &quot;%s&quot;</Arguments>
      <WorkingDirectory>%s</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`, xmlEscape(runnerBinaryPath), xmlEscape(configPath), xmlEscape(logDir), xmlEscape(logDir))
}

func BuildScheduledTaskCommand(runnerBinaryPath string, configPath string, logDir string) string {
	return fmt.Sprintf(`"%s" --config "%s" --log-dir "%s"`, runnerBinaryPath, configPath, logDir)
}

func BuildScheduledTaskXMLFileBytes(runnerBinaryPath string, configPath string, logDir string) []byte {
	xml := BuildScheduledTaskXML(runnerBinaryPath, configPath, logDir)
	encoded := utf16.Encode([]rune(xml))
	data := make([]byte, 2, 2+len(encoded)*2)
	data[0] = 0xff
	data[1] = 0xfe
	for _, unit := range encoded {
		data = append(data, byte(unit), byte(unit>>8))
	}
	return data
}

func xmlEscape(value string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(value))
	return b.String()
}
