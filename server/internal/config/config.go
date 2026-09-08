package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/viper"
	"github.com/subosito/gotenv"
)

const (
	opsDirEnv                 = "CLAWEE_OPS_DIR"
	defaultConfigRelativePath = "configs/config.yaml"
)

type Config struct {
	Server      ServerConfig      `mapstructure:"server"`
	Database    DatabaseConfig    `mapstructure:"database"`
	Admin       AdminConfig       `mapstructure:"admin"`
	Security    SecurityConfig    `mapstructure:"security"`
	Logging     LoggingConfig     `mapstructure:"logging"`
	Static      StaticConfig      `mapstructure:"static"`
	MCP         MCPConfig         `mapstructure:"mcp"`
	Office      OfficeConfig      `mapstructure:"office"`
	Knowledge   KnowledgeConfig   `mapstructure:"knowledge"`
	SkillHub    SkillHubConfig    `mapstructure:"skillhub"`
	SharedFiles SharedFilesConfig `mapstructure:"shared_files"`
	ClawAdmin   ClawAdminConfig   `mapstructure:"claw_admin"`
	Sub2API     Sub2APIConfig     `mapstructure:"sub2api"`
	DingTalk    DingTalkConfig    `mapstructure:"dingtalk"`
	Bilibili    BilibiliConfig    `mapstructure:"bilibili"`
	ModelAccess ModelAccessConfig `mapstructure:"model_access"`
	Activity    ActivityConfig    `mapstructure:"agent_activity"`
}

type ActivityConfig struct {
	ReportingEnabled bool `mapstructure:"reporting_enabled"`
}

type BilibiliConfig struct {
	Enabled      bool   `mapstructure:"enabled"`
	ClientID     string `mapstructure:"client_id"`
	ClientSecret string `mapstructure:"client_secret"`
	RedirectURL  string `mapstructure:"redirect_url"`
}

func (cfg BilibiliConfig) Validate() error {
	if !cfg.Enabled {
		return nil
	}
	if strings.TrimSpace(cfg.ClientID) == "" || strings.TrimSpace(cfg.ClientSecret) == "" || strings.TrimSpace(cfg.RedirectURL) == "" {
		return errors.New("bilibili client_id, client_secret and redirect_url must not be empty when enabled")
	}
	redirectURL, err := url.Parse(strings.TrimSpace(cfg.RedirectURL))
	if err != nil || !redirectURL.IsAbs() || redirectURL.Scheme != "https" || redirectURL.Host == "" || redirectURL.User != nil || redirectURL.Path != "/api/v1/integrations/bilibili/oauth/callback" || redirectURL.RawQuery != "" || redirectURL.Fragment != "" {
		return errors.New("bilibili.redirect_url must be an absolute HTTPS URL ending in /api/v1/integrations/bilibili/oauth/callback")
	}
	return nil
}

type Sub2APIConfig struct {
	BaseURL            string `mapstructure:"base_url"`
	AdminAPIKey        string `mapstructure:"admin_api_key"`
	OrganizationUserID int64  `mapstructure:"organization_user_id"`
}

type ModelAccessConfig struct {
	Mode string `mapstructure:"mode"`
}

func (cfg ModelAccessConfig) Validate() error {
	switch cfg.Mode {
	case "platform_managed", "enterprise_managed":
		return nil
	default:
		return errors.New("model_access.mode must be platform_managed or enterprise_managed")
	}
}

type DingTalkConfig struct {
	Enabled        bool   `mapstructure:"enabled"`
	ClientID       string `mapstructure:"client_id"`
	ClientSecret   string `mapstructure:"client_secret"`
	RedirectURL    string `mapstructure:"redirect_url"`
	ProviderKey    string `mapstructure:"provider_key"`
	AutoProvision  bool   `mapstructure:"auto_provision"`
	StateTTL       string `mapstructure:"state_ttl"`
	RequestTimeout string `mapstructure:"request_timeout"`
}

