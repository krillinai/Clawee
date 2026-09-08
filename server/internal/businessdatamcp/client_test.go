package businessdatamcp

import (
	"context"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type dashboardStoreStub struct{}

func (dashboardStoreStub) XiaohongshuDashboard(context.Context, businessdata.DashboardRange) (businessdata.XiaohongshuDashboardData, error) {
	return businessdata.XiaohongshuDashboardData{
		State:   businessdata.DashboardState{DataStatus: businessdata.DataStatusAvailable},
		Summary: businessdata.XiaohongshuSummary{ExposureCount: 20}, Previous: businessdata.XiaohongshuSummary{ExposureCount: 10},
		Trend: []businessdata.XiaohongshuTrendPoint{}, TopItems: []businessdata.XiaohongshuTopItem{{Title: "one"}, {Title: "two"}},
	}, nil
}
func (dashboardStoreStub) DouyinAdsDashboard(context.Context, businessdata.DashboardRange) (businessdata.DouyinAdsDashboardData, error) {
	return businessdata.DouyinAdsDashboardData{
		State: businessdata.DashboardState{DataStatus: businessdata.DataStatusAvailable}, Summary: businessdata.DouyinAdsSummary{SpendMinor: 100, Currency: businessdata.Currency},
		Trend: []businessdata.DouyinAdsTrendPoint{{Date: "2026-09-01", SpendMinor: 100}}, TopItems: []businessdata.DouyinAdsTopItem{{Name: "campaign", SpendMinor: 100, Currency: businessdata.Currency}},
	}, nil
}
func (dashboardStoreStub) BilibiliDashboard(_ context.Context, sourceID string, _ businessdata.DashboardRange) (businessdata.BilibiliDashboardData, error) {
	now := time.Now().UTC()
	return businessdata.BilibiliDashboardData{
		State: businessdata.DashboardState{DataStatus: businessdata.DataStatusAvailable}, Account: businessdata.BilibiliDashboardAccount{SourceID: sourceID, Name: "account", Status: businessdata.SourceStatusActive},
		CapturedAt: now, FollowerCount: 10, CollectedContentCount: 1, ViewCount: 20, InteractionCount: 2,
		Trend: []businessdata.BilibiliTrendPoint{{Date: "2026-09-01", FollowerCount: 10}}, TopContents: []businessdata.BilibiliTopContent{{Title: "video", CapturedAt: now, ViewCount: 20}},
	}, nil
}
func (dashboardStoreStub) BilibiliDashboardOverview(context.Context) (businessdata.DashboardState, error) {
	return businessdata.DashboardState{DataStatus: businessdata.DataStatusAvailable}, nil
}
func (dashboardStoreStub) BilibiliViewSourceIDs(context.Context) ([]string, error) {
	return []string{"bdsrc_1"}, nil
}
func (dashboardStoreStub) ListBilibiliSources(context.Context) ([]businessdata.BilibiliSourceItem, error) {
	return []businessdata.BilibiliSourceItem{{SourceID: "bdsrc_1", Name: "account", Status: businessdata.SourceStatusActive}}, nil
}

func TestClientListsClosedReadOnlyTools(t *testing.T) {
	client := newTestClient(t, nil)
	tools, err := client.ListTools(context.Background(), mcpgateway.UpstreamServer{ID: ServerID}, "")
	if err != nil || len(tools) != 4 {
		t.Fatalf("tools = %#v, error = %v", tools, err)
	}
	expectedOutputFields := map[string]string{
		ToolViews: "views", ToolDashboard: "top_items", ToolCompare: "previous_start_date", ToolMetricExplain: "metrics",
	}
	for _, tool := range tools {
		if tool.InputSchema["additionalProperties"] != false || tool.Annotations["readOnlyHint"] != true || tool.Annotations["idempotentHint"] != true || tool.Annotations["openWorldHint"] != false {
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

func TestClientFiltersViewsAndUsesDashboardDefaults(t *testing.T) {
	client := newTestClient(t, []string{businessdata.ViewXiaohongshuOperation})
	views, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolViews}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{},
	})
	if err != nil || views.IsError {
		t.Fatalf("views = %#v, error = %v", views, err)
	}
	viewItems := views.StructuredContent.(mcpgateway.JSONMap)["views"].([]any)
	if len(viewItems) != 1 || viewItems[0].(mcpgateway.JSONMap)["view_id"] != businessdata.ViewXiaohongshuOperation {
		t.Fatalf("view items = %#v", viewItems)
	}
	dashboard, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolDashboard}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "top_n": 1},
	})
	if err != nil || dashboard.IsError {
		t.Fatalf("dashboard = %#v, error = %v", dashboard, err)
	}
	body := dashboard.StructuredContent.(mcpgateway.JSONMap)
	if body["range"] != businessdata.Range7Days || len(body["top_items"].([]any)) != 1 || body["schema_version"] != 1 {
		t.Fatalf("body = %#v", body)
	}
}

