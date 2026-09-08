package common

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

type fakeRegistrar struct {
	calls    int
	request  collectorapi.RegistrationRequest
	response collectorapi.RegistrationResponse
	err      error
}

func (r *fakeRegistrar) RegisterCollector(req collectorapi.RegistrationRequest) (collectorapi.RegistrationResponse, error) {
	r.calls++
	r.request = req
	if r.err != nil {
		return collectorapi.RegistrationResponse{}, r.err
	}
	if r.response == (collectorapi.RegistrationResponse{}) {
		return collectorapi.RegistrationResponse{
			CollectorID:    "collector-new",
			DeviceID:       "device-new",
			CollectorToken: "token-new",
			PrivacyMode:    "summary_only",
		}, nil
	}
	return r.response, nil
}

func TestRegisterCollectorIncludesStableAgentID(t *testing.T) {
	registrar := &fakeRegistrar{}
	cfg, err := registerCollector(ConfigOptions{
		OfficeURL: "https://office.example", RegistrationCode: "reg_xxx", Workspace: "repo",
	}, ConfigPaths{LogDir: t.TempDir()}, registrar, "clawee_agent_1")
	if err != nil {
		t.Fatal(err)
	}
	if registrar.request.AgentID != "clawee_agent_1" {
		t.Fatalf("registration agent_id = %q", registrar.request.AgentID)
	}
	if cfg.AgentID != registrar.request.AgentID {
		t.Fatalf("config agent_id = %q, request agent_id = %q", cfg.AgentID, registrar.request.AgentID)
	}
}

func TestEnsureCollectorConfigRejectsBrokenExistingConfigWithoutRegistering(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(configPath, []byte(`{"collector_id":"collector-old"`), 0o600); err != nil {
		t.Fatal(err)
	}
	registrar := &fakeRegistrar{}

	_, _, err := EnsureCollectorConfig(context.Background(), ConfigOptions{
		OfficeURL:        "https://office.example",
		RegistrationCode: "reg_xxx",
	}, ConfigPaths{ConfigPath: configPath, LogDir: filepath.Join(dir, "logs")}, registrar)

	if err == nil {
		t.Fatal("expected broken existing config to fail")
	}
	if registrar.calls != 0 {
		t.Fatalf("registrar calls = %d, want 0", registrar.calls)
	}
	if !strings.Contains(err.Error(), "配置文件存在但无法加载") {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureCollectorConfigRejectsBrokenLegacyJSONWithoutRegistering(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"collector_id":"collector-old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	registrar := &fakeRegistrar{}

	_, _, err := EnsureCollectorConfig(context.Background(), ConfigOptions{
		OfficeURL:        "https://office.example",
		RegistrationCode: "reg_xxx",
	}, ConfigPaths{ConfigPath: configPath, LogDir: filepath.Join(dir, "logs")}, registrar)

	if err == nil {
		t.Fatal("expected broken legacy config to fail")
	}
	if registrar.calls != 0 {
		t.Fatalf("registrar calls = %d, want 0", registrar.calls)
	}
	if !strings.Contains(err.Error(), "配置文件存在但无法加载") {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureCollectorConfigStopsBeforeRegisteringWhenContextIsCanceledAfterConfigCheck(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	orig := beforeRegisterCollector
	t.Cleanup(func() { beforeRegisterCollector = orig })

	ctx, cancel := context.WithCancel(context.Background())
	entered := make(chan struct{}, 1)
	beforeRegisterCollector = func(context.Context) {
		entered <- struct{}{}
		cancel()
	}

	registrar := &fakeRegistrar{}
	_, _, err := EnsureCollectorConfig(ctx, ConfigOptions{
		OfficeURL:        "https://office.example",
		RegistrationCode: "reg_xxx",
	}, ConfigPaths{ConfigPath: path, LogDir: filepath.Join(dir, "logs")}, registrar)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if registrar.calls != 0 {
		t.Fatalf("registrar calls = %d, want 0", registrar.calls)
	}
	select {
	case <-entered:
	default:
		t.Fatal("expected beforeRegisterCollector hook to run")
	}
}

func TestEnsureCollectorConfigReturnsCanceledContextWithoutRegistering(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	registrar := &fakeRegistrar{}

	_, _, err := EnsureCollectorConfig(ctx, ConfigOptions{
		OfficeURL:        "https://office.example",
		RegistrationCode: "reg_xxx",
	}, ConfigPaths{ConfigPath: filepath.Join(dir, "config.json"), LogDir: filepath.Join(dir, "logs")}, registrar)

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if registrar.calls != 0 {
		t.Fatalf("registrar calls = %d, want 0", registrar.calls)
	}
}

func TestValidateReusableConfigRejectsMissingRequiredFields(t *testing.T) {
	err := ValidateReusableConfig(collectorconfig.Config{
		OfficeURL:   "http://office.local",
		CollectorID: "collector-1",
	})
	if err == nil || !strings.Contains(err.Error(), "关键字段不完整") {
		t.Fatalf("err = %v", err)
	}
}
