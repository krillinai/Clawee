package businessdata

import (
	"context"
	"sort"
	"time"
)

type XiaohongshuDashboardResponse struct {
	ViewID           string                  `json:"view_id"`
	DataStatus       string                  `json:"data_status"`
	Range            string                  `json:"range"`
	Timezone         string                  `json:"timezone"`
	StartDate        string                  `json:"start_date"`
	EndDate          string                  `json:"end_date"`
	GeneratedAt      time.Time               `json:"generated_at"`
	LastSyncedAt     *time.Time              `json:"last_synced_at"`
	Summary          *XiaohongshuSummary     `json:"summary"`
	Trend            []XiaohongshuTrendPoint `json:"trend"`
	TopItems         []XiaohongshuTopItem    `json:"top_items"`
	UnavailableParts []string                `json:"unavailable_parts"`
}

type DouyinAdsDashboardResponse struct {
	ViewID           string                `json:"view_id"`
	DataStatus       string                `json:"data_status"`
	Range            string                `json:"range"`
	Timezone         string                `json:"timezone"`
	StartDate        string                `json:"start_date"`
	EndDate          string                `json:"end_date"`
	GeneratedAt      time.Time             `json:"generated_at"`
	LastSyncedAt     *time.Time            `json:"last_synced_at"`
	Summary          *DouyinAdsSummary     `json:"summary"`
	Trend            []DouyinAdsTrendPoint `json:"trend"`
	TopItems         []DouyinAdsTopItem    `json:"top_items"`
	UnavailableParts []string              `json:"unavailable_parts"`
}

type BilibiliDashboardResponse struct {
	Status           string                   `json:"status"`
	Account          BilibiliDashboardAccount `json:"account"`
	Range            string                   `json:"range"`
	Timezone         string                   `json:"timezone"`
	StartDate        string                   `json:"start_date"`
	EndDate          string                   `json:"end_date"`
	GeneratedAt      time.Time                `json:"generated_at"`
	Data             *BilibiliDashboardDTO    `json:"data,omitempty"`
	LastSyncedAt     *time.Time               `json:"last_synced_at,omitempty"`
	UnavailableParts []string                 `json:"unavailable_parts,omitempty"`
}

type BilibiliDashboardDTO struct {
	CapturedAt            time.Time            `json:"captured_at"`
	FollowerCount         int64                `json:"follower_count"`
	FollowingCount        int64                `json:"following_count"`
	PublishedCount        int64                `json:"published_count"`
	CollectedContentCount int64                `json:"collected_content_count"`
	ViewCount             int64                `json:"view_count"`
	DanmakuCount          int64                `json:"danmaku_count"`
	ReplyCount            int64                `json:"reply_count"`
	FavoriteCount         int64                `json:"favorite_count"`
	CoinCount             int64                `json:"coin_count"`
	ShareCount            int64                `json:"share_count"`
	LikeCount             int64                `json:"like_count"`
	InteractionCount      int64                `json:"interaction_count"`
	Trend                 []BilibiliTrendPoint `json:"trend"`
	TopContents           []BilibiliTopContent `json:"top_contents"`
}

type DashboardOverviewItem struct {
	ViewID           string     `json:"view_id"`
	DataStatus       string     `json:"data_status"`
	LastSyncedAt     *time.Time `json:"last_synced_at"`
	UnavailableParts []string   `json:"unavailable_parts"`
}

type DashboardService struct {
	store DashboardStore
	clock func() time.Time
}

func NewDashboardService(store DashboardStore) *DashboardService {
	return &DashboardService{store: store, clock: func() time.Time { return time.Now().UTC() }}
}

func newDashboardService(store DashboardStore, clock func() time.Time) *DashboardService {
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	return &DashboardService{store: store, clock: clock}
}

