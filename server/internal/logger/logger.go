package logger

import (
	"fmt"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

type Options struct {
	Level  string
	Format string
	Output string
}

func New(opts Options) (*zap.Logger, error) {
	cfg := zap.NewProductionConfig()
	applyBeijingTimeEncoder(&cfg.EncoderConfig)

	switch opts.Level {
	case "", "info":
		cfg.Level = zap.NewAtomicLevelAt(zap.InfoLevel)
	case "debug":
		cfg.Level = zap.NewAtomicLevelAt(zap.DebugLevel)
	case "warn":
		cfg.Level = zap.NewAtomicLevelAt(zap.WarnLevel)
	case "error":
		cfg.Level = zap.NewAtomicLevelAt(zap.ErrorLevel)
	default:
		return nil, fmt.Errorf("unsupported logging level: %s", opts.Level)
	}

	switch opts.Format {
	case "", "json":
		cfg.Encoding = "json"
	case "console":
		cfg.Encoding = "console"
		cfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	default:
		return nil, fmt.Errorf("unsupported logging format: %s", opts.Format)
	}

	switch opts.Output {
	case "", "stdout":
		cfg.OutputPaths = []string{"stdout"}
		cfg.ErrorOutputPaths = []string{"stderr"}
	case "stderr":
		cfg.OutputPaths = []string{"stderr"}
		cfg.ErrorOutputPaths = []string{"stderr"}
	default:
		return nil, fmt.Errorf("unsupported logging output: %s", opts.Output)
	}

	return cfg.Build()
}

func applyBeijingTimeEncoder(cfg *zapcore.EncoderConfig) {
	cfg.EncodeTime = func(t time.Time, enc zapcore.PrimitiveArrayEncoder) {
		enc.AppendString(t.In(beijingLocation()).Format("2006-01-02T15:04:05.000-07:00"))
	}
}

func beijingLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return location
}
