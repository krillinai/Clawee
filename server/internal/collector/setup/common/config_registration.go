package common

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/krillinai/Clawee/server/internal/collector/agentidentity"
	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/discovery"
	"github.com/krillinai/Clawee/server/internal/collector/report"
	"github.com/krillinai/Clawee/server/internal/collector/version"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func NewReportRegistrar(officeURL string) Registrar {
	return report.NewClient(report.Config{BaseURL: officeURL})
}

func EnsureCollectorConfig(ctx context.Context, options ConfigOptions, paths ConfigPaths, registrar Registrar) (collectorconfig.Config, ConfigAction, error) {
	if err := ctx.Err(); err != nil {
		return collectorconfig.Config{}, "", err
	}
	if options.ResetIdentity {
		return resetCollectorConfig(ctx, options, paths, registrar)
	}

	cfg, err := collectorconfig.Load(paths.ConfigPath)
	if err == nil {
		if err := ValidateReusableConfig(cfg); err != nil {
			return collectorconfig.Config{}, "", err
		}
		agentID, err := agentidentity.Resolve(ctx, agentidentity.Options{
			ClaweeAgentConfigPath: options.ClaweeAgentConfigPath,
			CollectorConfigPath:   paths.ConfigPath,
			OfficeURL:             cfg.OfficeURL,
		})
		if err != nil {
			return collectorconfig.Config{}, "", err
		}
		changed := false
		if cfg.AgentID != agentID {
			cfg.AgentID = agentID
			changed = true
		}
		if cfg.RequestLogDir == "" {
			cfg.RequestLogDir = paths.LogDir
			changed = true
		}
		if changed {
			if saveErr := collectorconfig.Save(paths.ConfigPath, cfg); saveErr != nil {
				return collectorconfig.Config{}, "", saveErr
			}
		}
		return cfg, ConfigReused, nil
	}
	existingPath := existingConfigPath(paths.ConfigPath)
	if existingPath != "" {
		if isRequiredFieldError(err) && configHasMostlyCompleteShape(existingPath) {
			return collectorconfig.Config{}, "", fmt.Errorf("配置文件存在但关键字段不完整，请使用 install --reset-identity --office-url URL --code reg_xxx 重新接入: %w", err)
		}
		return collectorconfig.Config{}, "", fmt.Errorf("配置文件存在但无法加载，请修复或使用 install --reset-identity 流程重新接入: %w", err)
	}
	if !errors.Is(err, os.ErrNotExist) && !isRequiredFieldError(err) {
		return collectorconfig.Config{}, "", fmt.Errorf("配置文件存在但无法加载，请修复或使用 install --reset-identity 流程重新接入: %w", err)
	}
	beforeRegisterCollector(ctx)
	if err := ctx.Err(); err != nil {
		return collectorconfig.Config{}, "", err
	}
	agentID, err := agentidentity.Resolve(ctx, agentidentity.Options{
		ClaweeAgentConfigPath: options.ClaweeAgentConfigPath,
		CollectorConfigPath:   paths.ConfigPath,
		OfficeURL:             options.OfficeURL,
	})
	if err != nil {
		return collectorconfig.Config{}, "", err
	}
	cfg, err = registerCollector(options, paths, registrar, agentID)
	if err != nil {
		return collectorconfig.Config{}, "", err
	}
	if err := collectorconfig.Save(paths.ConfigPath, cfg); err != nil {
		return collectorconfig.Config{}, "", err
	}
	return cfg, ConfigRegistered, nil
}

func ValidateReusableConfig(cfg collectorconfig.Config) error {
	if cfg.OfficeURL == "" || cfg.CollectorID == "" || cfg.DeviceID == "" || cfg.CollectorToken == "" {
		return errors.New("配置文件存在但关键字段不完整，请使用 install --reset-identity --office-url URL --code reg_xxx 重新接入")
	}
	return nil
}

func configHasMostlyCompleteShape(path string) bool {
	body, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var raw map[string]any
	if strings.EqualFold(filepath.Ext(path), ".json") {
		err = json.Unmarshal(body, &raw)
	} else {
		err = toml.Unmarshal(body, &raw)
	}
	if err != nil {
		return false
	}
	required := []string{"office_url", "collector_id", "device_id", "collector_token"}
	present := 0
	for _, key := range required {
		if _, ok := raw[key]; ok {
			present++
		}
	}
	return present >= 4
}

