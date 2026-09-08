package windowsuser

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestBuildScheduledTaskXMLUsesHiddenRunnerTask(t *testing.T) {
	xml := BuildScheduledTaskXML(`C:\Users\Me\.clawee-collector\bin\clawee-collector-runner.exe`, `C:\Users\Me\.clawee-collector\config.json`, `C:\Users\Me\.clawee-collector\logs`)

	for _, want := range []string{
		"<LogonTrigger>",
		"<Command>C:\\Users\\Me\\.clawee-collector\\bin\\clawee-collector-runner.exe</Command>",
		"<Arguments>--config &quot;C:\\Users\\Me\\.clawee-collector\\config.json&quot; --log-dir &quot;C:\\Users\\Me\\.clawee-collector\\logs&quot;</Arguments>",
		"<RunLevel>LeastPrivilege</RunLevel>",
		"<RestartOnFailure>",
		"<Interval>PT1M</Interval>",
		"<Count>3</Count>",
		"<StartWhenAvailable>true</StartWhenAvailable>",
		"<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
		"<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
		"<StopOnIdleEnd>false</StopOnIdleEnd>",
	} {
		if !strings.Contains(xml, want) {
			t.Fatalf("task XML missing %q:\n%s", want, xml)
		}
	}
	if strings.Contains(xml, "clawee-collector.exe</Command>") || strings.Contains(xml, "run --config") {
		t.Fatalf("task XML should use runner directly, got:\n%s", xml)
	}
}

func TestTaskManagerCreateUsesSchtasksXML(t *testing.T) {
	runner := &fakeCommandRunner{}
	manager := NewTaskManager(runner)

	err := manager.CreateOrUpdate(context.Background(), `C:\bin\clawee-collector-runner.exe`, `C:\cfg\config.json`, `C:\logs`)
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("calls = %#v", runner.calls)
	}
	call := runner.calls[0]
	if call.name != "schtasks.exe" {
		t.Fatalf("name = %q", call.name)
	}
	joined := strings.Join(call.args, " ")
	for _, want := range []string{"/Create", "/TN", "ClaweeCollector", "/XML", "/F"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("schtasks args missing %q: %#v", want, call.args)
		}
	}
}

func TestTaskManagerCreateFallsBackToBasicOnAccessDenied(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{
			{ExitCode: 1, Output: "ERROR: Access is denied.", Err: testError("exit status 1")},
			{ExitCode: 0, Output: "SUCCESS"},
		},
	}
	manager := NewTaskManager(runner)

	err := manager.CreateOrUpdate(context.Background(), `C:\bin\clawee-collector-runner.exe`, `C:\cfg\config.json`, `C:\logs`)
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %#v", runner.calls)
	}
	joined := strings.Join(runner.calls[1].args, " ")
	for _, want := range []string{"/Create", "/TN", "ClaweeCollector", "/SC", "ONLOGON", "/TR", "/RL", "LIMITED", "/F"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("fallback schtasks args missing %q: %#v", want, runner.calls[1].args)
		}
	}
	if !strings.Contains(joined, "clawee-collector-runner.exe") || !strings.Contains(joined, "--log-dir") {
		t.Fatalf("fallback task command missing runner or log dir: %#v", runner.calls[1].args)
	}
}

func TestTaskManagerCreateFallsBackToBasicOnAccessDeniedExitCodeFive(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{
			{ExitCode: 5, Output: "ERROR: Access is denied.", Err: testError("exit status 5")},
			{ExitCode: 0, Output: "SUCCESS"},
		},
	}
	manager := NewTaskManager(runner)

	err := manager.CreateOrUpdate(context.Background(), `C:\bin\clawee-collector-runner.exe`, `C:\cfg\config.json`, `C:\logs`)
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %#v", runner.calls)
	}
	joined := strings.Join(runner.calls[1].args, " ")
	for _, want := range []string{"/Create", "/TN", "ClaweeCollector", "/SC", "ONLOGON", "/TR", "/RL", "LIMITED", "/F"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("fallback schtasks args missing %q: %#v", want, runner.calls[1].args)
		}
	}
}

func TestBuildScheduledTaskXMLFileBytesUseUTF16LE(t *testing.T) {
	data := BuildScheduledTaskXMLFileBytes(`C:\bin\clawee-collector-runner.exe`, `C:\cfg\config.json`, `C:\logs`)
	if !bytes.HasPrefix(data, []byte{0xff, 0xfe}) {
		t.Fatalf("task XML file missing UTF-16LE BOM: % x", data[:4])
	}

	units := make([]uint16, 0, (len(data)-2)/2)
	for i := 2; i+1 < len(data); i += 2 {
		units = append(units, uint16(data[i])|uint16(data[i+1])<<8)
	}
	xml := string(utf16.Decode(units))
	if !strings.HasPrefix(xml, `<?xml version="1.0" encoding="UTF-16"?>`) {
		t.Fatalf("task XML declaration = %q", strings.SplitN(xml, "\n", 2)[0])
	}
	if !strings.Contains(xml, `<Arguments>--config &quot;C:\cfg\config.json&quot; --log-dir &quot;C:\logs&quot;</Arguments>`) {
		t.Fatalf("task XML missing arguments:\n%s", xml)
	}
}

