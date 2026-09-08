package windowsuser

import (
	"context"
	"fmt"
	"strings"
)

type LegacyServiceManager struct {
	runner CommandRunner
}

func NewLegacyServiceManager(runner CommandRunner) *LegacyServiceManager {
	if runner == nil {
		runner = ExecCommandRunner{}
	}
	return &LegacyServiceManager{runner: runner}
}

func (m *LegacyServiceManager) Cleanup(ctx context.Context) (LegacyServiceStatus, error) {
	query := m.runner.Run(ctx, "sc.exe", "query", TaskName)
	if query.OK() {
		stop := m.runner.Run(ctx, "sc.exe", "stop", TaskName)
		if !stop.OK() && !strings.Contains(strings.ToLower(stop.Output), "has not been started") {
			err := fmt.Errorf("旧机器级 Windows Service 清理失败: %s\n请使用管理员 PowerShell 执行:\nsc.exe stop ClaweeCollector\nsc.exe delete ClaweeCollector", stop.Output)
			return LegacyServiceStatus{Exists: true, Error: err.Error()}, err
		}
		del := m.runner.Run(ctx, "sc.exe", "delete", TaskName)
		if !del.OK() {
			err := fmt.Errorf("旧机器级 Windows Service 删除失败: %s\n请使用管理员 PowerShell 执行:\nsc.exe stop ClaweeCollector\nsc.exe delete ClaweeCollector", del.Output)
			return LegacyServiceStatus{Exists: true, Error: err.Error()}, err
		}
		return LegacyServiceStatus{Exists: true, Cleaned: true}, nil
	}
	if query.ExitCode == 1060 || strings.Contains(strings.ToLower(query.Output), "does not exist") {
		return LegacyServiceStatus{}, nil
	}
	err := fmt.Errorf("检查旧机器级 Windows Service 失败: %s", query.Output)
	return LegacyServiceStatus{Error: err.Error()}, err
}

func (m *LegacyServiceManager) Query(ctx context.Context) (LegacyServiceStatus, error) {
	query := m.runner.Run(ctx, "sc.exe", "query", TaskName)
	if query.OK() {
		return LegacyServiceStatus{Exists: true}, nil
	}
	if query.ExitCode == 1060 || strings.Contains(strings.ToLower(query.Output), "does not exist") {
		return LegacyServiceStatus{}, nil
	}
	err := fmt.Errorf("检查旧机器级 Windows Service 失败: %s", query.Output)
	return LegacyServiceStatus{Error: err.Error()}, err
}
