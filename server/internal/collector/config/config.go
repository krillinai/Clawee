package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/krillinai/Clawee/server/internal/collector/agentidentity"
)

type Config struct {
	OfficeURL         string           `json:"office_url" toml:"office_url"`
	AgentID           string           `json:"agent_id" toml:"agent_id"`
	CollectorToken    string           `json:"collector_token" toml:"collector_token"`
	CollectorID       string           `json:"collector_id" toml:"collector_id"`
	DeviceID          string           `json:"device_id" toml:"device_id"`
	ListenAddr        string           `json:"listen_addr" toml:"listen_addr"`
	EnabledAgentTypes []string         `json:"enabled_agent_types" toml:"enabled_agent_types"`
	PrivacyMode       string           `json:"privacy_mode" toml:"privacy_mode"`
	CodexStateDB      string           `json:"codex_state_db" toml:"codex_state_db"`
	RequestLogDir     string           `json:"request_log_dir,omitempty" toml:"request_log_dir,omitempty"`
	LogColor          *bool            `json:"log_color,omitempty" toml:"log_color,omitempty"`
	Debug             bool             `json:"debug,omitempty" toml:"debug,omitempty"`
	MCPServer         MCPServerConfig  `json:"mcp_server,omitempty" toml:"mcp_server,omitempty"`
	PullWorker        PullWorkerConfig `json:"pull_worker,omitempty" toml:"pull_worker,omitempty"`
}

type MCPServerConfig struct {
	Enabled      bool   `json:"enabled" toml:"enabled"`
	BearerToken  string `json:"bearer_token" toml:"bearer_token"`
	CodexWorkDir string `json:"codex_work_dir" toml:"codex_work_dir"`
}

type PullWorkerConfig struct {
	Enabled      bool   `json:"enabled" toml:"enabled"`
	CodexWorkDir string `json:"codex_work_dir" toml:"codex_work_dir"`
}

const (
	defaultConfigDirName  = ".clawee"
	collectorDirName      = "collector"
	defaultConfigFileName = "config.toml"
	legacyConfigFileName  = "config.json"
	legacyConfigDir       = ".clawee-collector"
	deprecatedConfigDir   = ".ao-collector"
	DefaultListenAddr     = "127.0.0.1:1905"
)

const (
	envConfigPathPrimary        = "CLAWEE_COLLECTOR_CONFIG"
	envConfigDirPrimary         = "CLAWEE_COLLECTOR_DIR"
	envOfficeURLPrimary         = "CLAWEE_COLLECTOR_OFFICE_URL"
	envCollectorTokenPrimary    = "CLAWEE_COLLECTOR_TOKEN"
	envCollectorIDPrimary       = "CLAWEE_COLLECTOR_ID"
	envDeviceIDPrimary          = "CLAWEE_DEVICE_ID"
	envListenAddrPrimary        = "CLAWEE_COLLECTOR_LISTEN_ADDR"
	envCodexStateDBPrimary      = "CLAWEE_CODEX_STATE_DB"
	envLogColorPrimary          = "CLAWEE_COLLECTOR_LOG_COLOR"
	envConfigPathDeprecated     = "AO_COLLECTOR_CONFIG"
	envOfficeURLDeprecated      = "AGENT_OFFICE_URL"
	envCollectorTokenDeprecated = "AGENT_OFFICE_COLLECTOR_TOKEN"
	envCollectorIDDeprecated    = "AGENT_OFFICE_COLLECTOR_ID"
	envDeviceIDDeprecated       = "AGENT_OFFICE_DEVICE_ID"
	envListenAddrDeprecated     = "AGENT_OFFICE_LISTEN_ADDR"
	envCodexStateDBDeprecated   = "AGENT_OFFICE_CODEX_STATE_DB"
	envLogColorDeprecated       = "AGENT_OFFICE_LOG_COLOR"
)

func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, defaultConfigDirName, collectorDirName, defaultConfigFileName), nil
}

func DeprecatedDefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, deprecatedConfigDir, legacyConfigFileName), nil
}

func LegacyDefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, legacyConfigDir, defaultConfigFileName), nil
}