func TestBuildScheduledTaskXMLEscapesSpecialWindowsPaths(t *testing.T) {
	xml := BuildScheduledTaskXML(
		`C:\Users\Me & Team\.clawee-collector\bin\clawee "collector-runner".exe`,
		`C:\Users\Me & Team\.clawee-collector\config "prod".json`,
		`C:\Users\Me & Team\.clawee-collector\logs\`,
	)
	for _, want := range []string{
		`Me &amp; Team`,
		`clawee &#34;collector-runner&#34;.exe`,
		`config &#34;prod&#34;.json`,
		`--log-dir &quot;C:\Users\Me &amp; Team\.clawee-collector\logs\&quot;`,
		`<WorkingDirectory>C:\Users\Me &amp; Team\.clawee-collector\logs\</WorkingDirectory>`,
	} {
		if !strings.Contains(xml, want) {
			t.Fatalf("task XML missing escaped path %q:\n%s", want, xml)
		}
	}
}

func TestTaskManagerDeleteIgnoresMissingTask(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 1, Output: "ERROR: The system cannot find the file specified."}},
	}
	manager := NewTaskManager(runner)

	if err := manager.Delete(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTaskManagerDeleteIgnoresLocalizedMissingTask(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 1, Output: "错误: 系统找不到指定的文件。"}},
	}
	manager := NewTaskManager(runner)

	if err := manager.Delete(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTaskManagerDeleteIgnoresLegacyLocalizedMissingMarkers(t *testing.T) {
	for _, output := range []string{
		"错误: 计划任务不存在。",
		"错误: 鎵句笉鍒版寚瀹氱殑鏂囦欢。",
		"错误: 涓嶅瓨鍦ㄦ寚瀹氱殑浠诲姟。",
	} {
		t.Run(output, func(t *testing.T) {
			runner := &fakeCommandRunner{
				results: []CommandResult{{ExitCode: 1, Output: output, Err: testError("exit status 1")}},
			}
			manager := NewTaskManager(runner)

			if err := manager.Delete(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTaskManagerStopIgnoresChineseMissingTask(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 1, Output: "错误: 系统找不到指定的文件。", Err: testError("exit status 1")}},
	}
	manager := NewTaskManager(runner)

	if err := manager.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTaskManagerStopIgnoresMojibakeChineseMissingTask(t *testing.T) {
	for _, output := range []string{
		"停止当前用户计划任务失败: 错误: 系统找不到指定的文件。",
		"鍋滄褰撳墠鐢ㄦ埛璁″垝浠诲姟澶辫触: 错误: 系统找不到指定的文件。",
	} {
		t.Run(output, func(t *testing.T) {
			runner := &fakeCommandRunner{
				results: []CommandResult{{ExitCode: 1, Output: output, Err: testError("exit status 1")}},
			}
			manager := NewTaskManager(runner)

			if err := manager.Stop(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTaskManagerStopIgnoresLegacyLocalizedNotRunningMarkers(t *testing.T) {
	for _, output := range []string{
		"错误: 任务未运行。",
		"错误: 没有运行中的任务。",
		"错误: 鏈繍琛岀殑浠诲姟。",
		"错误: 娌℃湁杩愯鐨勪换鍔。",
	} {
		t.Run(output, func(t *testing.T) {
			runner := &fakeCommandRunner{
				results: []CommandResult{{ExitCode: 1, Output: output, Err: testError("exit status 1")}},
			}
			manager := NewTaskManager(runner)

			if err := manager.Stop(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTaskManagerStopDoesNotIgnoreAccessDenied(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 1, Output: "ERROR: Access is denied.", Err: testError("exit status 1")}},
	}
	manager := NewTaskManager(runner)

	err := manager.Stop(context.Background())
	if err == nil {
		t.Fatal("expected access denied to stop cleanup")
	}
	if !strings.Contains(err.Error(), "Access is denied") {
		t.Fatalf("error = %v", err)
	}
}

func TestTaskManagerStopDoesNotIgnoreChineseAccessDenied(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 1, Output: "错误: 拒绝访问。", Err: testError("exit status 1")}},
	}
	manager := NewTaskManager(runner)

	err := manager.Stop(context.Background())
	if err == nil {
		t.Fatal("expected access denied to stop cleanup")
	}
	if !strings.Contains(err.Error(), "拒绝访问") {
		t.Fatalf("error = %v", err)
	}
}

func TestTaskManagerQueryReportsExistsAndRunning(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 0, Output: "TaskName: ClaweeCollector\r\nStatus: Running\r\nTask To Run: C:\\bin\\clawee-collector-runner.exe --config C:\\config.json"}},
	}
	manager := NewTaskManager(runner)

	status, err := manager.Query(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Exists || !status.Running || !status.UsesRunner {
		t.Fatalf("status = %#v", status)
	}
	if got := strings.Join(runner.calls[0].args, " "); !strings.Contains(got, "/V") {
		t.Fatalf("query args = %q, want /V", got)
	}
}

func TestTaskManagerQueryReportsRunningForChineseOutput(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 0, Output: "任务名: ClaweeCollector\r\n状态: 正在运行\r\n要运行的任务: C:\\bin\\clawee-collector-runner.exe --config C:\\config.json"}},
	}
	manager := NewTaskManager(runner)

	status, err := manager.Query(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Exists || !status.Running || !status.UsesRunner {
		t.Fatalf("status = %#v", status)
	}
}

func TestTaskManagerQueryDoesNotTreatRepeatRunningTextAsTaskRunning(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 0, Output: "TaskName: ClaweeCollector\r\nStatus: Ready\r\nTask To Run: C:\\bin\\clawee-collector-runner.exe --config C:\\config.json\r\nRepeat: Stop If Still Running: N/A"}},
	}
	manager := NewTaskManager(runner)

	status, err := manager.Query(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Exists || status.Running || !status.UsesRunner {
		t.Fatalf("status = %#v", status)
	}
}

func TestTaskManagerQueryReportsMissingForChineseOutput(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 1, Output: "错误: 系统找不到指定的文件。", Err: testError("exit status 1")}},
	}
	manager := NewTaskManager(runner)

	status, err := manager.Query(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Exists {
		t.Fatalf("status = %#v, want missing", status)
	}
}

