package codexconfig

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
)

const (
	blockStart = "# BEGIN clawee-collector codex hooks"
	blockEnd   = "# END clawee-collector codex hooks"
)

type EnsureOptions struct {
	CodexConfigPath     string
	CollectorConfigPath string
	BinaryPath          string
}

type EnsureResult struct {
	CodexConfigPath string
	Changed         bool
	HookCommand     string
}

type HookEvent struct {
	Name          string
	Matcher       string
	StatusMessage string
}

func DefaultCodexConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex", "config.toml"), nil
}

func DefaultHookEvents() []HookEvent {
	return []HookEvent{
		{Name: "SessionStart", Matcher: "startup|resume|clear|compact", StatusMessage: "向 Clawee Gateway 上报会话启动事件"},
		{Name: "UserPromptSubmit", StatusMessage: "向 Clawee Gateway 上报用户输入事件"},
		{Name: "PreToolUse", StatusMessage: "向 Clawee Gateway 上报工具开始事件"},
		{Name: "PostToolUse", StatusMessage: "向 Clawee Gateway 上报工具完成事件"},
		{Name: "PermissionRequest", StatusMessage: "向 Clawee Gateway 上报权限请求事件"},
		{Name: "SubagentStart", StatusMessage: "向 Clawee Gateway 上报子代理启动事件"},
		{Name: "SubagentStop", StatusMessage: "向 Clawee Gateway 上报子代理停止事件"},
		{Name: "Stop", StatusMessage: "向 Clawee Gateway 上报当前轮次结束事件"},
	}
}

func EnsureHooks(options EnsureOptions) (EnsureResult, error) {
	codexConfigPath, err := resolveCodexConfigPath(options.CodexConfigPath)
	if err != nil {
		return EnsureResult{}, err
	}

	parentDir := filepath.Dir(codexConfigPath)
	stat, err := os.Stat(parentDir)
	if err != nil {
		if os.IsNotExist(err) {
			return EnsureResult{}, fmt.Errorf("Codex 配置目录不存在: %s；请先启动 Codex 或通过 --codex-config 指定真实的 Codex 配置文件", parentDir)
		}
		return EnsureResult{}, err
	}
	if !stat.IsDir() {
		return EnsureResult{}, fmt.Errorf("Codex 配置文件的父路径不是目录: %s", parentDir)
	}

	binaryPath := options.BinaryPath
	if strings.TrimSpace(binaryPath) == "" {
		binaryPath, err = os.Executable()
		if err != nil {
			return EnsureResult{}, err
		}
	}
	hookCommand, err := BuildHookCommand(binaryPath, options.CollectorConfigPath)
	if err != nil {
		return EnsureResult{}, err
	}

	currentBytes, err := os.ReadFile(codexConfigPath)
	if err != nil && !os.IsNotExist(err) {
		return EnsureResult{}, err
	}

	next := EnsureFeaturesHooksTrue(string(currentBytes))
	next = EnsureHookBlock(next, BuildHookBlock(hookCommand))
	if next == string(currentBytes) {
		return EnsureResult{
			CodexConfigPath: codexConfigPath,
			Changed:         false,
			HookCommand:     hookCommand,
		}, nil
	}

	tmpPath := codexConfigPath + ".tmp"
	if err := os.WriteFile(tmpPath, []byte(next), 0o644); err != nil {
		return EnsureResult{}, err
	}
	if err := os.Rename(tmpPath, codexConfigPath); err != nil {
		_ = os.Remove(tmpPath)
		return EnsureResult{}, err
	}

	return EnsureResult{
		CodexConfigPath: codexConfigPath,
		Changed:         true,
		HookCommand:     hookCommand,
	}, nil
}

