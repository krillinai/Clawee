package activity

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"
)

type fakeSnapshotClient struct {
	request  SnapshotRequest
	calls    int
	snapshot *Snapshot
	err      error
}

func (f *fakeSnapshotClient) Snapshot(_ context.Context, request SnapshotRequest) (Snapshot, error) {
	f.request = request
	f.calls++
	if f.err != nil {
		return Snapshot{}, f.err
	}
	if f.snapshot != nil {
		return *f.snapshot, nil
	}
	location, _ := time.LoadLocation("Asia/Shanghai")
	return Snapshot{
		GeneratedAt:       time.Date(2026, 8, 13, 3, 0, 0, 0, time.UTC),
		Trend:             []TrendPoint{{BucketStart: time.Date(2026, 8, 13, 0, 0, 0, 0, location), Usage: Usage{InputTokens: 4, CachedInputTokens: 3, OutputTokens: 2, TotalTokens: 6}}},
		Models:            []ModelUsage{},
		TokenUsageRanking: []TokenUsageRank{{Rank: 1, Name: "张三", Requests: 2, TotalTokens: 6}},
	}, nil
}

type failingActivityStore struct{ err error }

func (failingActivityStore) Statistics(context.Context, time.Time, time.Time) (ActivitySnapshot, error) {
	return ActivitySnapshot{}, errors.New("store unavailable")
}

type failingMCPUsageStore struct{}

func (failingMCPUsageStore) MCPUsage(context.Context, time.Time, time.Time) ([]MCPUsage, error) {
	return nil, errors.New("store unavailable")
}

type fakeActivityStore struct{}

func (fakeActivityStore) Statistics(context.Context, time.Time, time.Time) (ActivitySnapshot, error) {
	return ActivitySnapshot{ActiveEmployees: 2, ActiveAgents: 3, CompletedTurns: 4}, nil
}

func TestServiceStatisticsReturnsNotConfiguredWithLocalActivity(t *testing.T) {
	service, err := NewService(nil, fakeActivityStore{}, &fakeMCPUsageStore{}, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	service.clock = func() time.Time { return time.Date(2026, 8, 25, 3, 0, 0, 0, time.UTC) }
	statistics, err := service.Statistics(context.Background(), Range7Days)
	if err != nil {
		t.Fatal(err)
	}
	if statistics.DataStatus["model_usage"] != "not_configured" || statistics.Organization.ActiveAgents != 3 || statistics.Organization.CompletedTurns != 4 {
		t.Fatalf("statistics = %#v", statistics)
	}
	if statistics.Organization.Usage != (Usage{}) || len(statistics.Trend.Points) != 0 || statistics.Trend.Points == nil || statistics.ModelDistribution == nil || statistics.TokenUsageRanking == nil {
		t.Fatalf("token placeholder = %#v", statistics)
	}
}

func TestServiceStatisticsReportsUsageCoverage(t *testing.T) {
	for _, test := range []struct {
		name              string
		known, incomplete int64
		status            string
	}{
		{"完整", 2, 0, "available"},
		{"部分缺失", 1, 1, "partial"},
		{"全部缺失", 0, 2, "unavailable"},
		{"没有调用", 0, 0, "available"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeSnapshotClient{snapshot: &Snapshot{KnownUsageRequests: test.known, IncompleteUsageRequests: test.incomplete}}
			service, err := NewService(client, fakeActivityStore{}, &fakeMCPUsageStore{}, "Asia/Shanghai")
			if err != nil {
				t.Fatal(err)
			}
			statistics, err := service.Statistics(context.Background(), RangeToday)
			if err != nil {
				t.Fatal(err)
			}
			if statistics.DataStatus["model_usage"] != test.status || statistics.IncompleteUsageRequests != test.incomplete {
				t.Fatalf("用量状态错误: %#v", statistics)
			}
		})
	}
}

func TestServiceStatisticsReturnsUnavailableWhenProviderFailsOrOverflows(t *testing.T) {
	tests := []struct {
		name   string
		client *fakeSnapshotClient
	}{
		{name: "provider failure", client: &fakeSnapshotClient{err: errors.New("secret upstream details")}},
		{name: "aggregate overflow", client: &fakeSnapshotClient{snapshot: &Snapshot{
			GeneratedAt: time.Now(), Trend: []TrendPoint{{Usage: Usage{TotalTokens: math.MaxInt64}}, {Usage: Usage{TotalTokens: 1}}}, Models: []ModelUsage{},
		}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service, err := NewService(test.client, fakeActivityStore{}, &fakeMCPUsageStore{}, "Asia/Shanghai")
			if err != nil {
				t.Fatal(err)
			}
			statistics, err := service.Statistics(context.Background(), Range7Days)
			if err != nil {
				t.Fatal(err)
			}
			if test.client.calls != 1 || statistics.DataStatus["model_usage"] != "unavailable" || statistics.Organization.ActiveAgents != 3 || statistics.Organization.Usage != (Usage{}) || len(statistics.Trend.Points) != 0 {
				t.Fatalf("statistics = %#v, calls = %d", statistics, test.client.calls)
			}
		})
	}
}

