package feedbackmcp

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/feedback"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestAutomaticIncidentsExcludedWithoutAgentID(t *testing.T) {
	ctx := context.Background()
	store := feedback.NewMemoryStore()
	service := feedback.NewService(store, nil, func(context.Context, feedback.Actor, string) error { return nil }, 0)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	incident := feedback.AutomaticIncident{
		SchemaVersion: 1, PolicyVersion: 1, ID: "11111111-1111-4111-8111-111111111111",
		InstallationID: "22222222-2222-4222-8222-222222222222", SessionID: "33333333-3333-4333-8333-333333333333",
		Revision: 1, Source: "desktop", Layer: "desktop_bootstrap", Stage: "starting_daemon", ErrorCode: "DAEMON_START_FAILED",
		FirstSeenAt: now, LastSeenAt: now, OccurrenceCount: 1, Outcome: "failed", Message: "DAEMON_START_FAILED", FirstMessage: "DAEMON_START_FAILED",
	}
	if _, _, err := service.PutIncident(ctx, incident.ID, strings.Repeat("ab", 32), incident, "127.0.0.1", ""); err != nil {
		t.Fatal(err)
	}
	client := NewClient(service)
	request := mcpgateway.UpstreamCallRequest{Caller: mcpgateway.AgentIdentity{UserID: "admin"}, Capability: mcpgateway.Capability{UpstreamName: "list_reports"}, Arguments: mcpgateway.JSONMap{}}
	listed, err := client.CallTool(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.StructuredContent.(map[string]any)["reports"].([]map[string]any)) != 0 {
		t.Fatal("未携带AgentID的MCP调用列出了自动异常")
	}
	for _, tool := range []string{"get_report", "read_conversation", "read_logs", "get_screenshot", "resolve_report"} {
		request.Capability.UpstreamName = tool
		request.Arguments = mcpgateway.JSONMap{"report_id": incident.ID, "artifact_id": "artifact_test", "expected_version": 1, "idempotency_key": "resolve_test", "resolution_summary": "不应处理", "verification": "不应处理"}
		if _, err = client.CallTool(ctx, request); err == nil {
			t.Fatal("MCP读取或处理了自动异常", tool)
		}
	}
	stored, err := store.Get(incident.ID)
	if err != nil || stored.ProcessingStatus != "open" || stored.Version != 1 || len(stored.Events) != 0 {
		t.Fatal("MCP改写了人工处理状态", err)
	}
}
