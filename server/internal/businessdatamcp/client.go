package businessdatamcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type accessService interface {
	HasAction(context.Context, string, string, string, string) (bool, error)
	List(context.Context, dataaccess.Filter) ([]dataaccess.Grant, error)
}

type Client struct {
	service *businessdata.DashboardService
	access  accessService
	schemas map[string]mcpgateway.JSONMap
}

func NewClient(service *businessdata.DashboardService, access accessService) (*Client, error) {
	if access == nil {
		return nil, errors.New("business data access service is required")
	}
	return &Client{service: service, access: access, schemas: inputSchemas()}, nil
}

func (c *Client) ListTools(context.Context, mcpgateway.UpstreamServer, string) ([]mcpgateway.UpstreamTool, error) {
	annotations := readOnlyAnnotations()
	outputs := outputSchemas()
	return []mcpgateway.UpstreamTool{
		{Name: ToolViews, Title: "查询可用业务看板", Description: "发现当前账户已获数据视图授权的业务看板及数据状态", InputSchema: c.schemas[ToolViews], OutputSchema: outputs[ToolViews], Annotations: annotations},
		{Name: ToolDashboard, Title: "查询业务看板", Description: "查询指定业务数据视图的汇总、趋势和 Top 项目；B 站看板可通过 source_id 查询单个账号", InputSchema: c.schemas[ToolDashboard], OutputSchema: outputs[ToolDashboard], Annotations: annotations},
		{Name: ToolCompare, Title: "比较业务指标", Description: "比较当前周期与紧邻上一等长周期的业务指标；B 站看板可通过 source_id 查询单个账号", InputSchema: c.schemas[ToolCompare], OutputSchema: outputs[ToolCompare], Annotations: annotations},
		{Name: ToolMetricExplain, Title: "解释业务指标", Description: "查询指定业务视图内指标的固定定义和统计口径", InputSchema: c.schemas[ToolMetricExplain], OutputSchema: outputs[ToolMetricExplain], Annotations: annotations},
	}, nil
}

func (c *Client) CallTool(ctx context.Context, req mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	schema, ok := c.schemas[req.Capability.UpstreamName]
	if !ok {
		return mcpgateway.UpstreamCallResult{}, errors.New("unsupported business data tool")
	}
	arguments := req.Arguments
	if arguments == nil {
		arguments = mcpgateway.JSONMap{}
	}
	if err := mcpgateway.ValidateInput(schema, arguments); err != nil {
		return toolError("invalid_input", "参数不合法", false), nil
	}
	userID := strings.TrimSpace(req.Caller.UserID)
	if userID == "" {
		return toolError("data_view_forbidden", "无权查询该数据视图", false), nil
	}
	if req.Capability.UpstreamName == ToolViews {
		return c.views(ctx, userID)
	}
	viewID := strings.TrimSpace(arguments["view_id"].(string))
	allowed, err := c.access.HasAction(ctx, userID, dataaccess.ResourceDataView, viewID, dataaccess.ActionRead)
	if err != nil {
		return toolError("data_unavailable", "数据授权服务暂不可用", true), nil
	}
	if !allowed {
		return toolError("data_view_forbidden", "无权查询该数据视图", false), nil
	}
	sourceID := stringArgument(arguments, "source_id", "")
	if _, supplied := arguments["source_id"]; supplied && sourceID == "" {
		return toolError("invalid_input", "source_id 不能为空", false), nil
	}
	if sourceID != "" && viewID != businessdata.ViewBilibiliOperation {
		return toolError("invalid_input", "source_id 仅适用于 B 站运营看板", false), nil
	}

	switch req.Capability.UpstreamName {
	case ToolDashboard:
		if c.service == nil {
			return toolError("data_unavailable", "业务数据服务暂不可用", true), nil
		}
		return c.dashboard(ctx, viewID, sourceID, stringArgument(arguments, "range", businessdata.Range7Days), intArgument(arguments, "top_n", 10)), nil
	case ToolCompare:
		if c.service == nil {
			return toolError("data_unavailable", "业务数据服务暂不可用", true), nil
		}
		response, err := c.service.Compare(ctx, businessdata.CompareRequest{ViewID: viewID, SourceID: sourceID, Range: stringArgument(arguments, "range", businessdata.Range7Days), MetricIDs: stringSlice(arguments["metric_ids"])})
		if errors.Is(err, businessdata.ErrMetricNotSupported) {
			return toolError("metric_not_supported", "指标不属于指定业务视图", false), nil
		}
		if err != nil {
			return businessError(err), nil
		}
		body := jsonMap(response)
		body["unavailable_parts"] = append([]string{}, response.UnavailableParts...)
		body["schema_version"] = 1
		return mcpgateway.UpstreamCallResult{StructuredContent: body}, nil
	case ToolMetricExplain:
		definitions, _ := businessdata.MetricDefinitions(viewID)
		byID := make(map[string]businessdata.MetricDefinition, len(definitions))
		for _, definition := range definitions {
			byID[definition.MetricID] = definition
		}
		metrics := make([]any, 0)
		for _, metricID := range stringSlice(arguments["metric_ids"]) {
			definition, exists := byID[metricID]
			if !exists {
				return toolError("metric_not_supported", "指标不属于指定业务视图", false), nil
			}
			metrics = append(metrics, jsonMap(definition))
		}
		return mcpgateway.UpstreamCallResult{StructuredContent: mcpgateway.JSONMap{"schema_version": 1, "view_id": viewID, "metrics": metrics}}, nil
	}
	return mcpgateway.UpstreamCallResult{}, errors.New("unsupported business data tool")
}

