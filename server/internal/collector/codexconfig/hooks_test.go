package codexconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOMEDRIVE", "")
	t.Setenv("HOMEPATH", home)
	return home
}

func TestEnsureHooksFailsWhenCodexConfigDirMissing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing", ".codex")
	configPath := filepath.Join(dir, "config.toml")

	_, err := EnsureHooks(EnsureOptions{
		CodexConfigPath: configPath,
		BinaryPath:      "/opt/clawee/clawee-collector",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "请先启动 Codex 或通过 --codex-config 指定真实的 Codex 配置文件") {
		t.Fatalf("err = %v", err)
	}
	if _, statErr := os.Stat(dir); !os.IsNotExist(statErr) {
		t.Fatalf("EnsureHooks should not create Codex config dir, stat err = %v", statErr)
	}
}

func TestEnsureHooksFailsWhenCodexConfigParentIsFile(t *testing.T) {
	tmp := t.TempDir()
	parent := filepath.Join(tmp, "not-a-dir")
	if err := os.WriteFile(parent, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := EnsureHooks(EnsureOptions{
		CodexConfigPath: filepath.Join(parent, "config.toml"),
		BinaryPath:      "/opt/clawee/clawee-collector",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "Codex 配置文件的父路径不是目录") {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureHooksIgnoresCodexConfigEnvWhenPathIsExplicit(t *testing.T) {
	t.Setenv("CODEX_CONFIG", filepath.Join(t.TempDir(), "env", "config.toml"))

	dir := filepath.Join(t.TempDir(), ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.toml")

	result, err := EnsureHooks(EnsureOptions{
		CodexConfigPath: configPath,
		BinaryPath:      "/opt/clawee/clawee-collector",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.CodexConfigPath != configPath {
		t.Fatalf("CodexConfigPath = %q, want %q", result.CodexConfigPath, configPath)
	}
}

func TestEnsureHooksUsesDefaultPathWhenEnvSetAndPathEmpty(t *testing.T) {
	t.Setenv("CODEX_CONFIG", filepath.Join(t.TempDir(), "env", "config.toml"))

	home := setTestHome(t)

	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.toml")

	result, err := EnsureHooks(EnsureOptions{
		BinaryPath: "/opt/clawee/clawee-collector",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.CodexConfigPath != configPath {
		t.Fatalf("CodexConfigPath = %q, want %q", result.CodexConfigPath, configPath)
	}
}

func TestBuildHookCommandOmitsDefaultCollectorConfig(t *testing.T) {
	home := setTestHome(t)

	defaultCollectorConfig := filepath.Join(home, ".clawee", "collector", "config.toml")
	command, err := BuildHookCommand("/opt/clawee/clawee-collector", defaultCollectorConfig)
	if err != nil {
		t.Fatal(err)
	}
	if command != `"/opt/clawee/clawee-collector" hook codex` {
		t.Fatalf("command = %q", command)
	}
}

func TestBuildHookCommandIncludesExplicitNonDefaultCollectorConfig(t *testing.T) {
	home := setTestHome(t)

	customConfig := filepath.Join(home, "custom collector", "config.json")
	command, err := BuildHookCommand("/opt/clawee/clawee-collector", customConfig)
	if err != nil {
		t.Fatal(err)
	}
	want := `"/opt/clawee/clawee-collector" hook codex --config ` + shellDoubleQuote(customConfig)
	if command != want {
		t.Fatalf("command = %q, want %q", command, want)
	}
}

func TestBuildHookBlockIncludesWindowsCommandOverride(t *testing.T) {
	block := BuildHookBlock(`"C:\\Users\\me\\.clawee-collector\\bin\\clawee-collector.exe" hook codex --config "C:\\Users\\me\\.clawee-collector\\config.json"`)

	for _, want := range []string{
		`command = "\"C:\\\\Users\\\\me\\\\.clawee-collector\\\\bin\\\\clawee-collector.exe\" hook codex --config \"C:\\\\Users\\\\me\\\\.clawee-collector\\\\config.json\""`,
		`command_windows = "& 'C:\\Users\\me\\.clawee-collector\\bin\\clawee-collector.exe' hook codex --config 'C:\\Users\\me\\.clawee-collector\\config.json'"`,
	} {
		if !strings.Contains(block, want) {
			t.Fatalf("hook block missing %q:\n%s", want, block)
		}
	}
}

func TestBuildHookCommandRequiresBinaryPathInChinese(t *testing.T) {
	_, err := BuildHookCommand("", "")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "必须提供采集器二进制路径") {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureHooksCreatesFileWhenParentExists(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.toml")

	result, err := EnsureHooks(EnsureOptions{
		CodexConfigPath: configPath,
		BinaryPath:      "/opt/clawee/clawee-collector",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed {
		t.Fatal("Changed = false, want true")
	}

	bodyBytes, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	for _, want := range []string{
		"[features]",
		"hooks = true",
		blockStart,
		"[[hooks.SessionStart]]",
		`matcher = "startup|resume|clear|compact"`,
		"[[hooks.Stop.hooks]]",
		`command = "\"/opt/clawee/clawee-collector\" hook codex"`,
		`statusMessage = "向 Clawee Gateway 上报会话启动事件"`,
		blockEnd,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("config missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "--config") {
		t.Fatalf("default hook command should not include --config:\n%s", body)
	}
}

func TestEnsureHooksIsIdempotent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.toml")

	first, err := EnsureHooks(EnsureOptions{
		CodexConfigPath: configPath,
		BinaryPath:      "/opt/clawee/clawee-collector",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := EnsureHooks(EnsureOptions{
		CodexConfigPath: configPath,
		BinaryPath:      "/opt/clawee/clawee-collector",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed {
		t.Fatal("first Changed = false, want true")
	}
	if second.Changed {
		t.Fatal("second Changed = true, want false")
	}

	bodyBytes, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	if count := strings.Count(body, blockStart); count != 1 {
		t.Fatalf("blockStart count = %d, want 1:\n%s", count, body)
	}
}

func TestEnsureHooksPreservesExistingConfigAndEnablesFeatures(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.toml")
	initial := `[model]
name = "gpt-5"

[features]
other = true

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "echo user hook"
`
	if err := os.WriteFile(configPath, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := EnsureHooks(EnsureOptions{
		CodexConfigPath: configPath,
		BinaryPath:      "/opt/clawee/clawee-collector",
	}); err != nil {
		t.Fatal(err)
	}

	bodyBytes, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	for _, want := range []string{
		`name = "gpt-5"`,
		"other = true",
		`command = "echo user hook"`,
		"hooks = true",
		blockStart,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("config missing %q:\n%s", want, body)
		}
	}
}

func TestEnsureFeaturesHooksTruePreservesHooksEnabled(t *testing.T) {
	content := "[features]\nhooks_enabled = false\n"

	next := EnsureFeaturesHooksTrue(content)
	if !strings.Contains(next, "hooks_enabled = false") {
		t.Fatalf("hooks_enabled should be preserved:\n%s", next)
	}
	if !strings.Contains(next, "hooks = true") {
		t.Fatalf("hooks = true should be added:\n%s", next)
	}
}

func TestRemoveHooksRemovesOnlyManagedBlock(t *testing.T) {
	body := `[features]
hooks = true

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "echo user"

# BEGIN clawee-collector codex hooks
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "clawee"
# END clawee-collector codex hooks
`
	next, changed := RemoveHookBlock(body)
	if !changed {
		t.Fatal("changed = false")
	}
	if strings.Contains(next, "clawee") {
		t.Fatalf("managed block remained:\n%s", next)
	}
	if !strings.Contains(next, `command = "echo user"`) {
		t.Fatalf("user hook removed:\n%s", next)
	}
}