func TestClientQueriesBilibiliDashboardAndComparisonBySource(t *testing.T) {
	client := newTestClient(t, []string{businessdata.ViewBilibiliOperation})
	views, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolViews}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{},
	})
	if err != nil || views.IsError {
		t.Fatalf("views = %#v, error = %v", views, err)
	}
	accounts := views.StructuredContent.(mcpgateway.JSONMap)["views"].([]any)[0].(mcpgateway.JSONMap)["accounts"].([]any)
	if len(accounts) != 1 || accounts[0].(mcpgateway.JSONMap)["source_id"] != "bdsrc_1" {
		t.Fatalf("accounts = %#v", accounts)
	}

	dashboard, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolDashboard}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"},
		Arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewBilibiliOperation, "source_id": "bdsrc_1"},
	})
	if err != nil || dashboard.IsError {
		t.Fatalf("dashboard = %#v, error = %v", dashboard, err)
	}
	body := dashboard.StructuredContent.(mcpgateway.JSONMap)
	if body["account"].(mcpgateway.JSONMap)["source_id"] != "bdsrc_1" || body["summary"].(mcpgateway.JSONMap)["follower_count"] != float64(10) {
		t.Fatalf("dashboard body = %#v", body)
	}

	comparison, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolCompare}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"},
		Arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewBilibiliOperation, "source_id": "bdsrc_1", "metric_ids": []any{"follower_count"}},
	})
	if err != nil || comparison.IsError || comparison.StructuredContent.(mcpgateway.JSONMap)["account"] == nil {
		t.Fatalf("comparison = %#v, error = %v", comparison, err)
	}
}

func TestClientComparesMetricsAndRejectsForgedIdentity(t *testing.T) {
	client := newTestClient(t, []string{businessdata.ViewXiaohongshuOperation})
	comparison, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolCompare}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": []any{"exposure_count"}},
	})
	if err != nil || comparison.IsError {
		t.Fatalf("comparison = %#v, error = %v", comparison, err)
	}
	metrics := comparison.StructuredContent.(mcpgateway.JSONMap)["metrics"].([]any)
	if metrics[0].(map[string]any)["absolute_change"] != float64(10) {
		t.Fatalf("metrics = %#v", metrics)
	}
	invalid, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
		Capability: mcpgateway.Capability{UpstreamName: ToolDashboard}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "tenant_id": "forged"},
	})
	if err != nil || !invalid.IsError || invalid.StructuredContent.(mcpgateway.JSONMap)["code"] != "invalid_input" {
		t.Fatalf("invalid = %#v, error = %v", invalid, err)
	}
}

