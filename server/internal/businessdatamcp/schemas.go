package businessdatamcp

import "github.com/krillinai/Clawee/server/internal/mcpgateway"

func inputSchemas() map[string]mcpgateway.JSONMap {
	viewProperty := mcpgateway.JSONMap{"type": "string", "enum": []any{"xiaohongshu_operation", "douyin_ads", "bilibili_operation"}}
	rangeProperty := mcpgateway.JSONMap{"type": "string", "enum": []any{"today", "7d", "30d"}, "default": "7d"}
	sourceProperty := mcpgateway.JSONMap{"type": "string", "minLength": 1, "description": "B 站数据源 ID；仅用于 bilibili_operation，不传时查询全部 B 站账号汇总"}
	return map[string]mcpgateway.JSONMap{
		ToolViews: {"type": "object", "additionalProperties": false, "properties": mcpgateway.JSONMap{}},
		ToolDashboard: {"type": "object", "additionalProperties": false, "required": []any{"view_id"}, "properties": mcpgateway.JSONMap{
			"view_id": viewProperty, "source_id": sourceProperty, "range": rangeProperty, "top_n": mcpgateway.JSONMap{"type": "integer", "minimum": 1, "maximum": 20, "default": 10},
		}},
		ToolCompare: {"type": "object", "additionalProperties": false, "required": []any{"view_id", "metric_ids"}, "properties": mcpgateway.JSONMap{
			"view_id": viewProperty, "source_id": sourceProperty, "range": rangeProperty,
			"metric_ids": mcpgateway.JSONMap{"type": "array", "minItems": 1, "maxItems": 10, "uniqueItems": true, "items": mcpgateway.JSONMap{"type": "string"}},
		}},
		ToolMetricExplain: {"type": "object", "additionalProperties": false, "required": []any{"view_id", "metric_ids"}, "properties": mcpgateway.JSONMap{
			"view_id":    viewProperty,
			"metric_ids": mcpgateway.JSONMap{"type": "array", "minItems": 1, "maxItems": 20, "uniqueItems": true, "items": mcpgateway.JSONMap{"type": "string"}},
		}},
	}
}

func queryProperties() mcpgateway.JSONMap {
	return mcpgateway.JSONMap{
		"schema_version": mcpgateway.JSONMap{"type": "integer", "const": 1},
		"data_status":    mcpgateway.JSONMap{"type": "string", "enum": []any{"available", "partial", "unconfigured", "unavailable"}},
		"generated_at":   mcpgateway.JSONMap{"type": "string", "format": "date-time"}, "timezone": mcpgateway.JSONMap{"type": "string"},
		"range": mcpgateway.JSONMap{"type": "string", "enum": []any{"today", "7d", "30d"}}, "start_date": mcpgateway.JSONMap{"type": "string"}, "end_date": mcpgateway.JSONMap{"type": "string"},
	}
}

