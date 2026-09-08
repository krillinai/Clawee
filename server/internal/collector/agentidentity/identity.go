package agentidentity

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

const (
	configEnvName = "CLAWEE_AGENT_CONFIG"
	lockFileName  = ".agent-id.lock"
)

var agentIDPattern = regexp.MustCompile(`^clawee_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type Options struct {
	ClaweeAgentConfigPath string
	CollectorConfigPath   string
	OfficeURL             string
}

type claweeAgentConfig struct {
	Gateway string `toml:"gateway"`
	AgentID string `toml:"agent_id,omitempty"`
}

type collectorIdentityConfig struct {
	OfficeURL string `toml:"office_url" json:"office_url"`
	AgentID   string `toml:"agent_id" json:"agent_id"`
}

func ResolveClaweeAgentConfigPath(explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		return filepath.Abs(explicit)
	}
	if configured := strings.TrimSpace(os.Getenv(configEnvName)); configured != "" {
		return filepath.Abs(configured)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".clawee", "config.toml"), nil
}

func Resolve(ctx context.Context, options Options) (string, error) {
	agentConfigPath, err := ResolveClaweeAgentConfigPath(options.ClaweeAgentConfigPath)
	if err != nil {
		return "", err
	}
	release, err := acquireLock(ctx, filepath.Join(filepath.Dir(agentConfigPath), lockFileName))
	if err != nil {
		return "", err
	}
	defer release()

	agentConfig, agentConfigExists, err := readClaweeAgentConfig(agentConfigPath)
	if err != nil {
		return "", err
	}
	if agentConfigExists && !sameGateway(agentConfig.Gateway, options.OfficeURL) {
		return "", fmt.Errorf("clawee-agent gateway does not match collector office_url")
	}

	collectorAgentID, err := readCollectorAgentID(options.CollectorConfigPath, options.OfficeURL)
	if err != nil {
		return "", err
	}
	agentID := strings.TrimSpace(agentConfig.AgentID)
	if agentID == "" {
		agentID = collectorAgentID
	}
	if agentID == "" {
		agentID, err = generateAgentID()
		if err != nil {
			return "", err
		}
	}
	if !agentIDPattern.MatchString(agentID) {
		return "", fmt.Errorf("invalid clawee agent_id")
	}

	if !agentConfigExists || agentConfig.AgentID != agentID {
		agentConfig.Gateway = options.OfficeURL
		agentConfig.AgentID = agentID
		if err := writeAtomicTOML(agentConfigPath, agentConfig); err != nil {
			return "", err
		}
	}
	return agentID, nil
}

func IsValid(agentID string) bool {
	return agentIDPattern.MatchString(strings.TrimSpace(agentID))
}

func readClaweeAgentConfig(path string) (claweeAgentConfig, bool, error) {
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return claweeAgentConfig{}, false, nil
	}
	if err != nil {
		return claweeAgentConfig{}, false, err
	}
	var cfg claweeAgentConfig
	if err := toml.Unmarshal(body, &cfg); err != nil {
		return claweeAgentConfig{}, true, fmt.Errorf("invalid clawee-agent config: %w", err)
	}
	if strings.TrimSpace(cfg.Gateway) == "" {
		return claweeAgentConfig{}, true, errors.New("invalid clawee-agent config: gateway is required")
	}
	if cfg.AgentID != "" && !IsValid(cfg.AgentID) {
		return claweeAgentConfig{}, true, errors.New("invalid clawee-agent config: agent_id is invalid")
	}
	return cfg, true, nil
}

func readCollectorAgentID(path string, officeURL string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var cfg collectorIdentityConfig
	if strings.EqualFold(filepath.Ext(path), ".json") {
		err = json.Unmarshal(body, &cfg)
	} else {
		err = toml.Unmarshal(body, &cfg)
	}
	if err != nil {
		return "", fmt.Errorf("invalid collector config: %w", err)
	}
	if cfg.AgentID != "" && !IsValid(cfg.AgentID) {
		return "", errors.New("invalid collector config: agent_id is invalid")
	}
	if cfg.AgentID == "" {
		return "", nil
	}
	if strings.TrimSpace(cfg.OfficeURL) == "" {
		return "", errors.New("invalid collector config: office_url is required when agent_id is set")
	}
	if !sameGateway(cfg.OfficeURL, officeURL) {
		return "", errors.New("collector office_url does not match requested office_url")
	}
	return strings.TrimSpace(cfg.AgentID), nil
}

func sameGateway(left string, right string) bool {
	return normalizeGateway(left) != "" && normalizeGateway(left) == normalizeGateway(right)
}

func normalizeGateway(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	return (&url.URL{Scheme: parsed.Scheme, Host: parsed.Host}).String()
}

func generateAgentID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("clawee_%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func writeAtomicTOML(path string, value any) error {
	body, err := toml.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, body, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func acquireLock(ctx context.Context, path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = fmt.Fprintf(file, "%d\n", os.Getpid())
			_ = file.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > 30*time.Second {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("timed out waiting for clawee agent identity lock")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}