func RemoveHooks(codexConfigPath string) (bool, error) {
	currentBytes, err := os.ReadFile(codexConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	next, changed := RemoveHookBlock(string(currentBytes))
	if !changed {
		return false, nil
	}
	tmpPath := codexConfigPath + ".tmp"
	if err := os.WriteFile(tmpPath, []byte(next), 0o644); err != nil {
		return false, err
	}
	if err := os.Rename(tmpPath, codexConfigPath); err != nil {
		_ = os.Remove(tmpPath)
		return false, err
	}
	return true, nil
}

func RemoveHookBlock(content string) (string, bool) {
	start := strings.Index(content, blockStart)
	end := strings.Index(content, blockEnd)
	if start < 0 || end < start {
		return content, false
	}
	end += len(blockEnd)
	next := strings.TrimRight(content[:start], "\n") + "\n" + strings.TrimLeft(content[end:], "\n")
	return next, true
}

func BuildHookCommand(binaryPath string, collectorConfigPath string) (string, error) {
	if strings.TrimSpace(binaryPath) == "" {
		return "", errors.New("必须提供采集器二进制路径")
	}

	command := shellDoubleQuote(binaryPath) + " hook codex"
	includeConfig, err := shouldIncludeCollectorConfig(collectorConfigPath)
	if err != nil {
		return "", err
	}
	if includeConfig {
		command += " --config " + shellDoubleQuote(collectorConfigPath)
	}
	return command, nil
}

func BuildHookBlock(command string) string {
	windowsCommand := windowsCommandFromShellCommand(command)
	var b strings.Builder
	b.WriteString(blockStart)
	b.WriteString("\n")
	for idx, event := range DefaultHookEvents() {
		if idx > 0 {
			b.WriteString("\n")
		}
		b.WriteString("[[hooks.")
		b.WriteString(event.Name)
		b.WriteString("]]\n")
		if event.Matcher != "" {
			b.WriteString("matcher = ")
			b.WriteString(tomlString(event.Matcher))
			b.WriteString("\n")
		}
		b.WriteString("[[hooks.")
		b.WriteString(event.Name)
		b.WriteString(".hooks]]\n")
		b.WriteString("type = \"command\"\n")
		b.WriteString("command = ")
		b.WriteString(tomlString(command))
		b.WriteString("\n")
		if windowsCommand != "" {
			b.WriteString("command_windows = ")
			b.WriteString(tomlString(windowsCommand))
			b.WriteString("\n")
		}
		b.WriteString("timeout = 2\n")
		b.WriteString("statusMessage = ")
		b.WriteString(tomlString(event.StatusMessage))
		b.WriteString("\n")
	}
	b.WriteString(blockEnd)
	b.WriteString("\n")
	return b.String()
}

func EnsureHookBlock(content string, block string) string {
	start := strings.Index(content, blockStart)
	end := strings.Index(content, blockEnd)
	if start >= 0 && end >= start {
		end += len(blockEnd)
		next := content[:start] + strings.TrimRight(block, "\n") + content[end:]
		if !strings.HasSuffix(next, "\n") {
			next += "\n"
		}
		return next
	}

	trimmed := strings.TrimRight(content, "\n")
	if trimmed == "" {
		return block
	}
	return trimmed + "\n\n" + block
}

func EnsureFeaturesHooksTrue(content string) string {
	lines := strings.Split(content, "\n")
	featuresIndex := -1
	nextSectionIndex := len(lines)

	for idx, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "[features]" {
			featuresIndex = idx
			continue
		}
		if featuresIndex >= 0 && idx > featuresIndex && strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			nextSectionIndex = idx
			break
		}
	}

	if featuresIndex < 0 {
		trimmed := strings.TrimRight(content, "\n")
		if trimmed == "" {
			return "[features]\nhooks = true\n"
		}
		return trimmed + "\n\n[features]\nhooks = true\n"
	}

	for idx := featuresIndex + 1; idx < nextSectionIndex; idx++ {
		trimmed := strings.TrimSpace(lines[idx])
		if isHooksKey(trimmed) {
			lines[idx] = "hooks = true"
			return strings.Join(lines, "\n")
		}
	}

	nextLines := append([]string{}, lines[:nextSectionIndex]...)
	nextLines = append(nextLines, "hooks = true")
	nextLines = append(nextLines, lines[nextSectionIndex:]...)
	return strings.Join(nextLines, "\n")
}

func resolveCodexConfigPath(path string) (string, error) {
	if path != "" {
		return path, nil
	}
	return DefaultCodexConfigPath()
}

func isHooksKey(trimmed string) bool {
	if !strings.HasPrefix(trimmed, "hooks") {
		return false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "hooks"))
	return rest == "" || strings.HasPrefix(rest, "=")
}

func shouldIncludeCollectorConfig(path string) (bool, error) {
	if path == "" {
		return false, nil
	}

	defaultPath, err := collectorconfig.DefaultPath()
	if err != nil {
		return false, err
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false, err
	}
	absDefault, err := filepath.Abs(defaultPath)
	if err != nil {
		return false, err
	}
	return absPath != absDefault, nil
}

func shellDoubleQuote(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	value = strings.ReplaceAll(value, "$", `\$`)
	value = strings.ReplaceAll(value, "`", "\\`")
	return `"` + value + `"`
}

func windowsCommandFromShellCommand(command string) string {
	tokens := splitShellCommand(command)
	if len(tokens) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("& ")
	b.WriteString(powerShellSingleQuote(tokens[0].value))
	for _, token := range tokens[1:] {
		b.WriteByte(' ')
		if token.quoted || strings.ContainsAny(token.value, " \t'") {
			b.WriteString(powerShellSingleQuote(token.value))
			continue
		}
		b.WriteString(token.value)
	}
	return b.String()
}

type shellToken struct {
	value  string
	quoted bool
}

func splitShellCommand(command string) []shellToken {
	var tokens []shellToken
	for idx := 0; idx < len(command); {
		for idx < len(command) && (command[idx] == ' ' || command[idx] == '\t') {
			idx++
		}
		if idx >= len(command) {
			break
		}
		if command[idx] == '"' {
			value, next := readDoubleQuotedToken(command, idx+1)
			tokens = append(tokens, shellToken{value: value, quoted: true})
			idx = next
			continue
		}
		start := idx
		for idx < len(command) && command[idx] != ' ' && command[idx] != '\t' {
			idx++
		}
		tokens = append(tokens, shellToken{value: command[start:idx]})
	}
	return tokens
}

func readDoubleQuotedToken(command string, idx int) (string, int) {
	var b strings.Builder
	for idx < len(command) {
		ch := command[idx]
		if ch == '"' {
			return b.String(), idx + 1
		}
		if ch == '\\' && idx+1 < len(command) {
			idx++
			b.WriteByte(command[idx])
			idx++
			continue
		}
		b.WriteByte(ch)
		idx++
	}
	return b.String(), idx
}

func powerShellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func tomlString(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return `"` + value + `"`
}
