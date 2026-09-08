package windowsuser

import (
	"context"
	"time"
)

const (
	TaskName          = "ClaweeCollector"
	DefaultListenAddr = "127.0.0.1:1905"
)

type Options struct {
	OfficeURL             string
	RegistrationCode      string
	BinaryPath            string
	RunnerBinaryPath      string
	ConfigPath            string
	CodexConfigPath       string
	ClaweeAgentConfigPath string
	Workspace             string
	JSON                  bool
	ResetIdentity         bool
}

type Paths struct {
	InstallDir       string
	BinDir           string
	BinaryPath       string
	RunnerBinaryPath string
	ConfigPath       string
	LogDir           string
	DiagnosticsDir   string
	CodexConfigPath  string
}

type Result struct {
	Status         StatusSummary
	DiagnosticsLog string
}

type StatusSummary struct {
	Installed        bool                `json:"installed"`
	Prepared         bool                `json:"prepared"`
	StartupInstalled bool                `json:"startup_installed"`
	StartupElevated  bool                `json:"startup_elevated"`
	StartupErrorCode string              `json:"startup_error_code,omitempty"`
	SuggestedAction  string              `json:"suggested_action,omitempty"`
	Running          bool                `json:"running"`
	Connected        bool                `json:"connected"`
	TaskUsesRunner   bool                `json:"task_uses_runner"`
	CodexReady       bool                `json:"codex_ready"`
	LegacyService    LegacyServiceStatus `json:"legacy_service"`
}

type LegacyServiceStatus struct {
	Exists  bool   `json:"exists"`
	Cleaned bool   `json:"cleaned"`
	Error   string `json:"error,omitempty"`
}

type RuntimeCleaner interface {
	CleanupRuntime(context.Context, RuntimeCleanupOptions) (RuntimeCleanupResult, error)
}

type RuntimeCleanupOptions struct {
	BinaryPath       string
	RunnerBinaryPath string
	ConfigPath       string
	CodexConfigPath  string
	Elevated         bool
}

type RuntimeCleanupResult struct {
	DiagnosticsLog string
	TaskRemoved    bool
	LegacyService  LegacyServiceStatus
	HooksRemoved   bool
}

type Clock func() time.Time
