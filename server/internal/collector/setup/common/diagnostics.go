package common

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var (
	collectorTokenKVPattern    = regexp.MustCompile(`(?i)collector_token\s*=\s*[^ \r\n]+`)
	collectorTokenJSONPattern  = regexp.MustCompile(`(?i)"collector_token"\s*:\s*"[^"]*"`)
	collectorTokenCamelPattern = regexp.MustCompile(`(?i)"collectorToken"\s*:\s*"[^"]*"`)
	collectorTokenGoPattern    = regexp.MustCompile(`"CollectorToken"\s*:\s*"[^"]*"|CollectorToken\s*[:=]\s*[^ \r\n,}]+`)
	collectorTokenNamePattern  = regexp.MustCompile(`collector_token|CollectorToken|collectorToken`)
)

type DiagnosticsWriter struct {
	path string
	file *os.File
}

func NewDiagnosticsWriter(dir string, now func() time.Time) (*DiagnosticsWriter, error) {
	if now == nil {
		now = time.Now
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "install-"+now().Format("20060102-150405")+".log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &DiagnosticsWriter{path: path, file: file}, nil
}

func (w *DiagnosticsWriter) Path() string {
	if w == nil {
		return ""
	}
	return w.path
}

func (w *DiagnosticsWriter) Step(name string, message string) {
	if w == nil || w.file == nil {
		return
	}
	_, _ = fmt.Fprintf(w.file, "[%s] %s\n", name, RedactSensitive(message))
}

func (w *DiagnosticsWriter) Close() error {
	if w == nil || w.file == nil {
		return nil
	}
	return w.file.Close()
}

func RedactSensitive(value string) string {
	value = collectorTokenKVPattern.ReplaceAllString(value, "collector_token=<redacted>")
	value = collectorTokenJSONPattern.ReplaceAllString(value, `"collector_token":"<redacted>"`)
	value = collectorTokenCamelPattern.ReplaceAllString(value, `"collectorToken":"<redacted>"`)
	value = collectorTokenGoPattern.ReplaceAllStringFunc(value, func(match string) string {
		if len(match) > 0 && match[0] == '"' {
			return `"CollectorToken":"<redacted>"`
		}
		return "CollectorToken=<redacted>"
	})
	value = collectorTokenNamePattern.ReplaceAllString(value, "<redacted_token_field>")
	return value
}