func (cfg DingTalkConfig) Validate() (time.Duration, time.Duration, error) {
	stateTTL, err := time.ParseDuration(strings.TrimSpace(cfg.StateTTL))
	if err != nil || stateTTL < 5*time.Minute || stateTTL > 15*time.Minute {
		return 0, 0, errors.New("dingtalk.state_ttl must be between 5m and 15m")
	}
	timeout, err := time.ParseDuration(strings.TrimSpace(cfg.RequestTimeout))
	if err != nil || timeout < time.Second || timeout > 30*time.Second {
		return 0, 0, errors.New("dingtalk.request_timeout must be between 1s and 30s")
	}
	if !cfg.Enabled {
		return stateTTL, timeout, nil
	}
	if strings.TrimSpace(cfg.ClientID) == "" || strings.TrimSpace(cfg.ClientSecret) == "" || strings.TrimSpace(cfg.ProviderKey) == "" {
		return 0, 0, errors.New("dingtalk client_id, client_secret and provider_key must not be empty when enabled")
	}
	providerKey := strings.TrimSpace(cfg.ProviderKey)
	if len(providerKey) > 64 {
		return 0, 0, errors.New("dingtalk.provider_key must match [a-z0-9_-]{1,64}")
	}
	for _, char := range providerKey {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' && char != '-' {
			return 0, 0, errors.New("dingtalk.provider_key must match [a-z0-9_-]{1,64}")
		}
	}
	redirectURL, err := url.Parse(strings.TrimSpace(cfg.RedirectURL))
	if err != nil || !redirectURL.IsAbs() || (redirectURL.Scheme != "http" && redirectURL.Scheme != "https") || redirectURL.Host == "" || redirectURL.Path != "/api/v1/auth/dingtalk/callback" {
		return 0, 0, errors.New("dingtalk.redirect_url must be an absolute HTTP URL ending in /api/v1/auth/dingtalk/callback")
	}
	return stateTTL, timeout, nil
}

type ServerConfig struct {
	Addr        string `mapstructure:"addr"`
	EnablePprof bool   `mapstructure:"enable_pprof"`
}

type DatabaseConfig struct {
	URL string `mapstructure:"url"`
}

type AdminConfig struct {
	Token string `mapstructure:"token"`
}

type SecurityConfig struct {
	SessionCookieName       string `mapstructure:"session_cookie_name"`
	AdminSessionCookieName  string `mapstructure:"admin_session_cookie_name"`
	SessionCookieSecure     bool   `mapstructure:"session_cookie_secure"`
	SessionDuration         string `mapstructure:"session_duration"`
	UserJWTSigningKey       string `mapstructure:"user_jwt_signing_key"`
	AgentTokenEncryptionKey string `mapstructure:"agent_token_encryption_key"`
}

func (cfg SecurityConfig) Validate() (time.Duration, error) {
	frontendCookie := strings.TrimSpace(cfg.SessionCookieName)
	adminCookie := strings.TrimSpace(cfg.AdminSessionCookieName)
	if frontendCookie == "" || adminCookie == "" {
		return 0, errors.New("security session cookie names must not be empty")
	}
	if frontendCookie == adminCookie {
		return 0, errors.New("security session cookie names must be different")
	}
	duration, err := time.ParseDuration(strings.TrimSpace(cfg.SessionDuration))
	if err != nil || duration < time.Second || duration%time.Second != 0 {
		return 0, errors.New("security.session_duration must be a positive whole-second duration")
	}
	key := cfg.UserJWTSigningKey
	if len(key) < 32 {
		return 0, errors.New("security.user_jwt_signing_key must contain at least 32 ASCII characters")
	}
	for _, char := range []byte(key) {
		if char < 0x20 || char > 0x7e {
			return 0, fmt.Errorf("security.user_jwt_signing_key must contain only ASCII characters")
		}
	}
	encryptionKey := cfg.AgentTokenEncryptionKey
	if len(encryptionKey) != 32 {
		return 0, errors.New("security.agent_token_encryption_key must contain exactly 32 ASCII characters")
	}
	for _, char := range []byte(encryptionKey) {
		if char < 0x20 || char > 0x7e {
			return 0, errors.New("security.agent_token_encryption_key must contain exactly 32 ASCII characters")
		}
	}
	return duration, nil
}

type LoggingConfig struct {
	Level             string `mapstructure:"level"`
	Format            string `mapstructure:"format"`
	Output            string `mapstructure:"output"`
	AccessEnabled     bool   `mapstructure:"access_enabled"`
	ErrorResponseBody bool   `mapstructure:"error_response_body"`
}

