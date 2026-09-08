package businessdata

import "time"

const (
	ProviderXiaohongshu = "xiaohongshu"
	ProviderDouyinAds   = "douyin_ads"
	ProviderBilibili    = "bilibili"

	SourceStatusActive   = "active"
	SourceStatusDisabled = "disabled"

	SyncRunStatusQueued  = "queued"
	SyncRunStatusRunning = "running"
	SyncRunStatusSuccess = "success"
	SyncRunStatusFailed  = "failed"

	DataStatusUnconfigured = "unconfigured"
	DataStatusAvailable    = "available"
	DataStatusPartial      = "partial"
	DataStatusUnavailable  = "unavailable"

	RangeToday  = "today"
	Range7Days  = "7d"
	Range30Days = "30d"

	ViewXiaohongshuOperation = "xiaohongshu_operation"
	ViewDouyinAds            = "douyin_ads"
	ViewBilibiliOperation    = "bilibili_operation"
	Timezone                 = "Asia/Shanghai"
	Currency                 = "CNY"

	BilibiliSyncDisabledCode = "bilibili_sync_disabled"
)

type Source struct {
	SourceID          string
	Provider          string
	ExternalAccountID string
	Name              string
	Status            string
	NextSyncAt        *time.Time
	LastAttemptAt     *time.Time
	LastSuccessAt     *time.Time
	LastErrorCode     string
	LastErrorSummary  string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type SyncRun struct {
	RunID         string
	SourceID      string
	StartDate     time.Time
	EndDate       time.Time
	Status        string
	FetchedCount  int64
	UpsertedCount int64
	ErrorCode     string
	ErrorSummary  string
	StartedAt     *time.Time
	FinishedAt    *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type SyncRequestResult struct {
	SourceCount int
	QueuedCount int
}

type BilibiliSourceItem struct {
	SourceID        string     `json:"source_id"`
	Name            string     `json:"name"`
	Status          string     `json:"status"`
	StatusReason    string     `json:"status_reason"`
	LastAttemptAt   *time.Time `json:"last_attempt_at"`
	LastSuccessAt   *time.Time `json:"last_success_at"`
	NextSyncAt      *time.Time `json:"next_sync_at"`
	ActiveRunStatus string     `json:"active_run_status"`
}

type BilibiliSourceChange struct {
	Source      BilibiliSourceItem
	QueuedCount int
}

type PullRequest struct {
	SourceID  string
	StartDate time.Time
	EndDate   time.Time
}

type Content struct {
	ExternalContentID string
	Title             string
	ContentType       string
	Status            string
	PublishedAt       *time.Time
}

type ContentDailyMetric struct {
	ExternalContentID string
	StatDate          time.Time
	ExposureCount     int64
	LikeCount         int64
	FavoriteCount     int64
	CommentCount      int64
	ShareCount        int64
}

type AccountDailyMetric struct {
	StatDate         time.Time
	NewFollowerCount int64
}

type Campaign struct {
	ExternalCampaignID string
	Name               string
	CampaignType       string
	Status             string
}

type CampaignDailyMetric struct {
	ExternalCampaignID string
	StatDate           time.Time
	SpendMinor         int64
	ImpressionCount    int64
	VideoPlayCount     int64
	ClickCount         int64
}

type BilibiliAccountSnapshot struct {
	SnapshotDate   time.Time
	CapturedAt     time.Time
	FollowerCount  int64
	FollowingCount int64
	PublishedCount int64
}

type BilibiliContentSnapshot struct {
	ExternalContentID string
	SnapshotDate      time.Time
	CapturedAt        time.Time
	ViewCount         int64
	DanmakuCount      int64
	ReplyCount        int64
	FavoriteCount     int64
	CoinCount         int64
	ShareCount        int64
	LikeCount         int64
}

type Batch struct {
	SourceName               string
	Contents                 []Content
	ContentDailyMetrics      []ContentDailyMetric
	AccountDailyMetrics      []AccountDailyMetric
	Campaigns                []Campaign
	CampaignDailyMetrics     []CampaignDailyMetric
	BilibiliAccountSnapshots []BilibiliAccountSnapshot
	BilibiliContentSnapshots []BilibiliContentSnapshot
}

type DashboardRange struct {
	Name          string
	StartDate     time.Time
	EndDate       time.Time
	PreviousStart time.Time
	PreviousEnd   time.Time
}

type DashboardState struct {
	DataStatus       string
	LastSyncedAt     *time.Time
	UnavailableParts []string
}

type XiaohongshuSummary struct {
	PublishedCount             int64    `json:"published_count"`
	PublishedCountChangeRate   *float64 `json:"published_count_change_rate"`
	ExposureCount              int64    `json:"exposure_count"`
	ExposureCountChangeRate    *float64 `json:"exposure_count_change_rate"`
	InteractionCount           int64    `json:"interaction_count"`
	InteractionCountChangeRate *float64 `json:"interaction_count_change_rate"`
	NewFollowerCount           int64    `json:"new_follower_count"`
	NewFollowerCountChangeRate *float64 `json:"new_follower_count_change_rate"`
	ConversionCount            *int64   `json:"conversion_count"`
	ConversionRate             *float64 `json:"conversion_rate"`
}

type XiaohongshuTrendPoint struct {
	Date             string `json:"date"`
	ExposureCount    int64  `json:"exposure_count"`
	InteractionCount int64  `json:"interaction_count"`
}

type XiaohongshuTopItem struct {
	ExternalContentID string   `json:"external_content_id"`
	Title             string   `json:"title"`
	ContentType       string   `json:"content_type"`
	ExposureCount     int64    `json:"exposure_count"`
	InteractionCount  int64    `json:"interaction_count"`
	InteractionRate   *float64 `json:"interaction_rate"`
}

type XiaohongshuDashboardData struct {
	State    DashboardState
	Summary  XiaohongshuSummary
	Previous XiaohongshuSummary
	Trend    []XiaohongshuTrendPoint
	TopItems []XiaohongshuTopItem
}

type DouyinAdsSummary struct {
	SpendMinor               int64    `json:"spend_minor"`
	SpendChangeRate          *float64 `json:"spend_change_rate"`
	VideoPlayCount           int64    `json:"video_play_count"`
	VideoPlayCountChangeRate *float64 `json:"video_play_count_change_rate"`
	ConversionCount          *int64   `json:"conversion_count"`
	AttributedRevenueMinor   *int64   `json:"attributed_revenue_minor"`
	ROI                      *float64 `json:"roi"`
	Currency                 string   `json:"currency"`
}

type DouyinAdsTrendPoint struct {
	Date           string `json:"date"`
	SpendMinor     int64  `json:"spend_minor"`
	VideoPlayCount int64  `json:"video_play_count"`
}

type DouyinAdsTopItem struct {
	ExternalCampaignID string `json:"external_campaign_id"`
	Name               string `json:"name"`
	CampaignType       string `json:"campaign_type"`
	SpendMinor         int64  `json:"spend_minor"`
	ImpressionCount    int64  `json:"impression_count"`
	VideoPlayCount     int64  `json:"video_play_count"`
	ClickCount         int64  `json:"click_count"`
	Currency           string `json:"currency"`
}

type DouyinAdsDashboardData struct {
	State    DashboardState
	Summary  DouyinAdsSummary
	Previous DouyinAdsSummary
	Trend    []DouyinAdsTrendPoint
	TopItems []DouyinAdsTopItem
}

type BilibiliTopContent struct {
	SourceID          string    `json:"source_id"`
	AccountName       string    `json:"account_name"`
	ExternalContentID string    `json:"external_content_id"`
	Title             string    `json:"title"`
	CapturedAt        time.Time `json:"captured_at"`
	ViewCount         int64     `json:"view_count"`
	InteractionCount  int64     `json:"interaction_count"`
}

type BilibiliDashboardAccount struct {
	SourceID      string     `json:"source_id"`
	Name          string     `json:"name"`
	Status        string     `json:"status"`
	StatusReason  string     `json:"status_reason"`
	LastSuccessAt *time.Time `json:"last_success_at"`
}

type BilibiliTrendPoint struct {
	Date                  string `json:"date"`
	FollowerCount         int64  `json:"follower_count"`
	ViewCount             int64  `json:"view_count"`
	InteractionCount      int64  `json:"interaction_count"`
	FollowerCountDelta    int64  `json:"follower_count_delta"`
	ViewCountDelta        int64  `json:"view_count_delta"`
	InteractionCountDelta int64  `json:"interaction_count_delta"`
}

type BilibiliDashboardData struct {
	State                 DashboardState
	Account               BilibiliDashboardAccount
	CapturedAt            time.Time
	FollowerCount         int64
	CollectedContentCount int64
	ViewCount             int64
	InteractionCount      int64
	Trend                 []BilibiliTrendPoint
	TopContents           []BilibiliTopContent
}

type CompareRequest struct {
	ViewID    string
	SourceID  string
	Range     string
	MetricIDs []string
}

type MetricComparison struct {
	MetricID       string   `json:"metric_id"`
	CurrentValue   int64    `json:"current_value"`
	PreviousValue  int64    `json:"previous_value"`
	AbsoluteChange int64    `json:"absolute_change"`
	ChangeRate     *float64 `json:"change_rate"`
	Unit           string   `json:"unit"`
}

type CompareResponse struct {
	ViewID            string                    `json:"view_id"`
	Account           *BilibiliDashboardAccount `json:"account,omitempty"`
	DataStatus        string                    `json:"data_status"`
	Range             string                    `json:"range"`
	Timezone          string                    `json:"timezone"`
	StartDate         string                    `json:"start_date"`
	EndDate           string                    `json:"end_date"`
	PreviousStartDate string                    `json:"previous_start_date"`
	PreviousEndDate   string                    `json:"previous_end_date"`
	GeneratedAt       time.Time                 `json:"generated_at"`
	LastSyncedAt      *time.Time                `json:"last_synced_at"`
	Metrics           []MetricComparison        `json:"metrics"`
	UnavailableParts  []string                  `json:"unavailable_parts"`
}

type MetricDefinition struct {
	MetricID        string `json:"metric_id"`
	Label           string `json:"label"`
	Description     string `json:"description"`
	Unit            string `json:"unit"`
	Aggregation     string `json:"aggregation"`
	DataSource      string `json:"data_source"`
	TimeScope       string `json:"time_scope"`
	ValueType       string `json:"value_type"`
	MissingDataRule string `json:"missing_data_rule"`
	Comparable      bool   `json:"comparable"`
}

func (b Batch) RecordCount() int64 {
	return int64(len(b.Contents) + len(b.ContentDailyMetrics) + len(b.AccountDailyMetrics) + len(b.Campaigns) + len(b.CampaignDailyMetrics) + len(b.BilibiliAccountSnapshots) + len(b.BilibiliContentSnapshots))
}
