package unixuser

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/krillinai/Clawee/server/internal/collector/codexconfig"
	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

func CleanupRuntime(ctx context.Context, paths Paths, platform Platform, runner common.CommandRunner, removeHooks func(string) (bool, error)) (RuntimeCleanupResult, error) {
	if runner == nil {
		runner = common.ExecCommandRunner{}
	}
	if removeHooks == nil {
		removeHooks = codexconfig.RemoveHooks
	}

	switch platform.OS {
	case "darwin":
		if err := cleanupLaunchAgent(ctx, paths, runner); err != nil {
			return RuntimeCleanupResult{}, err
		}
	case "linux":
		if err := cleanupSystemdUserService(ctx, paths, runner); err != nil {
			return RuntimeCleanupResult{}, err
		}
	default:
		return RuntimeCleanupResult{}, fmt.Errorf("unsupported unix-user platform: %s", platform.OS)
	}

	hooksRemoved, err := removeHooks(paths.CodexConfigPath)
	if err != nil {
		return RuntimeCleanupResult{StartupRemoved: true}, err
	}
	return RuntimeCleanupResult{StartupRemoved: true, HooksRemoved: hooksRemoved}, nil
}

func cleanupLaunchAgent(ctx context.Context, paths Paths, runner common.CommandRunner) error {
	result := runner.Run(ctx, "launchctl", "bootout", "gui/"+strconv.Itoa(os.Getuid()), paths.LaunchAgentPath)
	if !result.OK() && !launchAgentMissing(result) {
		return fmt.Errorf("launchctl bootout failed: %s", commandErrorText(result))
	}
	if err := os.Remove(paths.LaunchAgentPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func cleanupSystemdUserService(ctx context.Context, paths Paths, runner common.CommandRunner) error {
	stop := runner.Run(ctx, "systemctl", "--user", "stop", SystemdUnitName)
	if !stop.OK() && !systemdUnitMissing(stop) {
		return fmt.Errorf("systemctl stop failed: %s", commandErrorText(stop))
	}

	disable := runner.Run(ctx, "systemctl", "--user", "disable", SystemdUnitName)
	if !disable.OK() && !systemdUnitMissing(disable) {
		return fmt.Errorf("systemctl disable failed: %s", commandErrorText(disable))
	}

	if err := os.Remove(paths.SystemdUnitPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func launchAgentMissing(result common.CommandResult) bool {
	return containsAnyFold(result.Output, []string{
		"No such process",
		"No such file or directory",
		"Could not find service",
		"service not found",
	})
}

func systemdUnitMissing(result common.CommandResult) bool {
	return containsAnyFold(result.Output, []string{
		"not loaded",
		"could not be found",
		"not-found",
		"No such file or directory",
	})
}

func containsAnyFold(value string, parts []string) bool {
	lower := strings.ToLower(value)
	for _, part := range parts {
		if strings.Contains(lower, strings.ToLower(part)) {
			return true
		}
	}
	return false
}

func commandErrorText(result common.CommandResult) string {
	if strings.TrimSpace(result.Output) != "" {
		return result.Output
	}
	if result.Err != nil {
		return result.Err.Error()
	}
	return fmt.Sprintf("exit code %d", result.ExitCode)
}
