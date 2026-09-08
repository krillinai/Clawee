package businessdata

var metricCatalog = map[string][]MetricDefinition{
	ViewXiaohongshuOperation: {
		{MetricID: "published_count", Label: "发布内容数", Description: "查询周期内发布的内容数量", Unit: "count", Aggregation: "count", DataSource: ProviderXiaohongshu, TimeScope: "自然日区间", ValueType: "period", MissingDataRule: "缺失日期按零补点，数据源不可用时不返回零值成功", Comparable: true},
		{MetricID: "exposure_count", Label: "曝光量", Description: "查询周期内内容曝光量之和", Unit: "count", Aggregation: "sum", DataSource: ProviderXiaohongshu, TimeScope: "自然日区间", ValueType: "period", MissingDataRule: "缺失日期按零补点，数据源不可用时不返回零值成功", Comparable: true},
		{MetricID: "interaction_count", Label: "互动量", Description: "点赞、收藏、评论和分享量之和", Unit: "count", Aggregation: "sum", DataSource: ProviderXiaohongshu, TimeScope: "自然日区间", ValueType: "period", MissingDataRule: "缺失日期按零补点，数据源不可用时不返回零值成功", Comparable: true},
		{MetricID: "new_follower_count", Label: "新增粉丝数", Description: "查询周期内新增粉丝数之和", Unit: "count", Aggregation: "sum", DataSource: ProviderXiaohongshu, TimeScope: "自然日区间", ValueType: "period", MissingDataRule: "缺失日期按零补点，数据源不可用时不返回零值成功", Comparable: true},
	},
	ViewDouyinAds: {
		{MetricID: "spend_minor", Label: "消耗金额", Description: "查询周期内广告消耗，单位为人民币分", Unit: "CNY_minor", Aggregation: "sum", DataSource: ProviderDouyinAds, TimeScope: "自然日区间", ValueType: "period", MissingDataRule: "缺失日期按零补点，数据源不可用时不返回零值成功", Comparable: true},
		{MetricID: "video_play_count", Label: "视频播放量", Description: "查询周期内广告视频播放量之和", Unit: "count", Aggregation: "sum", DataSource: ProviderDouyinAds, TimeScope: "自然日区间", ValueType: "period", MissingDataRule: "缺失日期按零补点，数据源不可用时不返回零值成功", Comparable: true},
	},
	ViewBilibiliOperation: {
		{MetricID: "follower_count", Label: "粉丝数", Description: "最新有效快照的累计粉丝数", Unit: "count", Aggregation: "latest", DataSource: ProviderBilibili, TimeScope: "周期末快照", ValueType: "cumulative", MissingDataRule: "沿用最近有效快照，数据源不可用时不返回零值成功", Comparable: true},
		{MetricID: "view_count", Label: "播放量", Description: "已采集内容最新快照的累计播放量之和", Unit: "count", Aggregation: "latest_sum", DataSource: ProviderBilibili, TimeScope: "周期末快照", ValueType: "cumulative", MissingDataRule: "沿用最近有效快照，数据源不可用时不返回零值成功", Comparable: true},
		{MetricID: "interaction_count", Label: "互动量", Description: "已采集内容最新快照的累计互动量之和", Unit: "count", Aggregation: "latest_sum", DataSource: ProviderBilibili, TimeScope: "周期末快照", ValueType: "cumulative", MissingDataRule: "沿用最近有效快照，数据源不可用时不返回零值成功", Comparable: true},
		{MetricID: "collected_content_count", Label: "已采集内容数", Description: "已采集并具有指标快照的内容数量", Unit: "count", Aggregation: "count", DataSource: ProviderBilibili, TimeScope: "最新快照", ValueType: "cumulative", MissingDataRule: "数据源不可用时不返回零值成功"},
	},
}

func MetricDefinitions(viewID string) ([]MetricDefinition, bool) {
	items, ok := metricCatalog[viewID]
	if !ok {
		return nil, false
	}
	return append([]MetricDefinition(nil), items...), true
}