func (c *Client) views(ctx context.Context, userID string) (mcpgateway.UpstreamCallResult, error) {
	grants, err := c.access.List(ctx, dataaccess.Filter{UserID: userID, ResourceType: dataaccess.ResourceDataView, Action: dataaccess.ActionRead})
	if err != nil {
		return toolError("data_unavailable", "数据授权服务暂不可用", true), nil
	}
	granted := map[string]bool{}
	for _, grant := range grants {
		granted[grant.ResourceID] = true
	}
	viewIDs := make([]string, 0, len(supportedViews))
	for _, viewID := range supportedViews {
		if granted[viewID] {
			viewIDs = append(viewIDs, viewID)
		}
	}
	if c.service == nil {
		return toolError("data_unavailable", "业务数据服务暂不可用", true), nil
	}
	overview, err := c.service.Overview(ctx, viewIDs, businessdata.Range7Days)
	if err != nil {
		return toolError("data_unavailable", "业务数据暂不可用", true), nil
	}
	views := make([]any, 0, len(overview))
	for _, item := range overview {
		view := mcpgateway.JSONMap{
			"view_id": item.ViewID, "name": viewNames[item.ViewID], "data_status": item.DataStatus,
			"last_synced_at": item.LastSyncedAt, "supported_ranges": []any{"today", "7d", "30d"}, "unavailable_parts": append([]string{}, item.UnavailableParts...),
		}
		if item.ViewID == businessdata.ViewBilibiliOperation {
			accounts, err := c.service.BilibiliSources(ctx)
			if err != nil {
				return toolError("data_unavailable", "B 站账号列表暂不可用", true), nil
			}
			view["accounts"] = bilibiliAccounts(accounts)
		}
		views = append(views, view)
	}
	r, generatedAt, err := c.service.QueryRange(businessdata.Range7Days)
	if err != nil {
		return toolError("data_unavailable", "业务数据暂不可用", true), nil
	}
	return mcpgateway.UpstreamCallResult{StructuredContent: mcpgateway.JSONMap{
		"schema_version": 1, "data_status": "available", "generated_at": generatedAt.Format(time.RFC3339Nano), "timezone": businessdata.Timezone,
		"range": r.Name, "start_date": r.StartDate.Format("2006-01-02"), "end_date": r.EndDate.Format("2006-01-02"), "views": views,
	}}, nil
}

