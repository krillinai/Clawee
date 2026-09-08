package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestDefaultPathUsesClaweeCollectorUnderHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	path, err := DefaultPath()
	if err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(home, ".clawee", "collector", "config.toml")
	if path != want {
		t.Fatalf("DefaultPath() = %q, want %q", path, want)
	}
}

func TestResolvePathUsesExplicitPathFirst(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_CONFIG", "/tmp/from-env.json")
	t.Setenv("AO_COLLECTOR_CONFIG", "/tmp/deprecated.json")

	path, err := ResolvePath("/tmp/explicit.json")
	if err != nil {
		t.Fatal(err)
	}

	if path != "/tmp/explicit.json" {
		t.Fatalf("ResolvePath explicit = %q, want /tmp/explicit.json", path)
	}
}

func TestResolvePathUsesClaweeCollectorConfigEnv(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_CONFIG", "/tmp/from-env.json")
	t.Setenv("AO_COLLECTOR_CONFIG", "/tmp/deprecated.json")

	path, err := ResolvePath("")
	if err != nil {
		t.Fatal(err)
	}

	if path != "/tmp/from-env.json" {
		t.Fatalf("ResolvePath env = %q, want /tmp/from-env.json", path)
	}
}

func TestResolvePathUsesClaweeCollectorDirEnv(t *testing.T) {
	t.Setenv("CLAWEE_COLLECTOR_DIR", "/tmp/clawee-home")
	t.Setenv("AO_COLLECTOR_CONFIG", "/tmp/deprecated.json")

	path, err := ResolvePath("")
	if err != nil {
		t.Fatal(err)
	}

	want := filepath.Join("/tmp/clawee-home", "config.toml")
	if path != want {
		t.Fatalf("ResolvePath dir env = %q, want %q", path, want)
	}
}

func TestResolvePathFallsBackToDeprecatedAOCollectorConfigEnv(t *testing.T) {
	t.Setenv("AO_COLLECTOR_CONFIG", "/tmp/from-deprecated-env.json")

	path, err := ResolvePath("")
	if err != nil {
		t.Fatal(err)
	}

	if path != "/tmp/from-deprecated-env.json" {
		t.Fatalf("ResolvePath deprecated env = %q, want /tmp/from-deprecated-env.json", path)
	}
}

func TestLoadIgnoresLegacyAgentDisplayName(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := home + "/.clawee/collector/config.toml"
	if err := os.MkdirAll(home+"/.clawee/collector", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`office_url = "http://office.local"
collector_token = "token"
collector_id = "collector-1"
device_id = "device-1"
privacy_mode = "summary_only"
agent_display_name = "徐刚的Mini Codex"
`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}

	if cfg.CollectorID != "collector-1" {
		t.Fatalf("CollectorID = %q, want collector-1", cfg.CollectorID)
	}
}

