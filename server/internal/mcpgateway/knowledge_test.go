package mcpgateway

import (
	"reflect"
	"testing"
)

func TestKnowledgeBaseIDsFromResolvedScopeNormalizesAuditValues(t *testing.T) {
	got := knowledgeBaseIDsFromResolvedScope(JSONMap{"knowledge_base_ids": []any{" kb_1 ", "kb_2", "kb_1", 3}})
	if !reflect.DeepEqual(got, []string{"kb_1", "kb_2"}) {
		t.Fatalf("knowledgeBaseIDsFromResolvedScope() = %#v", got)
	}
}

func TestKnowledgeAuditProjectionRedactsQueryAndChunks(t *testing.T) {
	audit := ProxyAuditRecord{
		UpstreamServerID: KnowledgeAdapterServerID,
		UpstreamName:     KnowledgeSearchUpstreamName,
		ExposedName:      "enterprise.policy.search",
		RequestBody:      JSONMap{"query": "secret", "top_k": 3},
		ResponseBody: JSONMap{
			"chunks":                        []any{map[string]any{"text": "secret chunk", "knowledge_base_id": "kb-1", "knowledge_base_name": "制度库", "document_name": "handbook.pdf", "source_id": "src_1"}},
			"searched_knowledge_base_count": 2, "successful_knowledge_base_count": 1, "partial": true,
			"failures": []any{map[string]any{"knowledge_base_id": "kb-2", "code": "timeout"}},
		},
	}
	projected := ProjectProxyAudit(audit)
	if projected.RequestBody["query_redacted"] != true || projected.RequestBody["query"] != nil {
		t.Fatalf("request body = %#v", projected.RequestBody)
	}
	if projected.ResponseBody["result_count"] != 1 || projected.ResponseBody["chunks"] != nil || projected.ResponseBody["partial"] != true || projected.ResponseBody["successful_knowledge_base_count"] != 1 {
		t.Fatalf("response body = %#v", projected.ResponseBody)
	}
	sources := projected.ResponseBody["sources"].([]any)
	if sources[0].(map[string]any)["knowledge_base_id"] != "kb-1" {
		t.Fatalf("sources = %#v", sources)
	}
}

func TestKnowledgeAuditProjectionSupportsTypedChunkSlices(t *testing.T) {
	projected := ProjectProxyAudit(ProxyAuditRecord{
		ExposedName:  KnowledgeSearchExposedName,
		RequestBody:  JSONMap{"query": "secret"},
		ResponseBody: JSONMap{"chunks": []map[string]any{{"text": "secret", "document_name": "guide.md", "source_id": "source-1"}}},
	})
	if projected.ResponseBody["result_count"] != 1 {
		t.Fatalf("response body = %#v", projected.ResponseBody)
	}
}

func TestKnowledgeAuditProjectionOmitsTopKForInvalidInput(t *testing.T) {
	projected := ProjectProxyAudit(ProxyAuditRecord{
		ExposedName: KnowledgeSearchExposedName,
		Decision:    DecisionInvalidInput,
		RequestBody: JSONMap{"query": "secret", "top_k": 3},
	})
	if projected.RequestBody["query_redacted"] != true || projected.RequestBody["top_k"] != nil {
		t.Fatalf("request body = %#v", projected.RequestBody)
	}
}

func TestDataServiceAuditProjectionKeepsCountsWithoutSensitiveContent(t *testing.T) {
	summaryAudit := ProjectProxyAudit(ProxyAuditRecord{
		ExposedName: "agent_activity.summary",
		ResponseBody: JSONMap{
			"organization": map[string]any{"active_agents": float64(3)},
			"trend":        map[string]any{"points": []any{map[string]any{"bucket_start": "2026-09-01"}}},
		},
	})
	if summaryAudit.ResponseBody["agent_count"] != 3 || summaryAudit.ResponseBody["trend_point_count"] != 1 || summaryAudit.ResponseBody["organization"] != nil {
		t.Fatalf("summary audit = %#v", summaryAudit)
	}
	activityAudit := ProjectProxyAudit(ProxyAuditRecord{
		UpstreamServerID: "agent-activity", UpstreamName: "agent_detail", RequestBody: JSONMap{"agent_id": "agent-1", "range": "7d"},
		ResponseBody: JSONMap{"data_status": "available", "generated_at": "2026-09-01T00:00:00Z", "recent_activities": []any{map[string]any{"type": "coding", "summary": "secret"}}},
	})
	if activityAudit.RequestBody["agent_id"] != "agent-1" || activityAudit.ResponseBody["recent_activities"] != nil || activityAudit.ResponseBody["data_status"] != "available" {
		t.Fatalf("activity audit = %#v", activityAudit)
	}
	businessAudit := ProjectProxyAudit(ProxyAuditRecord{
		ExposedName: "business_data.dashboard", RequestBody: JSONMap{"view_id": "bilibili_operation", "range": "7d", "top_n": 10},
		ResponseBody: JSONMap{"data_status": "available", "trend": []any{map[string]any{"date": "2026-09-01"}}, "top_items": []any{map[string]any{"title": "secret title"}}, "summary": map[string]any{"view_count": 10, "conversion_count": nil, "captured_at": "2026-09-01T00:00:00Z", "currency": "CNY"}},
	})
	if businessAudit.ResponseBody["trend_point_count"] != 1 || businessAudit.ResponseBody["top_item_count"] != 1 || businessAudit.ResponseBody["trend"] != nil || businessAudit.ResponseBody["top_items"] != nil || businessAudit.ResponseBody["summary"] != nil {
		t.Fatalf("business audit = %#v", businessAudit)
	}
	if businessAudit.ResponseBody["metric_count"] != 1 {
		t.Fatalf("business metric count = %#v", businessAudit.ResponseBody)
	}
}