func TestTaskManagerClassifiesChineseMissingAndAccessDeniedResults(t *testing.T) {
	tests := []struct {
		name   string
		result CommandResult
		want   taskCommandResultKind
	}{
		{
			name:   "missing",
			result: CommandResult{ExitCode: 1, Output: "错误: 系统找不到指定的文件。", Err: testError("exit status 1")},
			want:   taskCommandResultMissing,
		},
		{
			name:   "plain missing contains zhaobudao",
			result: CommandResult{ExitCode: 1, Output: "错误: 找不到指定的计划任务。", Err: testError("exit status 1")},
			want:   taskCommandResultMissing,
		},
		{
			name:   "plain missing contains bucunzai",
			result: CommandResult{ExitCode: 1, Output: "错误: 计划任务不存在。", Err: testError("exit status 1")},
			want:   taskCommandResultMissing,
		},
		{
			name:   "mojibake missing contains zhaobudao",
			result: CommandResult{ExitCode: 1, Output: "错误: 鎵句笉鍒版寚瀹氱殑鏂囦欢。", Err: testError("exit status 1")},
			want:   taskCommandResultMissing,
		},
		{
			name:   "mojibake missing contains bucunzai",
			result: CommandResult{ExitCode: 1, Output: "错误: 涓嶅瓨鍦ㄦ寚瀹氱殑浠诲姟。", Err: testError("exit status 1")},
			want:   taskCommandResultMissing,
		},
		{
			name:   "plain not running contains weiyunxing",
			result: CommandResult{ExitCode: 1, Output: "错误: 任务未运行。", Err: testError("exit status 1")},
			want:   taskCommandResultNotRunning,
		},
		{
			name:   "plain not running contains meiyouyunxing",
			result: CommandResult{ExitCode: 1, Output: "错误: 没有运行中的任务。", Err: testError("exit status 1")},
			want:   taskCommandResultNotRunning,
		},
		{
			name:   "mojibake not running contains weiyunxing",
			result: CommandResult{ExitCode: 1, Output: "错误: 鏈繍琛岀殑浠诲姟。", Err: testError("exit status 1")},
			want:   taskCommandResultNotRunning,
		},
		{
			name:   "mojibake not running contains meiyouyunxing",
			result: CommandResult{ExitCode: 1, Output: "错误: 娌℃湁杩愯鐨勪换鍔。", Err: testError("exit status 1")},
			want:   taskCommandResultNotRunning,
		},
		{
			name:   "access denied",
			result: CommandResult{ExitCode: 1, Output: "错误: 拒绝访问。", Err: testError("exit status 1")},
			want:   taskCommandResultAccessDenied,
		},
		{
			name:   "traditional access denied",
			result: CommandResult{ExitCode: 1, Output: "错误: 存取被拒。", Err: testError("exit status 1")},
			want:   taskCommandResultAccessDenied,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyTaskCommandResult(tt.result); got != tt.want {
				t.Fatalf("kind = %v, want %v", got, tt.want)
			}
		})
	}
}
