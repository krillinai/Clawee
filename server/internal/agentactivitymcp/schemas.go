package agentactivitymcp

import "github.com/krillinai/Clawee/server/internal/mcpgateway"

func inputSchemas() map[string]mcpgateway.JSONMap {
	rangeProperty := mcpgateway.JSONMap{"type": "string", "enum": []any{"today", "7d", "30d"}, "default": "7d"}
	return map[string]mcpgateway.JSONMap{
		ToolSummary: {"type": "object", "additionalProperties": false, "properties": mcpgateway.JSONMap{"range": rangeProperty}},
		ToolAgents: {"type": "object", "additionalProperties": false, "properties": mcpgateway.JSONMap{
			"range":   rangeProperty,
			"sort_by": mcpgateway.JSONMap{"type": "string", "enum": []any{"turn_count", "session_count", "last_activity_at"}, "default": "turn_count"},
			"limit":   mcpgateway.JSONMap{"type": "integer", "minimum": 1, "maximum": 20, "default": 10},
		}},
		ToolAgentDetail: {"type": "object", "additionalProperties": false, "required": []any{"agent_id"}, "properties": mcpgateway.JSONMap{
			"agent_id": mcpgateway.JSONMap{"type": "string", "minLength": 1, "maxLength": 128}, "range": rangeProperty,
		}},
		ToolMetricExplain: {"type": "object", "additionalProperties": false, "required": []any{"metric_ids"}, "properties": mcpgateway.JSONMap{
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
	usageSchema := mcpgateway.JSONMap{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"},
		"properties": mcpgateway.JSONMap{
			"input_tokens":        mcpgateway.JSONMap{"type": "integer"},
			"cached_input_tokens": mcpgateway.JSONMap{"type": "integer"},
			"output_tokens":       mcpgateway.JSONMap{"type": "integer"},
			"total_tokens":        mcpgateway.JSONMap{"type": "integer"},
		},
	}
	sourceStatusSchema := mcpgateway.JSONMap{"type": "object", "additionalProperties": mcpgateway.JSONMap{"type": "string"}}
	trendPointSchema := mcpgateway.JSONMap{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"bucket_start", "input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"},
		"properties": mcpgateway.JSONMap{
			"bucket_start":        mcpgateway.JSONMap{"type": "string", "format": "date-time"},
			"input_tokens":        mcpgateway.JSONMap{"type": "integer"},
			"cached_input_tokens": mcpgateway.JSONMap{"type": "integer"},
			"output_tokens":       mcpgateway.JSONMap{"type": "integer"},
			"total_tokens":        mcpgateway.JSONMap{"type": "integer"},
		},
	}
	modelUsageSchema := mcpgateway.JSONMap{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"model", "requests", "input_tokens", "cached_input_tokens", "output_tokens", "total_tokens", "share"},
		"properties": mcpgateway.JSONMap{
			"model":               mcpgateway.JSONMap{"type": "string"},
			"requests":            mcpgateway.JSONMap{"type": "integer"},
			"input_tokens":        mcpgateway.JSONMap{"type": "integer"},
			"cached_input_tokens": mcpgateway.JSONMap{"type": "integer"},
			"output_tokens":       mcpgateway.JSONMap{"type": "integer"},
			"total_tokens":        mcpgateway.JSONMap{"type": "integer"},
			"share":               mcpgateway.JSONMap{"type": "number"},
		},
	}
	summaryProperties := queryProperties()
	summaryProperties["source_status"] = sourceStatusSchema
	summaryProperties["organization"] = mcpgateway.JSONMap{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"usage", "active_employees", "active_agents", "completed_turns", "mcp_distribution"},
		"properties": mcpgateway.JSONMap{
			"usage":            usageSchema,
			"active_employees": mcpgateway.JSONMap{"type": "integer"},
			"active_agents":    mcpgateway.JSONMap{"type": "integer"},
			"completed_turns":  mcpgateway.JSONMap{"type": "integer"},
			"mcp_distribution": mcpgateway.JSONMap{
				"type": "array",
				"items": mcpgateway.JSONMap{
					"type":                 "object",
					"additionalProperties": false,
					"required":             []any{"id", "label", "invocation_count", "share"},
					"properties": mcpgateway.JSONMap{
						"id":               mcpgateway.JSONMap{"type": "string"},
						"label":            mcpgateway.JSONMap{"type": "string"},
						"invocation_count": mcpgateway.JSONMap{"type": "integer"},
						"share":            mcpgateway.JSONMap{"type": "number"},
					},
				},
			},
		},
	}
	summaryProperties["trend"] = mcpgateway.JSONMap{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"granularity", "points"},
		"properties": mcpgateway.JSONMap{
			"granularity": mcpgateway.JSONMap{"type": "string"},
			"points":      mcpgateway.JSONMap{"type": "array", "items": trendPointSchema},
		},
	}
	summaryProperties["model_distribution"] = mcpgateway.JSONMap{"type": "array", "items": modelUsageSchema}
	summaryProperties["token_usage_ranking"] = mcpgateway.JSONMap{
		"type": "array",
		"items": mcpgateway.JSONMap{
			"type":                 "object",
			"additionalProperties": false,
			"required":             []any{"rank", "name", "requests", "total_tokens"},
			"properties": mcpgateway.JSONMap{
				"rank":         mcpgateway.JSONMap{"type": "integer"},
				"name":         mcpgateway.JSONMap{"type": "string"},
				"requests":     mcpgateway.JSONMap{"type": "integer"},
				"total_tokens": mcpgateway.JSONMap{"type": "integer"},
			},
		},
	}
	agentsProperties := queryProperties()
	agentsProperties["source_status"] = sourceStatusSchema
	agentsProperties["sort_by"] = mcpgateway.JSONMap{"type": "string", "enum": []any{"turn_count", "session_count", "last_activity_at"}}
	agentsProperties["agents"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"agent_id", "name", "status", "session_count", "turn_count", "last_activity_at", "rank"}, "properties": mcpgateway.JSONMap{
		"agent_id": mcpgateway.JSONMap{"type": "string"}, "name": mcpgateway.JSONMap{"type": "string"}, "status": mcpgateway.JSONMap{"type": "string"},
		"session_count": mcpgateway.JSONMap{"type": "integer"}, "turn_count": mcpgateway.JSONMap{"type": "integer"}, "last_activity_at": mcpgateway.JSONMap{"type": []any{"string", "null"}}, "rank": mcpgateway.JSONMap{"type": "integer"},
	}}}
	detailProperties := queryProperties()
	for _, key := range []string{"agent_id", "name", "status"} {
		detailProperties[key] = mcpgateway.JSONMap{"type": "string"}
	}
	detailProperties["last_activity_at"] = mcpgateway.JSONMap{"type": []any{"string", "null"}}
	for _, key := range []string{"session_count", "turn_count", "completed_turn_count", "tool_call_count", "mcp_call_count"} {
		detailProperties[key] = mcpgateway.JSONMap{"type": "integer"}
	}
	detailProperties["recent_activities"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"occurred_at", "type", "status"}, "properties": mcpgateway.JSONMap{
		"occurred_at": mcpgateway.JSONMap{"type": "string", "format": "date-time"}, "type": mcpgateway.JSONMap{"type": "string"}, "status": mcpgateway.JSONMap{"type": "string"},
	}}}
	return map[string]mcpgateway.JSONMap{
		ToolSummary:       {"type": "object", "additionalProperties": false, "required": append(commonRequired, "source_status", "organization", "trend", "model_distribution", "token_usage_ranking"), "properties": summaryProperties},
		ToolAgents:        {"type": "object", "additionalProperties": false, "required": append(commonRequired, "source_status", "sort_by", "agents"), "properties": agentsProperties},
		ToolAgentDetail:   {"type": "object", "additionalProperties": false, "required": append(commonRequired, "agent_id", "name", "status", "last_activity_at", "session_count", "turn_count", "completed_turn_count", "tool_call_count", "mcp_call_count", "recent_activities"), "properties": detailProperties},
		ToolMetricExplain: metricOutputSchema(),
	}
}

func metricOutputSchema() mcpgateway.JSONMap {
	return mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"schema_version", "metrics"}, "properties": mcpgateway.JSONMap{
		"schema_version": mcpgateway.JSONMap{"type": "integer", "const": 1}, "metrics": mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"metric_id", "label", "description", "unit", "aggregation", "scope", "data_source", "rules"}, "properties": mcpgateway.JSONMap{
			"metric_id": mcpgateway.JSONMap{"type": "string"}, "label": mcpgateway.JSONMap{"type": "string"}, "description": mcpgateway.JSONMap{"type": "string"}, "unit": mcpgateway.JSONMap{"type": "string"},
			"aggregation": mcpgateway.JSONMap{"type": "string"}, "scope": mcpgateway.JSONMap{"type": "string"}, "data_source": mcpgateway.JSONMap{"type": "string"}, "rules": mcpgateway.JSONMap{"type": "string"},
		}}},
	}}
}

func readOnlyAnnotations() mcpgateway.JSONMap {
	return mcpgateway.JSONMap{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
}
