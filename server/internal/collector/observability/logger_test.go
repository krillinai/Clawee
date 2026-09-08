package observability

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

var ansiSequence = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestLoggerPrintsColoredOutputWhenColorEnabled(t *testing.T) {
	var out bytes.Buffer
	logger := NewLogger(Config{Output: &out, Debug: true, Color: true})

	logger.Debug("collector ready", "listen", "127.0.0.1:1905")

	got := out.String()
	if !strings.Contains(got, "\x1b[") {
		t.Fatalf("expected ANSI sequence in output, got %q", got)
	}
	if !strings.Contains(got, "collector ready") {
		t.Fatalf("expected message in output, got %q", got)
	}
	if !strings.Contains(ansiSequence.ReplaceAllString(got, ""), "listen=127.0.0.1:1905") {
		t.Fatalf("expected listen attr in output, got %q", got)
	}
}

func TestLoggerOmitsColorWhenColorDisabled(t *testing.T) {
	var out bytes.Buffer
	logger := NewLogger(Config{Output: &out, Debug: true, Color: false})

	logger.Info("collector ready", "listen", "127.0.0.1:1905")

	got := out.String()
	if strings.Contains(got, "\x1b[") {
		t.Fatalf("expected no ANSI sequence in output, got %q", got)
	}
	if !strings.Contains(got, "collector ready") {
		t.Fatalf("expected message in output, got %q", got)
	}
}

func TestLoggerPrintsBeijingTimezoneOffset(t *testing.T) {
	var out bytes.Buffer
	logger := NewLogger(Config{Output: &out, Debug: true, Color: false})

	logger.Info("timezone check")

	got := out.String()
	if !strings.Contains(got, "+08:00") {
		t.Fatalf("expected Beijing timezone offset in output, got %q", got)
	}
}

func TestLoggerSuppressesDebugWhenDisabled(t *testing.T) {
	var out bytes.Buffer
	logger := NewLogger(Config{Output: &out, Debug: false, Color: false})

	logger.Debug("hidden", "key", "value")
	logger.Info("visible")

	got := out.String()
	if strings.Contains(got, "hidden") {
		t.Fatalf("expected debug log to be suppressed, got %q", got)
	}
	if !strings.Contains(got, "visible") {
		t.Fatalf("expected info log in output, got %q", got)
	}
}

func TestNewRequestLoggerWritesToCollectorRequestLogFile(t *testing.T) {
	dir := t.TempDir()

	logger, closer, err := NewRequestLogger(dir, Config{Debug: true, Color: true})
	if err != nil {
		t.Fatal(err)
	}
	defer closer.Close()

	logger.Info("collector request", "endpoint", "/api/v1/collector/events")

	got, err := os.ReadFile(filepath.Join(dir, "collector-requests.log"))
	if err != nil {
		t.Fatal(err)
	}
	output := string(got)
	if strings.Contains(output, "\x1b[") {
		t.Fatalf("expected request log file to omit color, got %q", output)
	}
	if !strings.Contains(output, "collector request") || !strings.Contains(output, "endpoint=/api/v1/collector/events") {
		t.Fatalf("expected request log content, got %q", output)
	}
}

func TestReplaceLevelAttrOnlyOverridesDebugLevel(t *testing.T) {
	customLowLevelAttr := slog.Any(slog.LevelKey, slog.LevelDebug+1)

	if got := replaceLevelAttr(nil, customLowLevelAttr); !reflect.DeepEqual(got, customLowLevelAttr) {
		t.Fatalf("expected custom low level attr to remain unchanged, got %#v", got)
	}

	debugLevelAttr := slog.Any(slog.LevelKey, slog.LevelDebug)
	if got := replaceLevelAttr(nil, debugLevelAttr); reflect.DeepEqual(got, debugLevelAttr) {
		t.Fatalf("expected debug level attr to be overridden")
	}
}

func TestLogRawIngestPrettyPrintsJSONInDebugMode(t *testing.T) {
	var out bytes.Buffer
	logger := NewLogger(Config{Output: &out, Debug: true, Color: false})

	logger.RawIngest("codex", "/ingest/codex", []byte(`{"hook_event_name":"PreToolUse","tool_input":{"command":"echo secret"}}`))

	got := out.String()
	for _, want := range []string{
		"incoming hook",
		"agent_type=codex",
		"path=/ingest/codex",
		"raw_hook_json=",
		`"hook_event_name": "PreToolUse"`,
		`"command": "echo secret"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected output to contain %q, got %q", want, got)
		}
	}
}

func TestLogRawIngestKeepsRawJSONDetails(t *testing.T) {
	var out bytes.Buffer
	logger := NewLogger(Config{Output: &out, Debug: true, Color: false})

	logger.RawIngest("codex", "/ingest/codex", []byte(`{"dup":"first","dup":"second","big":12345678901234567890}`))

	got := out.String()
	for _, want := range []string{
		`"dup": "first"`,
		`"dup": "second"`,
		`"big": 12345678901234567890`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected output to contain %q, got %q", want, got)
		}
	}
}

func TestLogRawIngestPrintsInvalidJSONBodyInDebugMode(t *testing.T) {
	var out bytes.Buffer
	logger := NewLogger(Config{Output: &out, Debug: true, Color: false})

	logger.RawIngest("codex", "/ingest/codex", []byte(`{"hook_event_name":`))

	got := out.String()
	if !strings.Contains(got, "raw_hook_body=") {
		t.Fatalf("expected raw hook body marker, got %q", got)
	}
	if !strings.Contains(got, `{"hook_event_name":`) {
		t.Fatalf("expected original invalid body, got %q", got)
	}
}

func TestLogRawIngestSuppressesBodyWhenDebugDisabled(t *testing.T) {
	var out bytes.Buffer
	logger := NewLogger(Config{Output: &out, Debug: false, Color: false})

	logger.RawIngest("codex", "/ingest/codex", []byte(`{"hook_event_name":"PreToolUse"}`))

	if got := out.String(); got != "" {
		t.Fatalf("expected no output, got %q", got)
	}
}
