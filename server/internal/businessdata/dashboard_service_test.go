package businessdata

import (
	"context"
	"testing"
	"time"
)

type dashboardFixtureStore struct {
	x         XiaohongshuDashboardData
	d         DouyinAdsDashboardData
	b         BilibiliDashboardData
	bBySource map[string]BilibiliDashboardData
	sourceIDs []string
	bOverview *DashboardState
}

func (s dashboardFixtureStore) XiaohongshuDashboard(context.Context, DashboardRange) (XiaohongshuDashboardData, error) {
	return s.x, nil
}
func (s dashboardFixtureStore) DouyinAdsDashboard(context.Context, DashboardRange) (DouyinAdsDashboardData, error) {
	return s.d, nil
}

func (s dashboardFixtureStore) BilibiliDashboard(_ context.Context, sourceID string, _ DashboardRange) (BilibiliDashboardData, error) {
	if s.bBySource != nil {
		return s.bBySource[sourceID], nil
	}
	return s.b, nil
}
func (s dashboardFixtureStore) BilibiliDashboardOverview(context.Context) (DashboardState, error) {
	if s.bOverview != nil {
		return *s.bOverview, nil
	}
	return s.b.State, nil
}
func (s dashboardFixtureStore) BilibiliViewSourceIDs(context.Context) ([]string, error) {
	if s.sourceIDs != nil {
		return append([]string(nil), s.sourceIDs...), nil
	}
	return []string{"bdsrc_1"}, nil
}

func TestBilibiliDashboardResponseUsesLatestCumulativeContract(t *testing.T) {
	captured := time.Date(2026, 8, 28, 2, 10, 0, 0, time.UTC)
	service := newDashboardService(dashboardFixtureStore{b: BilibiliDashboardData{
		State:   DashboardState{DataStatus: DataStatusAvailable, LastSyncedAt: &captured},
		Account: BilibiliDashboardAccount{SourceID: "bdsrc_1", Name: "账号一", Status: SourceStatusActive, LastSuccessAt: &captured}, CapturedAt: captured,
		FollowerCount: 10, CollectedContentCount: 2, ViewCount: 100, InteractionCount: 20,
		Trend:       []BilibiliTrendPoint{{Date: "2026-08-28", FollowerCount: 10, ViewCount: 100, InteractionCount: 20}},
		TopContents: []BilibiliTopContent{{ExternalContentID: "BV1", CapturedAt: captured, ViewCount: 80}},
	}}, nil)
	response, err := service.Bilibili(context.Background(), "bdsrc_1", Range7Days)
	if err != nil || response.Status != DataStatusAvailable || response.Account.SourceID != "bdsrc_1" || response.Range != Range7Days || response.Data == nil || response.Data.ViewCount != 100 || len(response.Data.TopContents) != 1 || len(response.Data.Trend) != 1 {
		t.Fatalf("response=%#v err=%v", response, err)
	}
	if _, err := service.Bilibili(context.Background(), "", Range7Days); err != ErrInvalidRequest {
		t.Fatalf("empty source error=%v", err)
	}
}

