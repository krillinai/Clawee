package server

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestModelProxyAuditFinalizeIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	createdAt := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	if err := store.CreateModelProxyAuditRecord(ctx, mcpgateway.ModelProxyAuditRecord{
		AuditID: "audit_1", RequestID: "request_1", UserID: "user_1", Status: mcpgateway.ModelProxyAuditStarted, CreatedAt: createdAt,
	}); err != nil {
		t.Fatalf("create audit: %v", err)
	}
	finalize := mcpgateway.ModelProxyAuditFinalize{AuditID: "audit_1", Status: mcpgateway.ModelProxyAuditSucceeded, GatewayStatus: 200, CompletedAt: createdAt.Add(time.Second)}
	updated, err := store.FinalizeModelProxyAuditRecord(ctx, finalize)
	if err != nil || !updated {
		t.Fatalf("first finalize = %v, %v", updated, err)
	}
	updated, err = store.FinalizeModelProxyAuditRecord(ctx, finalize)
	if err != nil || updated {
		t.Fatalf("second finalize = %v, %v", updated, err)
	}
	record, err := store.GetModelProxyAuditRecord(ctx, "audit_1")
	if err != nil {
		t.Fatalf("get audit: %v", err)
	}
	if record.Status != mcpgateway.ModelProxyAuditSucceeded || record.GatewayStatus != 200 {
		t.Fatalf("record = %#v", record)
	}
}

func TestListModelProxyAuditRecordsUsesCreatedAtAndIDCursor(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	createdAt := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	for _, id := range []string{"audit_a", "audit_b", "audit_c"} {
		if err := store.CreateModelProxyAuditRecord(ctx, mcpgateway.ModelProxyAuditRecord{
			AuditID: id, UserID: "user_1", Model: "model_1", Status: mcpgateway.ModelProxyAuditSucceeded, CreatedAt: createdAt,
		}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	first, err := store.ListModelProxyAuditRecords(ctx, mcpgateway.ModelProxyAuditFilter{Limit: 2})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(first.Items) != 2 || first.Items[0].AuditID != "audit_c" || first.Items[1].AuditID != "audit_b" {
		t.Fatalf("first page = %#v", first.Items)
	}
	second, err := store.ListModelProxyAuditRecords(ctx, mcpgateway.ModelProxyAuditFilter{Limit: 2, CursorCreatedAt: first.NextCreatedAt, CursorID: first.NextID})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(second.Items) != 1 || second.Items[0].AuditID != "audit_a" {
		t.Fatalf("second page = %#v", second.Items)
	}
}

func TestSanitizeModelProxyJSONRedactsMediaAndSecrets(t *testing.T) {
	raw, err := json.Marshal(map[string]any{
		"api_key":    "sk-secret",
		"image_url":  "data:image/png;base64,aGk=",
		"b64_json":   "aGk=",
		"input_text": "keep this text",
	})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	snapshot, truncated := snapshotModelProxyBody(raw)
	if truncated {
		t.Fatal("small body was truncated")
	}
	if snapshot["api_key"] != "[REDACTED]" || snapshot["input_text"] != "keep this text" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	media, ok := snapshot["image_url"].(mcpgateway.JSONMap)
	if !ok {
		if object, objectOK := snapshot["image_url"].(map[string]any); objectOK {
			media = mcpgateway.JSONMap(object)
			ok = true
		}
	}
	if !ok || media["media_type"] != "image/png" || media["bytes"] != 2 || media["sha256"] == "" {
		t.Fatalf("media snapshot = %#v", snapshot["image_url"])
	}
}

func TestExtractModelProxyUsageFromSSE(t *testing.T) {
	raw := []byte("data: {\"id\":\"chunk_1\",\"choices\":[{\"delta\":{}}]}\n\n" +
		"data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":4,\"total_tokens\":11}}\n\n" +
		"data: [DONE]\n")
	input, output, total, cacheRead, available := extractModelProxyUsageBytes(raw)
	if !available || input != 7 || output != 4 || total != 11 || cacheRead != 0 {
		t.Fatalf("usage = %d/%d/%d cache=%d available=%v", input, output, total, cacheRead, available)
	}
}

func TestExtractModelProxyUsageIncludesCachedInputTokens(t *testing.T) {
	raw := []byte(`{"usage":{"input_tokens":12,"output_tokens":8,"prompt_tokens_details":{"cached_tokens":5}}}`)
	input, output, total, cacheRead, available := extractModelProxyUsageBytes(raw)
	if !available || input != 12 || output != 8 || total != 20 || cacheRead != 5 {
		t.Fatalf("usage = %d/%d/%d cache=%d available=%v", input, output, total, cacheRead, available)
	}
}

func TestExtractModelProxyUsageUsesFinalSSEUsageAndDetailedFields(t *testing.T) {
	raw := []byte("data: {\"usage\":{\"input_tokens\":7,\"output_tokens\":4,\"total_tokens\":11}}\n\n" +
		"data: {\"model\":\"clawee-sonnet\",\"usage\":{\"input_tokens\":17,\"output_tokens\":14,\"cache_creation_input_tokens\":3,\"input_tokens_details\":{\"cached_tokens\":5},\"output_tokens_details\":{\"reasoning_tokens\":6}}}\n\n" +
		"data: [DONE]\n")
	usage := extractModelProxyUsageBytesDetailed(raw)
	if !usage.available || usage.status != mcpgateway.ModelProxyUsageComplete || usage.inputTokens != 17 || usage.outputTokens != 14 || usage.totalTokens != 31 || usage.cacheReadTokens != 5 || usage.cacheCreationTokens != 3 || usage.reasoningTokens != 6 || usage.responseModel != "clawee-sonnet" {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestModelProxyUsageAccumulatorHandlesSplitFinalEvent(t *testing.T) {
	var accumulator modelProxyUsageAccumulator
	accumulator.Consume([]byte("data: {\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}\n\n"))
	accumulator.Consume([]byte("data: {\"usage\":{\"input_tokens\":3,"))
	accumulator.Consume([]byte("\"output_tokens\":4}}\n\n"))
	usage := accumulator.Finalize()
	if !usage.available || usage.inputTokens != 3 || usage.outputTokens != 4 || usage.totalTokens != 7 {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestSummarizeModelProxyAuditsFiltersErrorsByUserAndModel(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	for _, record := range []mcpgateway.ModelProxyAuditRecord{
		{AuditID: "summary_success", UserID: "user_1", Model: "model_a", Status: mcpgateway.ModelProxyAuditSucceeded},
		{AuditID: "summary_error", UserID: "user_1", Model: "model_a", Status: mcpgateway.ModelProxyAuditFailed, ErrorCode: "upstream_error"},
		{AuditID: "summary_other", UserID: "user_2", Model: "model_b", Status: mcpgateway.ModelProxyAuditFailed, ErrorCode: "upstream_error"},
	} {
		if err := store.CreateModelProxyAuditRecord(ctx, record); err != nil {
			t.Fatalf("create %s: %v", record.AuditID, err)
		}
	}

	summaries, err := store.SummarizeModelProxyAuditRecords(ctx, mcpgateway.ModelProxyAuditSummaryFilter{
		UserID: "user_1", Model: "model_a", ErrorOnly: true,
	})
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if len(summaries) != 1 || summaries[0].RequestCount != 1 || summaries[0].SucceededCount != 0 {
		t.Fatalf("summaries = %#v", summaries)
	}
}
