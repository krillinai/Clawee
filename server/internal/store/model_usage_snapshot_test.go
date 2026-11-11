package store

import (
	"context"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestModelUsageSnapshotOnPostgres(t *testing.T) {
	pool, _ := skillRoleTestDatabase(t, 87)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES
('user-a','a@example.com','同名员工','unused','active',now(),now()),
('user-b','b@example.com','同名员工','unused','active',now(),now())`); err != nil {
		t.Fatal(err)
	}
	location, _ := time.LoadLocation("Asia/Shanghai")
	start := time.Date(2026, 11, 10, 0, 0, 0, 0, location)
	auditStore := NewMCPGatewayStore(pool)
	records := []mcpgateway.ModelProxyAuditRecord{
		{AuditID: "complete", UserID: "user-a", Model: "model-a", CreatedAt: start, InputTokens: 7, OutputTokens: 3, TotalTokens: 10, CacheReadTokens: 5, UsageStatus: mcpgateway.ModelProxyUsageComplete},
		{AuditID: "partial_failed", UserID: "user-a", Model: "model-b", CreatedAt: start.Add(time.Hour), InputTokens: 20, TotalTokens: 20, UsageStatus: mcpgateway.ModelProxyUsagePartial, Status: mcpgateway.ModelProxyAuditFailed},
		{AuditID: "disconnected", UserID: "user-b", Endpoint: "/v1/responses", Model: "model-a", CreatedAt: start.Add(24*time.Hour - time.Second), InputTokens: 4, OutputTokens: 6, TotalTokens: 10, UsageStatus: mcpgateway.ModelProxyUsageComplete, Status: mcpgateway.ModelProxyAuditClientDisconnected},
		{AuditID: "unknown", UserID: "user-b", Model: "model-a", CreatedAt: start.Add(2 * time.Hour), TotalTokens: 999, UsageStatus: mcpgateway.ModelProxyUsageUnavailable},
		{AuditID: "no_headers", UserID: "user-b", Model: "model-a", CreatedAt: start.Add(2 * time.Hour), Status: mcpgateway.ModelProxyAuditFailed, ErrorCode: "upstream_timeout"},
	}
	for _, record := range records {
		if record.Endpoint == "" {
			record.Endpoint = "/v1/chat/completions"
		}
		record.Method = "POST"
		if record.Status == "" {
			record.Status = mcpgateway.ModelProxyAuditSucceeded
		}
		if record.ErrorCode == "" {
			record.UpstreamStatus = 200
		}
		record.CompletedAt = record.CreatedAt.Add(time.Second)
		record.UserNameSnapshot = "改名前的名字"
		if err := auditStore.CreateModelProxyAuditRecord(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	for _, record := range []mcpgateway.ModelProxyAuditRecord{
		{AuditID: "before", CreatedAt: start.Add(-time.Second), Endpoint: "/v1/responses", Method: "POST", Status: mcpgateway.ModelProxyAuditSucceeded, UpstreamStatus: 200},
		{AuditID: "after", CreatedAt: start.Add(24 * time.Hour), Endpoint: "/v1/responses", Method: "POST", Status: mcpgateway.ModelProxyAuditSucceeded, UpstreamStatus: 200},
		{AuditID: "models", CreatedAt: start, Endpoint: "/v1/models", Method: "GET", Status: mcpgateway.ModelProxyAuditSucceeded},
		{AuditID: "rejected", CreatedAt: start, Endpoint: "/v1/responses", Method: "POST", Status: mcpgateway.ModelProxyAuditRejectedScope},
		{AuditID: "invalid", CreatedAt: start, Endpoint: "/v1/responses", Method: "POST", Status: mcpgateway.ModelProxyAuditFailed},
		{AuditID: "running", CreatedAt: start, Endpoint: "/v1/responses", Method: "POST", Status: mcpgateway.ModelProxyAuditStarted, UpstreamStatus: 200},
	} {
		if record.Status != mcpgateway.ModelProxyAuditStarted {
			record.CompletedAt = record.CreatedAt.Add(time.Second)
		}
		if err := auditStore.CreateModelProxyAuditRecord(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	client := NewModelUsageSnapshotStore(pool)
	for _, granularity := range []string{"hour", "day"} {
		snapshot, err := client.Snapshot(ctx, activity.SnapshotRequest{StartDate: "2026-11-10", EndDate: "2026-11-10", Granularity: granularity})
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.KnownUsageRequests != 3 || snapshot.IncompleteUsageRequests != 3 {
			t.Fatalf("用量覆盖统计不正确: %#v", snapshot)
		}
		var trendUsage, modelUsage activity.Usage
		for _, point := range snapshot.Trend {
			if point.BucketStart.In(location).Day() != 10 {
				t.Fatalf("北京时间日期错误: %v", point.BucketStart)
			}
			addModelUsage(&trendUsage, point.Usage)
		}
		var requests, rankedTokens int64
		for _, item := range snapshot.Models {
			addModelUsage(&modelUsage, item.Usage)
			requests += item.Requests
			if item.Share != 0.5 {
				t.Fatalf("模型占比不正确: %#v", item)
			}
		}
		for _, rank := range snapshot.TokenUsageRanking {
			rankedTokens += rank.TotalTokens
		}
		want := activity.Usage{InputTokens: 31, CachedInputTokens: 5, OutputTokens: 9, TotalTokens: 40}
		if trendUsage != want || modelUsage != want || rankedTokens != 40 || requests != 5 {
			t.Fatalf("统计不一致: trend=%#v models=%#v ranking=%d requests=%d", trendUsage, modelUsage, rankedTokens, requests)
		}
		if len(snapshot.TokenUsageRanking) != 2 || snapshot.TokenUsageRanking[0].Name != "同名员工" || snapshot.TokenUsageRanking[1].Name != "同名员工" || snapshot.TokenUsageRanking[0].TotalTokens != 30 || snapshot.TokenUsageRanking[0].Requests != 2 {
			t.Fatalf("同名员工被合并或旧姓名未更新: %#v", snapshot.TokenUsageRanking)
		}
		if (granularity == "day" && len(snapshot.Trend) != 1) || (granularity == "hour" && len(snapshot.Trend) != 4) {
			t.Fatalf("时间分桶不正确: %#v", snapshot.Trend)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET name = '' WHERE user_id = 'user-a'`); err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.Snapshot(ctx, activity.SnapshotRequest{StartDate: "2026-11-10", EndDate: "2026-11-10", Granularity: "day"})
	if err != nil || snapshot.TokenUsageRanking[0].Name != "a@example.com" {
		t.Fatalf("员工名称回退失败: %#v, %v", snapshot, err)
	}
}

func TestModelUsageSnapshotWithoutDatabaseIsUnavailable(t *testing.T) {
	if _, err := NewModelUsageSnapshotStore(nil).Snapshot(context.Background(), activity.SnapshotRequest{}); err != activity.ErrActivityUnavailable {
		t.Fatalf("缺少数据库时不能返回零用量: %v", err)
	}
}
