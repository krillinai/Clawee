package observability

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/lmittmann/tint"
)

type RawIngestLogger interface {
	RawIngest(agentType string, path string, body []byte)
}

const requestLogFileName = "collector-requests.log"

type Config struct {
	Output io.Writer
	Debug  bool
	Color  bool
}

type Logger struct {
	output io.Writer
	debug  bool
	logger *slog.Logger
	mu     sync.Mutex
}

func NewLogger(cfg Config) *Logger {
	out := cfg.Output
	if out == nil {
		out = os.Stderr
	}

	level := slog.LevelInfo
	if cfg.Debug {
		level = slog.LevelDebug
	}

	handler := tint.NewHandler(out, &tint.Options{
		Level:       level,
		NoColor:     !cfg.Color,
		TimeFormat:  "2006-01-02 15:04:05 -07:00",
		ReplaceAttr: replaceLevelAttr,
	})

	return &Logger{
		output: out,
		debug:  cfg.Debug,
		logger: slog.New(handler),
	}
}

func NewRequestLogger(dir string, cfg Config) (*Logger, io.Closer, error) {
	if dir == "" {
		return NewLogger(cfg), nil, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, err
	}
	file, err := os.OpenFile(filepath.Join(dir, requestLogFileName), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, nil, err
	}
	cfg.Output = file
	cfg.Color = false
	return NewLogger(cfg), file, nil
}

func replaceLevelAttr(groups []string, attr slog.Attr) slog.Attr {
	if len(groups) == 0 && attr.Key == slog.TimeKey {
		if value, ok := attr.Value.Any().(time.Time); ok {
			return slog.Time(slog.TimeKey, value.In(beijingLocation()))
		}
	}
	if len(groups) == 0 && attr.Key == slog.LevelKey {
		if level, ok := attr.Value.Any().(slog.Level); ok && level == slog.LevelDebug {
			return tint.Attr(6, attr)
		}
	}
	return attr
}

func beijingLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return location
}

func (l *Logger) Debug(message string, attrs ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.logger.Debug(message, attrs...)
}

func (l *Logger) Info(message string, attrs ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.logger.Info(message, attrs...)
}

func (l *Logger) Warn(message string, attrs ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.logger.Warn(message, attrs...)
}

func (l *Logger) Error(message string, attrs ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.logger.Error(message, attrs...)
}

func (l *Logger) RawIngest(agentType string, path string, body []byte) {
	if !l.debug {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	l.logger.Debug("incoming hook", "agent_type", agentType, "path", path, "bytes", len(body))

	var pretty bytes.Buffer
	if err := json.Indent(&pretty, body, "", "  "); err != nil {
		l.writeRawBody(body)
		return
	}

	_, _ = l.output.Write([]byte("raw_hook_json=\n"))
	_, _ = l.output.Write(pretty.Bytes())
	_, _ = l.output.Write([]byte("\n"))
}

func (l *Logger) writeRawBody(body []byte) {
	_, _ = l.output.Write([]byte("raw_hook_body=\n"))
	_, _ = l.output.Write(body)
	_, _ = l.output.Write([]byte("\n"))
}
