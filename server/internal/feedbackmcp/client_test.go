package feedbackmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/krillinai/Clawee/server/internal/feedback"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"image"
	"image/png"
	"strings"
	"testing"
	"time"
)

func TestToolsAndDeniedIdentity(t *testing.T) {
	c := NewClient(feedback.NewService(feedback.NewMemoryStore(), nil, nil, 0))
	tools, e := c.ListTools(context.Background(), mcpgateway.UpstreamServer{}, "")
	if e != nil || len(tools) != 6 {
		t.Fatal("tools missing", e)
	}
	for _, tool := range tools {
		if tool.Annotations["readOnlyHint"] != (tool.Name != "resolve_report") {
			t.Fatal("incorrect annotation", tool.Name)
		}
	}
	for _, tool := range tools {
		if tool.Name == "get_screenshot" {
			continue
		}
		_, e = c.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{Capability: mcpgateway.Capability{UpstreamName: tool.Name}, Arguments: mcpgateway.JSONMap{"report_id": "report_test"}})
		if e == nil {
			t.Fatal("anonymous tool permitted", tool.Name)
		}
	}
}
func TestScreenshotContentBlockAndReadOnlyResolveDenied(t *testing.T) {
	ctx := context.Background()
	storage, _ := sharedfiles.NewFileSystemStorage(t.TempDir())
	s := feedback.NewService(feedback.NewMemoryStore(), storage, func(_ context.Context, a feedback.Actor, operation string) error {
		if a.UserID != "center_reader" || operation == "resolve" {
			return &feedback.Error{Status: 403, Code: "feedback_forbidden"}
		}
		return nil
	}, 0)
	var bitmap bytes.Buffer
	_ = png.Encode(&bitmap, image.NewRGBA(image.Rect(0, 0, 2, 3)))
	data := bitmap.Bytes()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	manifest, _ := json.Marshal(feedback.Manifest{SchemaVersion: 1, SnapshotAt: now, ThreadID: "thread_test", RedactionPolicyVersion: 1, Completeness: "partial", MissingItems: []string{"conversation:unavailable"}, Artifacts: []feedback.Artifact{{ID: "screenshot_test", Kind: "screenshot", Name: "screenshot-1", Source: "screenshot", PartIndex: 1, ContentType: "image/png", Size: int64(len(data)), SHA256: feedback.Hash(data)}}})
	in := feedback.CreateInput{ClientID: "client_test", RecoveryToken: strings.Repeat("a", 43), StatusToken: strings.Repeat("b", 43), Description: "截图问题", OccurredAt: now, Manifest: manifest}
	in.Consent.PolicyVersion = 1
	in.Consent.ConfirmedAt = now
	p, _, e := s.Create(ctx, in, "test", "")
	if e != nil {
		t.Fatal(e)
	}
	id := p["report_id"].(string)
	raw := p["upload_token"].(string)
	if _, e = s.Upload(ctx, id, "screenshot_test", raw, "image/png", feedback.Hash(data), int64(len(data)), bytes.NewReader(data)); e != nil {
		t.Fatal(e)
	}
	mh, _ := feedback.CanonicalHash(manifest)
	if _, e = s.Submit(ctx, id, raw, mh, true); e != nil {
		t.Fatal(e)
	}
	client := NewClient(s)
	result, e := client.CallTool(ctx, mcpgateway.UpstreamCallRequest{Caller: mcpgateway.AgentIdentity{UserID: "center_reader"}, Capability: mcpgateway.Capability{UpstreamName: "get_screenshot"}, Arguments: mcpgateway.JSONMap{"report_id": id, "artifact_id": "screenshot_test"}})
	if e != nil {
		t.Fatal(e)
	}
	if len(result.Content) != 2 {
		t.Fatal("screenshot content missing")
	}
	content, ok := result.Content[1].(*mcp.ImageContent)
	if !ok || content.MIMEType != "image/png" || !bytes.Equal(content.Data, data) {
		t.Fatal("screenshot is not a real image content block")
	}
	_, e = client.CallTool(ctx, mcpgateway.UpstreamCallRequest{Caller: mcpgateway.AgentIdentity{UserID: "center_reader"}, Capability: mcpgateway.Capability{UpstreamName: "resolve_report"}, Arguments: mcpgateway.JSONMap{"report_id": id, "expected_version": 1, "idempotency_key": "resolve_test", "resolution_summary": "未授权处理", "verification": "未授权验证"}})
	status, _ := feedback.HTTPError(e)
	if status != 403 {
		t.Fatal("read-only account resolved feedback", e)
	}
}
func TestMetadataContinuationIsCompleteAndBound(t *testing.T) {
	value := map[string]any{"report_id": "report_test", "manifest": map[string]any{"warnings": []string{strings.Repeat("资料", 60000)}}}
	expected, _ := json.Marshal(value)
	cursor := ""
	var joined strings.Builder
	for range 100 {
		page, e := metadataPage("report_test", value, cursor)
		if e != nil {
			t.Fatal(e)
		}
		record := page.(map[string]any)
		encoded, _ := json.Marshal(record)
		if len(encoded) > 256<<10 {
			t.Fatal("unbounded metadata output")
		}
		joined.WriteString(record["metadata_fragment"].(string))
		cursor = record["next_cursor"].(string)
		if cursor == "" {
			break
		}
		if _, e = metadataPage("other_report", value, cursor); e == nil {
			t.Fatal("cross-report cursor accepted")
		}
	}
	if joined.String() != string(expected) {
		t.Fatal("metadata lost during continuation")
	}
}
