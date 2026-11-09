package server

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type modelProxyAuditResponse struct {
	AuditID             string             `json:"audit_id"`
	RequestID           string             `json:"request_id"`
	UserID              string             `json:"user_id"`
	UserNameSnapshot    string             `json:"user_name_snapshot"`
	APIKeyID            string             `json:"api_key_id"`
	APIKeyFingerprint   string             `json:"api_key_fingerprint"`
	Endpoint            string             `json:"endpoint"`
	Method              string             `json:"method"`
	Model               string             `json:"model"`
	RequestedModel      string             `json:"requested_model"`
	UpstreamModel       string             `json:"upstream_model"`
	ResponseModel       string             `json:"response_model"`
	Status              string             `json:"status"`
	GatewayStatus       int                `json:"gateway_status"`
	UpstreamStatus      int                `json:"upstream_status"`
	ErrorCode           string             `json:"error_code"`
	ErrorMessage        string             `json:"error_message"`
	InputTokens         int64              `json:"input_tokens"`
	OutputTokens        int64              `json:"output_tokens"`
	TotalTokens         int64              `json:"total_tokens"`
	CacheReadTokens     int64              `json:"cache_read_tokens"`
	CacheCreationTokens int64              `json:"cache_creation_tokens"`
	ReasoningTokens     int64              `json:"reasoning_tokens"`
	UsageAvailable      bool               `json:"usage_available"`
	UsageStatus         string             `json:"usage_status"`
	UsageSource         string             `json:"usage_source"`
	RequestHeaders      mcpgateway.JSONMap `json:"request_headers"`
	RequestBody         mcpgateway.JSONMap `json:"request_body"`
	ResponseHeaders     mcpgateway.JSONMap `json:"response_headers"`
	ResponseBody        mcpgateway.JSONMap `json:"response_body"`
	RequestBytes        int64              `json:"request_bytes"`
	ResponseBytes       int64              `json:"response_bytes"`
	ResponseChunks      int64              `json:"response_chunks"`
	Truncated           bool               `json:"truncated"`
	DurationMS          int64              `json:"duration_ms"`
	CreatedAt           time.Time          `json:"created_at"`
	CompletedAt         *time.Time         `json:"completed_at,omitempty"`
}

type modelProxyAuditSummaryResponse struct {
	UserID                string  `json:"user_id"`
	UserNameSnapshot      string  `json:"user_name_snapshot"`
	Model                 string  `json:"model"`
	RequestCount          int64   `json:"request_count"`
	SucceededCount        int64   `json:"succeeded_count"`
	UsageCompleteCount    int64   `json:"usage_complete_count"`
	UsagePartialCount     int64   `json:"usage_partial_count"`
	UsageUnavailableCount int64   `json:"usage_unavailable_count"`
	UsageCoverageRate     float64 `json:"usage_coverage_rate"`
	InputTokens           int64   `json:"input_tokens"`
	OutputTokens          int64   `json:"output_tokens"`
	TotalTokens           int64   `json:"total_tokens"`
	CacheReadTokens       int64   `json:"cache_read_tokens"`
	CacheCreationTokens   int64   `json:"cache_creation_tokens"`
	ReasoningTokens       int64   `json:"reasoning_tokens"`
	UsageCount            int64   `json:"usage_count"`
	SuccessRate           float64 `json:"success_rate"`
}

func toModelProxyAuditResponse(record mcpgateway.ModelProxyAuditRecord) modelProxyAuditResponse {
	var completedAt *time.Time
	if !record.CompletedAt.IsZero() {
		value := record.CompletedAt
		completedAt = &value
	}
	return modelProxyAuditResponse{
		AuditID:             record.AuditID,
		RequestID:           record.RequestID,
		UserID:              record.UserID,
		UserNameSnapshot:    record.UserNameSnapshot,
		APIKeyID:            record.APIKeyID,
		APIKeyFingerprint:   record.APIKeyFingerprint,
		Endpoint:            record.Endpoint,
		Method:              record.Method,
		Model:               record.Model,
		RequestedModel:      record.RequestedModel,
		UpstreamModel:       record.UpstreamModel,
		ResponseModel:       record.ResponseModel,
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
		RequestHeaders:      record.RequestHeaders,
		RequestBody:         record.RequestBody,
		ResponseHeaders:     record.ResponseHeaders,
		ResponseBody:        record.ResponseBody,
		RequestBytes:        record.RequestBytes,
		ResponseBytes:       record.ResponseBytes,
		ResponseChunks:      record.ResponseChunks,
		Truncated:           record.Truncated,
		DurationMS:          record.DurationMS,
		CreatedAt:           record.CreatedAt,
		CompletedAt:         completedAt,
	}
}

func toModelProxyAuditSummaryResponse(summary mcpgateway.ModelProxyAuditSummary) modelProxyAuditSummaryResponse {
	return modelProxyAuditSummaryResponse{
		UserID:                summary.UserID,
		UserNameSnapshot:      summary.UserNameSnapshot,
		Model:                 summary.Model,
		RequestCount:          summary.RequestCount,
		SucceededCount:        summary.SucceededCount,
		UsageCompleteCount:    summary.UsageCompleteCount,
		UsagePartialCount:     summary.UsagePartialCount,
		UsageUnavailableCount: summary.UsageUnavailableCount,
		UsageCoverageRate:     summary.UsageCoverageRate,
		InputTokens:           summary.InputTokens,
		OutputTokens:          summary.OutputTokens,
		TotalTokens:           summary.TotalTokens,
		CacheReadTokens:       summary.CacheReadTokens,
		CacheCreationTokens:   summary.CacheCreationTokens,
		ReasoningTokens:       summary.ReasoningTokens,
		UsageCount:            summary.UsageCount,
		SuccessRate:           summary.SuccessRate,
	}
}