func resetCollectorConfig(ctx context.Context, options ConfigOptions, paths ConfigPaths, registrar Registrar) (collectorconfig.Config, ConfigAction, error) {
	if options.OfficeURL == "" {
		return collectorconfig.Config{}, "", errors.New("--office-url is required")
	}
	if options.RegistrationCode == "" {
		return collectorconfig.Config{}, "", errors.New("--code is required")
	}
	backupPath := ""
	if existingPath := existingConfigPath(paths.ConfigPath); existingPath != "" {
		backupPath = backupConfigPath(existingPath, time.Now())
		if err := copyFile(existingPath, backupPath); err != nil {
			return collectorconfig.Config{}, "", fmt.Errorf("备份旧配置失败，已停止 reset-identity: %w", err)
		}
	}
	if err := ctx.Err(); err != nil {
		return collectorconfig.Config{}, "", err
	}
	agentID, err := agentidentity.Resolve(ctx, agentidentity.Options{
		ClaweeAgentConfigPath: options.ClaweeAgentConfigPath,
		CollectorConfigPath:   paths.ConfigPath,
		OfficeURL:             options.OfficeURL,
	})
	if err != nil {
		return collectorconfig.Config{}, "", err
	}
	cfg, err := registerCollector(options, paths, registrar, agentID)
	if err != nil {
		return collectorconfig.Config{}, "", err
	}
	if err := collectorconfig.Save(paths.ConfigPath, cfg); err != nil {
		return collectorconfig.Config{}, "", err
	}
	_ = backupPath
	return cfg, ConfigReset, nil
}

func registerCollector(options ConfigOptions, paths ConfigPaths, registrar Registrar, agentID string) (collectorconfig.Config, error) {
	if options.OfficeURL == "" {
		return collectorconfig.Config{}, errors.New("--office-url is required")
	}
	if options.RegistrationCode == "" {
		return collectorconfig.Config{}, errors.New("--code is required")
	}
	if registrar == nil {
		registrar = NewReportRegistrar(options.OfficeURL)
	}
	agents := discovery.DiscoverAgents(options.Workspace)
	device := discovery.DeviceInfo(version.CollectorVersion())
	resp, err := registrar.RegisterCollector(collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: options.RegistrationCode,
		AgentID:          agentID,
		DeviceName:       device.DeviceName,
		Hostname:         device.Hostname,
		OS:               device.OS,
		Arch:             device.Arch,
		CollectorVersion: device.CollectorVersion,
		Agents:           agents,
	})
	if err != nil {
		return collectorconfig.Config{}, err
	}
	privacyMode := resp.PrivacyMode
	if privacyMode == "" {
		privacyMode = "summary_only"
	}
	return collectorconfig.Config{
		OfficeURL:         options.OfficeURL,
		AgentID:           agentID,
		CollectorToken:    resp.CollectorToken,
		CollectorID:       resp.CollectorID,
		DeviceID:          resp.DeviceID,
		ListenAddr:        collectorconfig.DefaultListenAddr,
		EnabledAgentTypes: []string{"codex"},
		PrivacyMode:       privacyMode,
		RequestLogDir:     paths.LogDir,
	}, nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func existingConfigPath(path string) string {
	if fileExists(path) {
		return path
	}
	if strings.EqualFold(filepath.Ext(path), ".toml") {
		legacyPath := strings.TrimSuffix(path, filepath.Ext(path)) + ".json"
		if fileExists(legacyPath) {
			return legacyPath
		}
	}
	return ""
}

func isRequiredFieldError(err error) bool {
	if err == nil {
		return false
	}
	switch err.Error() {
	case "device_id is required", "collector_id is required", "office_url is required", "collector_token is required":
		return true
	default:
		return false
	}
}

func backupConfigPath(configPath string, now time.Time) string {
	ext := filepath.Ext(configPath)
	base := configPath[:len(configPath)-len(ext)]
	return base + "-" + now.Format("20060102-150405") + ext
}

func copyFile(src string, dst string) error {
	body, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	return os.WriteFile(dst, body, 0o600)
}

var beforeRegisterCollector = func(context.Context) {}