type StaticConfig struct {
	Enabled bool   `mapstructure:"enabled"`
	Dir     string `mapstructure:"dir"`
}

type OfficeConfig struct {
	Install OfficeInstallConfig `mapstructure:"install"`
}

type OfficeInstallConfig struct {
	PublicBaseURL       string `mapstructure:"public_base_url"`
	CollectorBinaryRoot string `mapstructure:"collector_binary_root"`
}

type MCPConfig struct {
	PublicBaseURL string        `mapstructure:"public_base_url"`
	Auth          MCPAuthConfig `mapstructure:"auth"`
}

type KnowledgeConfig struct {
	Enabled      bool          `mapstructure:"enabled"`
	ProviderType string        `mapstructure:"provider_type"`
	Bailian      BailianConfig `mapstructure:"bailian"`
}

type SkillHubConfig struct {
	Enabled           bool   `mapstructure:"enabled"`
	PackageRoot       string `mapstructure:"package_root"`
	GitHubSyncEnabled bool   `mapstructure:"github_sync_enabled"`
	RepositoryRoot    string `mapstructure:"repository_root"`
}

type SharedFilesConfig struct {
	StorageRoot string `mapstructure:"storage_root"`
}

type ClawAdminConfig struct {
	BaseURL              string `mapstructure:"base_url"`
	DeploymentCredential string `mapstructure:"deployment_credential"`
	Timeout              string `mapstructure:"timeout"`
}

func (cfg ClawAdminConfig) Validate() (time.Duration, error) {
	timeout, err := time.ParseDuration(strings.TrimSpace(cfg.Timeout))
	if err != nil || timeout <= 0 || timeout > time.Minute {
		return 0, errors.New("claw_admin.timeout must be between 0 and 1m")
	}
	if strings.TrimSpace(cfg.DeploymentCredential) == "" {
		return timeout, nil
	}
	parsed, err := url.Parse(strings.TrimSpace(cfg.BaseURL))
	if err != nil || !parsed.IsAbs() || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return 0, errors.New("claw_admin.base_url must be an absolute HTTP(S) URL without user info")
	}
	return timeout, nil
}

type BailianConfig struct {
	Endpoint           string `mapstructure:"endpoint"`
	WorkspaceID        string `mapstructure:"workspace_id"`
	AccessKeyID        string `mapstructure:"access_key_id"`
	AccessKeySecret    string `mapstructure:"access_key_secret"`
	AccessKeyIDRef     string `mapstructure:"access_key_id_ref"`
	AccessKeySecretRef string `mapstructure:"access_key_secret_ref"`
}

type MCPAuthConfig struct {
	Enabled              bool                      `mapstructure:"enabled"`
	Resource             string                    `mapstructure:"resource"`
	ResourceMetadataURL  string                    `mapstructure:"resource_metadata_url"`
	AuthorizationServers []string                  `mapstructure:"authorization_servers"`
	RequiredScopes       []string                  `mapstructure:"required_scopes"`
	DemoTokens           map[string]MCPTokenConfig `mapstructure:"demo_tokens"`
}

type MCPTokenConfig struct {
	Subject  string   `mapstructure:"subject"`
	ClientID string   `mapstructure:"client_id"`
	AgentID  string   `mapstructure:"agent_id"`
	Issuer   string   `mapstructure:"issuer"`
	TokenID  string   `mapstructure:"token_id"`
	Scopes   []string `mapstructure:"scopes"`
}