func modelProxyAuditFilter(c *gin.Context) (mcpgateway.ModelProxyAuditFilter, error) {
	filter := mcpgateway.ModelProxyAuditFilter{
		Limit:       adminListLimit(c),
		UserID:      strings.TrimSpace(c.Query("user_id")),
		Model:       strings.TrimSpace(c.Query("model")),
		Endpoint:    strings.TrimSpace(c.Query("endpoint")),
		Status:      mcpgateway.ModelProxyAuditStatus(strings.TrimSpace(c.Query("status"))),
		UsageStatus: mcpgateway.ModelProxyUsageStatus(strings.TrimSpace(c.Query("usage_status"))),
		UsageSource: mcpgateway.ModelProxyUsageSource(strings.TrimSpace(c.Query("usage_source"))),
	}
	if raw := c.Query("error_only"); raw != "" {
		errorOnly, err := strconv.ParseBool(raw)
		if err != nil {
			return mcpgateway.ModelProxyAuditFilter{}, err
		}
		filter.ErrorOnly = errorOnly
	}
	if raw := c.Query("created_from"); raw != "" {
		value, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return mcpgateway.ModelProxyAuditFilter{}, err
		}
		filter.CreatedFrom = value
	}
	if raw := c.Query("created_to"); raw != "" {
		value, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return mcpgateway.ModelProxyAuditFilter{}, err
		}
		filter.CreatedTo = value
	}
	if raw := c.Query("cursor_created_at"); raw != "" {
		value, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return mcpgateway.ModelProxyAuditFilter{}, err
		}
		filter.CursorCreatedAt = value
		filter.CursorID = strings.TrimSpace(c.Query("cursor_id"))
	}
	return filter, nil
}

func modelProxyAuditSummaryFilter(c *gin.Context) (mcpgateway.ModelProxyAuditSummaryFilter, error) {
	filter := mcpgateway.ModelProxyAuditSummaryFilter{
		UserID:      strings.TrimSpace(c.Query("user_id")),
		Model:       strings.TrimSpace(c.Query("model")),
		Endpoint:    strings.TrimSpace(c.Query("endpoint")),
		Status:      mcpgateway.ModelProxyAuditStatus(strings.TrimSpace(c.Query("status"))),
		UsageStatus: mcpgateway.ModelProxyUsageStatus(strings.TrimSpace(c.Query("usage_status"))),
		UsageSource: mcpgateway.ModelProxyUsageSource(strings.TrimSpace(c.Query("usage_source"))),
	}
	if raw := c.Query("error_only"); raw != "" {
		errorOnly, err := strconv.ParseBool(raw)
		if err != nil {
			return mcpgateway.ModelProxyAuditSummaryFilter{}, err
		}
		filter.ErrorOnly = errorOnly
	}
	if raw := c.Query("created_from"); raw != "" {
		value, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return mcpgateway.ModelProxyAuditSummaryFilter{}, err
		}
		filter.CreatedFrom = value
	}
	if raw := c.Query("created_to"); raw != "" {
		value, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return mcpgateway.ModelProxyAuditSummaryFilter{}, err
		}
		filter.CreatedTo = value
	}
	return filter, nil
}

func mountAdminModelProxyAuditRoutes(admin *gin.RouterGroup, opts Options) {
	if modelAccessMode(opts) != ModelAccessPlatformManaged {
		return
	}
	admin.GET("/model-proxy/audits", requirePermission(opts.RBACService, rbac.PermissionMCPAuditRead), func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		filter, err := modelProxyAuditFilter(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		page, err := opts.ProxyGateway.Store().ListModelProxyAuditRecords(c.Request.Context(), filter)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		items := make([]modelProxyAuditResponse, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, toModelProxyAuditResponse(item))
		}
		c.JSON(http.StatusOK, gin.H{
			"items": items,
			"meta": gin.H{
				"next_created_at": nullableTimeValue(page.NextCreatedAt),
				"next_id":         page.NextID,
				"has_next":        page.NextID != "",
			},
		})
	})

	admin.GET("/model-proxy/audits/detail", requirePermission(opts.RBACService, rbac.PermissionMCPAuditRead), func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		id := strings.TrimSpace(c.Query("audit_id"))
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "audit_id is required"})
			return
		}
		item, err := opts.ProxyGateway.Store().GetModelProxyAuditRecord(c.Request.Context(), id)
		if err != nil {
			if err == mcpgateway.ErrModelProxyAuditNotFound {
				c.JSON(http.StatusNotFound, gin.H{"error": "audit not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, toModelProxyAuditResponse(item))
	})

	admin.GET("/model-proxy/audits/summary", requirePermission(opts.RBACService, rbac.PermissionMCPAuditRead), func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		filter, err := modelProxyAuditSummaryFilter(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		items, err := opts.ProxyGateway.Store().SummarizeModelProxyAuditRecords(c.Request.Context(), filter)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		out := make([]modelProxyAuditSummaryResponse, 0, len(items))
		for _, item := range items {
			out = append(out, toModelProxyAuditSummaryResponse(item))
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	})
}

func nullableTimeValue(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}