func TestServiceStatisticsKeepsAvailableForRealZeroUsage(t *testing.T) {
	client := &fakeSnapshotClient{snapshot: &Snapshot{GeneratedAt: time.Now(), Trend: []TrendPoint{}, Models: []ModelUsage{}}}
	service, err := NewService(client, fakeActivityStore{}, &fakeMCPUsageStore{}, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	statistics, err := service.Statistics(context.Background(), Range7Days)
	if err != nil {
		t.Fatal(err)
	}
	if statistics.DataStatus["model_usage"] != "available" || statistics.Organization.Usage != (Usage{}) || len(statistics.Trend.Points) != 7 {
		t.Fatalf("statistics = %#v", statistics)
	}
}

func TestServiceStatisticsQueriesLocalStoresBeforeProvider(t *testing.T) {
	for _, test := range []struct {
		name     string
		activity ActivityStore
		mcp      MCPUsageStore
	}{
		{name: "activity failure", activity: failingActivityStore{}, mcp: &fakeMCPUsageStore{}},
		{name: "mcp failure", activity: fakeActivityStore{}, mcp: failingMCPUsageStore{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeSnapshotClient{}
			service, err := NewService(client, test.activity, test.mcp, "Asia/Shanghai")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.Statistics(context.Background(), Range7Days); !errors.Is(err, ErrActivityUnavailable) {
				t.Fatalf("error = %v", err)
			}
			if client.calls != 0 {
				t.Fatalf("provider calls = %d", client.calls)
			}
		})
	}
}

type fakeMCPUsageStore struct {
	start time.Time
	end   time.Time
}

func (f *fakeMCPUsageStore) MCPUsage(_ context.Context, start, end time.Time) ([]MCPUsage, error) {
	f.start = start
	f.end = end
	return []MCPUsage{{ID: "knowledge-adapter", Label: "企业知识库", InvocationCount: 3, Share: 1}}, nil
}

func TestServiceStatisticsBuildsNaturalDateRangeAndFillsBuckets(t *testing.T) {
	client := &fakeSnapshotClient{}
	mcpUsageStore := &fakeMCPUsageStore{}
	service, err := NewService(client, fakeActivityStore{}, mcpUsageStore, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	service.clock = func() time.Time { return time.Date(2027, 1, 1, 5, 0, 0, 0, time.UTC) }
	statistics, err := service.Statistics(context.Background(), Range7Days)
	if err != nil {
		t.Fatal(err)
	}
	if client.request.StartDate != "2026-12-26" || client.request.EndDate != "2027-01-01" || client.request.Granularity != "day" {
		t.Fatalf("request = %#v", client.request)
	}
	if len(statistics.Trend.Points) != 7 || statistics.Organization.Usage.TotalTokens != 6 {
		t.Fatalf("statistics = %#v", statistics)
	}
	if statistics.Trend.Points[0].BucketStart.Format(time.RFC3339) != "2026-12-26T00:00:00+08:00" {
		t.Fatalf("first bucket = %s", statistics.Trend.Points[0].BucketStart.Format(time.RFC3339))
	}
	if statistics.Organization.MCPDistribution == nil || statistics.Agents == nil || statistics.ModelDistribution == nil || statistics.TokenUsageRanking == nil {
		t.Fatal("empty arrays must not be null")
	}
	if len(statistics.TokenUsageRanking) != 1 || statistics.TokenUsageRanking[0].Name != "张三" {
		t.Fatalf("ranking = %#v", statistics.TokenUsageRanking)
	}
	if statistics.DataStatus["model_usage"] != "available" {
		t.Fatalf("model usage status = %#v", statistics.DataStatus)
	}
	if len(statistics.Organization.MCPDistribution) != 1 || statistics.Organization.MCPDistribution[0].InvocationCount != 3 {
		t.Fatalf("MCP distribution = %#v", statistics.Organization.MCPDistribution)
	}
	if !mcpUsageStore.start.Equal(time.Date(2026, 12, 26, 0, 0, 0, 0, service.location)) || !mcpUsageStore.end.Equal(time.Date(2027, 1, 2, 0, 0, 0, 0, service.location)) {
		t.Fatalf("MCP usage range = %s to %s", mcpUsageStore.start, mcpUsageStore.end)
	}
}

func TestServiceStatisticsFiltersTokenUsageRankingByAccountName(t *testing.T) {
	client := &fakeSnapshotClient{snapshot: &Snapshot{
		GeneratedAt: time.Now(),
		Trend:       []TrendPoint{{Usage: Usage{TotalTokens: 6}}},
		Models:      []ModelUsage{},
		TokenUsageRanking: []TokenUsageRank{
			{Rank: 1, Name: "外部账户", Requests: 8, TotalTokens: 80},
			{Rank: 2, Name: " 张三 ", Requests: 2, TotalTokens: 20},
			{Rank: 3, Name: "未命名 API Key", Requests: 1, TotalTokens: 10},
		},
	}}
	service, err := NewService(client, fakeActivityStore{}, &fakeMCPUsageStore{}, "Asia/Shanghai", func(context.Context) ([]string, error) {
		return []string{"张三", "李四"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	statistics, err := service.Statistics(context.Background(), Range7Days)
	if err != nil {
		t.Fatal(err)
	}
	if len(statistics.TokenUsageRanking) != 1 || statistics.TokenUsageRanking[0].Rank != 1 || statistics.TokenUsageRanking[0].Name != " 张三 " || statistics.TokenUsageRanking[0].TotalTokens != 20 {
		t.Fatalf("ranking = %#v", statistics.TokenUsageRanking)
	}
	if statistics.Organization.Usage.TotalTokens != 6 {
		t.Fatalf("organization usage = %#v", statistics.Organization.Usage)
	}
}

type agentListActivityStore struct {
	agents []Agent
}

func (s agentListActivityStore) Statistics(context.Context, time.Time, time.Time) (ActivitySnapshot, error) {
	return ActivitySnapshot{Agents: s.agents}, nil
}

func TestServiceAgentsAggregatesPartitionsAndSortsDeterministically(t *testing.T) {
	now := time.Date(2026, 8, 25, 5, 0, 0, 0, time.UTC)
	earlier := now.Add(-time.Hour)
	service, err := NewService(nil, agentListActivityStore{agents: []Agent{
		{CollectorID: "c2", AgentID: "agent-b", Name: "B", SessionCount: 2, TurnCount: 3, LastActivityAt: &earlier},
		{CollectorID: "c1", AgentID: "agent-a", Name: "A", SessionCount: 1, TurnCount: 3, LastActivityAt: &now},
		{CollectorID: "c3", AgentID: "agent-a", Name: "A", SessionCount: 2, TurnCount: 1, LastActivityAt: &earlier},
	}}, &fakeMCPUsageStore{}, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Agents(context.Background(), AgentListRequest{Range: Range7Days, SortBy: SortByTurnCount, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Agents) != 2 || result.Agents[0].AgentID != "agent-a" || result.Agents[0].TurnCount != 4 || result.Agents[0].SessionCount != 3 || result.Agents[0].Rank != 1 || result.Agents[1].AgentID != "agent-b" {
		t.Fatalf("agents = %#v", result.Agents)
	}
	if _, err := service.Agents(context.Background(), AgentListRequest{SortBy: "unknown", Limit: 10}); !errors.Is(err, ErrInvalidAgentList) {
		t.Fatalf("invalid sort error = %v", err)
	}
}

func TestServiceAgentsKeepsEmployeesSeparateAndPaginatesAfterFiltering(t *testing.T) {
	service, err := NewService(nil, agentListActivityStore{agents: []Agent{
		{CollectorID: "c1", AgentID: "shared", EmployeeID: "employee-a", EmployeeName: "张三", TurnCount: 2},
		{CollectorID: "c2", AgentID: "shared", EmployeeID: "employee-a", EmployeeName: "张三", TurnCount: 3},
		{CollectorID: "c3", AgentID: "shared", EmployeeID: "employee-b", EmployeeName: "李四", TurnCount: 7},
		{CollectorID: "c4", AgentID: "another", EmployeeID: "employee-a", EmployeeName: "张三", TurnCount: 4},
		{CollectorID: "c5", AgentID: "unknown", TurnCount: 1},
	}}, &fakeMCPUsageStore{}, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.Agents(context.Background(), AgentListRequest{Limit: 1})
	if err != nil || first.Total != 4 || !first.HasMore || first.NextOffset == nil || *first.NextOffset != 1 || first.Agents[0].EmployeeID != "employee-b" {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	filtered, err := service.Agents(context.Background(), AgentListRequest{EmployeeID: "employee-a", Limit: 1})
	if err != nil || filtered.Total != 2 || len(filtered.Agents) != 1 || filtered.Agents[0].TurnCount != 5 || filtered.Agents[0].EmployeeName != "张三" {
		t.Fatalf("filtered=%#v err=%v", filtered, err)
	}
	next, err := service.Agents(context.Background(), AgentListRequest{EmployeeID: "employee-a", Limit: 1, Offset: *filtered.NextOffset})
	if err != nil || next.HasMore || next.NextOffset != nil || next.Agents[0].AgentID != "another" || next.Agents[0].Rank != 2 {
		t.Fatalf("next=%#v err=%v", next, err)
	}
	for _, offset := range []int{2, 100} {
		empty, err := service.Agents(context.Background(), AgentListRequest{EmployeeID: "employee-a", Offset: offset})
		if err != nil || empty.Total != 2 || empty.Agents == nil || len(empty.Agents) != 0 || empty.HasMore || empty.NextOffset != nil {
			t.Fatalf("empty=%#v err=%v", empty, err)
		}
	}
}
