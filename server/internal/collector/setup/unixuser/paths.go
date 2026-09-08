package unixuser

import (
	"errors"
	"os"
	"path/filepath"
)

func ResolvePaths(options Options) (Paths, error) {
	home := os.Getenv("HOME")
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return Paths{}, err
		}
	}
	if home == "" {
		return Paths{}, errors.New("无法解析当前 Unix 用户目录")
	}

	installDir := os.Getenv("CLAWEE_COLLECTOR_DIR")
	if installDir == "" {
		installDir = filepath.Join(home, ".clawee", "collector", "bin")
	}

	binaryPath := options.BinaryPath
	if binaryPath == "" {
		binaryPath = filepath.Join(installDir, "clawee-collector")
	}

	configPath := options.ConfigPath
	if configPath == "" {
		configPath = os.Getenv("CLAWEE_COLLECTOR_CONFIG")
	}
	if configPath == "" {
		configPath = filepath.Join(home, ".clawee", "collector", "config.toml")
	}

	codexConfigPath := options.CodexConfigPath
	if codexConfigPath == "" {
		codexConfigPath = os.Getenv("CODEX_CONFIG")
	}
	if codexConfigPath == "" {
		codexConfigPath = filepath.Join(home, ".codex", "config.toml")
	}

	baseDir := filepath.Dir(installDir)
	return Paths{
		InstallDir:      installDir,
		BinaryPath:      binaryPath,
		ConfigPath:      configPath,
		LogDir:          filepath.Join(baseDir, "logs"),
		DiagnosticsDir:  filepath.Join(baseDir, "diagnostics"),
		CodexConfigPath: codexConfigPath,
		LaunchAgentPath: filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist"),
		SystemdUnitPath: filepath.Join(home, ".config", "systemd", "user", SystemdUnitName),
	}, nil
}