func outputSchemas() map[string]mcpgateway.JSONMap {
	commonRequired := []any{"schema_version", "data_status", "generated_at", "timezone", "range", "start_date", "end_date"}
	viewsProperties := queryProperties()
	viewsProperties["views"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"view_id", "name", "data_status", "last_synced_at", "supported_ranges", "unavailable_parts"}, "properties": mcpgateway.JSONMap{
		"view_id": mcpgateway.JSONMap{"type": "string"}, "name": mcpgateway.JSONMap{"type": "string"}, "data_status": mcpgateway.JSONMap{"type": "string", "enum": []any{"available", "partial", "unconfigured", "unavailable"}},
		"last_synced_at": mcpgateway.JSONMap{"type": []any{"string", "null"}}, "supported_ranges": mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "string"}}, "unavailable_parts": mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "string"}},
		"accounts": mcpgateway.JSONMap{"type": "array", "items": bilibiliAccountSchema()},
	}}}
	dashboardProperties := queryProperties()
	dashboardProperties["view_id"] = mcpgateway.JSONMap{"type": "string"}
	dashboardProperties["last_synced_at"] = mcpgateway.JSONMap{"type": []any{"string", "null"}}
	dashboardProperties["summary"] = mcpgateway.JSONMap{"type": []any{"object", "null"}}
	dashboardProperties["trend"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object"}}
	dashboardProperties["top_items"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object"}}
	dashboardProperties["account"] = bilibiliAccountSchema()
	dashboardProperties["unavailable_parts"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "string"}}
	compareProperties := queryProperties()
	compareProperties["view_id"] = mcpgateway.JSONMap{"type": "string"}
	compareProperties["previous_start_date"] = mcpgateway.JSONMap{"type": "string"}
	compareProperties["previous_end_date"] = mcpgateway.JSONMap{"type": "string"}
	compareProperties["last_synced_at"] = mcpgateway.JSONMap{"type": []any{"string", "null"}}
	compareProperties["metrics"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"metric_id", "current_value", "previous_value", "absolute_change", "change_rate", "unit"}, "properties": mcpgateway.JSONMap{
		"metric_id": mcpgateway.JSONMap{"type": "string"}, "current_value": mcpgateway.JSONMap{"type": "integer"}, "previous_value": mcpgateway.JSONMap{"type": "integer"},
		"absolute_change": mcpgateway.JSONMap{"type": "integer"}, "change_rate": mcpgateway.JSONMap{"type": []any{"number", "null"}}, "unit": mcpgateway.JSONMap{"type": "string"},
	}}}
	compareProperties["unavailable_parts"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "string"}}
	compareProperties["account"] = bilibiliAccountSchema()
	return map[string]mcpgateway.JSONMap{
		ToolViews:         {"type": "object", "additionalProperties": false, "required": append(commonRequired, "views"), "properties": viewsProperties},
		ToolDashboard:     {"type": "object", "additionalProperties": false, "required": append(commonRequired, "view_id", "last_synced_at", "summary", "trend", "top_items", "unavailable_parts"), "properties": dashboardProperties},
		ToolCompare:       {"type": "object", "additionalProperties": false, "required": append(commonRequired, "view_id", "previous_start_date", "previous_end_date", "last_synced_at", "metrics", "unavailable_parts"), "properties": compareProperties},
		ToolMetricExplain: metricOutputSchema(),
	}
}

func bilibiliAccountSchema() mcpgateway.JSONMap {
	return mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"source_id", "name", "status", "status_reason", "last_success_at"}, "properties": mcpgateway.JSONMap{
		"source_id": mcpgateway.JSONMap{"type": "string"}, "name": mcpgateway.JSONMap{"type": "string"}, "status": mcpgateway.JSONMap{"type": "string"},
		"status_reason": mcpgateway.JSONMap{"type": "string"}, "last_success_at": mcpgateway.JSONMap{"type": []any{"string", "null"}},
	}}
}

func metricOutputSchema() mcpgateway.JSONMap {
	return mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"schema_version", "view_id", "metrics"}, "properties": mcpgateway.JSONMap{
		"schema_version": mcpgateway.JSONMap{"type": "integer", "const": 1}, "view_id": mcpgateway.JSONMap{"type": "string"},
		"metrics": mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"metric_id", "label", "description", "unit", "aggregation", "data_source", "time_scope", "value_type", "missing_data_rule", "comparable"}, "properties": mcpgateway.JSONMap{
			"metric_id": mcpgateway.JSONMap{"type": "string"}, "label": mcpgateway.JSONMap{"type": "string"}, "description": mcpgateway.JSONMap{"type": "string"}, "unit": mcpgateway.JSONMap{"type": "string"},
			"aggregation": mcpgateway.JSONMap{"type": "string"}, "data_source": mcpgateway.JSONMap{"type": "string"}, "time_scope": mcpgateway.JSONMap{"type": "string"}, "value_type": mcpgateway.JSONMap{"type": "string"},
			"missing_data_rule": mcpgateway.JSONMap{"type": "string"}, "comparable": mcpgateway.JSONMap{"type": "boolean"},
		}}},
	}}
}

func readOnlyAnnotations() mcpgateway.JSONMap {
	return mcpgateway.JSONMap{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
}
