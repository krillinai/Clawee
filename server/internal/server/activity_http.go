package server

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

func mountActivityRoutes(app *gin.RouterGroup, opts Options) {
	if opts.DataAccessService == nil {
		return
	}
	app.GET("/data-views", handleDataViews(opts))
	app.GET("/activity/statistics", handleActivityStatistics(opts))
}

func handleDataViews(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.URL.RawQuery != "" {
			activityError(c, http.StatusBadRequest, "invalid_request", "数据视图请求参数无效")
			return
		}
		account, _ := currentAccount(c)
		grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{UserID: account.UserID, ResourceType: dataaccess.ResourceDataView})
		if err != nil {
			activityError(c, http.StatusServiceUnavailable, "data_authorization_unavailable", "数据授权服务不可用")
			return
		}
		actions := map[string][]string{}
		for _, grant := range grants {
			actions[grant.ResourceID] = append(actions[grant.ResourceID], grant.Action)
		}
		items := []gin.H{}
		for _, viewID := range []string{dataaccess.ViewAgentActivity, dataaccess.ViewXiaohongshuOperation, dataaccess.ViewDouyinAds, dataaccess.ViewBilibiliOperation} {
			if granted := actions[viewID]; len(granted) > 0 {
				items = append(items, gin.H{"view_id": viewID, "actions": granted})
			}
		}
		c.JSON(http.StatusOK, gin.H{"data": items})
	}
}

func handleActivityStatistics(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAgentActivityRead(c, opts) {
			return
		}
		account, _ := currentAccount(c)
		if opts.ActivityService == nil {
			activityError(c, http.StatusServiceUnavailable, "activity_unavailable", "Agent 活动数据暂不可用")
			return
		}
		requestedRange := c.Query("range")
		started := time.Now()
		statistics, err := opts.ActivityService.Statistics(c.Request.Context(), requestedRange)
		if err != nil {
			activityServiceError(c, err)
			return
		}
		if opts.Logger != nil {
			opts.Logger.Info("activity statistics request",
				zap.String("request_id", requestIDFromContext(c.Request.Context())), zap.String("user_id", account.UserID),
				zap.Bool("authorized", true), zap.String("range", statistics.Range), zap.String("start_date", statistics.StartDate),
				zap.String("end_date", statistics.EndDate), zap.String("timezone", statistics.Timezone), zap.Int64("duration_ms", time.Since(started).Milliseconds()))
			opts.Logger.Info("activity statistics data sources", zap.String("request_id", requestIDFromContext(c.Request.Context())),
				zap.String("model_usage_status", statistics.DataStatus["model_usage"]), zap.String("activity_status", statistics.DataStatus["activity"]))
		}
		c.JSON(http.StatusOK, gin.H{"data": statistics})
	}
}

func requireAgentActivityRead(c *gin.Context, opts Options) bool {
	if opts.DataAccessService == nil {
		activityError(c, http.StatusServiceUnavailable, "data_authorization_unavailable", "数据授权服务不可用")
		return false
	}
	account, ok := currentAccount(c)
	if !ok {
		activityError(c, http.StatusUnauthorized, "unauthorized", "未登录")
		return false
	}
	allowed, err := opts.DataAccessService.HasAction(c.Request.Context(), account.UserID, dataaccess.ResourceDataView, dataaccess.ViewAgentActivity, dataaccess.ActionRead)
	if err != nil {
		activityError(c, http.StatusServiceUnavailable, "data_authorization_unavailable", "数据授权服务不可用")
		return false
	}
	if !allowed {
		activityError(c, http.StatusForbidden, "data_view_forbidden", "无权查看 Agent 动态")
		return false
	}
	return true
}

func activityServiceError(c *gin.Context, err error) {
	if errors.Is(err, activity.ErrInvalidRange) {
		activityError(c, http.StatusBadRequest, "invalid_activity_range", "range must be one of today, 7d, 30d")
		return
	}
	if errors.Is(err, activity.ErrActivityUnavailable) {
		activityError(c, http.StatusServiceUnavailable, "activity_unavailable", "Agent 活动数据暂不可用")
		return
	}
	var upstream *activity.UpstreamError
	if errors.As(err, &upstream) {
		status := http.StatusBadGateway
		if upstream.Code == "billing_rate_limited" {
			status = http.StatusServiceUnavailable
			if retryAfter := validRetryAfter(upstream.RetryAfter); retryAfter != "" {
				c.Header("Retry-After", retryAfter)
			}
		}
		activityError(c, status, upstream.Code, "模型用量数据暂不可用")
		return
	}
	activityError(c, http.StatusInternalServerError, "activity_statistics_failed", "Agent 动态统计失败")
}

func validRetryAfter(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return ""
	}
	if _, err := time.ParseDuration(value + "s"); err == nil {
		for _, char := range value {
			if char < '0' || char > '9' {
				return ""
			}
		}
		return value
	}
	if _, err := http.ParseTime(value); err == nil {
		return value
	}
	return ""
}

func activityError(c *gin.Context, status int, code, message string) {
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}