func Load(path string) (Config, error) {
	resolvedPath, useConfigFile, err := resolveConfigPath(path)
	if err != nil {
		return Config{}, err
	}
	if err := loadOpsDotEnv(); err != nil {
		return Config{}, err
	}

	v := viper.New()
	v.SetConfigType("yaml")
	v.SetEnvPrefix("CLAW_MCP")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	bindEnv(v)

	setDefaults(v)

	if useConfigFile {
		v.SetConfigFile(resolvedPath)
		if err := v.ReadInConfig(); err != nil {
			return Config{}, err
		}
	}
	if mode, ok := os.LookupEnv("CLAW_MCP_MODEL_ACCESS_MODE"); ok {
		v.Set("model_access.mode", mode)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return Config{}, err
	}
	if err := cfg.ModelAccess.Validate(); err != nil {
		return Config{}, err
	}
	if err := cfg.Bilibili.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func resolveConfigPath(path string) (string, bool, error) {
	if path != "" && filepath.IsAbs(path) {
		return filepath.Clean(path), true, nil
	}

	opsDir, configured := os.LookupEnv(opsDirEnv)
	if !configured {
		if path == "" {
			return "", false, nil
		}
		return "", false, fmt.Errorf("relative config path %q requires %s", path, opsDirEnv)
	}
	if strings.TrimSpace(opsDir) == "" {
		return "", false, fmt.Errorf("%s is set but empty", opsDirEnv)
	}

	opsRoot, err := filepath.Abs(opsDir)
	if err != nil {
		return "", false, fmt.Errorf("resolve %s: %w", opsDirEnv, err)
	}
	opsRoot, err = filepath.EvalSymlinks(opsRoot)
	if err != nil {
		return "", false, fmt.Errorf("resolve %s directory %q: %w", opsDirEnv, opsDir, err)
	}
	info, err := os.Stat(opsRoot)
	if err != nil {
		return "", false, fmt.Errorf("inspect %s directory %q: %w", opsDirEnv, opsDir, err)
	}
	if !info.IsDir() {
		return "", false, fmt.Errorf("%s path %q is not a directory", opsDirEnv, opsDir)
	}

	relativePath := path
	if relativePath == "" {
		relativePath = defaultConfigRelativePath
	}
	candidate := filepath.Join(opsRoot, filepath.Clean(relativePath))
	resolvedPath, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", false, fmt.Errorf("resolve config %q under %s: %w", relativePath, opsDirEnv, err)
	}
	rel, err := filepath.Rel(opsRoot, resolvedPath)
	if err != nil {
		return "", false, fmt.Errorf("validate config %q under %s: %w", relativePath, opsDirEnv, err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false, fmt.Errorf("config path %q escapes %s", relativePath, opsDirEnv)
	}
	info, err = os.Stat(resolvedPath)
	if err != nil {
		return "", false, fmt.Errorf("inspect config %q under %s: %w", relativePath, opsDirEnv, err)
	}
	if !info.Mode().IsRegular() {
		return "", false, fmt.Errorf("config path %q under %s is not a regular file", relativePath, opsDirEnv)
	}
	return resolvedPath, true, nil
}

func loadOpsDotEnv() error {
	opsDir, configured := os.LookupEnv(opsDirEnv)
	if !configured {
		return nil
	}
	if strings.TrimSpace(opsDir) == "" {
		return fmt.Errorf("%s is set but empty", opsDirEnv)
	}
	opsRoot, err := filepath.Abs(opsDir)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", opsDirEnv, err)
	}
	dotEnvPath := filepath.Join(opsRoot, ".env")
	info, err := os.Stat(dotEnvPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s .env path is not a regular file", opsDirEnv)
	}
	return gotenv.Load(dotEnvPath)
}

