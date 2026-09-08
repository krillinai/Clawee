package businessdatamcp

import "github.com/krillinai/Clawee/server/internal/businessdata"

const (
	ServerID          = "business-data"
	ToolViews         = "views"
	ToolDashboard     = "dashboard"
	ToolCompare       = "compare"
	ToolMetricExplain = "metric_explain"
)

var supportedViews = []string{
	businessdata.ViewXiaohongshuOperation,
	businessdata.ViewDouyinAds,
	businessdata.ViewBilibiliOperation,
}

var viewNames = map[string]string{
	businessdata.ViewXiaohongshuOperation: "小红书运营",
	businessdata.ViewDouyinAds:            "抖音广告",
	businessdata.ViewBilibiliOperation:    "B 站运营",
}