func (s *DashboardService) Xiaohongshu(ctx context.Context, requestedRange string) (XiaohongshuDashboardResponse, error) {
	r, generatedAt, err := s.dashboardRange(requestedRange)
	if err != nil {
		return XiaohongshuDashboardResponse{}, err
	}
	data := XiaohongshuDashboardData{State: DashboardState{DataStatus: DataStatusUnconfigured}}
	if s.store != nil {
		data, err = s.store.XiaohongshuDashboard(ctx, r)
	}
	if err != nil {
		return XiaohongshuDashboardResponse{}, err
	}
	response := XiaohongshuDashboardResponse{
		ViewID: ViewXiaohongshuOperation, DataStatus: data.State.DataStatus, Range: r.Name, Timezone: Timezone,
		StartDate: dateKey(r.StartDate), EndDate: dateKey(r.EndDate), GeneratedAt: generatedAt, LastSyncedAt: data.State.LastSyncedAt,
		Trend: data.Trend, TopItems: data.TopItems,
		UnavailableParts: append([]string(nil), data.State.UnavailableParts...),
	}
	response.LastSyncedAt = utcTimePointer(response.LastSyncedAt)
	if response.Trend == nil {
		response.Trend = []XiaohongshuTrendPoint{}
	}
	if response.TopItems == nil {
		response.TopItems = []XiaohongshuTopItem{}
	}
	if data.State.DataStatus == DataStatusAvailable || data.State.DataStatus == DataStatusPartial {
		response.Summary = &data.Summary
	}
	return response, nil
}

func (s *DashboardService) DouyinAds(ctx context.Context, requestedRange string) (DouyinAdsDashboardResponse, error) {
	r, generatedAt, err := s.dashboardRange(requestedRange)
	if err != nil {
		return DouyinAdsDashboardResponse{}, err
	}
	data := DouyinAdsDashboardData{State: DashboardState{DataStatus: DataStatusUnconfigured}}
	if s.store != nil {
		data, err = s.store.DouyinAdsDashboard(ctx, r)
	}
	if err != nil {
		return DouyinAdsDashboardResponse{}, err
	}
	response := DouyinAdsDashboardResponse{
		ViewID: ViewDouyinAds, DataStatus: data.State.DataStatus, Range: r.Name, Timezone: Timezone,
		StartDate: dateKey(r.StartDate), EndDate: dateKey(r.EndDate), GeneratedAt: generatedAt, LastSyncedAt: data.State.LastSyncedAt,
		Trend: data.Trend, TopItems: data.TopItems,
		UnavailableParts: append([]string(nil), data.State.UnavailableParts...),
	}
	response.LastSyncedAt = utcTimePointer(response.LastSyncedAt)
	if response.Trend == nil {
		response.Trend = []DouyinAdsTrendPoint{}
	}
	if response.TopItems == nil {
		response.TopItems = []DouyinAdsTopItem{}
	}
	if data.State.DataStatus == DataStatusAvailable || data.State.DataStatus == DataStatusPartial {
		response.Summary = &data.Summary
	}
	return response, nil
}

func (s *DashboardService) Bilibili(ctx context.Context, sourceID, requestedRange string) (BilibiliDashboardResponse, error) {
	if sourceID == "" {
		return BilibiliDashboardResponse{}, ErrInvalidRequest
	}
	r, generatedAt, err := s.dashboardRange(requestedRange)
	if err != nil {
		return BilibiliDashboardResponse{}, err
	}
	data := BilibiliDashboardData{State: DashboardState{DataStatus: DataStatusUnconfigured}, TopContents: []BilibiliTopContent{}}
	if s.store != nil {
		data, err = s.store.BilibiliDashboard(ctx, sourceID, r)
	}
	if err != nil {
		return BilibiliDashboardResponse{}, err
	}
	response := BilibiliDashboardResponse{
		Status: data.State.DataStatus, Account: data.Account, Range: r.Name, Timezone: Timezone,
		StartDate: dateKey(r.StartDate), EndDate: dateKey(r.EndDate), GeneratedAt: generatedAt,
		LastSyncedAt:     utcTimePointer(data.State.LastSyncedAt),
		UnavailableParts: append([]string(nil), data.State.UnavailableParts...),
	}
	if data.State.DataStatus != DataStatusAvailable && data.State.DataStatus != DataStatusPartial {
		return response, nil
	}
	if data.Trend == nil {
		data.Trend = []BilibiliTrendPoint{}
	}
	if data.TopContents == nil {
		data.TopContents = []BilibiliTopContent{}
	}
	response.Data = &BilibiliDashboardDTO{
		CapturedAt: data.CapturedAt.UTC(), FollowerCount: data.FollowerCount,
		FollowingCount: data.FollowingCount, PublishedCount: data.PublishedCount,
		CollectedContentCount: data.CollectedContentCount, ViewCount: data.ViewCount,
		DanmakuCount: data.DanmakuCount, ReplyCount: data.ReplyCount,
		FavoriteCount: data.FavoriteCount, CoinCount: data.CoinCount,
		ShareCount: data.ShareCount, LikeCount: data.LikeCount,
		InteractionCount: data.InteractionCount, Trend: data.Trend, TopContents: data.TopContents,
	}
	return response, nil
}