func setDefaults(v *viper.Viper) {
	v.SetDefault("server.addr", "0.0.0.0:1904")
	v.SetDefault("server.enable_pprof", false)
	v.SetDefault("database.url", "")
	v.SetDefault("admin.token", "")
	v.SetDefault("security.session_cookie_name", "claw_front_token")
	v.SetDefault("security.admin_session_cookie_name", "claw_admin_token")
	v.SetDefault("security.session_cookie_secure", false)
	v.SetDefault("security.session_duration", "168h")
	v.SetDefault("security.user_jwt_signing_key", "")
	v.SetDefault("security.agent_token_encryption_key", "")
	v.SetDefault("logging.level", "info")
	v.SetDefault("logging.format", "json")
	v.SetDefault("logging.output", "stdout")
	v.SetDefault("logging.access_enabled", true)
	v.SetDefault("logging.error_response_body", false)
	v.SetDefault("static.enabled", true)
	v.SetDefault("static.dir", "")
	v.SetDefault("office.install.public_base_url", "")
	v.SetDefault("office.install.collector_binary_root", "public/collectors")
	v.SetDefault("mcp.auth.enabled", true)
	v.SetDefault("mcp.public_base_url", "")
	v.SetDefault("mcp.auth.resource", "http://localhost:1904/mcp")
	v.SetDefault("mcp.auth.resource_metadata_url", "http://localhost:1904/.well-known/oauth-protected-resource/mcp")
	v.SetDefault("mcp.auth.authorization_servers", []string{"http://localhost:1904/mock-oauth"})
	v.SetDefault("mcp.auth.required_scopes", []string{"mcp:call"})
	v.SetDefault("knowledge.enabled", false)
	v.SetDefault("knowledge.provider_type", "bailian")
	v.SetDefault("knowledge.bailian.endpoint", "https://bailian.cn-beijing.aliyuncs.com")
	v.SetDefault("knowledge.bailian.workspace_id", "")
	v.SetDefault("knowledge.bailian.access_key_id", "")
	v.SetDefault("knowledge.bailian.access_key_secret", "")
	v.SetDefault("knowledge.bailian.access_key_id_ref", "ALIBABA_CLOUD_ACCESS_KEY_ID")
	v.SetDefault("knowledge.bailian.access_key_secret_ref", "ALIBABA_CLOUD_ACCESS_KEY_SECRET")
	v.SetDefault("skillhub.enabled", false)
	v.SetDefault("skillhub.package_root", "data/skillhub/packages")
	v.SetDefault("skillhub.github_sync_enabled", true)
	v.SetDefault("skillhub.repository_root", "data/skillhub/repositories")
	v.SetDefault("shared_files.storage_root", "data/shared-files")
	v.SetDefault("claw_admin.base_url", "")
	v.SetDefault("claw_admin.deployment_credential", "")
	v.SetDefault("claw_admin.timeout", "10s")
	v.SetDefault("dingtalk.enabled", false)
	v.SetDefault("dingtalk.client_id", "")
	v.SetDefault("dingtalk.client_secret", "")
	v.SetDefault("dingtalk.redirect_url", "")
	v.SetDefault("dingtalk.provider_key", "default")
	v.SetDefault("dingtalk.auto_provision", false)
	v.SetDefault("dingtalk.state_ttl", "10m")
	v.SetDefault("dingtalk.request_timeout", "10s")
	v.SetDefault("bilibili.enabled", false)
	v.SetDefault("bilibili.client_id", "")
	v.SetDefault("bilibili.client_secret", "")
	v.SetDefault("bilibili.redirect_url", "")
	v.SetDefault("model_access.mode", "enterprise_managed")
	v.SetDefault("agent_activity.reporting_enabled", false)
}

func bindEnv(v *viper.Viper) {
	keys := []string{
		"server.addr",
		"server.enable_pprof",
		"database.url",
		"admin.token",
		"security.session_cookie_name",
		"security.admin_session_cookie_name",
		"security.session_cookie_secure",
		"security.session_duration",
		"security.user_jwt_signing_key",
		"security.agent_token_encryption_key",
		"logging.level",
		"logging.format",
		"logging.output",
		"logging.access_enabled",
		"logging.error_response_body",
		"static.enabled",
		"static.dir",
		"office.install.public_base_url",
		"office.install.collector_binary_root",
		"mcp.auth.enabled",
		"mcp.public_base_url",
		"mcp.auth.resource",
		"mcp.auth.resource_metadata_url",
		"mcp.auth.authorization_servers",
		"mcp.auth.required_scopes",
		"knowledge.enabled",
		"knowledge.provider_type",
		"knowledge.bailian.endpoint",
		"knowledge.bailian.workspace_id",
		"knowledge.bailian.access_key_id",
		"knowledge.bailian.access_key_secret",
		"knowledge.bailian.access_key_id_ref",
		"knowledge.bailian.access_key_secret_ref",
		"skillhub.enabled",
		"skillhub.package_root",
		"shared_files.storage_root",
		"claw_admin.base_url",
		"claw_admin.deployment_credential",
		"claw_admin.timeout",
		"dingtalk.enabled",
		"dingtalk.client_id",
		"dingtalk.client_secret",
		"dingtalk.redirect_url",
		"dingtalk.provider_key",
		"dingtalk.auto_provision",
		"dingtalk.state_ttl",
		"dingtalk.request_timeout",
		"model_access.mode",
		"agent_activity.reporting_enabled",
	}
	for _, key := range keys {
		_ = v.BindEnv(key)
	}
}
