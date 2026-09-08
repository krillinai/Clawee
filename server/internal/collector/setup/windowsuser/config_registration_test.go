package windowsuser

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestEnsureCollectorConfigReusesValidConfigEvenWhenCodeProvided(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	err := collectorconfig.Save(path, collectorconfig.Config{
		OfficeURL:      "http://old-office.local",
		CollectorToken: "token_old",
		CollectorID:    "collector_old",
		DeviceID:       "device_old",
		PrivacyMode:    "summary_only",
		RequestLogDir:  filepath.Join(dir, "logs"),
	})
	if err != nil {
		t.Fatal(err)
	}

	registrar := &fakeRegistrar{}
	cfg, action, err := EnsureCollectorConfig(context.Background(), Options{
		OfficeURL:             "http://new-office.local",
		RegistrationCode:      "reg_new",
		ClaweeAgentConfigPath: filepath.Join(dir, "clawee-agent.toml"),
	}, Paths{ConfigPath: path, LogDir: filepath.Join(dir, "logs")}, registrar)
	if err != nil {
		t.Fatal(err)
	}
	if action != ConfigReused {
		t.Fatalf("action = %s", action)
	}
	if registrar.calls != 0 {
		t.Fatalf("registrar calls = %d, want 0", registrar.calls)
	}
	if cfg.CollectorID != "collector_old" {
		t.Fatalf("CollectorID = %q", cfg.CollectorID)
	}
}

func TestEnsureCollectorConfigFailsWhenExistingConfigIsBroken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"collector_id":"collector_1"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	_, _, err := EnsureCollectorConfig(context.Background(), Options{
		OfficeURL:        "http://office.local",
		RegistrationCode: "reg_123",
	}, Paths{ConfigPath: path, LogDir: filepath.Join(t.TempDir(), "logs")}, &fakeRegistrar{})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "配置文件存在但无法加载") {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureCollectorConfigFailsWhenExistingConfigMissesRequiredFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{
		"office_url": "http://office.local",
		"collector_token": "",
		"collector_id": "collector_1",
		"device_id": "device_1",
		"privacy_mode": "summary_only"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	_, _, err := EnsureCollectorConfig(context.Background(), Options{
		OfficeURL:        "http://office.local",
		RegistrationCode: "reg_123",
	}, Paths{ConfigPath: path, LogDir: filepath.Join(t.TempDir(), "logs")}, &fakeRegistrar{})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "关键字段不完整") {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureCollectorConfigRegistersWhenConfigMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	registrar := &fakeRegistrar{response: collectorapi.RegistrationResponse{
		CollectorID:    "collector_new",
		CollectorToken: "token_new",
		DeviceID:       "device_new",
		PrivacyMode:    "summary_only",
	}}

	cfg, action, err := EnsureCollectorConfig(context.Background(), Options{
		OfficeURL:             "http://office.local",
		RegistrationCode:      "reg_123",
		Workspace:             "workspace-a",
		ClaweeAgentConfigPath: filepath.Join(dir, "clawee-agent.toml"),
	}, Paths{ConfigPath: path, LogDir: filepath.Join(dir, "logs")}, registrar)
	if err != nil {
		t.Fatal(err)
	}
	if action != ConfigRegistered {
		t.Fatalf("action = %s", action)
	}
	if cfg.CollectorID != "collector_new" || cfg.DeviceID != "device_new" {
		t.Fatalf("cfg = %#v", cfg)
	}
	if registrar.request.AgentID == "" || registrar.request.AgentID != cfg.AgentID {
		t.Fatalf("registration agent_id = %q, config agent_id = %q", registrar.request.AgentID, cfg.AgentID)
	}
	loaded, err := collectorconfig.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.RequestLogDir != filepath.Join(dir, "logs") {
		t.Fatalf("RequestLogDir = %q", loaded.RequestLogDir)
	}
}

func TestEnsureCollectorConfigResetIdentityRequiresOfficeURLAndCode(t *testing.T) {
	_, _, err := EnsureCollectorConfig(context.Background(), Options{ResetIdentity: true, RegistrationCode: "reg_123"}, Paths{ConfigPath: filepath.Join(t.TempDir(), "config.json")}, &fakeRegistrar{})
	if err == nil || !strings.Contains(err.Error(), "--office-url is required") {
		t.Fatalf("err = %v", err)
	}
	_, _, err = EnsureCollectorConfig(context.Background(), Options{ResetIdentity: true, OfficeURL: "http://office.local"}, Paths{ConfigPath: filepath.Join(t.TempDir(), "config.json")}, &fakeRegistrar{})
	if err == nil || !strings.Contains(err.Error(), "--code is required") {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureCollectorConfigResetIdentityBacksUpAndRegistersNewIdentity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := collectorconfig.Save(path, collectorconfig.Config{
		OfficeURL:      "http://old-office.local",
		CollectorToken: "token_old",
		CollectorID:    "collector_old",
		DeviceID:       "device_old",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	registrar := &fakeRegistrar{response: collectorapi.RegistrationResponse{
		CollectorID:    "collector_new",
		CollectorToken: "token_new",
		DeviceID:       "device_new",
		PrivacyMode:    "summary_only",
	}}
	cfg, action, err := EnsureCollectorConfig(context.Background(), Options{
		ResetIdentity:         true,
		OfficeURL:             "http://office.local",
		RegistrationCode:      "reg_123",
		ClaweeAgentConfigPath: filepath.Join(dir, "clawee-agent.toml"),
	}, Paths{ConfigPath: path, LogDir: filepath.Join(dir, "logs")}, registrar)
	if err != nil {
		t.Fatal(err)
	}
	if action != ConfigReset {
		t.Fatalf("action = %s", action)
	}
	if cfg.CollectorID != "collector_new" {
		t.Fatalf("CollectorID = %q", cfg.CollectorID)
	}
	matches, err := filepath.Glob(filepath.Join(dir, "config-*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("backup matches = %#v", matches)
	}
}

func TestEnsureCollectorConfigResetIdentityKeepsOldConfigWhenRegistrationFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := collectorconfig.Save(path, collectorconfig.Config{
		OfficeURL:      "http://old-office.local",
		CollectorToken: "token_old",
		CollectorID:    "collector_old",
		DeviceID:       "device_old",
		PrivacyMode:    "summary_only",
	}); err != nil {
		t.Fatal(err)
	}

	_, _, err := EnsureCollectorConfig(context.Background(), Options{
		ResetIdentity:         true,
		OfficeURL:             "http://office.local",
		RegistrationCode:      "reg_123",
		ClaweeAgentConfigPath: filepath.Join(dir, "clawee-agent.toml"),
	}, Paths{ConfigPath: path, LogDir: filepath.Join(dir, "logs")}, &fakeRegistrar{err: errors.New("register failed")})
	if err == nil {
		t.Fatal("expected error")
	}
	cfg, loadErr := collectorconfig.Load(path)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if cfg.CollectorID != "collector_old" {
		t.Fatalf("CollectorID = %q", cfg.CollectorID)
	}
}
