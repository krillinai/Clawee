package server

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

func mountBusinessDataRoutes(app *gin.RouterGroup, opts Options) {
	app.GET("/business-dashboards", handleBusinessDashboardOverview(opts))
	app.GET("/business-dashboards/xiaohongshu-operation", handleXiaohongshuDashboard(opts))
	app.GET("/business-dashboards/douyin-ads", handleDouyinAdsDashboard(opts))
	app.GET("/business-dashboards/bilibili-operation", handleBilibiliDashboard(opts))
}

func handleBilibiliDashboard(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		requestedRange, sourceID, ok := bilibiliDashboardQuery(c)
		if !ok || !requireBusinessDataView(c, opts, dataaccess.ViewBilibiliOperation) {
			return
		}
		if opts.BusinessDashboardService == nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		started := time.Now()
		response, err := opts.BusinessDashboardService.Bilibili(c.Request.Context(), sourceID, requestedRange)
		if err != nil {
			if errors.Is(err, businessdata.ErrNotFound) {
				businessDataError(c, http.StatusNotFound, "business_data_source_not_found", "哔哩哔哩账号不存在")
				return
			}
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		logBusinessDashboardAccess(c, opts, dataaccess.ViewBilibiliOperation, sourceID, response.Status, response.Range, started)
		c.JSON(http.StatusOK, gin.H{"data": response})
	}
}

func handleBusinessDashboardOverview(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		requestedRange, ok := businessDashboardRange(c)
		if !ok {
			return
		}
		viewIDs, ok := allowedBusinessDataViews(c, opts)
		if !ok {
			return
		}
		if opts.BusinessDashboardService == nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		items, err := opts.BusinessDashboardService.Overview(c.Request.Context(), viewIDs, requestedRange)
		if err != nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": items})
	}
}

func handleXiaohongshuDashboard(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		requestedRange, ok := businessDashboardRange(c)
		if !ok || !requireBusinessDataView(c, opts, dataaccess.ViewXiaohongshuOperation) {
			return
		}
		if opts.BusinessDashboardService == nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		started := time.Now()
		response, err := opts.BusinessDashboardService.Xiaohongshu(c.Request.Context(), requestedRange)
		if err != nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		logBusinessDashboardAccess(c, opts, response.ViewID, "", response.DataStatus, response.Range, started)
		c.JSON(http.StatusOK, gin.H{"data": response})
	}
}

func handleDouyinAdsDashboard(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		requestedRange, ok := businessDashboardRange(c)
		if !ok || !requireBusinessDataView(c, opts, dataaccess.ViewDouyinAds) {
			return
		}
		if opts.BusinessDashboardService == nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		started := time.Now()
		response, err := opts.BusinessDashboardService.DouyinAds(c.Request.Context(), requestedRange)
		if err != nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		logBusinessDashboardAccess(c, opts, response.ViewID, "", response.DataStatus, response.Range, started)
		c.JSON(http.StatusOK, gin.H{"data": response})
	}
}

func businessDashboardRange(c *gin.Context) (string, bool) {
	query, err := url.ParseQuery(c.Request.URL.RawQuery)
	if err != nil {
		businessDataError(c, http.StatusBadRequest, "invalid_request", "业务看板请求参数无效")
		return "", false
	}
	for key, values := range query {
		if key != "range" || len(values) != 1 {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "业务看板请求参数无效")
			return "", false
		}
	}
	values, exists := query["range"]
	if !exists {
		return businessdata.Range7Days, true
	}
	rangeValue := values[0]
	if rangeValue != businessdata.RangeToday && rangeValue != businessdata.Range7Days && rangeValue != businessdata.Range30Days {
		businessDataError(c, http.StatusBadRequest, "invalid_dashboard_range", "range must be one of today, 7d, 30d")
		return "", false
	}
	return rangeValue, true
}

func bilibiliDashboardQuery(c *gin.Context) (string, string, bool) {
	query, err := url.ParseQuery(c.Request.URL.RawQuery)
	if err != nil {
		businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩看板请求参数无效")
		return "", "", false
	}
	for key, values := range query {
		if (key != "range" && key != "source_id") || len(values) != 1 {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩看板请求参数无效")
			return "", "", false
		}
	}
	sourceID := strings.TrimSpace(query.Get("source_id"))
	if sourceID == "" {
		businessDataError(c, http.StatusBadRequest, "invalid_request", "source_id is required")
		return "", "", false
	}
	requestedRange := query.Get("range")
	if requestedRange == "" {
		requestedRange = businessdata.Range7Days
	}
	if requestedRange != businessdata.RangeToday && requestedRange != businessdata.Range7Days && requestedRange != businessdata.Range30Days {
		businessDataError(c, http.StatusBadRequest, "invalid_dashboard_range", "range must be one of today, 7d, 30d")
		return "", "", false
	}
	return requestedRange, sourceID, true
}

func allowedBusinessDataViews(c *gin.Context, opts Options) ([]string, bool) {
	if opts.DataAccessService == nil {
		businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "数据授权服务不可用")
		return nil, false
	}
	account, ok := currentAccount(c)
	if !ok {
		businessDataError(c, http.StatusUnauthorized, "unauthorized", "未登录")
		return nil, false
	}
	grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{UserID: account.UserID, ResourceType: dataaccess.ResourceDataView, Action: dataaccess.ActionRead})
	if err != nil {
		businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "数据授权服务不可用")
		return nil, false
	}
	allowed := map[string]bool{}
	for _, grant := range grants {
		allowed[grant.ResourceID] = true
	}
	views := []string{}
	for _, viewID := range []string{dataaccess.ViewXiaohongshuOperation, dataaccess.ViewDouyinAds, dataaccess.ViewBilibiliOperation} {
		if allowed[viewID] {
			views = append(views, viewID)
		}
	}
	return views, true
}

func requireBusinessDataView(c *gin.Context, opts Options, viewID string) bool {
	if opts.DataAccessService == nil {
		businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "数据授权服务不可用")
		return false
	}
	account, ok := currentAccount(c)
	if !ok {
		businessDataError(c, http.StatusUnauthorized, "unauthorized", "未登录")
		return false
	}
	allowed, err := opts.DataAccessService.HasAction(c.Request.Context(), account.UserID, dataaccess.ResourceDataView, viewID, dataaccess.ActionRead)
	if err != nil {
		businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "数据授权服务不可用")
		return false
	}
	if !allowed {
		businessDataError(c, http.StatusForbidden, "business_data_view_forbidden", "无权查看业务数据")
		return false
	}
	return true
}

func logBusinessDashboardAccess(c *gin.Context, opts Options, viewID, sourceID, status, requestedRange string, started time.Time) {
	if opts.Logger == nil {
		return
	}
	account, _ := currentAccount(c)
	opts.Logger.Info("business dashboard request",
		zap.String("request_id", requestIDFromContext(c.Request.Context())), zap.String("user_id", account.UserID),
		zap.String("view_id", viewID), zap.String("source_id", sourceID), zap.Bool("authorized", true), zap.String("range", requestedRange),
		zap.String("data_status", status), zap.Int64("duration_ms", time.Since(started).Milliseconds()))
}

func businessDataError(c *gin.Context, status int, code, message string) {
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}