func (c *Client) dashboard(ctx context.Context, viewID, sourceID, requestedRange string, topN int) mcpgateway.UpstreamCallResult {
	var body mcpgateway.JSONMap
	switch viewID {
	case businessdata.ViewXiaohongshuOperation:
		response, err := c.service.Xiaohongshu(ctx, requestedRange)
		if err != nil {
			return businessError(err)
		}
		if len(response.TopItems) > topN {
			response.TopItems = response.TopItems[:topN]
		}
		body = jsonMap(response)
	case businessdata.ViewDouyinAds:
		response, err := c.service.DouyinAds(ctx, requestedRange)
		if err != nil {
			return businessError(err)
		}
		if len(response.TopItems) > topN {
			response.TopItems = response.TopItems[:topN]
		}
		body = jsonMap(response)
	case businessdata.ViewBilibiliOperation:
		var response businessdata.BilibiliDashboardResponse
		var err error
		if sourceID == "" {
			response, err = c.service.BilibiliView(ctx, requestedRange)
		} else {
			response, err = c.service.Bilibili(ctx, sourceID, requestedRange)
		}
		if err != nil {
			return businessError(err)
		}
		body = mcpgateway.JSONMap{
			"view_id": viewID, "data_status": response.Status, "range": response.Range, "timezone": response.Timezone,
			"start_date": response.StartDate, "end_date": response.EndDate, "generated_at": response.GeneratedAt.Format(time.RFC3339Nano), "last_synced_at": response.LastSyncedAt,
			"summary": nil, "trend": []any{}, "top_items": []any{}, "unavailable_parts": append([]string{}, response.UnavailableParts...),
		}
		if response.Data != nil {
			data := jsonMap(response.Data)
			trend := data["trend"]
			topItems, _ := data["top_contents"].([]any)
			if len(topItems) > topN {
				topItems = topItems[:topN]
			}
			delete(data, "trend")
			delete(data, "top_contents")
			body["summary"], body["trend"], body["top_items"], body["account"] = data, trend, topItems, jsonMap(response.Account)
		}
	default:
		return toolError("invalid_input", "参数不合法", false)
	}
	if body["unavailable_parts"] == nil {
		body["unavailable_parts"] = []any{}
	}
	body["schema_version"] = 1
	return mcpgateway.UpstreamCallResult{StructuredContent: body}
}

func businessError(err error) mcpgateway.UpstreamCallResult {
	if errors.Is(err, businessdata.ErrInvalidRequest) {
		return toolError("invalid_input", "参数不合法", false)
	}
	if errors.Is(err, businessdata.ErrNotFound) {
		return toolError("data_unconfigured", "业务数据源尚未配置", false)
	}
	return toolError("data_unavailable", "业务数据暂不可用", true)
}

func toolError(code, message string, retryable bool) mcpgateway.UpstreamCallResult {
	return mcpgateway.UpstreamCallResult{IsError: true, StructuredContent: mcpgateway.JSONMap{"code": code, "message": message, "retryable": retryable}}
}

func jsonMap(value any) mcpgateway.JSONMap {
	raw, _ := json.Marshal(value)
	var result mcpgateway.JSONMap
	_ = json.Unmarshal(raw, &result)
	if result == nil {
		result = mcpgateway.JSONMap{}
	}
	return result
}

func bilibiliAccounts(items []businessdata.BilibiliSourceItem) []any {
	result := make([]any, 0, len(items))
	for _, item := range items {
		result = append(result, mcpgateway.JSONMap{
			"source_id": item.SourceID, "name": item.Name, "status": item.Status,
			"status_reason": item.StatusReason, "last_success_at": item.LastSuccessAt,
		})
	}
	return result
}

func stringArgument(arguments mcpgateway.JSONMap, key, fallback string) string {
	value, _ := arguments[key].(string)
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

func intArgument(arguments mcpgateway.JSONMap, key string, fallback int) int {
	if value, ok := arguments[key].(int); ok {
		return value
	}
	if value, ok := arguments[key].(float64); ok {
		return int(value)
	}
	return fallback
}

func stringSlice(value any) []string {
	if typed, ok := value.([]string); ok {
		return append([]string(nil), typed...)
	}
	raw, _ := value.([]any)
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}