func ResolvePath(path string) (string, error) {
	if path != "" {
		return path, nil
	}
	if value := os.Getenv(envConfigPathPrimary); value != "" {
		return value, nil
	}
	if value := os.Getenv(envConfigDirPrimary); value != "" {
		return filepath.Join(value, defaultConfigFileName), nil
	}
	if value := os.Getenv(envConfigPathDeprecated); value != "" {
		return value, nil
	}
	return DefaultPath()
}

func Load(path string) (Config, error) {
	cfg := defaultConfig()

	configPath, migrationTarget, err := resolveLoadPath(path)
	if err != nil {
		return cfg, err
	}

	if configPath != "" {
		body, err := os.ReadFile(configPath)
		if err != nil {
			return cfg, err
		}
		body = bytes.TrimPrefix(body, []byte{0xEF, 0xBB, 0xBF})
		if err := decode(configPath, body, &cfg); err != nil {
			return cfg, err
		}
		if migrationTarget != "" {
			if err := validate(cfg); err == nil {
				if err := Save(migrationTarget, cfg); err != nil {
					return cfg, fmt.Errorf("migrate legacy collector config to %s: %w", migrationTarget, err)
				}
			}
		}
	}

	overlayEnv(&cfg)
	if err := validate(cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func Save(path string, cfg Config) error {
	if path == "" {
		return errors.New("config path is required")
	}
	if cfg.PrivacyMode == "" {
		cfg.PrivacyMode = "summary_only"
	}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = DefaultListenAddr
	}
	if len(cfg.EnabledAgentTypes) == 0 {
		cfg.EnabledAgentTypes = []string{"codex"}
	}
	if err := validate(cfg); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	encodeErr := encode(path, file, cfg)
	closeErr := file.Close()
	if encodeErr != nil {
		_ = os.Remove(tmp)
		return encodeErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func defaultConfig() Config {
	return Config{
		ListenAddr:        DefaultListenAddr,
		EnabledAgentTypes: []string{"codex"},
		PrivacyMode:       "summary_only",
	}
}

func resolveLoadPath(path string) (string, string, error) {
	if path != "" {
		return resolveRequestedLoadPath(path)
	}

	resolved, err := ResolvePath("")
	if err != nil {
		return "", "", err
	}
	if usesConfiguredPath() {
		return resolveRequestedLoadPath(resolved)
	}
	if loadPath, migrationTarget, found, err := findRequestedLoadPath(resolved); err != nil || found {
		return loadPath, migrationTarget, err
	}

	legacyResolved, err := LegacyDefaultPath()
	if err != nil {
		return "", "", err
	}
	if loadPath, _, found, err := findRequestedLoadPath(legacyResolved); err != nil || found {
		return loadPath, resolved, err
	}

	deprecatedResolved, err := DeprecatedDefaultPath()
	if err != nil {
		return "", "", err
	}
	if _, statErr := os.Stat(deprecatedResolved); statErr == nil {
		return deprecatedResolved, resolved, nil
	} else if !os.IsNotExist(statErr) {
		return "", "", statErr
	}
	return "", "", nil
}

func resolveRequestedLoadPath(path string) (string, string, error) {
	if loadPath, migrationTarget, found, err := findRequestedLoadPath(path); err != nil || found {
		return loadPath, migrationTarget, err
	}
	defaultPath, err := DefaultPath()
	if err != nil {
		return "", "", err
	}
	if filepath.Clean(path) == filepath.Clean(defaultPath) {
		legacyPath, legacyErr := LegacyDefaultPath()
		if legacyErr != nil {
			return "", "", legacyErr
		}
		if loadPath, _, found, findErr := findRequestedLoadPath(legacyPath); findErr != nil || found {
			return loadPath, path, findErr
		}
	}
	return path, "", nil
}

func findRequestedLoadPath(path string) (string, string, bool, error) {
	if _, err := os.Stat(path); err == nil {
		return path, "", true, nil
	} else if !os.IsNotExist(err) {
		return "", "", false, err
	}
	if !strings.EqualFold(filepath.Ext(path), ".toml") {
		return "", "", false, nil
	}
	legacyPath := strings.TrimSuffix(path, filepath.Ext(path)) + ".json"
	if _, err := os.Stat(legacyPath); err == nil {
		return legacyPath, path, true, nil
	} else if !os.IsNotExist(err) {
		return "", "", false, err
	}
	return "", "", false, nil
}

func decode(path string, body []byte, cfg *Config) error {
	if strings.EqualFold(filepath.Ext(path), ".json") {
		return json.Unmarshal(body, cfg)
	}
	return toml.Unmarshal(body, cfg)
}

func encode(path string, file *os.File, cfg Config) error {
	if strings.EqualFold(filepath.Ext(path), ".json") {
		encoder := json.NewEncoder(file)
		encoder.SetIndent("", "  ")
		return encoder.Encode(cfg)
	}
	return toml.NewEncoder(file).Encode(cfg)
}

func validate(cfg Config) error {
	if cfg.DeviceID == "" {
		return errors.New("device_id is required")
	}
	if cfg.CollectorID == "" {
		return errors.New("collector_id is required")
	}
	if cfg.OfficeURL == "" {
		return errors.New("office_url is required")
	}
	if cfg.CollectorToken == "" {
		return errors.New("collector_token is required")
	}
	if cfg.PrivacyMode != "summary_only" {
		return errors.New("privacy_mode must be summary_only")
	}
	if cfg.AgentID != "" && !agentidentity.IsValid(cfg.AgentID) {
		return errors.New("agent_id is invalid")
	}
	if err := cfg.MCPServer.Validate(); err != nil {
		return err
	}
	if err := cfg.PullWorker.Validate(); err != nil {
		return err
	}
	if cfg.MCPServer.Enabled && cfg.PullWorker.Enabled {
		return errors.New("mcp_server and pull_worker cannot both be enabled")
	}
	return nil
}

func (cfg MCPServerConfig) Validate() error {
	if !cfg.Enabled {
		return nil
	}
	if strings.TrimSpace(cfg.BearerToken) == "" {
		return errors.New("mcp_server.bearer_token is required when mcp_server is enabled")
	}
	if strings.TrimSpace(cfg.CodexWorkDir) == "" {
		return errors.New("mcp_server.codex_work_dir is required when mcp_server is enabled")
	}
	return nil
}

func (cfg PullWorkerConfig) Validate() error {
	if !cfg.Enabled {
		return nil
	}
	if strings.TrimSpace(cfg.CodexWorkDir) == "" {
		return errors.New("pull_worker.codex_work_dir is required when pull_worker is enabled")
	}
	return nil
}

func (cfg Config) LogColorEnabled() bool {
	if cfg.LogColor == nil {
		return true
	}
	return *cfg.LogColor
}

func overlayEnv(cfg *Config) {
	if value := getenvFirst(envOfficeURLPrimary, envOfficeURLDeprecated); value != "" {
		cfg.OfficeURL = value
	}
	if value := getenvFirst(envCollectorTokenPrimary, envCollectorTokenDeprecated); value != "" {
		cfg.CollectorToken = value
	}
	if value := getenvFirst(envCollectorIDPrimary, envCollectorIDDeprecated); value != "" {
		cfg.CollectorID = value
	}
	if value := getenvFirst(envDeviceIDPrimary, envDeviceIDDeprecated); value != "" {
		cfg.DeviceID = value
	}
	if value := getenvFirst(envListenAddrPrimary, envListenAddrDeprecated); value != "" {
		cfg.ListenAddr = value
	}
	if value := getenvFirst(envCodexStateDBPrimary, envCodexStateDBDeprecated); value != "" {
		cfg.CodexStateDB = value
	}
	if value := getenvFirst(envLogColorPrimary, envLogColorDeprecated); value != "" {
		enabled, err := strconv.ParseBool(value)
		if err == nil {
			cfg.LogColor = &enabled
		}
	}
}

func getenvFirst(keys ...string) string {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return ""
}

func usesConfiguredPath() bool {
	return os.Getenv(envConfigPathPrimary) != "" ||
		os.Getenv(envConfigDirPrimary) != "" ||
		os.Getenv(envConfigPathDeprecated) != ""
}
