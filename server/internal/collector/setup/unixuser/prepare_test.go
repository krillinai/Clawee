package unixuser

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type prepareRegistrar struct {
	calls int
}

func (r *prepareRegistrar) RegisterCollector(req collectorapi.RegistrationRequest) (collectorapi.RegistrationResponse, error) {
	r.calls++
	return collectorapi.RegistrationResponse{
		CollectorID:    "collector-new",
		DeviceID:       "device-new",
		CollectorToken: "token-new",
		PrivacyMode:    "summary_only",
	}, nil
}

type hookRecorder struct {
	calls int
}

func (h *hookRecorder) Ensure(codexConfigPath string, collectorConfigPath string, binaryPath string) error {
	h.calls++
	return nil
}

func TestPrepareReusesExistingValidConfigAndWritesHook(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".clawee-collector", "config.json")
	binaryPath := filepath.Join(home, ".clawee-collector", "bin", "clawee-collector")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := collectorconfig.Config{
		OfficeURL:         "https://office.example",
		CollectorID:       "collector-old",
		DeviceID:          "device-old",
		CollectorToken:    "token-old",
		ListenAddr:        "127.0.0.1:1905",
		PrivacyMode:       "summary_only",
		EnabledAgentTypes: []string{"codex"},
	}
	body, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	registrar := &prepareRegistrar{}
	hook := &hookRecorder{}
	installer := NewInstaller(InstallerDeps{
		Registrar: registrar,
		Hook:      hook,
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				InstallDir:      filepath.Dir(binaryPath),
				BinaryPath:      binaryPath,
				ConfigPath:      configPath,
				CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
				LogDir:          filepath.Join(home, ".clawee-collector", "logs"),
				DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
			}, nil
		},
	})

	result, err := installer.Prepare(context.Background(), Options{
		OfficeURL:             "https://office.example",
		RegistrationCode:      "reg_xxx",
		ClaweeAgentConfigPath: filepath.Join(home, ".clawee", "config.toml"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Status.Prepared || !result.Status.CodexReady {
		t.Fatalf("status = %#v", result.Status)
	}
	if registrar.calls != 0 {
		t.Fatalf("registrar calls = %d, want 0", registrar.calls)
	}
	if hook.calls != 1 {
		t.Fatalf("hook calls = %d, want 1", hook.calls)
	}
	diagnostics, err := os.ReadFile(result.DiagnosticsLog)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"token-old", "collector_token"} {
		if strings.Contains(string(diagnostics), forbidden) {
			t.Fatalf("diagnostics leaked %q:\n%s", forbidden, diagnostics)
		}
	}
}

func TestPrepareRejectsBrokenExistingConfigWithoutResetIdentity(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".clawee-collector", "config.json")
	binaryPath := filepath.Join(home, ".clawee-collector", "bin", "clawee-collector")
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(`{"collector_id":"old"`), 0o600); err != nil {
		t.Fatal(err)
	}
	registrar := &prepareRegistrar{}
	installer := NewInstaller(InstallerDeps{
		Registrar: registrar,
		ResolvePaths: func(options Options) (Paths, error) {
			return Paths{
				BinaryPath:      binaryPath,
				ConfigPath:      configPath,
				LogDir:          filepath.Join(home, "logs"),
				DiagnosticsDir:  filepath.Join(home, "diagnostics"),
				CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
			}, nil
		},
	})

	_, err := installer.Prepare(context.Background(), Options{
		OfficeURL:        "https://office.example",
		RegistrationCode: "reg_xxx",
	})
	if err == nil {
		t.Fatal("expected broken config to fail")
	}
	if registrar.calls != 0 {
		t.Fatalf("registrar calls = %d, want 0", registrar.calls)
	}
}
