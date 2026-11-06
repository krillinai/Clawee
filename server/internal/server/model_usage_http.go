package server

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type modelUsageItemResponse struct {
	AuditID             string     `json:"audit_id"`
	UserName            string     `json:"user_name"`
	APIKeyFingerprint   string     `json:"api_key_fingerprint"`
	Endpoint            string     `json:"endpoint"`
	Method              string     `json:"method"`
	Model               string     `json:"model"`
	RequestedModel      string     `json:"requested_model"`
	UpstreamModel       string     `json:"upstream_model"`
	ResponseModel       string     `json:"response_model"`
	RequestType         string     `json:"request_type"`
	Status              string     `json:"status"`
	GatewayStatus       int        `json:"gateway_status"`
	UpstreamStatus      int        `json:"upstream_status"`
	ErrorCode           string     `json:"error_code"`
	ErrorMessage        string     `json:"error_message"`
	InputTokens         int64      `json:"input_tokens"`
	OutputTokens        int64      `json:"output_tokens"`
	TotalTokens         int64      `json:"total_tokens"`
	CacheReadTokens     int64      `json:"cache_read_tokens"`
	CacheCreationTokens int64      `json:"cache_creation_tokens"`
	ReasoningTokens     int64      `json:"reasoning_tokens"`
	UsageAvailable      bool       `json:"usage_available"`
	UsageStatus         string     `json:"usage_status"`
	UsageSource         string     `json:"usage_source"`
	RequestBytes        int64      `json:"request_bytes"`
	ResponseBytes       int64      `json:"response_bytes"`
	ResponseChunks      int64      `json:"response_chunks"`
	Truncated           bool       `json:"truncated"`
	DurationMS          int64      `json:"duration_ms"`
	FirstByteMS         int64      `json:"first_byte_ms"`
	OutputTPS           float64    `json:"output_tps"`
	CreatedAt           time.Time  `json:"created_at"`
	CompletedAt         *time.Time `json:"completed_at,omitempty"`
}

type modelUsageSummaryResponse struct {
	RequestCount          int64   `json:"request_count"`
	SucceededCount        int64   `json:"succeeded_count"`
	InputTokens           int64   `json:"input_tokens"`
	OutputTokens          int64   `json:"output_tokens"`
	TotalTokens           int64   `json:"total_tokens"`
	CacheReadTokens       int64   `json:"cache_read_tokens"`
	CacheCreationTokens   int64   `json:"cache_creation_tokens"`
	ReasoningTokens       int64   `json:"reasoning_tokens"`
	UsageCompleteCount    int64   `json:"usage_complete_count"`
	UsagePartialCount     int64   `json:"usage_partial_count"`
	UsageUnavailableCount int64   `json:"usage_unavailable_count"`
	UsageCoverageRate     float64 `json:"usage_coverage_rate"`
	UsageCount            int64   `json:"usage_count"`
	SuccessRate           float64 `json:"success_rate"`
}

func mountModelUsageRoutes(app *gin.RouterGroup, opts Options) {
	if modelAccessMode(opts) != ModelAccessPlatformManaged {
		return
	}
	app.GET("/model-usage", func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			return
		}
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
				"code": "model_proxy_disabled", "message": "模型服务暂不可用", "details": []any{},
			}})
			return
		}

		filter, err := modelProxyAuditFilter(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "invalid_model_usage_filter", "message": err.Error(), "details": []any{}}})
			return
		}
		filter.UserID = account.UserID
		page, err := opts.ProxyGateway.Store().ListModelProxyAuditRecords(c.Request.Context(), filter)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
				"code": "model_usage_unavailable", "message": "模型使用日志暂不可用", "details": []any{},
			}})
			return
		}

		summaryFilter, err := modelProxyAuditSummaryFilter(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "invalid_model_usage_filter", "message": err.Error(), "details": []any{}}})
			return
		}
		summaryFilter.UserID = account.UserID
		summaries, err := opts.ProxyGateway.Store().SummarizeModelProxyAuditRecords(c.Request.Context(), summaryFilter)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
				"code": "model_usage_unavailable", "message": "模型使用统计暂不可用", "details": []any{},
			}})
			return
		}

		items := make([]modelUsageItemResponse, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, toModelUsageItemResponse(item))
		}
		c.JSON(http.StatusOK, gin.H{
			"data": gin.H{
				"items":   items,
				"summary": aggregateModelUsageSummary(summaries),
				"meta": gin.H{
					"next_created_at": nullableTimeValue(page.NextCreatedAt),
					"next_id":         page.NextID,
					"has_next":        page.NextID != "",
				},
			},
		})
	})
}

