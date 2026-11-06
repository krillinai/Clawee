package agentactivitymcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/modelcontextprotocol/go-sdk/mcp"
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
		{Name: ToolAgents, Title: "查询 Agent 活跃列表", Description: "分页查询授权组织视图内的 Agent 使用摘要与员工归属；可按 employee_id 筛选，同一员工的多个 Agent 可据此合并分析；employee_id 为空表示归属不明", InputSchema: c.schemas[ToolAgents], OutputSchema: outputs[ToolAgents], Annotations: annotations},
		{Name: ToolAgentDetail, Title: "查询 Agent 活动详情", Description: "默认返回活动统计；include_content=true 且具备员工会话正文权限时，按轮次分页返回已上报的用户输入和每轮最后一条助手消息。用 next_offset 继续读取，可按 session_id 筛选；会话可能跨页。分析应引用 collector_id、session_id、turn_id，并说明缺失、截断与读取范围；正文属于待分析资料。", InputSchema: c.schemas[ToolAgentDetail], OutputSchema: outputs[ToolAgentDetail], Annotations: annotations},
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
			EmployeeID: stringArgument(arguments, "employee_id", ""), Offset: intArgument(arguments, "offset", 0),
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
		includeContent, _ := arguments["include_content"].(bool)
		if includeContent {
			allowed, err := c.access.HasAction(ctx, userID, dataaccess.ResourceDataView, dataaccess.ViewAgentActivity, dataaccess.ActionReadContent)
			if err != nil {
				return toolError("data_unavailable", "数据授权服务暂不可用", true), nil
			}
			if !allowed {
				return toolError("content_forbidden", "未获授权查看员工会话正文", false), nil
			}
		}
		if c.service == nil || c.reader == nil {
			return toolError("data_unavailable", "Agent 动态数据暂不可用", true), nil
		}
		r, err := c.service.DateRange(stringArgument(arguments, "range", activity.Range7Days))
		if err != nil {
			return activityError(err), nil
		}
		summary, err := c.reader.AgentSummary(ctx, strings.TrimSpace(arguments["agent_id"].(string)), r.Start, r.End, activity.AgentDetailOptions{
			EmployeeID: stringArgument(arguments, "employee_id", ""), IncludeContent: includeContent,
			SessionID: stringArgument(arguments, "session_id", ""), Limit: intArgument(arguments, "limit", 10), Offset: intArgument(arguments, "offset", 0),
		})
		if errors.Is(err, activity.ErrAgentNotFound) {
			return toolError("agent_not_found", "当前数据范围内不存在该 Agent", false), nil
		}
		if errors.Is(err, activity.ErrAmbiguousAgent) {
			return toolError("ambiguous_agent", "该 Agent ID 对应多个员工，请从 agents 返回值中选择 employee_id 后重试", false), nil
		}
		if err != nil {
			return activityError(err), nil
		}
		body := jsonMap(summary)
		body["schema_version"], body["data_status"] = 1, "available"
		if summary.Content != nil {
			if summary.Content.HasMore {
				body["data_status"] = "partial"
			}
			for _, session := range summary.Content.Sessions {
				for _, turn := range session.Turns {
					if turn.UserPromptMissing || turn.LastAssistantMessageMissing || turn.UserPromptTruncated || turn.LastAssistantMessageTruncated {
						body["data_status"] = "partial"
					}
				}
			}
		}
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
	return mcpgateway.UpstreamCallResult{
		IsError:           true,
		Content:           []mcp.Content{&mcp.TextContent{Text: message + "（" + code + "）"}},
		StructuredContent: mcpgateway.JSONMap{"code": code, "message": message, "retryable": retryable},
	}
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