type bilibiliViewSourceResolver interface {
	BilibiliViewSourceIDs(context.Context) ([]string, error)
}

type bilibiliSourceLister interface {
	ListBilibiliSources(context.Context) ([]BilibiliSourceItem, error)
}

func (s *DashboardService) BilibiliSources(ctx context.Context) ([]BilibiliSourceItem, error) {
	if s == nil || s.store == nil {
		return []BilibiliSourceItem{}, nil
	}
	lister, ok := s.store.(bilibiliSourceLister)
	if !ok {
		return nil, ErrInvalidRequest
	}
	items, err := lister.ListBilibiliSources(ctx)
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []BilibiliSourceItem{}
	}
	return items, nil
}

func (s *DashboardService) BilibiliView(ctx context.Context, requestedRange string) (BilibiliDashboardResponse, error) {
	r, generatedAt, err := s.dashboardRange(requestedRange)
	if err != nil {
		return BilibiliDashboardResponse{}, err
	}
	state := DashboardState{DataStatus: DataStatusUnconfigured}
	if s.store != nil {
		state, err = s.store.BilibiliDashboardOverview(ctx)
	}
	if err != nil {
		return BilibiliDashboardResponse{}, err
	}
	empty := BilibiliDashboardResponse{
		Status: state.DataStatus, Range: r.Name, Timezone: Timezone, StartDate: dateKey(r.StartDate), EndDate: dateKey(r.EndDate), GeneratedAt: generatedAt,
		LastSyncedAt: utcTimePointer(state.LastSyncedAt), UnavailableParts: append([]string(nil), state.UnavailableParts...),
	}
	if state.DataStatus != DataStatusAvailable && state.DataStatus != DataStatusPartial {
		return empty, nil
	}
	resolver, ok := s.store.(bilibiliViewSourceResolver)
	if !ok {
		return BilibiliDashboardResponse{}, ErrInvalidRequest
	}
	sourceIDs, err := resolver.BilibiliViewSourceIDs(ctx)
	if err != nil {
		return BilibiliDashboardResponse{}, err
	}
	result := empty
	result.Account = BilibiliDashboardAccount{Name: "全部 B 站账号", Status: SourceStatusActive}
	result.Data = &BilibiliDashboardDTO{Trend: []BilibiliTrendPoint{}, TopContents: []BilibiliTopContent{}}
	trendByDate := map[string]BilibiliTrendPoint{}
	for _, sourceID := range sourceIDs {
		response, callErr := s.Bilibili(ctx, sourceID, r.Name)
		if callErr != nil {
			return BilibiliDashboardResponse{}, callErr
		}
		if response.Data == nil {
			part := response.Account.Name
			if part == "" {
				part = "B 站账号数据"
			}
			result.UnavailableParts = appendUnique(result.UnavailableParts, part)
			result.Status = DataStatusPartial
			continue
		}
		result.Data.FollowerCount += response.Data.FollowerCount
		result.Data.FollowingCount += response.Data.FollowingCount
		result.Data.PublishedCount += response.Data.PublishedCount
		result.Data.CollectedContentCount += response.Data.CollectedContentCount
		result.Data.ViewCount += response.Data.ViewCount
		result.Data.DanmakuCount += response.Data.DanmakuCount
		result.Data.ReplyCount += response.Data.ReplyCount
		result.Data.FavoriteCount += response.Data.FavoriteCount
		result.Data.CoinCount += response.Data.CoinCount
		result.Data.ShareCount += response.Data.ShareCount
		result.Data.LikeCount += response.Data.LikeCount
		result.Data.InteractionCount += response.Data.InteractionCount
		if response.Data.CapturedAt.After(result.Data.CapturedAt) {
			result.Data.CapturedAt = response.Data.CapturedAt
		}
		result.Data.TopContents = append(result.Data.TopContents, response.Data.TopContents...)
		for _, point := range response.Data.Trend {
			aggregated := trendByDate[point.Date]
			aggregated.Date = point.Date
			aggregated.FollowerCount += point.FollowerCount
			aggregated.ViewCount += point.ViewCount
			aggregated.InteractionCount += point.InteractionCount
			aggregated.FollowerCountDelta += point.FollowerCountDelta
			aggregated.ViewCountDelta += point.ViewCountDelta
			aggregated.InteractionCountDelta += point.InteractionCountDelta
			trendByDate[point.Date] = aggregated
		}
	}
	for date := r.StartDate; !date.After(r.EndDate); date = date.AddDate(0, 0, 1) {
		point := trendByDate[dateKey(date)]
		point.Date = dateKey(date)
		result.Data.Trend = append(result.Data.Trend, point)
	}
	sort.SliceStable(result.Data.TopContents, func(i, j int) bool {
		left, right := result.Data.TopContents[i], result.Data.TopContents[j]
		if left.ViewCount != right.ViewCount {
			return left.ViewCount > right.ViewCount
		}
		if left.SourceID != right.SourceID {
			return left.SourceID < right.SourceID
		}
		return left.ExternalContentID < right.ExternalContentID
	})
	if len(result.Data.TopContents) > 20 {
		result.Data.TopContents = result.Data.TopContents[:20]
	}
	return result, nil
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func utcTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

func (s *DashboardService) Overview(ctx context.Context, viewIDs []string, requestedRange string) ([]DashboardOverviewItem, error) {
	items := make([]DashboardOverviewItem, 0, len(viewIDs))
	for _, viewID := range viewIDs {
		switch viewID {
		case ViewXiaohongshuOperation:
			response, err := s.Xiaohongshu(ctx, requestedRange)
			if err != nil {
				return nil, err
			}
			items = append(items, DashboardOverviewItem{ViewID: viewID, DataStatus: response.DataStatus, LastSyncedAt: response.LastSyncedAt, UnavailableParts: response.UnavailableParts})
		case ViewDouyinAds:
			response, err := s.DouyinAds(ctx, requestedRange)
			if err != nil {
				return nil, err
			}
			items = append(items, DashboardOverviewItem{ViewID: viewID, DataStatus: response.DataStatus, LastSyncedAt: response.LastSyncedAt, UnavailableParts: response.UnavailableParts})
		case ViewBilibiliOperation:
			state := DashboardState{DataStatus: DataStatusUnconfigured}
			var err error
			if s.store != nil {
				state, err = s.store.BilibiliDashboardOverview(ctx)
			}
			if err != nil {
				return nil, err
			}
			items = append(items, DashboardOverviewItem{ViewID: viewID, DataStatus: state.DataStatus, LastSyncedAt: utcTimePointer(state.LastSyncedAt), UnavailableParts: append([]string(nil), state.UnavailableParts...)})
		}
	}
	return items, nil
}

func (s *DashboardService) dashboardRange(requested string) (DashboardRange, time.Time, error) {
	if requested == "" {
		requested = Range7Days
	}
	days := 0
	switch requested {
	case RangeToday:
		days = 1
	case Range7Days:
		days = 7
	case Range30Days:
		days = 30
	default:
		return DashboardRange{}, time.Time{}, ErrInvalidRequest
	}
	location, err := time.LoadLocation(Timezone)
	if err != nil {
		return DashboardRange{}, time.Time{}, err
	}
	generatedAt := s.clock().UTC()
	localNow := generatedAt.In(location)
	end := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	start := end.AddDate(0, 0, -(days - 1))
	previousEnd := start.AddDate(0, 0, -1)
	return DashboardRange{Name: requested, StartDate: start, EndDate: end, PreviousStart: previousEnd.AddDate(0, 0, -(days - 1)), PreviousEnd: previousEnd}, generatedAt, nil
}

func (s *DashboardService) QueryRange(requested string) (DashboardRange, time.Time, error) {
	return s.dashboardRange(requested)
}

func (s *DashboardService) Compare(ctx context.Context, input CompareRequest) (CompareResponse, error) {
	r, generatedAt, err := s.dashboardRange(input.Range)
	if err != nil || len(input.MetricIDs) == 0 {
		if err != nil {
			return CompareResponse{}, err
		}
		return CompareResponse{}, ErrInvalidRequest
	}
	response := CompareResponse{
		ViewID: input.ViewID, Range: r.Name, Timezone: Timezone, StartDate: dateKey(r.StartDate), EndDate: dateKey(r.EndDate),
		PreviousStartDate: dateKey(r.PreviousStart), PreviousEndDate: dateKey(r.PreviousEnd), GeneratedAt: generatedAt,
		Metrics: []MetricComparison{},
	}
	definitions, ok := MetricDefinitions(input.ViewID)
	if !ok {
		return CompareResponse{}, ErrInvalidRequest
	}
	comparable := make(map[string]bool, len(definitions))
	for _, definition := range definitions {
		comparable[definition.MetricID] = definition.Comparable
	}
	for _, metricID := range input.MetricIDs {
		if !comparable[metricID] {
			return CompareResponse{}, ErrMetricNotSupported
		}
	}
	values := map[string][2]int64{}
	units := map[string]string{}
	switch input.ViewID {
	case ViewXiaohongshuOperation:
		data := XiaohongshuDashboardData{State: DashboardState{DataStatus: DataStatusUnconfigured}}
		if s.store != nil {
			data, err = s.store.XiaohongshuDashboard(ctx, r)
		}
		if err != nil {
			return CompareResponse{}, err
		}
		response.DataStatus, response.LastSyncedAt, response.UnavailableParts = data.State.DataStatus, utcTimePointer(data.State.LastSyncedAt), append([]string(nil), data.State.UnavailableParts...)
		if response.DataStatus != DataStatusAvailable && response.DataStatus != DataStatusPartial {
			return response, nil
		}
		values = map[string][2]int64{
			"published_count":    {data.Summary.PublishedCount, data.Previous.PublishedCount},
			"exposure_count":     {data.Summary.ExposureCount, data.Previous.ExposureCount},
			"interaction_count":  {data.Summary.InteractionCount, data.Previous.InteractionCount},
			"new_follower_count": {data.Summary.NewFollowerCount, data.Previous.NewFollowerCount},
		}
		units = map[string]string{"published_count": "count", "exposure_count": "count", "interaction_count": "count", "new_follower_count": "count"}
	case ViewDouyinAds:
		data := DouyinAdsDashboardData{State: DashboardState{DataStatus: DataStatusUnconfigured}}
		if s.store != nil {
			data, err = s.store.DouyinAdsDashboard(ctx, r)
		}
		if err != nil {
			return CompareResponse{}, err
		}
		response.DataStatus, response.LastSyncedAt, response.UnavailableParts = data.State.DataStatus, utcTimePointer(data.State.LastSyncedAt), append([]string(nil), data.State.UnavailableParts...)
		if response.DataStatus != DataStatusAvailable && response.DataStatus != DataStatusPartial {
			return response, nil
		}
		values = map[string][2]int64{
			"spend_minor":      {data.Summary.SpendMinor, data.Previous.SpendMinor},
			"video_play_count": {data.Summary.VideoPlayCount, data.Previous.VideoPlayCount},
		}
		units = map[string]string{"spend_minor": "CNY_minor", "video_play_count": "count"}
	case ViewBilibiliOperation:
		var data BilibiliDashboardResponse
		var callErr error
		if input.SourceID == "" {
			data, callErr = s.BilibiliView(ctx, r.Name)
		} else {
			data, callErr = s.Bilibili(ctx, input.SourceID, r.Name)
		}
		if callErr != nil {
			return CompareResponse{}, callErr
		}
		response.Account = &data.Account
		response.DataStatus, response.LastSyncedAt, response.UnavailableParts = data.Status, data.LastSyncedAt, append([]string(nil), data.UnavailableParts...)
		if response.DataStatus != DataStatusAvailable && response.DataStatus != DataStatusPartial {
			return response, nil
		}
		if data.Data != nil {
			previousFollower, previousView, previousInteraction := int64(0), int64(0), int64(0)
			if len(data.Data.Trend) > 0 {
				first := data.Data.Trend[0]
				previousFollower = first.FollowerCount - first.FollowerCountDelta
				previousView = first.ViewCount - first.ViewCountDelta
				previousInteraction = first.InteractionCount - first.InteractionCountDelta
			}
			values = map[string][2]int64{
				"follower_count":    {data.Data.FollowerCount, previousFollower},
				"view_count":        {data.Data.ViewCount, previousView},
				"interaction_count": {data.Data.InteractionCount, previousInteraction},
			}
		}
		units = map[string]string{"follower_count": "count", "view_count": "count", "interaction_count": "count"}
	default:
		return CompareResponse{}, ErrInvalidRequest
	}
	for _, metricID := range input.MetricIDs {
		pair, ok := values[metricID]
		if !ok {
			return CompareResponse{}, ErrMetricNotSupported
		}
		response.Metrics = append(response.Metrics, MetricComparison{
			MetricID: metricID, CurrentValue: pair[0], PreviousValue: pair[1], AbsoluteChange: pair[0] - pair[1],
			ChangeRate: changeRate(pair[0], pair[1]), Unit: units[metricID],
		})
	}
	return response, nil
}
