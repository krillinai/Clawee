package unixuser

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

type StartupOptions struct {
	BinaryPath      string
	ConfigPath      string
	CodexConfigPath string
	GOOS            string
}

func BuildLaunchAgentPlist(binaryPath string, configPath string) string {
	return strings.Join([]string{
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
		`<plist version="1.0">`,
		`<dict>`,
		`  <key>Label</key>`,
		`  <string>` + binaryXML(LaunchAgentLabel) + `</string>`,
		`  <key>ProgramArguments</key>`,
		`  <array>`,
		`    <string>` + binaryXML(binaryPath) + `</string>`,
		`    <string>run</string>`,
		`    <string>--config</string>`,
		`    <string>` + binaryXML(configPath) + `</string>`,
		`  </array>`,
		`  <key>RunAtLoad</key>`,
		`  <true/>`,
		`  <key>KeepAlive</key>`,
		`  <true/>`,
		`</dict>`,
		`</plist>`,
		"",
	}, "\n")
}

func BuildSystemdUserUnit(binaryPath string, configPath string) string {
	return strings.Join([]string{
		"[Unit]",
		"Description=Clawee Collector",
		"After=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		"ExecStart=" + strconv.Quote(binaryPath) + " run --config " + strconv.Quote(configPath),
		"Restart=always",
		"RestartSec=5",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	}, "\n")
}

func installStartup(ctx context.Context, paths Paths, platform Platform, runner common.CommandRunner) error {
	if runner == nil {
		runner = common.ExecCommandRunner{}
	}

	switch platform.OS {
	case "darwin":
		return installLaunchAgent(ctx, paths, runner)
	case "linux":
		return installSystemdUserService(ctx, paths, runner)
	default:
		return fmt.Errorf("unsupported unix-user platform: %s", platform.OS)
	}
}

func installLaunchAgent(ctx context.Context, paths Paths, runner common.CommandRunner) error {
	if err := os.MkdirAll(filepath.Dir(paths.LaunchAgentPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(paths.LaunchAgentPath, []byte(BuildLaunchAgentPlist(paths.BinaryPath, paths.ConfigPath)), 0o644); err != nil {
		return err
	}
	load := runner.Run(ctx, "launchctl", "bootstrap", "gui/"+strconv.Itoa(os.Getuid()), paths.LaunchAgentPath)
	if !load.OK() {
		return fmt.Errorf("launchctl bootstrap failed: %s", commandErrorText(load))
	}
	kickstart := runner.Run(ctx, "launchctl", "kickstart", "-k", "gui/"+strconv.Itoa(os.Getuid())+"/"+LaunchAgentLabel)
	if !kickstart.OK() {
		return fmt.Errorf("launchctl kickstart failed: %s", commandErrorText(kickstart))
	}
	return nil
}

func installSystemdUserService(ctx context.Context, paths Paths, runner common.CommandRunner) error {
	if err := os.MkdirAll(filepath.Dir(paths.SystemdUnitPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(paths.SystemdUnitPath, []byte(BuildSystemdUserUnit(paths.BinaryPath, paths.ConfigPath)), 0o644); err != nil {
		return err
	}

	reload := runner.Run(ctx, "systemctl", "--user", "daemon-reload")
	if !reload.OK() {
		return fmt.Errorf("systemctl daemon-reload failed: %s", commandErrorText(reload))
	}
	enable := runner.Run(ctx, "systemctl", "--user", "enable", SystemdUnitName)
	if !enable.OK() {
		return fmt.Errorf("systemctl enable failed: %s", commandErrorText(enable))
	}
	restart := runner.Run(ctx, "systemctl", "--user", "restart", SystemdUnitName)
	if !restart.OK() {
		return fmt.Errorf("systemctl restart failed: %s", commandErrorText(restart))
	}
	return nil
}

func binaryXML(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(value)
}
