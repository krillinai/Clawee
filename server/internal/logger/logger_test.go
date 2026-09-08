package logger

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func TestNewBuildsDebugLogger(t *testing.T) {
	log, err := New(Options{Level: "debug", Format: "json", Output: "stdout"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer log.Sync()

	if !log.Core().Enabled(zapcore.DebugLevel) {
		t.Fatal("debug logger does not enable debug level")
	}
}

func TestNewRejectsUnsupportedFormat(t *testing.T) {
	_, err := New(Options{Level: "info", Format: "xml", Output: "stdout"})
	if err == nil {
		t.Fatal("New() error = nil, want unsupported format error")
	}
}

func TestNewRejectsUnsupportedOutput(t *testing.T) {
	_, err := New(Options{Level: "info", Format: "json", Output: "/tmp/app.log"})
	if err == nil {
		t.Fatal("New() error = nil, want unsupported output error")
	}
}

func TestNewEncodesLogTimeInBeijingTimezone(t *testing.T) {
	var out bytes.Buffer
	cfg := zap.NewProductionEncoderConfig()
	applyBeijingTimeEncoder(&cfg)
	core := zapcore.NewCore(zapcore.NewJSONEncoder(cfg), zapcore.AddSync(&out), zapcore.InfoLevel)
	log := zap.New(core)

	log.Info("timezone check", zap.Time("event_time", time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC)))

	got := out.String()
	if !strings.Contains(got, `"ts":"`) || !strings.Contains(got, `+08:00`) {
		t.Fatalf("expected logger timestamp to include +08:00, got %q", got)
	}
	if !strings.Contains(got, `"event_time":"2026-05-27T20:00:00.000+08:00"`) {
		t.Fatalf("expected zap time field to be encoded in Beijing timezone, got %q", got)
	}
}
