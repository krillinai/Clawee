package unixuser

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
)

func TestDiagnoseDoesNotPrintCollectorToken(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".clawee-collector", "config.json")
	cfg := collectorconfig.Config{
		OfficeURL:         "https://office.example",
		CollectorID:       "collector",
		DeviceID:          "device",
		CollectorToken:    "secret-token",
		ListenAddr:        "127.0.0.1:1905",
		PrivacyMode:       "summary_only",
		EnabledAgentTypes: []string{"codex"},
	}
	if err := collectorconfig.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	installer := NewInstaller(InstallerDeps{
		Health:     &okWaiter{},
		Connection: &okConnection{},
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				ConfigPath:      configPath,
				BinaryPath:      filepath.Join(home, "bin", "clawee-collector"),
				CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
				SystemdUnitPath: filepath.Join(home, ".config", "systemd", "user", SystemdUnitName),
				DiagnosticsDir:  filepath.Join(home, "diagnostics"),
			}, nil
		},
	})

	result, err := installer.Diagnose(context.Background(), DiagnoseOptions{GOOS: "linux", JSON: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{
		"secret-token",
		"collector_token",
		"CollectorToken",
		"collectorToken",
	} {
		if strings.Contains(result.Text, needle) {
			t.Fatalf("diagnose text leaked %q:\nTEXT=%s", needle, result.Text)
		}
		if strings.Contains(result.JSON, needle) {
			t.Fatalf("diagnose json leaked %q:\nJSON=%s", needle, result.JSON)
		}
	}
	if !strings.Contains(result.JSON, `"health_ok":true`) || !strings.Contains(result.JSON, `"heartbeat_ok":true`) {
		t.Fatalf("json missing status: %s", result.JSON)
	}
}
