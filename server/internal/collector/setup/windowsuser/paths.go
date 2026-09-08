package windowsuser

import (
	"errors"
	"os"
	"path/filepath"
)

func ResolvePaths(options Options) (Paths, error) {
	home := os.Getenv("USERPROFILE")
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return Paths{}, err
		}
	}
	if home == "" {
		return Paths{}, errors.New("无法解析当前 Windows 用户目录")
	}

	installDir := os.Getenv("CLAWEE_COLLECTOR_DIR")
	if installDir == "" {
		installDir = filepath.Join(home, ".clawee", "collector")
	}
	binDir := filepath.Join(installDir, "bin")
	binaryPath := options.BinaryPath
	if binaryPath == "" {
		binaryPath = filepath.Join(binDir, "clawee-collector.exe")
	}
	runnerBinaryPath := options.RunnerBinaryPath
	if runnerBinaryPath == "" {
		runnerBinaryPath = filepath.Join(binDir, "clawee-collector-runner.exe")
	}
	configPath := options.ConfigPath
	if configPath == "" {
		configPath = os.Getenv("CLAWEE_COLLECTOR_CONFIG")
	}
	if configPath == "" {
		configPath = filepath.Join(installDir, "config.toml")
	}
	codexConfigPath := options.CodexConfigPath
	if codexConfigPath == "" {
		codexConfigPath = os.Getenv("CODEX_CONFIG")
	}
	if codexConfigPath == "" {
		codexConfigPath = filepath.Join(home, ".codex", "config.toml")
	}

	return Paths{
		InstallDir:       installDir,
		BinDir:           binDir,
		BinaryPath:       binaryPath,
		RunnerBinaryPath: runnerBinaryPath,
		ConfigPath:       configPath,
		LogDir:           filepath.Join(installDir, "logs"),
		DiagnosticsDir:   filepath.Join(installDir, "diagnostics"),
		CodexConfigPath:  codexConfigPath,
	}, nil
}
