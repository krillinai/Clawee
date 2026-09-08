package agentactivitymcp

import (
	"context"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type activityStoreStub struct{}

func (activityStoreStub) Statistics(context.Context, time.Time, time.Time) (activity.ActivitySnapshot, error) {
	now := time.Now().UTC()
	return activity.ActivitySnapshot{Agents: []activity.Agent{{AgentID: "agent-1", Name: "Agent 1", Status: "idle", SessionCount: 2, TurnCount: 3, LastActivityAt: &now}}}, nil
}

type mcpUsageStoreStub struct{}

func (mcpUsageStoreStub) MCPUsage(context.Context, time.Time, time.Time) ([]activity.MCPUsage, error) {
	return []activity.MCPUsage{}, nil
}

type summaryReaderStub struct {
	agentID string
}

func (s *summaryReaderStub) AgentSummary(_ context.Context, agentID string, _, _ time.Time) (activity.AgentSummary, error) {
	s.agentID = agentID
	return activity.AgentSummary{AgentID: agentID, Name: "Agent 1", RecentActivities: []activity.AgentRecentActivity{}}, nil
}

func TestClientListsClosedReadOnlyTools(t *testing.T) {
	client := newTestClient(t, false, nil)
	tools, err := client.ListTools(context.Background(), mcpgateway.UpstreamServer{ID: ServerID}, "")
	if err != nil || len(tools) != 4 {
		t.Fatalf("tools = %#v, error = %v", tools, err)
	}
	expectedOutputFields := map[string]string{
		ToolSummary: "organization", ToolAgents: "agents", ToolAgentDetail: "recent_activities", ToolMetricExplain: "metrics",
	}
	for _, tool := range tools {
		if tool.InputSchema["additionalProperties"] != false || tool.Annotations["readOnlyHint"] != true || tool.Annotations["destructiveHint"] != false || tool.Annotations["idempotentHint"] != true || tool.Annotations["openWorldHint"] != false {
			t.Fatalf("tool = %#v", tool)
		}
		if tool.OutputSchema["additionalProperties"] != false || !schemaRequires(tool.OutputSchema, expectedOutputFields[tool.Name]) {
			t.Fatalf("output schema for %s = %#v", tool.Name, tool.OutputSchema)
		}
	}
}

func schemaRequires(schema mcpgateway.JSONMap, field string) bool {
	for _, item := range schema["required"].([]any) {
		if item == field {
			return true
		}
	}
	return false
}

func TestClientUsesCallerForAuthorizationAndAppliesDefaults(t *testing.T) {
	reader := &summaryReaderStub{}
	client := newTestClient(t, true, reader)
	result, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolAgents}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{},
	})
	if err != nil || result.IsError {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	body := result.StructuredContent.(mcpgateway.JSONMap)
	if body["range"] != "7d" || body["sort_by"] != "turn_count" || body["schema_version"] != 1 {
		t.Fatalf("body = %#v", body)
	}
	result, err = client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolAgentDetail}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{"agent_id": "agent-1"},
	})
	if err != nil || result.IsError || reader.agentID != "agent-1" {
		t.Fatalf("detail = %#v, error = %v, reader = %#v", result, err, reader)
	}
}

func TestClientRejectsInvalidInputAndMissingDataGrant(t *testing.T) {
	client := newTestClient(t, false, nil)
	invalid, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolSummary}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{"user_id": "forged"},
	})
	if err != nil || !invalid.IsError || invalid.StructuredContent.(mcpgateway.JSONMap)["code"] != "invalid_input" {
		t.Fatalf("invalid = %#v, error = %v", invalid, err)
	}
	forbidden, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolSummary}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{},
	})
	if err != nil || !forbidden.IsError || forbidden.StructuredContent.(mcpgateway.JSONMap)["code"] != "data_view_forbidden" {
		t.Fatalf("forbidden = %#v, error = %v", forbidden, err)
	}
}

