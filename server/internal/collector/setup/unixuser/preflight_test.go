package unixuser

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

type recordingRunner struct {
	results map[string]common.CommandResult
}

func (r recordingRunner) Run(ctx context.Context, name string, args ...string) common.CommandResult {
	key := name
	for _, arg := range args {
		key += "\x00" + arg
	}
	if result, ok := r.results[key]; ok {
		return result
	}
	return common.CommandResult{ExitCode: 1, Output: "not found", Err: os.ErrNotExist}
}

func TestDetectExistingInstallFindsConfigWithoutBinary(t *testing.T) {
	home := t.TempDir()
	paths := Paths{
		InstallDir:      filepath.Join(home, ".clawee-collector", "bin"),
		BinaryPath:      filepath.Join(home, ".clawee-collector", "bin", "clawee-collector"),
		ConfigPath:      filepath.Join(home, ".clawee-collector", "config.json"),
		CodexConfigPath: filepath.Join(home, ".codex", "config.toml"),
		LaunchAgentPath: filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist"),
		SystemdUnitPath: filepath.Join(home, ".config", "systemd", "user", SystemdUnitName),
		DiagnosticsDir:  filepath.Join(home, ".clawee-collector", "diagnostics"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.ConfigPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.ConfigPath, []byte(`{"broken":true}`), 0o600); err != nil {
		t.Fatal(err)
	}

	trace, err := DetectExistingInstall(paths, Platform{OS: "linux"}, recordingRunner{})
	if err != nil {
		t.Fatal(err)
	}
	if !trace.ConfigExists || !trace.Any() {
		t.Fatalf("trace = %#v", trace)
	}
	if !trace.RequiresExistingBinary() {
		t.Fatalf("RequiresExistingBinary = false, trace = %#v", trace)
	}
}

func TestDetectExistingInstallTreatsLoadedSystemdUnitAsLoadedDespiteNonZeroExit(t *testing.T) {
	home := t.TempDir()
	paths := Paths{
		SystemdUnitPath: filepath.Join(home, ".config", "systemd", "user", SystemdUnitName),
	}
	runner := recordingRunner{
		results: map[string]common.CommandResult{
			"systemctl\x00--user\x00status\x00" + SystemdUnitName: {
				ExitCode: 3,
				Output:   "Loaded: loaded (/home/user/.config/systemd/user/clawee-collector.service; enabled; vendor preset: enabled)\nActive: inactive (dead)",
			},
		},
	}

	trace, err := DetectExistingInstall(paths, Platform{OS: "linux"}, runner)
	if err != nil {
		t.Fatal(err)
	}
	if !trace.SystemdUnitLoaded {
		t.Fatalf("SystemdUnitLoaded = false, trace = %#v", trace)
	}
}

func TestDetectExistingInstallTreatsMissingSystemdUnitAsNotLoaded(t *testing.T) {
	home := t.TempDir()
	paths := Paths{
		SystemdUnitPath: filepath.Join(home, ".config", "systemd", "user", SystemdUnitName),
	}
	cases := []common.CommandResult{
		{
			ExitCode: 4,
			Output:   "Loaded: not-found (Reason: Unit not found)",
		},
		{
			ExitCode: 5,
			Output:   "Unit clawee-collector.service could not be found.",
		},
	}

	for i, result := range cases {
		runner := recordingRunner{
			results: map[string]common.CommandResult{
				"systemctl\x00--user\x00status\x00" + SystemdUnitName: result,
			},
		}

		trace, err := DetectExistingInstall(paths, Platform{OS: "linux"}, runner)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if trace.SystemdUnitLoaded {
			t.Fatalf("case %d: SystemdUnitLoaded = true, trace = %#v", i, trace)
		}
	}
}

func TestDetectExistingInstallTreatsLaunchctlPrintAsLoaded(t *testing.T) {
	home := t.TempDir()
	uid := os.Getuid()
	paths := Paths{
		LaunchAgentPath: filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist"),
	}
	if err := os.MkdirAll(filepath.Dir(paths.LaunchAgentPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.LaunchAgentPath, []byte(`<?xml version="1.0"?>`), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := recordingRunner{
		results: map[string]common.CommandResult{
			"launchctl\x00print\x00gui/" + strconv.Itoa(uid) + "/" + LaunchAgentLabel: {
				ExitCode: 0,
				Output:   "gui/" + strconv.Itoa(uid) + "/" + LaunchAgentLabel + " = {\n\tstate = running\n}",
			},
		},
	}

	trace, err := DetectExistingInstall(paths, Platform{OS: "darwin"}, runner)
	if err != nil {
		t.Fatal(err)
	}
	if !trace.LaunchAgentLoaded {
		t.Fatalf("LaunchAgentLoaded = false, trace = %#v", trace)
	}
}
