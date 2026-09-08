package unixuser

import (
	"context"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

const (
	DefaultListenAddr = "127.0.0.1:1905"
	LaunchAgentLabel  = "com.clawee.collector"
	SystemdUnitName   = "clawee-collector.service"
)

type Options struct {
	OfficeURL             string
	RegistrationCode      string
	BinaryPath            string
	ConfigPath            string
	CodexConfigPath       string
	ClaweeAgentConfigPath string
	Workspace             string
	JSON                  bool
	ResetIdentity         bool
	GOOS                  string
}

type Paths struct {
	InstallDir      string
	BinaryPath      string
	ConfigPath      string
	LogDir          string
	DiagnosticsDir  string
	CodexConfigPath string
	LaunchAgentPath string
	SystemdUnitPath string
}

type Platform struct {
	OS string
}

type StatusSummary struct {
	Installed        bool `json:"installed"`
	Prepared         bool `json:"prepared"`
	StartupInstalled bool `json:"startup_installed"`
	Running          bool `json:"running"`
	HealthOK         bool `json:"health_ok"`
	HeartbeatOK      bool `json:"heartbeat_ok"`
	CodexReady       bool `json:"codex_ready"`
}

type Result struct {
	Status         StatusSummary
	DiagnosticsLog string
}

type InstallerDeps struct {
	Runner       common.CommandRunner
	Now          func() time.Time
	ResolvePaths func(Options) (Paths, error)
	Registrar    common.Registrar
	Hook         HookEnsurer
	Health       common.HealthWaiter
	Connection   common.ConnectionWaiter
	RemoveHooks  func(string) (bool, error)
}

type HookEnsurer interface {
	Ensure(codexConfigPath string, collectorConfigPath string, binaryPath string) error
}

type RuntimeCleanupOptions struct {
	BinaryPath      string
	ConfigPath      string
	CodexConfigPath string
	GOOS            string
}

type RuntimeCleanupResult struct {
	DiagnosticsLog string
	StartupRemoved bool
	HooksRemoved   bool
}

type Clock func() time.Time

type RuntimeCleaner interface {
	CleanupRuntime(context.Context, RuntimeCleanupOptions) (RuntimeCleanupResult, error)
}
