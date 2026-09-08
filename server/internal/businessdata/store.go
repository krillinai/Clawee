package businessdata

import (
	"context"
	"errors"
	"time"
)

var (
	ErrInvalidRequest                      = errors.New("invalid business data request")
	ErrNotFound                            = errors.New("business data not found")
	ErrInvalidBatch                        = errors.New("invalid business data batch")
	ErrBilibiliOAuthStateUnavailable       = errors.New("bilibili OAuth state store unavailable")
	ErrBilibiliReauthRequired              = errors.New("bilibili reauthorization required")
	ErrBilibiliRateLimited                 = errors.New("bilibili rate limited")
	ErrBilibiliContentMissing              = errors.New("bilibili content missing")
	ErrBilibiliSourceDisabled              = errors.New("bilibili source is disabled")
	ErrBilibiliSourceAuthorizationRequired = errors.New("bilibili source authorization is required")
	ErrMetricNotSupported                  = errors.New("business metric not supported")
)

type SourceStore interface {
	GetSource(context.Context, string) (Source, error)
}

type SyncRunStore interface {
	QueueDueRuns(context.Context, time.Time, int) (int, error)
	QueueProviderRuns(context.Context, string, time.Time) (SyncRequestResult, error)
	ClaimNextRun(context.Context, time.Time) (SyncRun, bool, error)
	CompleteRun(context.Context, SyncRun) error
	RecoverRunningRuns(context.Context, time.Time) error
}

type MetricStore interface {
	UpsertBatch(context.Context, string, string, Batch, time.Time) (int64, error)
}

type DashboardStore interface {
	XiaohongshuDashboard(context.Context, DashboardRange) (XiaohongshuDashboardData, error)
	DouyinAdsDashboard(context.Context, DashboardRange) (DouyinAdsDashboardData, error)
	BilibiliDashboard(context.Context, string, DashboardRange) (BilibiliDashboardData, error)
	BilibiliDashboardOverview(context.Context) (DashboardState, error)
}

type BilibiliSourceManagementStore interface {
	ListBilibiliSources(context.Context) ([]BilibiliSourceItem, error)
	QueueBilibiliSourceRun(context.Context, string, time.Time) (SyncRequestResult, error)
	SetBilibiliSourceSyncEnabled(context.Context, string, bool, time.Time) (BilibiliSourceChange, error)
	DeleteBilibiliSource(context.Context, string) error
}

type Store interface {
	SourceStore
	SyncRunStore
	MetricStore
	DashboardStore
}