func TestClientRejectsArgumentBoundariesAndUnknownTool(t *testing.T) {
	client := newTestClient(t, []string{businessdata.ViewXiaohongshuOperation})
	tooManyCompareIDs := make([]any, 11)
	tooManyExplainIDs := make([]any, 21)
	for index := range tooManyExplainIDs {
		value := "metric-" + string(rune('a'+index))
		tooManyExplainIDs[index] = value
		if index < len(tooManyCompareIDs) {
			tooManyCompareIDs[index] = value
		}
	}
	tests := []struct {
		name      string
		tool      string
		arguments mcpgateway.JSONMap
		wantError bool
	}{
		{name: "invalid range", tool: ToolDashboard, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "range": "yesterday"}},
		{name: "zero top n", tool: ToolDashboard, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "top_n": 0}},
		{name: "top n over maximum", tool: ToolDashboard, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "top_n": 21}},
		{name: "blank source id", tool: ToolDashboard, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "source_id": " "}},
		{name: "source id for unsupported view", tool: ToolDashboard, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "source_id": "bdsrc_1"}},
		{name: "empty compare metric ids", tool: ToolCompare, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": []any{}}},
		{name: "duplicate compare metric ids", tool: ToolCompare, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": []any{"exposure_count", "exposure_count"}}},
		{name: "too many compare metric ids", tool: ToolCompare, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": tooManyCompareIDs}},
		{name: "empty explain metric ids", tool: ToolMetricExplain, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": []any{}}},
		{name: "duplicate explain metric ids", tool: ToolMetricExplain, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": []any{"exposure_count", "exposure_count"}}},
		{name: "too many explain metric ids", tool: ToolMetricExplain, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": tooManyExplainIDs}},
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
	client := newTestClient(t, []string{businessdata.ViewXiaohongshuOperation, businessdata.ViewDouyinAds, businessdata.ViewBilibiliOperation})
	tools, err := client.ListTools(context.Background(), mcpgateway.UpstreamServer{ID: ServerID}, "")
	if err != nil {
		t.Fatal(err)
	}
	schemas := make(map[string]mcpgateway.JSONMap, len(tools))
	for _, tool := range tools {
		schemas[tool.Name] = tool.OutputSchema
	}
	calls := []struct {
		name             string
		tool             string
		arguments        mcpgateway.JSONMap
		wantSummaryField string
	}{
		{name: ToolViews, tool: ToolViews, arguments: mcpgateway.JSONMap{}},
		{name: "xiaohongshu dashboard", tool: ToolDashboard, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation}, wantSummaryField: "published_count"},
		{name: "douyin dashboard", tool: ToolDashboard, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewDouyinAds}, wantSummaryField: "spend_minor"},
		{name: "bilibili dashboard", tool: ToolDashboard, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewBilibiliOperation}, wantSummaryField: "follower_count"},
		{name: ToolCompare, tool: ToolCompare, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": []any{"exposure_count"}}},
		{name: ToolMetricExplain, tool: ToolMetricExplain, arguments: mcpgateway.JSONMap{"view_id": businessdata.ViewXiaohongshuOperation, "metric_ids": []any{"exposure_count"}}},
	}
	for _, call := range calls {
		t.Run(call.name, func(t *testing.T) {
			result, err := client.CallTool(context.Background(), mcpgateway.UpstreamCallRequest{
				Capability: mcpgateway.Capability{UpstreamName: call.tool}, Caller: mcpgateway.AgentIdentity{UserID: "user-1"}, Arguments: call.arguments,
			})
			if err != nil || result.IsError {
				t.Fatalf("result = %#v, error = %v", result, err)
			}
			if err := mcpgateway.ValidateInput(schemas[call.tool], result.StructuredContent.(mcpgateway.JSONMap)); err != nil {
				t.Fatalf("response does not match output schema: %v\nresponse = %#v", err, result.StructuredContent)
			}
			if call.wantSummaryField != "" {
				summary := jsonMap(result.StructuredContent.(mcpgateway.JSONMap)["summary"])
				if summary[call.wantSummaryField] == nil {
					t.Fatalf("summary missing %q: %#v", call.wantSummaryField, summary)
				}
			}
		})
	}
}

func newTestClient(t *testing.T, grantedViews []string) *Client {
	t.Helper()
	access := dataaccess.NewService(dataaccess.NewMemoryStore())
	for _, viewID := range grantedViews {
		if _, err := access.Create(context.Background(), dataaccess.SetInput{UserID: "user-1", ResourceType: dataaccess.ResourceDataView, ResourceID: viewID, Actions: []string{dataaccess.ActionRead}, CreatedBy: "test"}); err != nil {
			t.Fatal(err)
		}
	}
	client, err := NewClient(businessdata.NewDashboardService(dashboardStoreStub{}), access)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