func TestDashboardServiceRangesAndUnconfiguredResponse(t *testing.T) {
	now := time.Date(2026, 8, 14, 3, 0, 0, 0, time.UTC)
	service := newDashboardService(dashboardFixtureStore{x: XiaohongshuDashboardData{State: DashboardState{DataStatus: DataStatusUnconfigured}}}, func() time.Time { return now })
	response, err := service.Xiaohongshu(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if response.Range != Range7Days || response.StartDate != "2026-08-08" || response.EndDate != "2026-08-14" {
		t.Fatalf("unexpected range: %#v", response)
	}
	if response.DataStatus != DataStatusUnconfigured || response.Summary != nil || response.Trend == nil || response.TopItems == nil {
		t.Fatalf("unexpected unconfigured response: %#v", response)
	}
	for requested, start := range map[string]string{RangeToday: "2026-08-14", Range30Days: "2026-07-16"} {
		result, err := service.Xiaohongshu(context.Background(), requested)
		if err != nil || result.StartDate != start {
			t.Fatalf("range %s result=%#v err=%v", requested, result, err)
		}
	}
	if _, err := service.Xiaohongshu(context.Background(), "90d"); err != ErrInvalidRequest {
		t.Fatalf("invalid range error=%v", err)
	}
}

func TestDashboardCalculationsAndMissingDates(t *testing.T) {
	location, _ := time.LoadLocation(Timezone)
	start := time.Date(2026, 8, 12, 0, 0, 0, 0, location)
	r := DashboardRange{StartDate: start, EndDate: start.AddDate(0, 0, 2)}
	trend := fillXiaohongshuTrend(r, map[string]XiaohongshuTrendPoint{
		"2026-08-13": {Date: "2026-08-13", ExposureCount: 10, InteractionCount: 4},
	})
	if len(trend) != 3 || trend[0].ExposureCount != 0 || trend[1].InteractionCount != 4 || trend[2].ExposureCount != 0 {
		t.Fatalf("trend=%#v", trend)
	}
	if changeRate(15, 10) == nil || *changeRate(15, 10) != 0.5 || changeRate(10, 0) != nil {
		t.Fatal("change rate calculation is invalid")
	}
	exposure, interactions := int64(10), int64(4)
	rate := float64(interactions) / float64(exposure)
	if rate != 0.4 {
		t.Fatalf("interaction rate=%v", rate)
	}
}

func TestFillBilibiliTrendCarriesMissingDatesAndComputesDeltas(t *testing.T) {
	location, _ := time.LoadLocation(Timezone)
	start := time.Date(2026, 8, 12, 0, 0, 0, 0, location)
	r := DashboardRange{StartDate: start, EndDate: start.AddDate(0, 0, 2)}
	baseline := BilibiliTrendPoint{FollowerCount: 90, ViewCount: 900, InteractionCount: 50}
	trend := fillBilibiliTrend(r, baseline, map[string]int64{
		"2026-08-13": 100,
	}, map[string]BilibiliTrendPoint{
		"2026-08-13": {ViewCount: 1000, InteractionCount: 60},
	})
	if len(trend) != 3 || trend[0].FollowerCount != 90 || trend[0].FollowerCountDelta != 0 || trend[1].ViewCount != 1000 || trend[1].ViewCountDelta != 100 || trend[2].InteractionCount != 60 || trend[2].InteractionCountDelta != 0 {
		t.Fatalf("trend=%#v", trend)
	}
}

func TestDashboardServiceCompareUsesCurrentAndPreviousAggregates(t *testing.T) {
	service := newDashboardService(dashboardFixtureStore{x: XiaohongshuDashboardData{
		State:   DashboardState{DataStatus: DataStatusAvailable},
		Summary: XiaohongshuSummary{ExposureCount: 150}, Previous: XiaohongshuSummary{ExposureCount: 100},
	}}, func() time.Time { return time.Date(2026, 9, 1, 2, 0, 0, 0, time.UTC) })
	response, err := service.Compare(context.Background(), CompareRequest{ViewID: ViewXiaohongshuOperation, Range: Range7Days, MetricIDs: []string{"exposure_count"}})
	if err != nil {
		t.Fatal(err)
	}
	if response.StartDate != "2026-08-26" || response.PreviousStartDate != "2026-08-19" || len(response.Metrics) != 1 || response.Metrics[0].AbsoluteChange != 50 || response.Metrics[0].ChangeRate == nil || *response.Metrics[0].ChangeRate != 0.5 {
		t.Fatalf("response = %#v", response)
	}
	service = newDashboardService(dashboardFixtureStore{d: DouyinAdsDashboardData{
		State: DashboardState{DataStatus: DataStatusAvailable}, Summary: DouyinAdsSummary{SpendMinor: 10}, Previous: DouyinAdsSummary{},
	}}, nil)
	zeroPrevious, err := service.Compare(context.Background(), CompareRequest{ViewID: ViewDouyinAds, Range: Range7Days, MetricIDs: []string{"spend_minor"}})
	if err != nil || zeroPrevious.Metrics[0].ChangeRate != nil {
		t.Fatalf("zero previous = %#v, error = %v", zeroPrevious, err)
	}
	if _, err := service.Compare(context.Background(), CompareRequest{ViewID: ViewDouyinAds, Range: Range7Days, MetricIDs: []string{"unknown"}}); err != ErrMetricNotSupported {
		t.Fatalf("unsupported metric error = %v", err)
	}
	if _, err := service.Compare(context.Background(), CompareRequest{ViewID: ViewBilibiliOperation, Range: Range7Days, MetricIDs: []string{"collected_content_count"}}); err != ErrMetricNotSupported {
		t.Fatalf("non-comparable metric error = %v", err)
	}
}

func TestBilibiliViewAggregatesAllActiveSources(t *testing.T) {
	now := time.Date(2026, 9, 1, 2, 0, 0, 0, time.UTC)
	state := DashboardState{DataStatus: DataStatusAvailable, LastSyncedAt: &now}
	store := dashboardFixtureStore{
		bOverview: &state,
		sourceIDs: []string{"bili-1", "bili-2"},
		bBySource: map[string]BilibiliDashboardData{
			"bili-1": {
				State: state, Account: BilibiliDashboardAccount{SourceID: "bili-1", Name: "账号一", Status: SourceStatusActive}, CapturedAt: now.Add(-time.Minute),
				FollowerCount: 10, CollectedContentCount: 1, ViewCount: 100, InteractionCount: 10,
				Trend: []BilibiliTrendPoint{{Date: "2026-09-01", FollowerCount: 10, ViewCount: 100, InteractionCount: 10}},
				TopContents: []BilibiliTopContent{
					{SourceID: "bili-1", ExternalContentID: "BV9", ViewCount: 120},
					{SourceID: "bili-1", ExternalContentID: "BV1", ViewCount: 80},
				},
			},
			"bili-2": {
				State: state, Account: BilibiliDashboardAccount{SourceID: "bili-2", Name: "账号二", Status: SourceStatusActive}, CapturedAt: now,
				FollowerCount: 20, CollectedContentCount: 2, ViewCount: 200, InteractionCount: 20,
				Trend:       []BilibiliTrendPoint{{Date: "2026-09-01", FollowerCount: 20, ViewCount: 200, InteractionCount: 20}},
				TopContents: []BilibiliTopContent{{SourceID: "bili-2", ExternalContentID: "BV2", ViewCount: 120}},
			},
		},
	}
	service := newDashboardService(store, func() time.Time { return now })
	response, err := service.BilibiliView(context.Background(), RangeToday)
	if err != nil || response.Status != DataStatusAvailable || response.Data == nil {
		t.Fatalf("response=%#v err=%v", response, err)
	}
	if response.Data.FollowerCount != 30 || response.Data.CollectedContentCount != 3 || response.Data.ViewCount != 300 || response.Data.InteractionCount != 30 {
		t.Fatalf("summary=%#v", response.Data)
	}
	if len(response.Data.Trend) != 1 || response.Data.Trend[0].ViewCount != 300 || len(response.Data.TopContents) != 3 || response.Data.TopContents[0].SourceID != "bili-1" || response.Data.TopContents[1].SourceID != "bili-2" {
		t.Fatalf("aggregated response=%#v", response.Data)
	}
}

func TestBilibiliViewReportsPartialSourcesWithoutDuplicates(t *testing.T) {
	now := time.Date(2026, 9, 1, 2, 0, 0, 0, time.UTC)
	state := DashboardState{DataStatus: DataStatusPartial, LastSyncedAt: &now, UnavailableParts: []string{"账号二"}}
	service := newDashboardService(dashboardFixtureStore{
		bOverview: &state,
		sourceIDs: []string{"bili-1", "bili-2"},
		bBySource: map[string]BilibiliDashboardData{
			"bili-1": {State: DashboardState{DataStatus: DataStatusAvailable}, Account: BilibiliDashboardAccount{Name: "账号一"}, CapturedAt: now, FollowerCount: 10},
			"bili-2": {State: DashboardState{DataStatus: DataStatusUnavailable}, Account: BilibiliDashboardAccount{Name: "账号二"}},
		},
	}, func() time.Time { return now })
	response, err := service.BilibiliView(context.Background(), RangeToday)
	if err != nil || response.Status != DataStatusPartial || response.Data == nil || response.Data.FollowerCount != 10 {
		t.Fatalf("response=%#v err=%v", response, err)
	}
	if len(response.UnavailableParts) != 1 || response.UnavailableParts[0] != "账号二" {
		t.Fatalf("unavailable parts=%#v", response.UnavailableParts)
	}
}

func TestCompareDoesNotReturnZeroMetricsForUnavailableViews(t *testing.T) {
	tests := []struct {
		name   string
		store  dashboardFixtureStore
		viewID string
		metric string
		status string
	}{
		{name: "unconfigured xiaohongshu", store: dashboardFixtureStore{x: XiaohongshuDashboardData{State: DashboardState{DataStatus: DataStatusUnconfigured}}}, viewID: ViewXiaohongshuOperation, metric: "exposure_count", status: DataStatusUnconfigured},
		{name: "unavailable douyin", store: dashboardFixtureStore{d: DouyinAdsDashboardData{State: DashboardState{DataStatus: DataStatusUnavailable}}}, viewID: ViewDouyinAds, metric: "spend_minor", status: DataStatusUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, err := newDashboardService(test.store, nil).Compare(context.Background(), CompareRequest{ViewID: test.viewID, Range: Range7Days, MetricIDs: []string{test.metric}})
			if err != nil || response.DataStatus != test.status || response.Metrics == nil || len(response.Metrics) != 0 {
				t.Fatalf("response=%#v err=%v", response, err)
			}
		})
	}
}
