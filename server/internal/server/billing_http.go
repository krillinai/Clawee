package server

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/clawadmin"
)

type billingOverviewUsage struct {
	Requests          int64 `json:"requests"`
	InputTokens       int64 `json:"input_tokens"`
	CachedInputTokens int64 `json:"cached_input_tokens"`
	OutputTokens      int64 `json:"output_tokens"`
	TotalTokens       int64 `json:"total_tokens"`
}

type billingOverviewTrendPoint struct {
	BucketStart time.Time `json:"bucket_start"`
	billingOverviewUsage
}

type billingOverviewModelUsage struct {
	Model string `json:"model"`
	billingOverviewUsage
}

type billingOverviewResponse struct {
	Currency     string                      `json:"currency"`
	ExchangeRate float64                     `json:"exchange_rate"`
	BalanceCNY   float64                     `json:"balance_cny"`
	StartDate    string                      `json:"start_date"`
	EndDate      string                      `json:"end_date"`
	Granularity  string                      `json:"granularity"`
	GeneratedAt  time.Time                   `json:"generated_at"`
	Stats        billingOverviewUsage        `json:"stats"`
	Trend        []billingOverviewTrendPoint `json:"trend"`
	Models       []billingOverviewModelUsage `json:"models"`
}

func mountBillingRoutes(app *gin.RouterGroup, opts Options) {
	app.GET("/billing/overview", func(c *gin.Context) {
		if !requireAgentActivityRead(c, opts) {
			return
		}
		if rejectEnterpriseManagedBilling(c, opts) {
			return
		}
		if opts.BillingProvider == nil {
			activityError(c, http.StatusServiceUnavailable, "billing_unavailable", "账户额度暂不可用")
			return
		}
		result, err := opts.BillingProvider.GetBillingOverview(c.Request.Context(), c.Query("range"))
		if err != nil {
			activityError(c, http.StatusServiceUnavailable, "billing_unavailable", "账户额度暂不可用")
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, newBillingOverviewResponse(result))
	})
	app.POST("/billing/recharge-session", func(c *gin.Context) {
		if !requireAgentActivityRead(c, opts) {
			return
		}
		if rejectEnterpriseManagedBilling(c, opts) {
			return
		}
		if c.Request.URL.RawQuery != "" || c.Request.ContentLength > 0 || opts.BillingProvider == nil {
			activityError(c, http.StatusServiceUnavailable, "recharge_unavailable", "充值入口暂不可用")
			return
		}
		result, err := opts.BillingProvider.CreateRechargeSession(c.Request.Context())
		if err != nil {
			activityError(c, http.StatusServiceUnavailable, "recharge_unavailable", "充值入口暂不可用")
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, result)
	})
	app.GET("/billing/recharge-orders", func(c *gin.Context) {
		if !requireAgentActivityRead(c, opts) {
			return
		}
		if rejectEnterpriseManagedBilling(c, opts) {
			return
		}
		for key := range c.Request.URL.Query() {
			if key != "page" && key != "page_size" {
				activityError(c, http.StatusBadRequest, "invalid_recharge_records_page", "充值记录分页参数无效")
				return
			}
		}
		page, ok := rechargePageParam(c.Query("page"), 1, 0)
		if !ok {
			activityError(c, http.StatusBadRequest, "invalid_recharge_records_page", "充值记录分页参数无效")
			return
		}
		pageSize, ok := rechargePageParam(c.Query("page_size"), 20, 100)
		if !ok || page-1 > int(^uint(0)>>1)/pageSize {
			activityError(c, http.StatusBadRequest, "invalid_recharge_records_page", "充值记录分页参数无效")
			return
		}
		if opts.BillingProvider == nil {
			activityError(c, http.StatusServiceUnavailable, "recharge_records_unavailable", "充值记录暂不可用")
			return
		}
		result, err := opts.BillingProvider.ListRechargeOrders(c.Request.Context(), page, pageSize)
		if err != nil {
			activityError(c, http.StatusServiceUnavailable, "recharge_records_unavailable", "充值记录暂不可用")
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"data": result})
	})
}

func newBillingOverviewResponse(snapshot clawadmin.BillingSnapshot) billingOverviewResponse {
	trend := make([]billingOverviewTrendPoint, 0, len(snapshot.Trend))
	for _, point := range snapshot.Trend {
		trend = append(trend, billingOverviewTrendPoint{
			BucketStart:          point.BucketStart,
			billingOverviewUsage: newBillingOverviewUsage(point.BillingUsage),
		})
	}
	models := make([]billingOverviewModelUsage, 0, len(snapshot.Models))
	for _, model := range snapshot.Models {
		models = append(models, billingOverviewModelUsage{
			Model:                model.Model,
			billingOverviewUsage: newBillingOverviewUsage(model.BillingUsage),
		})
	}
	return billingOverviewResponse{
		Currency: snapshot.Currency, ExchangeRate: snapshot.ExchangeRate, BalanceCNY: snapshot.BalanceCNY,
		StartDate: snapshot.StartDate, EndDate: snapshot.EndDate, Granularity: snapshot.Granularity, GeneratedAt: snapshot.GeneratedAt,
		Stats: newBillingOverviewUsage(snapshot.Stats), Trend: trend, Models: models,
	}
}

func newBillingOverviewUsage(usage clawadmin.BillingUsage) billingOverviewUsage {
	return billingOverviewUsage{
		Requests: usage.Requests, InputTokens: usage.InputTokens, CachedInputTokens: usage.CachedInputTokens,
		OutputTokens: usage.OutputTokens, TotalTokens: usage.TotalTokens,
	}
}

func rejectEnterpriseManagedBilling(c *gin.Context, opts Options) bool {
	if modelAccessMode(opts) != ModelAccessEnterpriseManaged {
		return false
	}
	activityError(c, http.StatusConflict, "billing_not_managed", "当前部署使用企业自有模型服务，平台不管理该模型账单")
	return true
}

func rechargePageParam(raw string, fallback, maximum int) (int, bool) {
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	return value, err == nil && value > 0 && (maximum == 0 || value <= maximum)
}
