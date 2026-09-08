package unixuser

import (
	"context"
	"os"
	"strconv"
	"strings"

	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

type InstallTrace struct {
	ConfigExists      bool `json:"config_exists"`
	BinaryExists      bool `json:"binary_exists"`
	LaunchAgentExists bool `json:"launch_agent_exists"`
	LaunchAgentLoaded bool `json:"launch_agent_loaded"`
	SystemdUnitExists bool `json:"systemd_unit_exists"`
	SystemdUnitLoaded bool `json:"systemd_unit_loaded"`
	CodexHookExists   bool `json:"codex_hook_exists"`
}

func (t InstallTrace) Any() bool {
	return t.ConfigExists || t.BinaryExists || t.LaunchAgentExists || t.LaunchAgentLoaded || t.SystemdUnitExists || t.SystemdUnitLoaded || t.CodexHookExists
}

func (t InstallTrace) RequiresExistingBinary() bool {
	return t.Any() && !t.BinaryExists
}

func DetectExistingInstall(paths Paths, platform Platform, runner common.CommandRunner) (InstallTrace, error) {
	trace := InstallTrace{
		ConfigExists:    fileExists(paths.ConfigPath),
		BinaryExists:    fileExists(paths.BinaryPath),
		CodexHookExists: hookBlockExists(paths.CodexConfigPath),
	}

	switch platform.OS {
	case "darwin":
		trace.LaunchAgentExists = fileExists(paths.LaunchAgentPath)
		if runner != nil {
			result := runner.Run(context.Background(), "launchctl", "print", "gui/"+strconv.Itoa(os.Getuid())+"/"+LaunchAgentLabel)
			trace.LaunchAgentLoaded = result.OK()
		}
	case "linux":
		trace.SystemdUnitExists = fileExists(paths.SystemdUnitPath)
		if runner != nil {
			result := runner.Run(context.Background(), "systemctl", "--user", "status", SystemdUnitName)
			trace.SystemdUnitLoaded = systemdUnitLoaded(result)
		}
	}

	return trace, nil
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

func hookBlockExists(path string) bool {
	body, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.Contains(string(body), "# BEGIN clawee-collector codex hooks")
}

func systemdUnitLoaded(result common.CommandResult) bool {
	output := result.Output
	if strings.Contains(output, "Loaded: loaded") {
		return true
	}
	lower := strings.ToLower(output)
	if strings.Contains(lower, "loaded: not-found") || strings.Contains(lower, "could not be found") {
		return false
	}
	return result.OK()
}
