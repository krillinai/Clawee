package mcpgateway

import (
	"context"
	"strings"

	"github.com/krillinai/Clawee/server/internal/knowledge"
)

const (
	KnowledgeAdapterServerID    = knowledge.AdapterServerID
	KnowledgeSearchUpstreamName = knowledge.SearchUpstreamName
	KnowledgeSearchExposedName  = "knowledge.search"
)

type KnowledgeBinding = knowledge.Binding

type KnowledgeBindingResolver interface {
	ResolveKnowledgeBinding(context.Context, string) (KnowledgeBinding, error)
}

type KnowledgeMCPAccessResolver interface {
	ResolveMCPKnowledgeBaseIDs(context.Context, string) ([]string, error)
}

func IsKnowledgeSearchCapability(capability Capability) bool {
	return capability.UpstreamServerID == KnowledgeAdapterServerID && capability.UpstreamName == KnowledgeSearchUpstreamName
}

func isKnowledgeSearchAudit(record ProxyAuditRecord) bool {
	return (record.UpstreamServerID == KnowledgeAdapterServerID && record.UpstreamName == KnowledgeSearchUpstreamName) ||
		(record.UpstreamServerID == "" && record.UpstreamName == "" && record.ExposedName == KnowledgeSearchExposedName)
}

func isKnowledgeSearchGate(gate GateRequest) bool {
	return (gate.UpstreamServerID == KnowledgeAdapterServerID && gate.UpstreamName == KnowledgeSearchUpstreamName) ||
		(gate.UpstreamServerID == "" && gate.UpstreamName == "" && gate.ExposedName == KnowledgeSearchExposedName)
}

func ProjectProxyAudit(record ProxyAuditRecord) ProxyAuditRecord {
	if !isKnowledgeSearchAudit(record) {
		return projectDataServiceAudit(record)
	}
	request := JSONMap{"query_redacted": true}
	if record.Decision != DecisionInvalidInput {
		if topK, ok := record.RequestBody["top_k"].(int); ok {
			request["top_k"] = topK
		} else if topK, ok := record.RequestBody["top_k"].(float64); ok {
			request["top_k"] = int(topK)
		} else {
			request["top_k"] = 5
		}
	}
	response := JSONMap{}
	if chunks, ok := auditChunkItems(record.ResponseBody["chunks"]); ok {
		sources := []any{}
		for _, item := range chunks {
			var chunk map[string]any
			switch typed := item.(type) {
			case map[string]any:
				chunk = typed
			case JSONMap:
				chunk = map[string]any(typed)
			}
			if chunk != nil {
				sources = append(sources, map[string]any{
					"knowledge_base_id": chunk["knowledge_base_id"], "knowledge_base_name": chunk["knowledge_base_name"],
					"document_name": chunk["document_name"], "source_id": chunk["source_id"],
				})
			}
		}
		response["result_count"] = len(chunks)
		response["sources"] = sources
		for _, key := range []string{"searched_knowledge_base_count", "successful_knowledge_base_count", "partial", "failures"} {
			if value, ok := record.ResponseBody[key]; ok {
				response[key] = cloneJSONValue(value)
			}
		}
	} else if record.ResponseBody != nil {
		if code, ok := record.ResponseBody["code"]; ok {
			response["code"] = code
		}
		if message, ok := record.ResponseBody["error"]; ok {
			response["error"] = message
		}
	}
	record.RequestBody = request
	record.ResponseBody = response
	return record
}

func projectDataServiceAudit(record ProxyAuditRecord) ProxyAuditRecord {
	isAgentActivity := record.UpstreamServerID == "agent-activity" || strings.HasPrefix(record.ExposedName, "agent_activity.")
	isBusinessData := record.UpstreamServerID == "business-data" || strings.HasPrefix(record.ExposedName, "business_data.")
	if !isAgentActivity && !isBusinessData {
		return record
	}
	request := JSONMap{}
	requestKeys := []string{"range", "sort_by", "limit", "agent_id"}
	if isBusinessData {
		requestKeys = []string{"view_id", "range", "metric_ids", "top_n"}
	}
	for _, key := range requestKeys {
		if value, ok := record.RequestBody[key]; ok {
			request[key] = cloneJSONValue(value)
		}
	}
	response := JSONMap{}
	for _, key := range []string{"code", "message", "retryable", "data_status", "generated_at"} {
		if value, ok := record.ResponseBody[key]; ok {
			response[key] = cloneJSONValue(value)
		}
	}
	if isAgentActivity {
		agentCount := auditArrayLength(record.ResponseBody["agents"])
		if _, hasAgents := record.ResponseBody["agents"]; !hasAgents {
			agentCount = auditNestedInt(record.ResponseBody["organization"], "active_agents")
		}
		response["agent_count"] = agentCount
		if trend, ok := record.ResponseBody["trend"].(map[string]any); ok {
			response["trend_point_count"] = auditArrayLength(trend["points"])
		} else if trend, ok := record.ResponseBody["trend"].(JSONMap); ok {
			response["trend_point_count"] = auditArrayLength(trend["points"])
		} else {
			response["trend_point_count"] = 0
		}
	} else {
		metricCount := auditArrayLength(record.ResponseBody["metrics"])
		if _, hasMetrics := record.ResponseBody["metrics"]; !hasMetrics {
			metricCount = auditSummaryMetricCount(record.ResponseBody["summary"])
		}
		response["metric_count"] = metricCount
		response["trend_point_count"] = auditArrayLength(record.ResponseBody["trend"])
		response["top_item_count"] = auditArrayLength(record.ResponseBody["top_items"])
		response["view_count"] = auditArrayLength(record.ResponseBody["views"])
	}
	record.RequestBody = request
	record.ResponseBody = response
	return record
}

func auditNestedInt(value any, key string) int {
	var raw any
	switch object := value.(type) {
	case map[string]any:
		raw = object[key]
	case JSONMap:
		raw = object[key]
	}
	switch number := raw.(type) {
	case int:
		return number
	case int32:
		return int(number)
	case int64:
		return int(number)
	case float64:
		return int(number)
	default:
		return 0
	}
}

func auditSummaryMetricCount(value any) int {
	var summary map[string]any
	switch object := value.(type) {
	case map[string]any:
		summary = object
	case JSONMap:
		summary = map[string]any(object)
	default:
		return 0
	}
	count := 0
	for key, metric := range summary {
		if metric != nil && key != "captured_at" && key != "currency" {
			count++
		}
	}
	return count
}

func auditArrayLength(value any) int {
	switch items := value.(type) {
	case []any:
		return len(items)
	case []map[string]any:
		return len(items)
	case []JSONMap:
		return len(items)
	default:
		return 0
	}
}

func auditChunkItems(value any) ([]any, bool) {
	switch chunks := value.(type) {
	case []any:
		return chunks, true
	case []map[string]any:
		out := make([]any, 0, len(chunks))
		for _, chunk := range chunks {
			out = append(out, chunk)
		}
		return out, true
	default:
		return nil, false
	}
}
