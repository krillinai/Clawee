package common

import (
	"time"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/report"
	"github.com/krillinai/Clawee/server/internal/collector/version"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type HeartbeatReporter interface {
	PostHeartbeat(collectorapi.HeartbeatRequest) error
}

type ConnectionWaiter interface {
	Check(cfg collectorconfig.Config) error
}

type ConnectionChecker struct {
	Reporter HeartbeatReporter
	Now      func() time.Time
}

func NewConnectionChecker(cfg collectorconfig.Config) ConnectionChecker {
	return ConnectionChecker{Reporter: report.NewClient(report.Config{BaseURL: cfg.OfficeURL, CollectorToken: cfg.CollectorToken})}
}

func (c ConnectionChecker) Check(cfg collectorconfig.Config) error {
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	reporter := c.Reporter
	if reporter == nil {
		reporter = report.NewClient(report.Config{BaseURL: cfg.OfficeURL, CollectorToken: cfg.CollectorToken})
	}
	sentAt := now().UTC()
	agent := collectorapi.AgentSummary{
		AgentID:    cfg.AgentID,
		AgentType:  collectorapi.AgentTypeCodex,
		Status:     collectorapi.StatusIdle,
		LastSeenAt: sentAt,
		Metadata:   map[string]string{"privacy_mode": cfg.PrivacyMode},
	}
	return reporter.PostHeartbeat(collectorapi.HeartbeatRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		CollectorID:      cfg.CollectorID,
		DeviceID:         cfg.DeviceID,
		SentAt:           sentAt,
		CollectorVersion: version.CollectorVersion(),
		Agents:           []collectorapi.AgentSummary{agent},
	})
}