func TestLoadMigratesClaweeCollectorDefaultToClaweeCollectorSubdirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	legacyPath := filepath.Join(home, ".clawee-collector", "config.toml")
	if err := os.MkdirAll(filepath.Dir(legacyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, []byte(`office_url = "http://office.local"
collector_token = "token"
collector_id = "collector-legacy"
device_id = "device-legacy"
privacy_mode = "summary_only"
`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CollectorID != "collector-legacy" {
		t.Fatalf("CollectorID = %q", cfg.CollectorID)
	}
	if _, err := os.Stat(filepath.Join(home, ".clawee", "collector", "config.toml")); err != nil {
		t.Fatalf("new config was not written: %v", err)
	}
}

func TestLoadMigratesLegacyJSONBesideRequestedTOML(t *testing.T) {
	dir := t.TempDir()
	tomlPath := filepath.Join(dir, "config.toml")
	jsonPath := filepath.Join(dir, "config.json")
	legacy := `{
		"office_url": "http://office.local",
		"collector_token": "token",
		"collector_id": "collector-legacy",
		"device_id": "device-legacy",
		"privacy_mode": "summary_only"
	}`
	if err := os.WriteFile(jsonPath, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(tomlPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CollectorID != "collector-legacy" || cfg.DeviceID != "device-legacy" || cfg.CollectorToken != "token" {
		t.Fatalf("migrated identity = %#v", cfg)
	}
	if _, err := os.Stat(jsonPath); err != nil {
		t.Fatalf("legacy JSON was not preserved: %v", err)
	}
	migrated, err := os.ReadFile(tomlPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(migrated), `collector_id = 'collector-legacy'`) &&
		!strings.Contains(string(migrated), `collector_id = "collector-legacy"`) {
		t.Fatalf("migrated TOML = %s", migrated)
	}
}

func TestLoadPrefersTOMLOverLegacyJSON(t *testing.T) {
	dir := t.TempDir()
	tomlPath := filepath.Join(dir, "config.toml")
	if err := Save(tomlPath, Config{
		OfficeURL: "http://office.local", CollectorToken: "toml-token", CollectorID: "collector-toml",
		DeviceID: "device-toml", PrivacyMode: "summary_only",
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{
		"office_url":"http://office.local","collector_token":"json-token",
		"collector_id":"collector-json","device_id":"device-json","privacy_mode":"summary_only"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(tomlPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CollectorID != "collector-toml" || cfg.CollectorToken != "toml-token" {
		t.Fatalf("Load() = %#v", cfg)
	}
}

func TestLegacyMigrationDoesNotPersistEnvironmentOverrides(t *testing.T) {
	dir := t.TempDir()
	tomlPath := filepath.Join(dir, "config.toml")
	jsonPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(jsonPath, []byte(`{
		"office_url":"http://from-file.local","collector_token":"file-token",
		"collector_id":"collector-file","device_id":"device-file","privacy_mode":"summary_only"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "env-token")

	cfg, err := Load(tomlPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CollectorToken != "env-token" {
		t.Fatalf("CollectorToken = %q, want env-token", cfg.CollectorToken)
	}

	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "")
	migrated, err := Load(tomlPath)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.CollectorToken != "file-token" {
		t.Fatalf("migrated CollectorToken = %q, want file-token", migrated.CollectorToken)
	}
}

func TestLoadReadsMCPServerConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	workDir := t.TempDir()
	body := []byte(`office_url = "http://office.local"
collector_token = "collector-token"
collector_id = "collector-1"
device_id = "device-1"
privacy_mode = "summary_only"

[mcp_server]
enabled = true
bearer_token = "mcp-token"
codex_work_dir = "` + workDir + `"
`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.MCPServer.Enabled || cfg.MCPServer.BearerToken != "mcp-token" || cfg.MCPServer.CodexWorkDir != workDir {
		t.Fatalf("MCPServer = %#v", cfg.MCPServer)
	}
}

func TestMCPServerConfigRequiresEnabledFields(t *testing.T) {
	for _, test := range []struct {
		name string
		cfg  MCPServerConfig
	}{
		{name: "bearer token", cfg: MCPServerConfig{Enabled: true, CodexWorkDir: "/repo"}},
		{name: "work directory", cfg: MCPServerConfig{Enabled: true, BearerToken: "token"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.cfg.Validate(); err == nil {
				t.Fatal("Validate() error = nil")
			}
		})
	}
	if err := (MCPServerConfig{}).Validate(); err != nil {
		t.Fatalf("disabled Validate() error = %v", err)
	}
}

func TestLoadReadsPullWorkerConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	workDir := t.TempDir()
	body := []byte(`office_url = "http://office.local"
collector_token = "collector-token"
collector_id = "collector-1"
device_id = "device-1"
privacy_mode = "summary_only"

[pull_worker]
enabled = true
codex_work_dir = "` + workDir + `"
`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.PullWorker.Enabled || cfg.PullWorker.CodexWorkDir != workDir {
		t.Fatalf("PullWorker = %#v", cfg.PullWorker)
	}
}

func TestPullWorkerRequiresWorkDirAndIsMutuallyExclusiveWithMCPServer(t *testing.T) {
	base := Config{
		OfficeURL: "http://office.local", CollectorToken: "token", CollectorID: "collector-1",
		DeviceID: "device-1", PrivacyMode: "summary_only",
	}
	base.PullWorker.Enabled = true
	if err := validate(base); err == nil || !strings.Contains(err.Error(), "pull_worker.codex_work_dir") {
		t.Fatalf("missing work dir error = %v", err)
	}
	base.PullWorker.CodexWorkDir = "/repo"
	base.MCPServer = MCPServerConfig{Enabled: true, BearerToken: "token", CodexWorkDir: "/repo"}
	if err := validate(base); err == nil || !strings.Contains(err.Error(), "cannot both be enabled") {
		t.Fatalf("mutual exclusion error = %v", err)
	}
}

func TestLoadWithoutDefaultFileStillAllowsEnvOnlyConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAWEE_COLLECTOR_OFFICE_URL", "http://office.local")
	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "token")
	t.Setenv("CLAWEE_COLLECTOR_ID", "collector-1")
	t.Setenv("CLAWEE_DEVICE_ID", "device-1")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}

	if cfg.CollectorID != "collector-1" {
		t.Fatalf("CollectorID = %q, want collector-1", cfg.CollectorID)
	}
}

func TestLoadDefaultsListenAddrToPort1905(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAWEE_COLLECTOR_OFFICE_URL", "http://office.local")
	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "token")
	t.Setenv("CLAWEE_COLLECTOR_ID", "collector-1")
	t.Setenv("CLAWEE_DEVICE_ID", "device-1")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}

	if cfg.ListenAddr != "127.0.0.1:1905" {
		t.Fatalf("ListenAddr = %q, want 127.0.0.1:1905", cfg.ListenAddr)
	}
}

func TestLoadSupportsDeprecatedAgentOfficeEnvFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AGENT_OFFICE_URL", "http://office.local")
	t.Setenv("AGENT_OFFICE_COLLECTOR_TOKEN", "token")
	t.Setenv("AGENT_OFFICE_COLLECTOR_ID", "collector-1")
	t.Setenv("AGENT_OFFICE_DEVICE_ID", "device-1")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}

	if cfg.CollectorID != "collector-1" {
		t.Fatalf("CollectorID = %q, want collector-1", cfg.CollectorID)
	}
}

func TestLoadReturnsErrorWhenDeprecatedAOCollectorConfigMissing(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AO_COLLECTOR_CONFIG", filepath.Join(home, "missing.json"))
	t.Setenv("CLAWEE_COLLECTOR_OFFICE_URL", "http://office.local")
	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "token")
	t.Setenv("CLAWEE_COLLECTOR_ID", "collector-1")
	t.Setenv("CLAWEE_DEVICE_ID", "device-1")

	if _, err := Load(""); err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadOverlaysCodexStateDBFromEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAWEE_COLLECTOR_OFFICE_URL", "http://office.local")
	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "token")
	t.Setenv("CLAWEE_COLLECTOR_ID", "collector-1")
	t.Setenv("CLAWEE_DEVICE_ID", "device-1")
	t.Setenv("CLAWEE_CODEX_STATE_DB", "/tmp/codex.db")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}

	if cfg.CodexStateDB != "/tmp/codex.db" {
		t.Fatalf("CodexStateDB = %q, want /tmp/codex.db", cfg.CodexStateDB)
	}
}

func TestSaveDoesNotPersistRemovedExecutionSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := Save(path, Config{
		OfficeURL: "http://office.local", CollectorToken: "collector-token", CollectorID: "collector-1",
		DeviceID: "device-1", PrivacyMode: "summary_only",
	}); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	if err := toml.Unmarshal(body, &saved); err != nil {
		t.Fatal(err)
	}
	if _, ok := saved["a2a"]; ok {
		t.Fatalf("saved config contains a2a: %s", body)
	}
	if _, ok := saved["codex"]; ok {
		t.Fatalf("saved config contains codex work settings: %s", body)
	}
}

func TestLoadReadsCodexStateDBFromConfigFile(t *testing.T) {
	path := t.TempDir() + "/config.toml"
	err := os.WriteFile(path, []byte(`office_url = "http://office.local"
collector_token = "token"
collector_id = "collector-1"
device_id = "device-1"
privacy_mode = "summary_only"
codex_state_db = "/tmp/from-file.db"
`), 0o600)
	if err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.CodexStateDB != "/tmp/from-file.db" {
		t.Fatalf("CodexStateDB = %q, want /tmp/from-file.db", cfg.CodexStateDB)
	}
}

func TestLoadAcceptsUTF8BOMConfigFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	body := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`office_url = "http://office.local"
collector_token = "token"
collector_id = "collector-1"
device_id = "device-1"
privacy_mode = "summary_only"
agent_display_name = "Windows Dev"
`)...)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.CollectorID != "collector-1" {
		t.Fatalf("CollectorID = %q, want collector-1", cfg.CollectorID)
	}
}

func TestLoadDefaultsLogColorEnabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAWEE_COLLECTOR_OFFICE_URL", "http://office.local")
	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "token")
	t.Setenv("CLAWEE_COLLECTOR_ID", "collector-1")
	t.Setenv("CLAWEE_DEVICE_ID", "device-1")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}

	if !cfg.LogColorEnabled() {
		t.Fatal("LogColorEnabled() = false, want true when log_color is omitted")
	}
}

func TestLoadReadsLogColorFalseFromConfigFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	err := os.WriteFile(path, []byte(`office_url = "http://office.local"
collector_token = "token"
collector_id = "collector-1"
device_id = "device-1"
privacy_mode = "summary_only"
log_color = false
`), 0o600)
	if err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.LogColorEnabled() {
		t.Fatal("LogColorEnabled() = true, want false when log_color is false")
	}
}

func TestLoadOverlaysLogColorFromEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAWEE_COLLECTOR_OFFICE_URL", "http://office.local")
	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "token")
	t.Setenv("CLAWEE_COLLECTOR_ID", "collector-1")
	t.Setenv("CLAWEE_DEVICE_ID", "device-1")
	t.Setenv("CLAWEE_COLLECTOR_LOG_COLOR", "false")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}

	if cfg.LogColorEnabled() {
		t.Fatal("LogColorEnabled() = true, want false from CLAWEE_COLLECTOR_LOG_COLOR=false")
	}
}

func TestLoadIgnoresDeprecatedAgentNameEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAWEE_COLLECTOR_OFFICE_URL", "http://office.local")
	t.Setenv("CLAWEE_COLLECTOR_TOKEN", "token")
	t.Setenv("CLAWEE_COLLECTOR_ID", "collector-1")
	t.Setenv("CLAWEE_DEVICE_ID", "device-1")
	t.Setenv("CLAWEE_AGENT_NAME", "Codex Desk")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}

	if cfg.CollectorID != "collector-1" {
		t.Fatalf("CollectorID = %q, want collector-1", cfg.CollectorID)
	}
}

func TestSaveWritesConfigAtomicallyWithPrivatePermissions(t *testing.T) {
	path := t.TempDir() + "/collector.toml"

	err := Save(path, Config{
		OfficeURL:         "http://office.local",
		CollectorToken:    "collector_token",
		CollectorID:       "collector_123",
		DeviceID:          "device_123",
		ListenAddr:        "127.0.0.1:1905",
		EnabledAgentTypes: []string{"codex"},
		PrivacyMode:       "summary_only",
	})
	if err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CollectorID != "collector_123" {
		t.Fatalf("CollectorID = %q", cfg.CollectorID)
	}
	if cfg.CollectorToken != "collector_token" {
		t.Fatalf("CollectorToken = %q", cfg.CollectorToken)
	}
}

func TestSaveWritesConfigWithoutUTF8BOM(t *testing.T) {
	path := t.TempDir() + "/collector.toml"

	err := Save(path, Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	})
	if err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) >= 3 && body[0] == 0xEF && body[1] == 0xBB && body[2] == 0xBF {
		t.Fatal("config file starts with UTF-8 BOM")
	}
}

func TestSaveDefaultsListenAddrToPort1905(t *testing.T) {
	path := t.TempDir() + "/collector.toml"

	err := Save(path, Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	})
	if err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != "127.0.0.1:1905" {
		t.Fatalf("ListenAddr = %q, want 127.0.0.1:1905", cfg.ListenAddr)
	}
}

func TestSaveRejectsInvalidConfig(t *testing.T) {
	valid := Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	}

	tests := []struct {
		name    string
		mutate  func(*Config)
		wantErr string
	}{
		{
			name: "missing device id",
			mutate: func(cfg *Config) {
				cfg.DeviceID = ""
			},
			wantErr: "device_id is required",
		},
		{
			name: "missing collector id",
			mutate: func(cfg *Config) {
				cfg.CollectorID = ""
			},
			wantErr: "collector_id is required",
		},
		{
			name: "missing office url",
			mutate: func(cfg *Config) {
				cfg.OfficeURL = ""
			},
			wantErr: "office_url is required",
		},
		{
			name: "missing collector token",
			mutate: func(cfg *Config) {
				cfg.CollectorToken = ""
			},
			wantErr: "collector_token is required",
		},
		{
			name: "invalid privacy mode",
			mutate: func(cfg *Config) {
				cfg.PrivacyMode = "full"
			},
			wantErr: "privacy_mode must be summary_only",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := valid
			tt.mutate(&cfg)

			err := Save(t.TempDir()+"/collector.json", cfg)
			if err == nil {
				t.Fatal("expected error")
			}
			if err.Error() != tt.wantErr {
				t.Fatalf("error = %q, want %q", err.Error(), tt.wantErr)
			}
		})
	}
}

func TestSaveRemovesTempFileWhenRenameFails(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/collector.json"
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}

	err := Save(path, Config{
		OfficeURL:      "http://office.local",
		CollectorToken: "collector_token",
		CollectorID:    "collector_123",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("tmp stat err = %v, want not exist", err)
	}
}