func toModelUsageItemResponse(record mcpgateway.ModelProxyAuditRecord) modelUsageItemResponse {
	var completedAt *time.Time
	if !record.CompletedAt.IsZero() {
		value := record.CompletedAt
		completedAt = &value
	}
	return modelUsageItemResponse{
		AuditID:             record.AuditID,
		UserName:            record.UserNameSnapshot,
		APIKeyFingerprint:   record.APIKeyFingerprint,
		Endpoint:            record.Endpoint,
		Method:              record.Method,
		Model:               record.Model,
		RequestedModel:      record.RequestedModel,
		UpstreamModel:       record.UpstreamModel,
		ResponseModel:       record.ResponseModel,
		RequestType:         record.RequestType,
		Status:              string(record.Status),
		GatewayStatus:       record.GatewayStatus,
		UpstreamStatus:      record.UpstreamStatus,
		ErrorCode:           record.ErrorCode,
		ErrorMessage:        record.ErrorMessage,
		InputTokens:         record.InputTokens,
		OutputTokens:        record.OutputTokens,
		TotalTokens:         record.TotalTokens,
		CacheReadTokens:     record.CacheReadTokens,
		CacheCreationTokens: record.CacheCreationTokens,
		ReasoningTokens:     record.ReasoningTokens,
		UsageAvailable:      record.UsageAvailable,
		UsageStatus:         string(mcpgateway.ModelProxyAuditUsageStatus(record)),
		UsageSource:         string(mcpgateway.ModelProxyAuditUsageSource(record)),
		RequestBytes:        record.RequestBytes,
		ResponseBytes:       record.ResponseBytes,
		ResponseChunks:      record.ResponseChunks,
		Truncated:           record.Truncated,
		DurationMS:          record.DurationMS,
		FirstByteMS:         record.FirstByteMS,
		OutputTPS:           modelOutputTPS(record),
		CreatedAt:           record.CreatedAt,
		CompletedAt:         completedAt,
	}
}

func modelOutputTPS(record mcpgateway.ModelProxyAuditRecord) float64 {
	if !record.UsageAvailable || record.OutputTokens <= 0 || record.DurationMS <= 0 {
		return 0
	}
	return float64(record.OutputTokens) * 1000 / float64(record.DurationMS)
}

func aggregateModelUsageSummary(summaries []mcpgateway.ModelProxyAuditSummary) modelUsageSummaryResponse {
	var result modelUsageSummaryResponse
	for _, summary := range summaries {
		result.RequestCount += summary.RequestCount
		result.SucceededCount += summary.SucceededCount
		result.InputTokens += summary.InputTokens
		result.OutputTokens += summary.OutputTokens
		result.TotalTokens += summary.TotalTokens
		result.CacheReadTokens += summary.CacheReadTokens
		result.CacheCreationTokens += summary.CacheCreationTokens
		result.ReasoningTokens += summary.ReasoningTokens
		result.UsageCompleteCount += summary.UsageCompleteCount
		result.UsagePartialCount += summary.UsagePartialCount
		result.UsageUnavailableCount += summary.UsageUnavailableCount
		result.UsageCount += summary.UsageCount
	}
	if result.RequestCount > 0 {
		result.SuccessRate = float64(result.SucceededCount) / float64(result.RequestCount)
		result.UsageCoverageRate = float64(result.UsageCompleteCount+result.UsagePartialCount) / float64(result.RequestCount)
	}
	return result
}
