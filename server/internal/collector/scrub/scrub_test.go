package scrub

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestKeepMetadataKeepsAllowedKeysAndScrubsSensitiveValues(t *testing.T) {
	input := map[string]any{
		"agent":          "codex",
		"cwd":            "/workspace/claw-mcp",
		"workspace_path": "/workspace/claw-mcp",
		"status":         "coding",
		"prompt":         "secret prompt",
		"tool_input":     "secret input",
		"tool_response":  "secret response",
		"token":          "secret token",
	}

	got := KeepMetadata(input, []string{
		"agent",
		"cwd",
		"workspace_path",
		"status",
	})

	want := map[string]string{
		"agent":          "codex",
		"cwd":            "claw-mcp",
		"workspace_path": "claw-mcp",
		"status":         "coding",
	}

	if len(got) != len(want) {
		t.Fatalf("KeepMetadata returned %d keys, want %d: %#v", len(got), len(want), got)
	}
	for key, wantValue := range want {
		if got[key] != wantValue {
			t.Fatalf("KeepMetadata[%q] = %q, want %q", key, got[key], wantValue)
		}
	}
	for _, key := range []string{"prompt", "tool_input", "tool_response", "token"} {
		if _, ok := got[key]; ok {
			t.Fatalf("KeepMetadata kept sensitive key %q", key)
		}
	}
}

func TestLimitTextTruncatesToMaxCharacters(t *testing.T) {
	got := LimitText("abcdefghijklmnopqrstuvwxyz", 10)
	if got != "abcdefghij" {
		t.Fatalf("LimitText() = %q, want %q", got, "abcdefghij")
	}
}

func TestLimitTextTruncatesChineseWithoutBreakingUTF8(t *testing.T) {
	got := LimitText(strings.Repeat("中", DefaultTextLimit+1), DefaultTextLimit)
	if utf8.RuneCountInString(got) != DefaultTextLimit {
		t.Fatalf("LimitText() returned %d runes, want %d", utf8.RuneCountInString(got), DefaultTextLimit)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("LimitText() returned invalid UTF-8: %q", got)
	}
}

func TestWorkspaceNameFromPathReturnsBasename(t *testing.T) {
	got := WorkspaceNameFromPath("/workspace/claw-mcp")
	if got != "claw-mcp" {
		t.Fatalf("WorkspaceNameFromPath() = %q, want %q", got, "claw-mcp")
	}
}
