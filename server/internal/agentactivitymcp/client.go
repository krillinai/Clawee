package agentactivitymcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type accessService interface {
	HasAction(context.Context, string, string, string, string) (bool, error)
}

type Client struct {
	service *activity.Service
	reader  activity.AgentSummaryReader
	access  accessService
	schemas map[string]mcpgateway.JSONMap
}

func NewClient(service *activity.Service, reader activity.AgentSummaryReader, access accessService) (*Client, error) {
	if access == nil {
		return nil, errors.New("agent activity data access service is required")
	}
	return &Client{service: service, reader: reader, access: access, schemas: inputSchemas()}, nil
}

func (c *Client) ListTools(context.Context, mcpgateway.UpstreamServer, string) ([]mcpgateway.UpstreamTool, error) {
	annotations := readOnlyAnnotations()
	outputs := outputSchemas()
	return []mcpgateway.UpstreamTool{
		{Name: ToolSummary, Title: "查询 Agent 动态总览", Description: "查询授权组织视图内的 Agent 活跃、Token、模型和 MCP 使用总览", InputSchema: c.schemas[ToolSummary], OutputSchema: outputs[ToolSummary], Annotations: annotations},
		{Name: ToolAgents, Title: "查询 Agent 活跃列表", Description: "按确定性规则查询和排序授权组织视图内的 Agent 活跃摘要", InputSchema: c.schemas[ToolAgents], OutputSchema: outputs[ToolAgents], Annotations: annotations},
		{Name: ToolAgentDetail, Title: "查询 Agent 活动摘要", Description: "查询单个 Agent 的非敏感活动计数和最近状态，不返回正文", InputSchema: c.schemas[ToolAgentDetail], OutputSchema: outputs[ToolAgentDetail], Annotations: annotations},
		{Name: ToolMetricExplain, Title: "解释 Agent 动态指标", Description: "查询 Agent 动态指标的固定定义和统计口径", InputSchema: c.schemas[ToolMetricExplain], OutputSchema: outputs[ToolMetricExplain], Annotations: annotations},
	}, nil
}

func (c *Client) CallTool(ctx context.Context, req mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	schema, ok := c.schemas[req.Capability.UpstreamName]
	if !ok {
		return mcpgateway.UpstreamCallResult{}, errors.New("unsupported agent activity tool")
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
	allowed, err := c.access.HasAction(ctx, userID, dataaccess.ResourceDataView, dataaccess.ViewAgentActivity, dataaccess.ActionRead)
	if err != nil {
		return toolError("data_unavailable", "数据授权服务暂不可用", true), nil
	}
	if !allowed {
		return toolError("data_view_forbidden", "无权查询该数据视图", false), nil
	}

	switch req.Capability.UpstreamName {
	case ToolSummary:
		if c.service == nil {
			return toolError("data_unavailable", "Agent 动态数据暂不可用", true), nil
		}
		statistics, err := c.service.Statistics(ctx, stringArgument(arguments, "range", activity.Range7Days))
		if err != nil {
			return activityError(err), nil
		}
		body := jsonMap(statistics)
		delete(body, "agents")
		body["schema_version"] = 1
		body["source_status"] = body["data_status"]
		body["data_status"] = overallActivityStatus(statistics.DataStatus)
		return mcpgateway.UpstreamCallResult{StructuredContent: body}, nil
	case ToolAgents:
		if c.service == nil {
			return toolError("data_unavailable", "Agent 动态数据暂不可用", true), nil
		}
		result, err := c.service.Agents(ctx, activity.AgentListRequest{
			Range: stringArgument(arguments, "range", activity.Range7Days), SortBy: stringArgument(arguments, "sort_by", activity.SortByTurnCount), Limit: intArgument(arguments, "limit", 10),
		})
		if err != nil {
			return activityError(err), nil
		}
		body := jsonMap(result)
		body["schema_version"] = 1
		body["source_status"] = body["data_status"]
		body["data_status"] = overallActivityStatus(result.DataStatus)
		return mcpgateway.UpstreamCallResult{StructuredContent: body}, nil
	case ToolAgentDetail:
		if c.service == nil || c.reader == nil {
			return toolError("data_unavailable", "Agent 动态数据暂不可用", true), nil
		}
		r, err := c.service.DateRange(stringArgument(arguments, "range", activity.Range7Days))
		if err != nil {
			return activityError(err), nil
		}
		summary, err := c.reader.AgentSummary(ctx, strings.TrimSpace(arguments["agent_id"].(string)), r.Start, r.End)
		if errors.Is(err, activity.ErrAgentNotFound) {
			return toolError("agent_not_found", "当前数据范围内不存在该 Agent", false), nil
		}
		if err != nil {
			return toolError("data_unavailable", "Agent 动态数据暂不可用", true), nil
		}
		body := jsonMap(summary)
		body["schema_version"], body["data_status"] = 1, "available"
		body["range"], body["timezone"], body["start_date"], body["end_date"], body["generated_at"] = r.Range, r.Timezone, r.StartDate, r.EndDate, r.GeneratedAt.Format("2006-01-02T15:04:05.999999999Z07:00")
		return mcpgateway.UpstreamCallResult{StructuredContent: body}, nil
	case ToolMetricExplain:
		ids := stringSlice(arguments["metric_ids"])
		metrics := make([]any, 0, len(ids))
		for _, id := range ids {
			definition, exists := metricCatalog[id]
			if !exists {
				return toolError("metric_not_supported", "指标不受支持", false), nil
			}
			metrics = append(metrics, jsonMap(definition))
		}
		return mcpgateway.UpstreamCallResult{StructuredContent: mcpgateway.JSONMap{"schema_version": 1, "metrics": metrics}}, nil
	}
	return mcpgateway.UpstreamCallResult{}, errors.New("unsupported agent activity tool")
}

func activityError(err error) mcpgateway.UpstreamCallResult {
	if errors.Is(err, activity.ErrInvalidRange) || errors.Is(err, activity.ErrInvalidAgentList) {
		return toolError("invalid_input", "参数不合法", false)
	}
	return toolError("data_unavailable", "Agent 动态数据暂不可用", true)
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

func stringArgument(arguments mcpgateway.JSONMap, key, fallback string) string {
	value, _ := arguments[key].(string)
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

func intArgument(arguments mcpgateway.JSONMap, key string, fallback int) int {
	value, ok := arguments[key].(int)
	if ok {
		return value
	}
	if numeric, ok := arguments[key].(float64); ok {
		return int(numeric)
	}
	return fallback
}

func stringSlice(value any) []string {
	raw, _ := value.([]any)
	if typed, ok := value.([]string); ok {
		return append([]string(nil), typed...)
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func overallActivityStatus(status map[string]string) string {
	available, unavailable, unconfigured := false, false, false
	for _, value := range status {
		switch value {
		case "available":
			available = true
		case "unavailable":
			unavailable = true
		default:
			unconfigured = true
		}
	}
	if available && (unavailable || unconfigured) {
		return "partial"
	}
	if available {
		return "available"
	}
	if unavailable {
		return "unavailable"
	}
	return "unconfigured"
}
