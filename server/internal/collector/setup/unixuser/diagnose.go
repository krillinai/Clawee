package unixuser

import (
	"context"
	"encoding/json"
	"fmt"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

type DiagnoseOptions struct {
	ConfigPath      string
	CodexConfigPath string
	JSON            bool
	GOOS            string
}

type DiagnoseResult struct {
	Status StatusSummary
	Text   string
	JSON   string
}

func (i *Installer) Diagnose(ctx context.Context, options DiagnoseOptions) (DiagnoseResult, error) {
	_ = ctx

	paths, err := i.resolvePaths(Options{
		ConfigPath:      options.ConfigPath,
		CodexConfigPath: options.CodexConfigPath,
		GOOS:            options.GOOS,
	})
	if err != nil {
		return DiagnoseResult{}, err
	}

	platform, err := DetectPlatform(options.GOOS)
	if err != nil {
		return DiagnoseResult{}, err
	}

	trace, err := DetectExistingInstall(paths, platform, i.runner())
	if err != nil {
		return DiagnoseResult{}, err
	}

	status := StatusSummary{
		Prepared:         trace.ConfigExists && trace.BinaryExists,
		StartupInstalled: startupInstalled(trace, platform),
		CodexReady:       trace.CodexHookExists,
	}

	running := false
	healthOK := false
	heartbeatOK := false
	if trace.ConfigExists {
		cfg, loadErr := collectorconfig.Load(paths.ConfigPath)
		if loadErr == nil {
			health := i.deps.Health
			if health == nil {
				health = common.HealthChecker{}
			}
			if err := health.Wait(cfg.ListenAddr); err == nil {
				running = true
				healthOK = true
				connection := i.deps.Connection
				if connection == nil {
					connection = common.NewConnectionChecker(cfg)
				}
				if err := connection.Check(cfg); err == nil {
					heartbeatOK = true
				}
			}
		}
	}
	status.Running = running
	status.HealthOK = healthOK
	status.HeartbeatOK = heartbeatOK
	status.Installed = status.Prepared && status.StartupInstalled && status.Running && status.HealthOK && status.HeartbeatOK

	payload := map[string]any{
		"mode":              "diagnose",
		"binary_path":       paths.BinaryPath,
		"config_exists":     fileExists(paths.ConfigPath),
		"startup_installed": status.StartupInstalled,
		"running":           running,
		"health_ok":         healthOK,
		"heartbeat_ok":      heartbeatOK,
		"codex_ready":       hookBlockExists(paths.CodexConfigPath),
	}

	text := fmt.Sprintf(
		"mode=diagnose binary_path=%s config_exists=%v startup_installed=%v running=%v health_ok=%v heartbeat_ok=%v codex_ready=%v",
		paths.BinaryPath,
		payload["config_exists"],
		status.StartupInstalled,
		running,
		healthOK,
		heartbeatOK,
		payload["codex_ready"],
	)
	jsonBody, err := json.Marshal(payload)
	if err != nil {
		return DiagnoseResult{}, err
	}
	jsonText := string(jsonBody)
	text = common.RedactSensitive(text)
	jsonText = common.RedactSensitive(jsonText)

	result := DiagnoseResult{
		Status: status,
		Text:   text,
		JSON:   jsonText,
	}
	if !options.JSON {
		result.JSON = ""
	}
	return result, nil
}

func startupInstalled(trace InstallTrace, platform Platform) bool {
	switch platform.OS {
	case "darwin":
		return trace.LaunchAgentExists || trace.LaunchAgentLoaded
	case "linux":
		return trace.SystemdUnitExists || trace.SystemdUnitLoaded
	default:
		return false
	}
}
