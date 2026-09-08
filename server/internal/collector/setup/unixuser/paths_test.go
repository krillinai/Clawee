package unixuser

import (
	"path/filepath"
	"testing"
)

func TestResolvePathsDefaultsToCurrentUserHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAWEE_COLLECTOR_DIR", "")
	t.Setenv("CLAWEE_COLLECTOR_CONFIG", "")
	t.Setenv("CODEX_CONFIG", "")

	paths, err := ResolvePaths(Options{})
	if err != nil {
		t.Fatal(err)
	}

	if paths.InstallDir != filepath.Join(home, ".clawee", "collector", "bin") {
		t.Fatalf("InstallDir = %q", paths.InstallDir)
	}
	if paths.BinaryPath != filepath.Join(home, ".clawee", "collector", "bin", "clawee-collector") {
		t.Fatalf("BinaryPath = %q", paths.BinaryPath)
	}
	if paths.ConfigPath != filepath.Join(home, ".clawee", "collector", "config.toml") {
		t.Fatalf("ConfigPath = %q", paths.ConfigPath)
	}
	if paths.CodexConfigPath != filepath.Join(home, ".codex", "config.toml") {
		t.Fatalf("CodexConfigPath = %q", paths.CodexConfigPath)
	}
}

func TestResolvePathsHonorsFlagsBeforeEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAWEE_COLLECTOR_CONFIG", filepath.Join(home, "env-config.json"))
	t.Setenv("CODEX_CONFIG", filepath.Join(home, "env-codex.toml"))

	paths, err := ResolvePaths(Options{
		BinaryPath:      filepath.Join(home, "bin", "collector"),
		ConfigPath:      filepath.Join(home, "flag-config.json"),
		CodexConfigPath: filepath.Join(home, "flag-codex.toml"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if paths.BinaryPath != filepath.Join(home, "bin", "collector") {
		t.Fatalf("BinaryPath = %q", paths.BinaryPath)
	}
	if paths.ConfigPath != filepath.Join(home, "flag-config.json") {
		t.Fatalf("ConfigPath = %q", paths.ConfigPath)
	}
	if paths.CodexConfigPath != filepath.Join(home, "flag-codex.toml") {
		t.Fatalf("CodexConfigPath = %q", paths.CodexConfigPath)
	}
}
