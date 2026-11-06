package skillcontributionsmcp

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

const ServerID = "skill-contributions"
const ToolQuery = "skill_contributions_query"
const ToolExport = "skill_contributions_export"
const Definitions = "上传按成功上传时间；首次通过按首次正式审核通过时间，每个 Skill ID 最多一条，归首次通过版本认证上传人。旧 Skill 历史无法确认不计入首次通过。仅完整人工四维分数参与平均，满分20，AI分及未评分不补零。概览不受状态和分数筛选影响。员工按稳定ID归组；不从截断分页计算全量汇总。名单仅为人事参考，不代表发奖。高分未指定门槛或员工重名时先澄清，不支持的条件明确失败。"

type Client struct {
	Service *skillhub.Service
	Access  *dataaccess.Service
}

func inputSchema(query bool) mcpgateway.JSONMap {
	properties := mcpgateway.JSONMap{
		"start_date": mcpgateway.JSONMap{"type": "string"}, "end_date": mcpgateway.JSONMap{"type": "string"},
		"report":          mcpgateway.JSONMap{"type": "string", "enum": []any{"uploads", "first_approvals", "employees"}},
		"employee_id":     mcpgateway.JSONMap{"type": "string", "minLength": 1},
		"status":          mcpgateway.JSONMap{"type": "string", "enum": []any{"pending", "approved", "rejected"}},
		"min_total_score": mcpgateway.JSONMap{"type": "number", "minimum": 0, "maximum": 20},
	}
	if query {
		properties["target"] = mcpgateway.JSONMap{"type": "string", "enum": []any{"summary", "records", "detail"}}
		properties["skill_id"] = mcpgateway.JSONMap{"type": "string", "minLength": 1}
		properties["version_id"] = mcpgateway.JSONMap{"type": "string", "minLength": 1}
		properties["page"] = mcpgateway.JSONMap{"type": "integer", "minimum": 1}
		properties["page_size"] = mcpgateway.JSONMap{"type": "integer", "minimum": 1, "maximum": 100}
	}
	return mcpgateway.JSONMap{"type": "object", "properties": properties, "additionalProperties": false}
}

func (c *Client) ListTools(context.Context, mcpgateway.UpstreamServer, string) ([]mcpgateway.UpstreamTool, error) {
	annotations := mcpgateway.JSONMap{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
	return []mcpgateway.UpstreamTool{
		{Name: ToolQuery, Title: "查询 Skill 贡献", Description: Definitions, InputSchema: inputSchema(true), Annotations: annotations},
		{Name: ToolExport, Title: "导出 Skill 贡献", Description: "校验条件，返回受控 CSV 下载描述；不返回链接、Token 或CSV正文。" + Definitions, InputSchema: inputSchema(false), Annotations: annotations},
	}, nil
}

func (c *Client) CallTool(ctx context.Context, request mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	isQuery := request.Capability.UpstreamName == ToolQuery
	if !isQuery && request.Capability.UpstreamName != ToolExport {
		return failure("invalid_input", "不支持该工具"), nil
	}
	if err := mcpgateway.ValidateInput(inputSchema(isQuery), request.Arguments); err != nil {
		return failure("invalid_input", "参数不合法"), nil
	}
	if c.Access == nil || request.Caller.UserID == "" {
		return failure("data_view_forbidden", "无权查询 Skill 贡献"), nil
	}
	allowed, err := c.Access.HasAction(ctx, request.Caller.UserID, dataaccess.ResourceDataView, dataaccess.ViewSkillContributions, dataaccess.ActionRead)
	if err != nil {
		return failure("data_unavailable", "数据授权暂不可用"), nil
	}
	if !allowed {
		return failure("data_view_forbidden", "无权查询 Skill 贡献"), nil
	}
	if c.Service == nil {
		return failure("data_unavailable", "Skill 贡献服务暂不可用"), nil
	}
	arguments := mcpgateway.JSONMap{}
	for key, value := range request.Arguments {
		arguments[key] = value
	}
	target, _ := arguments["target"].(string)
	delete(arguments, "target")
	if target == "" {
		target = "records"
	}
	var response skillhub.ContributionResponse
	if target == "detail" {
		skillID, _ := arguments["skill_id"].(string)
		versionID, _ := arguments["version_id"].(string)
		delete(arguments, "skill_id")
		delete(arguments, "version_id")
		if len(arguments) != 0 {
			return failure("invalid_input", "详情只支持 Skill ID 或版本 ID"), nil
		}
		response, err = c.Service.ContributionDetail(ctx, skillID, versionID)
	} else {
		if _, ok := arguments["skill_id"]; ok {
			return failure("invalid_input", "Skill ID 仅适用于详情"), nil
		}
		if _, ok := arguments["version_id"]; ok {
			return failure("invalid_input", "版本 ID 仅适用于详情"), nil
		}
		raw, _ := json.Marshal(arguments)
		var query skillhub.ContributionQuery
		if json.Unmarshal(raw, &query) != nil {
			return failure("invalid_input", "参数不合法"), nil
		}
		response, err = c.Service.Contributions(ctx, query, target == "summary", !isQuery)
	}
	if err != nil {
		if errors.Is(err, skillhub.ErrInvalidRequest) {
			return failure("invalid_input", "条件无效或不适用于该视图"), nil
		}
		if errors.Is(err, skillhub.ErrContributionLimit) {
			return failure("export_limit", "超过10,000行，请缩小周期或员工范围"), nil
		}
		if errors.Is(err, skillhub.ErrNotFound) {
			return failure("not_found", "没有对应审核记录"), nil
		}
		return failure("data_unavailable", "贡献数据暂不可用"), nil
	}
	raw, _ := json.Marshal(response)
	result := mcpgateway.JSONMap{}
	json.Unmarshal(raw, &result)
	result["definitions"] = Definitions
	if !isQuery {
		delete(result, "items")
		response.Query.Page, response.Query.PageSize = 0, 0
		raw, _ = json.Marshal(response.Query)
		query := mcpgateway.JSONMap{}
		json.Unmarshal(raw, &query)
		result["download"] = mcpgateway.JSONMap{"type": "skill_contributions_csv", "query": query}
	}
	return mcpgateway.UpstreamCallResult{StructuredContent: result}, nil
}
func failure(code, message string) mcpgateway.UpstreamCallResult {
	return mcpgateway.UpstreamCallResult{IsError: true, StructuredContent: mcpgateway.JSONMap{"code": code, "message": message}}
}
