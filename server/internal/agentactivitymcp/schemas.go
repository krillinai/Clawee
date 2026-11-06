package agentactivitymcp

import "github.com/krillinai/Clawee/server/internal/mcpgateway"

func inputSchemas() map[string]mcpgateway.JSONMap {
	rangeProperty := mcpgateway.JSONMap{"type": "string", "enum": []any{"today", "7d", "30d"}, "default": "7d"}
	return map[string]mcpgateway.JSONMap{
		ToolSummary: {"type": "object", "additionalProperties": false, "properties": mcpgateway.JSONMap{"range": rangeProperty}},
		ToolAgents: {"type": "object", "additionalProperties": false, "properties": mcpgateway.JSONMap{
			"range":       rangeProperty,
			"sort_by":     mcpgateway.JSONMap{"type": "string", "enum": []any{"turn_count", "session_count", "last_activity_at"}, "default": "turn_count"},
			"limit":       mcpgateway.JSONMap{"type": "integer", "minimum": 1, "maximum": 20, "default": 10},
			"offset":      mcpgateway.JSONMap{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0},
			"employee_id": mcpgateway.JSONMap{"type": "string", "minLength": 1, "maxLength": 128, "pattern": `\S`},
		}},
		ToolAgentDetail: {"type": "object", "additionalProperties": false, "required": []any{"agent_id"}, "properties": mcpgateway.JSONMap{
			"agent_id": mcpgateway.JSONMap{"type": "string", "minLength": 1, "maxLength": 128, "pattern": `\S`}, "range": rangeProperty,
			"employee_id":     mcpgateway.JSONMap{"type": "string", "minLength": 1, "maxLength": 128, "pattern": `\S`},
			"include_content": mcpgateway.JSONMap{"type": "boolean", "default": false},
			"session_id":      mcpgateway.JSONMap{"type": "string", "minLength": 1, "maxLength": 256, "pattern": `\S`},
			"limit":           mcpgateway.JSONMap{"type": "integer", "minimum": 1, "maximum": 20, "default": 10, "description": "正文每页轮次数，会话可能跨页"},
			"offset":          mcpgateway.JSONMap{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0},
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
		"required":             []any{"usage", "active_employees", "active_agents", "completed_turns", "platform_activity", "mcp_distribution", "skill_usage", "employee_skill_usage"},
		"properties": mcpgateway.JSONMap{
			"usage":            usageSchema,
			"active_employees": mcpgateway.JSONMap{"type": "integer"},
			"active_agents":    mcpgateway.JSONMap{"type": "integer"},
			"completed_turns":  mcpgateway.JSONMap{"type": "integer"},
			"platform_activity": mcpgateway.JSONMap{
				"type": "object", "additionalProperties": false,
				"required": []any{"active_users", "total_users", "rate"},
				"properties": mcpgateway.JSONMap{
					"active_users": mcpgateway.JSONMap{"type": "integer"},
					"total_users":  mcpgateway.JSONMap{"type": "integer"},
					"rate":         mcpgateway.JSONMap{"type": "number"},
				},
			},
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
			"skill_usage": mcpgateway.JSONMap{
				"type": "array",
				"items": mcpgateway.JSONMap{
					"type": "object", "additionalProperties": false,
					"required": []any{"skill_id", "skill_name", "skill_key", "source", "requested_runs", "observed_runs", "implicit_runs"},
					"properties": mcpgateway.JSONMap{
						"skill_id": mcpgateway.JSONMap{"type": "string"}, "skill_name": mcpgateway.JSONMap{"type": "string"},
						"skill_key": mcpgateway.JSONMap{"type": "string"}, "source": mcpgateway.JSONMap{"type": "string"},
						"requested_runs": mcpgateway.JSONMap{"type": "integer"}, "observed_runs": mcpgateway.JSONMap{"type": "integer"},
						"implicit_runs": mcpgateway.JSONMap{"type": "integer"},
					},
				},
			},
			"skill_contributions": mcpgateway.JSONMap{
				"type": "object", "additionalProperties": false,
				"required": []any{"created_count", "updated_count"},
				"properties": mcpgateway.JSONMap{
					"created_count": mcpgateway.JSONMap{"type": "integer"},
					"updated_count": mcpgateway.JSONMap{"type": "integer"},
				},
			},
			"skill_usage_totals": mcpgateway.JSONMap{
				"type": "object", "additionalProperties": false,
				"required": []any{"requested_skill_runs", "observed_skill_runs", "explicit_skill_runs", "implicit_skill_runs"},
				"properties": mcpgateway.JSONMap{
					"requested_skill_runs": mcpgateway.JSONMap{"type": "integer"},
					"observed_skill_runs":  mcpgateway.JSONMap{"type": "integer"},
					"explicit_skill_runs":  mcpgateway.JSONMap{"type": "integer"},
					"implicit_skill_runs":  mcpgateway.JSONMap{"type": "integer"},
				},
			},
			"employee_skill_usage": mcpgateway.JSONMap{
				"type": "array",
				"items": mcpgateway.JSONMap{
					"type": "object", "additionalProperties": false,
					"required": []any{"employee_id", "employee_name", "observed_skill_count", "requested_skill_runs", "observed_skill_runs", "explicit_skill_runs", "implicit_skill_runs"},
					"properties": mcpgateway.JSONMap{
						"employee_id": mcpgateway.JSONMap{"type": "string"}, "employee_name": mcpgateway.JSONMap{"type": "string"},
						"observed_skill_count": mcpgateway.JSONMap{"type": "integer"},
						"requested_skill_runs": mcpgateway.JSONMap{"type": "integer"}, "observed_skill_runs": mcpgateway.JSONMap{"type": "integer"},
						"explicit_skill_runs": mcpgateway.JSONMap{"type": "integer"}, "implicit_skill_runs": mcpgateway.JSONMap{"type": "integer"},
						"last_observed_at": mcpgateway.JSONMap{"type": "string", "format": "date-time"},
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
	agentsProperties["agents"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"agent_id", "name", "status", "employee_id", "employee_name", "session_count", "turn_count", "last_activity_at", "rank"}, "properties": mcpgateway.JSONMap{
		"agent_id": mcpgateway.JSONMap{"type": "string"}, "name": mcpgateway.JSONMap{"type": "string"}, "status": mcpgateway.JSONMap{"type": "string"},
		"employee_id": mcpgateway.JSONMap{"type": "string"}, "employee_name": mcpgateway.JSONMap{"type": "string"},
		"session_count": mcpgateway.JSONMap{"type": "integer"}, "turn_count": mcpgateway.JSONMap{"type": "integer"}, "last_activity_at": mcpgateway.JSONMap{"type": []any{"string", "null"}}, "rank": mcpgateway.JSONMap{"type": "integer"},
	}}}
	for _, key := range []string{"total", "limit", "offset"} {
		agentsProperties[key] = mcpgateway.JSONMap{"type": "integer"}
	}
	agentsProperties["has_more"] = mcpgateway.JSONMap{"type": "boolean"}
	agentsProperties["next_offset"] = mcpgateway.JSONMap{"type": []any{"integer", "null"}}
	detailProperties := queryProperties()
	for _, key := range []string{"agent_id", "name", "status", "employee_id", "employee_name"} {
		detailProperties[key] = mcpgateway.JSONMap{"type": "string"}
	}
	detailProperties["last_activity_at"] = mcpgateway.JSONMap{"type": []any{"string", "null"}}
	for _, key := range []string{"session_count", "turn_count", "completed_turn_count", "tool_call_count", "mcp_call_count"} {
		detailProperties[key] = mcpgateway.JSONMap{"type": "integer"}
	}
	detailProperties["recent_activities"] = mcpgateway.JSONMap{"type": "array", "items": mcpgateway.JSONMap{"type": "object", "additionalProperties": false, "required": []any{"occurred_at", "type", "status"}, "properties": mcpgateway.JSONMap{
		"occurred_at": mcpgateway.JSONMap{"type": "string", "format": "date-time"}, "type": mcpgateway.JSONMap{"type": "string"}, "status": mcpgateway.JSONMap{"type": "string"},
	}}}
	detailProperties["content"] = conversationContentSchema()
	return map[string]mcpgateway.JSONMap{
		ToolSummary:       {"type": "object", "additionalProperties": false, "required": append(commonRequired, "source_status", "organization", "trend", "model_distribution", "token_usage_ranking"), "properties": summaryProperties},
		ToolAgents:        {"type": "object", "additionalProperties": false, "required": append(commonRequired, "source_status", "sort_by", "agents", "total", "limit", "offset", "has_more", "next_offset"), "properties": agentsProperties},
		ToolAgentDetail:   {"type": "object", "additionalProperties": false, "required": append(commonRequired, "agent_id", "name", "status", "employee_id", "employee_name", "last_activity_at", "session_count", "turn_count", "completed_turn_count", "tool_call_count", "mcp_call_count", "recent_activities"), "properties": detailProperties},
		ToolMetricExplain: metricOutputSchema(),
	}
}

func conversationContentSchema() mcpgateway.JSONMap {
	turnProperties := mcpgateway.JSONMap{}
	for _, key := range []string{"turn_id", "status", "user_prompt", "last_assistant_message"} {
		turnProperties[key] = mcpgateway.JSONMap{"type": "string"}
	}
	turnProperties["started_at"] = mcpgateway.JSONMap{"type": "string", "format": "date-time"}
	turnProperties["completed_at"] = mcpgateway.JSONMap{"type": []any{"string", "null"}}
	for _, key := range []string{"user_prompt_missing", "last_assistant_message_missing", "user_prompt_truncated", "last_assistant_message_truncated"} {
		turnProperties[key] = mcpgateway.JSONMap{"type": "boolean"}
	}
	turnSchema := mcpgateway.JSONMap{"type": "object", "additionalProperties": false,
		"required": []any{"turn_id", "status", "started_at", "completed_at", "user_prompt", "last_assistant_message", "user_prompt_missing", "last_assistant_message_missing", "user_prompt_truncated", "last_assistant_message_truncated"}, "properties": turnProperties}
	sessionSchema := mcpgateway.JSONMap{"type": "object", "additionalProperties": false,
		"required": []any{"collector_id", "session_id", "workspace_name", "turns"}, "properties": mcpgateway.JSONMap{
			"collector_id": mcpgateway.JSONMap{"type": "string"}, "session_id": mcpgateway.JSONMap{"type": "string"}, "workspace_name": mcpgateway.JSONMap{"type": "string"},
			"turns": mcpgateway.JSONMap{"type": "array", "items": turnSchema},
		}}
	return mcpgateway.JSONMap{"type": "object", "additionalProperties": false,
		"required": []any{"scope", "note", "total_turns", "returned_turns", "limit", "offset", "has_more", "next_offset", "sessions"}, "properties": mcpgateway.JSONMap{
			"scope": mcpgateway.JSONMap{"type": "string", "const": "reported_turns_with_last_assistant_message"}, "note": mcpgateway.JSONMap{"type": "string"},
			"total_turns": mcpgateway.JSONMap{"type": "integer"}, "returned_turns": mcpgateway.JSONMap{"type": "integer"},
			"limit": mcpgateway.JSONMap{"type": "integer"}, "offset": mcpgateway.JSONMap{"type": "integer"},
			"has_more": mcpgateway.JSONMap{"type": "boolean"}, "next_offset": mcpgateway.JSONMap{"type": []any{"integer", "null"}},
			"sessions": mcpgateway.JSONMap{"type": "array", "items": sessionSchema},
		}}
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