func TestClientRejectsArgumentBoundariesAndUnknownTool(t *testing.T) {
	client := newTestClient(t, true, &summaryReaderStub{})
	tooManyMetricIDs := make([]any, 21)
	for index := range tooManyMetricIDs {
		tooManyMetricIDs[index] = "metric-" + string(rune('a'+index))
	}
	tests := []struct {
		name      string
		tool      string
		arguments mcpgateway.JSONMap
		wantError bool
	}{
		{name: "invalid range", tool: ToolSummary, arguments: mcpgateway.JSONMap{"range": "yesterday"}},
		{name: "invalid sort", tool: ToolAgents, arguments: mcpgateway.JSONMap{"sort_by": "name"}},
		{name: "zero limit", tool: ToolAgents, arguments: mcpgateway.JSONMap{"limit": 0}},
		{name: "limit over maximum", tool: ToolAgents, arguments: mcpgateway.JSONMap{"limit": 21}},
		{name: "empty metric ids", tool: ToolMetricExplain, arguments: mcpgateway.JSONMap{"metric_ids": []any{}}},
		{name: "duplicate metric ids", tool: ToolMetricExplain, arguments: mcpgateway.JSONMap{"metric_ids": []any{"total_tokens", "total_tokens"}}},
		{name: "too many metric ids", tool: ToolMetricExplain, arguments: mcpgateway.JSONMap{"metric_ids": tooManyMetricIDs}},
		{name: "unknown tool", tool: "unknown", arguments: mcpgateway.JSONMap{}, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
				Capability: mcpgateway.Capability{UpstreamName: test.tool}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: test.arguments,
			})
			if test.wantError {
				if err == nil {
					t.Fatalf("expected unsupported tool error, result = %#v", result)
				}
				return
			}
			if err != nil || !result.IsError || result.StructuredContent.(mcpgateway.JSONMap)["code"] != "invalid_input" {
				t.Fatalf("result = %#v, error = %v", result, err)
			}
		})
	}
}

func TestClientResponsesMatchOutputSchemas(t *testing.T) {
	client := newTestClient(t, true, &summaryReaderStub{})
	tools, err := client.ListTools(context.Background(), mcpgateway.UpstreamServer{ID: ServerID}, "")
	if err != nil {
		t.Fatal(err)
	}
	schemas := make(map[string]mcpgateway.JSONMap, len(tools))
	for _, tool := range tools {
		schemas[tool.Name] = tool.OutputSchema
	}
	calls := []struct {
		tool      string
		arguments mcpgateway.JSONMap
	}{
		{tool: ToolSummary, arguments: mcpgateway.JSONMap{}},
		{tool: ToolAgents, arguments: mcpgateway.JSONMap{}},
		{tool: ToolAgentDetail, arguments: mcpgateway.JSONMap{"agent_id": "agent-1"}},
		{tool: ToolMetricExplain, arguments: mcpgateway.JSONMap{"metric_ids": []any{"total_tokens"}}},
	}
	for _, call := range calls {
		t.Run(call.tool, func(t *testing.T) {
			result, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
				Capability: mcpgateway.Capability{UpstreamName: call.tool}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: call.arguments,
			})
			if err != nil || result.IsError {
				t.Fatalf("result = %#v, error = %v", result, err)
			}
			if err := mcpgateway.ValidateInput(schemas[call.tool], result.StructuredContent.(mcpgateway.JSONMap)); err != nil {
				t.Fatalf("response does not match output schema: %v\nresponse = %#v", err, result.StructuredContent)
			}
		})
	}
}

func newTestClient(t *testing.T, granted bool, reader activity.AgentSummaryReader) *Client {
	t.Helper()
	access := dataaccess.NewService(dataaccess.NewMemoryStore())
	if granted {
		if _, err := access.Create(context.Background(), dataaccess.SetInput{UserID: "user-1", ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "test"}); err != nil {
			t.Fatal(err)
		}
	}
	service, err := activity.NewService(nil, activityStoreStub{}, mcpUsageStoreStub{}, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(service, reader, access)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
