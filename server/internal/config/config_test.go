package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	_ = os.Unsetenv(opsDirEnv)
	os.Exit(m.Run())
}

func TestResolveConfigPathWithoutOpsDir(t *testing.T) {
	_, _, err := resolveConfigPath("configs/config.yaml")
	if err == nil || !strings.Contains(err.Error(), opsDirEnv) {
		t.Fatalf("resolveConfigPath() error = %v", err)
	}

	path, useConfigFile, err := resolveConfigPath("")
	if err != nil {
		t.Fatal(err)
	}
	if useConfigFile || path != "" {
		t.Fatalf("resolveConfigPath() default = %q, %v", path, useConfigFile)
	}
}

func TestResolveConfigPathFromOpsDir(t *testing.T) {
	opsDir := t.TempDir()
	configPath := filepath.Join(opsDir, "configs", "config.private.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("server:\n  addr: :2904\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath, err := filepath.EvalSymlinks(configPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(opsDirEnv, opsDir)

	got, useConfigFile, err := resolveConfigPath("configs/config.private.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if !useConfigFile || got != configPath {
		t.Fatalf("resolveConfigPath() = %q, %v, want %q, true", got, useConfigFile, configPath)
	}
}

func TestResolveDefaultConfigPathFromOpsDir(t *testing.T) {
	opsDir := t.TempDir()
	configPath := filepath.Join(opsDir, defaultConfigRelativePath)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("server:\n  addr: :2904\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath, err := filepath.EvalSymlinks(configPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(opsDirEnv, opsDir)

	got, useConfigFile, err := resolveConfigPath("")
	if err != nil {
		t.Fatal(err)
	}
	if !useConfigFile || got != configPath {
		t.Fatalf("resolveConfigPath() = %q, %v, want %q, true", got, useConfigFile, configPath)
	}
}

func TestResolveConfigPathRejectsInvalidOpsDir(t *testing.T) {
	t.Setenv(opsDirEnv, filepath.Join(t.TempDir(), "missing"))
	_, _, err := resolveConfigPath("configs/config.yaml")
	if err == nil || !strings.Contains(err.Error(), opsDirEnv) {
		t.Fatalf("resolveConfigPath() error = %v", err)
	}
}

func TestResolveConfigPathDoesNotFallbackWhenOpsConfigIsMissing(t *testing.T) {
	t.Setenv(opsDirEnv, t.TempDir())
	_, _, err := resolveConfigPath("configs/config.yaml")
	if err == nil || !strings.Contains(err.Error(), "configs/config.yaml") {
		t.Fatalf("resolveConfigPath() error = %v", err)
	}
}

func TestResolveConfigPathKeepsAbsolutePath(t *testing.T) {
	absolutePath := filepath.Join(t.TempDir(), "config.yaml")
	t.Setenv(opsDirEnv, filepath.Join(t.TempDir(), "missing"))
	got, useConfigFile, err := resolveConfigPath(absolutePath)
	if err != nil {
		t.Fatal(err)
	}
	if !useConfigFile || got != absolutePath {
		t.Fatalf("resolveConfigPath() = %q, %v, want %q, true", got, useConfigFile, absolutePath)
	}
}

func TestResolveConfigPathRejectsEscapeFromOpsDir(t *testing.T) {
	parentDir := t.TempDir()
	opsDir := filepath.Join(parentDir, "ops")
	if err := os.Mkdir(opsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	outsidePath := filepath.Join(parentDir, "outside.yaml")
	if err := os.WriteFile(outsidePath, []byte("server:\n  addr: :2904\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(opsDirEnv, opsDir)

	_, _, err := resolveConfigPath("../outside.yaml")
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("resolveConfigPath() error = %v", err)
	}
}

func TestLoadFromOpsDirPreservesConfigEnvironmentOverrides(t *testing.T) {
	opsDir := t.TempDir()
	configPath := filepath.Join(opsDir, "configs", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("server:\n  addr: :2904\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(opsDirEnv, opsDir)
	t.Setenv("CLAW_MCP_SERVER_ADDR", ":3904")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Addr != ":3904" {
		t.Fatalf("server.addr = %q, want :3904", cfg.Server.Addr)
	}
}

func TestSecurityConfigValidate(t *testing.T) {
	valid := SecurityConfig{
		SessionCookieName:       "claw_front_token",
		AdminSessionCookieName:  "claw_admin_token",
		SessionDuration:         "168h",
		UserJWTSigningKey:       "01234567890123456789012345678901",
		AgentTokenEncryptionKey: "01234567890123456789012345678901",
	}
	duration, err := valid.Validate()
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if duration != 168*time.Hour {
		t.Fatalf("duration = %v, want %v", duration, 168*time.Hour)
	}

	tests := []struct {
		name   string
		mutate func(*SecurityConfig)
	}{
		{"empty frontend cookie", func(cfg *SecurityConfig) { cfg.SessionCookieName = " " }},
		{"empty admin cookie", func(cfg *SecurityConfig) { cfg.AdminSessionCookieName = " " }},
		{"same cookie names", func(cfg *SecurityConfig) { cfg.AdminSessionCookieName = cfg.SessionCookieName }},
		{"invalid duration", func(cfg *SecurityConfig) { cfg.SessionDuration = "invalid" }},
		{"zero duration", func(cfg *SecurityConfig) { cfg.SessionDuration = "0s" }},
		{"sub-second duration", func(cfg *SecurityConfig) { cfg.SessionDuration = "500ms" }},
		{"fractional-second duration", func(cfg *SecurityConfig) { cfg.SessionDuration = "1500ms" }},
		{"short jwt key", func(cfg *SecurityConfig) { cfg.UserJWTSigningKey = "too-short" }},
		{"non ascii jwt key", func(cfg *SecurityConfig) { cfg.UserJWTSigningKey = "012345678901234567890123456789中" }},
		{"empty encryption key", func(cfg *SecurityConfig) { cfg.AgentTokenEncryptionKey = "" }},
		{"short encryption key", func(cfg *SecurityConfig) { cfg.AgentTokenEncryptionKey = "too-short" }},
		{"non ascii encryption key", func(cfg *SecurityConfig) { cfg.AgentTokenEncryptionKey = "012345678901234567890123456789中" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := valid
			test.mutate(&cfg)
			if _, err := cfg.Validate(); err == nil {
				t.Fatal("Validate() error = nil, want invalid security config")
			}
		})
	}
}

func TestDingTalkConfigValidate(t *testing.T) {
	valid := DingTalkConfig{
		Enabled: true, ClientID: "app", ClientSecret: "secret", RedirectURL: "http://localhost:1904/api/v1/auth/dingtalk/callback",
		ProviderKey: "default", StateTTL: "10m", RequestTimeout: "10s",
	}
	stateTTL, timeout, err := valid.Validate()
	if err != nil || stateTTL != 10*time.Minute || timeout != 10*time.Second {
		t.Fatalf("Validate() = %v, %v, %v", stateTTL, timeout, err)
	}
	for _, mutate := range []func(*DingTalkConfig){
		func(cfg *DingTalkConfig) { cfg.ClientSecret = "" },
		func(cfg *DingTalkConfig) { cfg.RedirectURL = "https://example.com/wrong" },
		func(cfg *DingTalkConfig) { cfg.ProviderKey = "Invalid" },
		func(cfg *DingTalkConfig) { cfg.StateTTL = "20m" },
		func(cfg *DingTalkConfig) { cfg.RequestTimeout = "500ms" },
	} {
		cfg := valid
		mutate(&cfg)
		if _, _, err := cfg.Validate(); err == nil {
			t.Fatalf("Validate(%#v) error=nil", cfg)
		}
	}
}

func TestBilibiliConfigValidate(t *testing.T) {
	if err := (BilibiliConfig{}).Validate(); err != nil {
		t.Fatalf("disabled config error=%v", err)
	}
	valid := BilibiliConfig{Enabled: true, ClientID: "client", ClientSecret: "secret", RedirectURL: "https://gateway.test/api/v1/integrations/bilibili/oauth/callback"}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid config error=%v", err)
	}
	for _, mutate := range []func(*BilibiliConfig){
		func(cfg *BilibiliConfig) { cfg.ClientID = "" },
		func(cfg *BilibiliConfig) { cfg.ClientSecret = "" },
		func(cfg *BilibiliConfig) {
			cfg.RedirectURL = "http://gateway.test/api/v1/integrations/bilibili/oauth/callback"
		},
		func(cfg *BilibiliConfig) { cfg.RedirectURL = "https://gateway.test/wrong" },
		func(cfg *BilibiliConfig) {
			cfg.RedirectURL = "https://gateway.test/api/v1/integrations/bilibili/oauth/callback?next=/admin"
		},
	} {
		cfg := valid
		mutate(&cfg)
		if err := cfg.Validate(); err == nil {
			t.Fatalf("Validate(%#v) error=nil", cfg)
		}
	}
}

func TestLoadDefaultsIncludeMCPAuth(t *testing.T) {
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.MCP.Auth.Enabled {
		t.Fatal("MCP auth should be enabled by default")
	}
	if cfg.Server.Addr != "0.0.0.0:1904" {
		t.Fatalf("server.addr = %q, want 0.0.0.0:1904", cfg.Server.Addr)
	}
	if cfg.MCP.Auth.Resource != "http://localhost:1904/mcp" {
		t.Fatalf("MCP auth resource = %q, want http://localhost:1904/mcp", cfg.MCP.Auth.Resource)
	}
	if cfg.MCP.PublicBaseURL != "" {
		t.Fatalf("MCP public base URL = %q, want empty fallback", cfg.MCP.PublicBaseURL)
	}
	if cfg.MCP.Auth.ResourceMetadataURL != "http://localhost:1904/.well-known/oauth-protected-resource/mcp" {
		t.Fatalf("MCP auth resource metadata URL = %q, want http://localhost:1904/.well-known/oauth-protected-resource/mcp", cfg.MCP.Auth.ResourceMetadataURL)
	}
	if len(cfg.MCP.Auth.AuthorizationServers) != 1 || cfg.MCP.Auth.AuthorizationServers[0] != "http://localhost:1904/mock-oauth" {
		t.Fatalf("MCP auth authorization servers = %#v, want http://localhost:1904/mock-oauth", cfg.MCP.Auth.AuthorizationServers)
	}
	if len(cfg.MCP.Auth.RequiredScopes) != 1 || cfg.MCP.Auth.RequiredScopes[0] != "mcp:call" {
		t.Fatalf("required scopes = %#v, want mcp:call", cfg.MCP.Auth.RequiredScopes)
	}
	if len(cfg.MCP.Auth.DemoTokens) != 0 {
		t.Fatalf("default MCP demo tokens = %#v, want none", cfg.MCP.Auth.DemoTokens)
	}
	if cfg.Static.Dir != "" {
		t.Fatalf("static.dir = %q, want empty default", cfg.Static.Dir)
	}
	if cfg.Office.Install.CollectorBinaryRoot != "public/collectors" {
		t.Fatalf("office.install.collector_binary_root = %q, want public/collectors", cfg.Office.Install.CollectorBinaryRoot)
	}
	if cfg.Office.Install.PublicBaseURL != "" {
		t.Fatalf("office.install.public_base_url = %q, want empty default", cfg.Office.Install.PublicBaseURL)
	}
	if cfg.Knowledge.ProviderType != "bailian" {
		t.Fatalf("knowledge defaults = %#v", cfg.Knowledge)
	}
	if cfg.Knowledge.Bailian.WorkspaceID != "" {
		t.Fatalf("knowledge workspace_id = %q, want empty", cfg.Knowledge.Bailian.WorkspaceID)
	}
	if cfg.Knowledge.Bailian.Endpoint != "https://bailian.cn-beijing.aliyuncs.com" {
		t.Fatalf("knowledge endpoint = %q", cfg.Knowledge.Bailian.Endpoint)
	}
	if cfg.SkillHub.Enabled {
		t.Fatal("skillhub should be disabled by default")
	}
	if cfg.SkillHub.PackageRoot != "data/skillhub/packages" {
		t.Fatalf("skillhub.package_root = %q", cfg.SkillHub.PackageRoot)
	}
	if !cfg.SkillHub.GitHubSyncEnabled {
		t.Fatal("skillhub.github_sync_enabled should be true by default")
	}
	if cfg.SkillHub.RepositoryRoot != "data/skillhub/repositories" {
		t.Fatalf("skillhub.repository_root = %q", cfg.SkillHub.RepositoryRoot)
	}
	if cfg.SharedFiles.StorageRoot != "data/shared-files" {
		t.Fatalf("shared_files.storage_root = %q", cfg.SharedFiles.StorageRoot)
	}
	if cfg.ClawAdmin.BaseURL != "" || cfg.ClawAdmin.DeploymentCredential != "" || cfg.ClawAdmin.Timeout != "10s" {
		t.Fatalf("claw-admin defaults = %#v", cfg.ClawAdmin)
	}
	if cfg.ModelAccess.Mode != "enterprise_managed" {
		t.Fatalf("model access mode = %q, want enterprise_managed", cfg.ModelAccess.Mode)
	}
	if cfg.Activity.ReportingEnabled {
		t.Fatal("agent activity reporting should be disabled by default")
	}
}

func TestLoadAgentActivityReportingFromEnv(t *testing.T) {
	t.Setenv("CLAW_MCP_AGENT_ACTIVITY_REPORTING_ENABLED", "true")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Activity.ReportingEnabled {
		t.Fatal("agent_activity.reporting_enabled = false, want true")
	}
}

func TestLoadModelAccessMode(t *testing.T) {
	for _, mode := range []string{"platform_managed", "enterprise_managed"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("CLAW_MCP_MODEL_ACCESS_MODE", mode)
			cfg, err := Load("")
			if err != nil {
				t.Fatal(err)
			}
			if cfg.ModelAccess.Mode != mode {
				t.Fatalf("model access mode = %q, want %q", cfg.ModelAccess.Mode, mode)
			}
		})
	}
}

func TestLoadSub2APIConfigFromYAML(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
model_access:
  mode: enterprise_managed
sub2api:
  base_url: http://127.0.0.1:8080
  admin_api_key: test-admin-key
  organization_user_id: 12
`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Sub2API.BaseURL != "http://127.0.0.1:8080" || cfg.Sub2API.AdminAPIKey != "test-admin-key" || cfg.Sub2API.OrganizationUserID != 12 {
		t.Fatalf("sub2api config = %#v", cfg.Sub2API)
	}
}

func TestLoadSub2APIConfigIgnoresEnvironment(t *testing.T) {
	t.Setenv("CLAW_MCP_SUB2API_BASE_URL", "https://environment.example.com")
	t.Setenv("CLAW_MCP_SUB2API_ADMIN_API_KEY", "environment-key")
	t.Setenv("CLAW_MCP_SUB2API_ORGANIZATION_USER_ID", "99")
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
model_access:
  mode: enterprise_managed
sub2api:
  base_url: ""
  admin_api_key: ""
  organization_user_id: 0
`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Sub2API != (Sub2APIConfig{}) {
		t.Fatalf("sub2api environment variables must be ignored: %#v", cfg.Sub2API)
	}
}

func TestLoadRejectsInvalidModelAccessMode(t *testing.T) {
	for _, mode := range []string{"", " ", "PLATFORM_MANAGED", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("CLAW_MCP_MODEL_ACCESS_MODE", mode)
			if _, err := Load(""); err == nil {
				t.Fatal("Load() error = nil, want invalid model access mode")
			}
		})
	}
}

func TestModelAccessEnvironmentDoesNotChangeEmptyEnvironmentHandling(t *testing.T) {
	t.Setenv("CLAW_MCP_CLAW_ADMIN_BASE_URL", "")
	t.Setenv("CLAW_MCP_MODEL_ACCESS_MODE", "enterprise_managed")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClawAdmin.BaseURL != "" {
		t.Fatalf("claw-admin base URL = %q, want default", cfg.ClawAdmin.BaseURL)
	}
}

func TestLoadClawAdminConfigFromEnvironment(t *testing.T) {
	t.Setenv("CLAW_MCP_CLAW_ADMIN_BASE_URL", "https://admin.example.com")
	t.Setenv("CLAW_MCP_CLAW_ADMIN_DEPLOYMENT_CREDENTIAL", "deployment-secret")
	t.Setenv("CLAW_MCP_CLAW_ADMIN_TIMEOUT", "4s")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClawAdmin.BaseURL != "https://admin.example.com" || cfg.ClawAdmin.DeploymentCredential != "deployment-secret" || cfg.ClawAdmin.Timeout != "4s" {
		t.Fatalf("claw-admin config = %#v", cfg.ClawAdmin)
	}
	if timeout, err := cfg.ClawAdmin.Validate(); err != nil || timeout != 4*time.Second {
		t.Fatalf("Validate = %v, %v", timeout, err)
	}
}

func TestClawAdminConfigRejectsInvalidConfiguredEndpoint(t *testing.T) {
	for _, cfg := range []ClawAdminConfig{
		{BaseURL: "/relative", DeploymentCredential: "credential", Timeout: "5s"},
		{BaseURL: "https://user@example.com", DeploymentCredential: "credential", Timeout: "5s"},
		{BaseURL: "https://admin.example.com", DeploymentCredential: "credential", Timeout: "0s"},
	} {
		if _, err := cfg.Validate(); err == nil {
			t.Fatalf("Validate(%#v) error=nil", cfg)
		}
	}
}

func TestLoadMCPPublicBaseURLFromEnv(t *testing.T) {
	t.Setenv("CLAW_MCP_MCP_PUBLIC_BASE_URL", "https://gateway.example.com")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MCP.PublicBaseURL != "https://gateway.example.com" {
		t.Fatalf("MCP public base URL = %q, want https://gateway.example.com", cfg.MCP.PublicBaseURL)
	}
}

func TestLoadMCPAuthResourceDoesNotOverridePublicBaseURLFallback(t *testing.T) {
	t.Setenv("CLAW_MCP_MCP_AUTH_RESOURCE", "https://gateway.example.com/mcp")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MCP.Auth.Resource != "https://gateway.example.com/mcp" {
		t.Fatalf("MCP auth resource = %q", cfg.MCP.Auth.Resource)
	}
	if cfg.MCP.PublicBaseURL != "" {
		t.Fatalf("MCP public base URL = %q, want empty fallback", cfg.MCP.PublicBaseURL)
	}
}

func TestLoadSharedFilesStorageRootFromEnvironment(t *testing.T) {
	t.Setenv("CLAW_MCP_SHARED_FILES_STORAGE_ROOT", "/var/lib/claw-mcp/shared-files")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SharedFiles.StorageRoot != "/var/lib/claw-mcp/shared-files" {
		t.Fatalf("storage root = %q", cfg.SharedFiles.StorageRoot)
	}
}

func TestLoadSkillHubConfigFromEnv(t *testing.T) {
	t.Setenv("CLAW_MCP_SKILLHUB_ENABLED", "true")
	t.Setenv("CLAW_MCP_SKILLHUB_PACKAGE_ROOT", "/tmp/claw-skillhub")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.SkillHub.Enabled || cfg.SkillHub.PackageRoot != "/tmp/claw-skillhub" {
		t.Fatalf("skillhub config = %#v", cfg.SkillHub)
	}
}

func TestLoadSkillHubGitHubSyncIgnoresEnvironment(t *testing.T) {
	t.Setenv("CLAW_MCP_SKILLHUB_GITHUB_SYNC_ENABLED", "false")
	t.Setenv("CLAW_MCP_SKILLHUB_REPOSITORY_ROOT", "/tmp/env-skillhub-repositories")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.SkillHub.GitHubSyncEnabled || cfg.SkillHub.RepositoryRoot != "data/skillhub/repositories" {
		t.Fatalf("skillhub github sync config = %#v", cfg.SkillHub)
	}
}

func TestLoadSkillHubGitHubSyncFromYAML(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	contents := "skillhub:\n  enabled: true\n  github_sync_enabled: false\n  repository_root: /var/lib/claw-mcp/skill-sources\n"
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.SkillHub.Enabled || cfg.SkillHub.GitHubSyncEnabled || cfg.SkillHub.RepositoryRoot != "/var/lib/claw-mcp/skill-sources" {
		t.Fatalf("skillhub github sync config = %#v", cfg.SkillHub)
	}
}

func TestLoadKnowledgeSecretsDirectlyFromYAML(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "config.yaml")
	contents := `knowledge:
  enabled: true
  bailian:
    access_key_id: "direct-access-key"
    access_key_secret: "direct-access-secret"
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Knowledge.Bailian.AccessKeyID != "direct-access-key" || cfg.Knowledge.Bailian.AccessKeySecret != "direct-access-secret" {
		t.Fatalf("knowledge bailian config = %#v", cfg.Knowledge.Bailian)
	}
}

func TestLoadLoggingConfigFromEnv(t *testing.T) {
	t.Setenv("CLAW_MCP_LOGGING_LEVEL", "debug")
	t.Setenv("CLAW_MCP_LOGGING_FORMAT", "console")
	t.Setenv("CLAW_MCP_LOGGING_OUTPUT", "stderr")
	t.Setenv("CLAW_MCP_LOGGING_ACCESS_ENABLED", "false")
	t.Setenv("CLAW_MCP_LOGGING_ERROR_RESPONSE_BODY", "false")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.Logging.Level != "debug" {
		t.Fatalf("logging.level = %q, want debug", cfg.Logging.Level)
	}
	if cfg.Logging.Format != "console" {
		t.Fatalf("logging.format = %q, want console", cfg.Logging.Format)
	}
	if cfg.Logging.Output != "stderr" {
		t.Fatalf("logging.output = %q, want stderr", cfg.Logging.Output)
	}
	if cfg.Logging.AccessEnabled {
		t.Fatal("logging.access_enabled = true, want false")
	}
	if cfg.Logging.ErrorResponseBody {
		t.Fatal("logging.error_response_body = true, want false")
	}
}

func TestLoadOfficeInstallConfigFromEnv(t *testing.T) {
	t.Setenv("CLAW_MCP_OFFICE_INSTALL_COLLECTOR_BINARY_ROOT", "/tmp/collectors")
	t.Setenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL", "https://env.example.com")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.Office.Install.CollectorBinaryRoot != "/tmp/collectors" {
		t.Fatalf("office.install.collector_binary_root = %q, want /tmp/collectors", cfg.Office.Install.CollectorBinaryRoot)
	}
	if cfg.Office.Install.PublicBaseURL != "https://env.example.com" {
		t.Fatalf("office.install.public_base_url = %q, want https://env.example.com", cfg.Office.Install.PublicBaseURL)
	}
}

func TestLoadOfficeInstallPublicBaseURLFromDotEnv(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "configs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, defaultConfigRelativePath), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".env"), []byte("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL=https://dotenv.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(opsDirEnv, tmp)
	oldEnv, hadEnv := os.LookupEnv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL")
	t.Cleanup(func() {
		if hadEnv {
			if err := os.Setenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL", oldEnv); err != nil {
				t.Fatalf("restore env: %v", err)
			}
		} else if err := os.Unsetenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL"); err != nil {
			t.Fatalf("restore env: %v", err)
		}
	})
	if err := os.Unsetenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL"); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.Office.Install.PublicBaseURL != "https://dotenv.example.com" {
		t.Fatalf("office.install.public_base_url = %q, want https://dotenv.example.com", cfg.Office.Install.PublicBaseURL)
	}
}

func TestLoadOfficeInstallPublicBaseURLPrefersDotEnvOverConfigFile(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "configs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".env"), []byte("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL=https://dotenv.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(tmp, defaultConfigRelativePath)
	if err := os.WriteFile(configPath, []byte("office:\n  install:\n    public_base_url: \"https://config.example.com\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(opsDirEnv, tmp)
	oldEnv, hadEnv := os.LookupEnv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL")
	t.Cleanup(func() {
		if hadEnv {
			if err := os.Setenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL", oldEnv); err != nil {
				t.Fatalf("restore env: %v", err)
			}
		} else if err := os.Unsetenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL"); err != nil {
			t.Fatalf("restore env: %v", err)
		}
	})
	if err := os.Unsetenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL"); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.Office.Install.PublicBaseURL != "https://dotenv.example.com" {
		t.Fatalf("office.install.public_base_url = %q, want https://dotenv.example.com", cfg.Office.Install.PublicBaseURL)
	}
}

func TestLoadOfficeInstallPublicBaseURLPrefersEnvOverDotEnv(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "configs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, defaultConfigRelativePath), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".env"), []byte("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL=https://dotenv.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(opsDirEnv, tmp)
	oldEnv, hadEnv := os.LookupEnv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL")
	t.Cleanup(func() {
		if hadEnv {
			if err := os.Setenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL", oldEnv); err != nil {
				t.Fatalf("restore env: %v", err)
			}
		} else if err := os.Unsetenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL"); err != nil {
			t.Fatalf("restore env: %v", err)
		}
	})
	if err := os.Setenv("CLAW_MCP_OFFICE_INSTALL_PUBLIC_BASE_URL", "https://env.example.com"); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.Office.Install.PublicBaseURL != "https://env.example.com" {
		t.Fatalf("office.install.public_base_url = %q, want https://env.example.com", cfg.Office.Install.PublicBaseURL)
	}
}
