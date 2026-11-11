package store

import (
	"context"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/krillinai/Clawee/server/internal/activity"
)

type ModelUsageSnapshotStore struct {
	pool mcpUsageQueryer
}

var _ activity.SnapshotClient = (*ModelUsageSnapshotStore)(nil)

func NewModelUsageSnapshotStore(pool *pgxpool.Pool) *ModelUsageSnapshotStore {
	if pool == nil {
		return &ModelUsageSnapshotStore{}
	}
	return &ModelUsageSnapshotStore{pool: pool}
}

func (s *ModelUsageSnapshotStore) Snapshot(ctx context.Context, request activity.SnapshotRequest) (activity.Snapshot, error) {
	if s == nil || s.pool == nil {
		return activity.Snapshot{}, activity.ErrActivityUnavailable
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return activity.Snapshot{}, err
	}
	start, err := time.ParseInLocation(time.DateOnly, request.StartDate, location)
	if err != nil {
		return activity.Snapshot{}, err
	}
	end, err := time.ParseInLocation(time.DateOnly, request.EndDate, location)
	if err != nil {
		return activity.Snapshot{}, err
	}
	if end.Before(start) || (request.Granularity != "hour" && request.Granularity != "day") {
		return activity.Snapshot{}, activity.ErrInvalidRange
	}
	rows, err := s.pool.Query(ctx, `
SELECT date_trunc($3, a.created_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS bucket_start,
       a.user_id, COALESCE(NULLIF(owner.name, ''), NULLIF(owner.email, ''), NULLIF(owner.phone, ''), a.user_id),
       a.model, COUNT(*),
       COUNT(*) FILTER (WHERE a.usage_status IN ('complete', 'partial')),
       COUNT(*) FILTER (WHERE a.usage_status <> 'complete'),
       COALESCE(SUM(a.input_tokens) FILTER (WHERE a.usage_status IN ('complete', 'partial')), 0),
       COALESCE(SUM(a.cache_read_tokens) FILTER (WHERE a.usage_status IN ('complete', 'partial')), 0),
       COALESCE(SUM(a.output_tokens) FILTER (WHERE a.usage_status IN ('complete', 'partial')), 0),
       COALESCE(SUM(a.total_tokens) FILTER (WHERE a.usage_status IN ('complete', 'partial')), 0)
FROM model_proxy_audit_records a
LEFT JOIN accounts owner ON owner.user_id = a.user_id
WHERE a.created_at >= $1 AND a.created_at < $2
  AND a.method = 'POST' AND a.endpoint IN ('/v1/chat/completions', '/v1/responses')
  AND a.status IN ('succeeded', 'failed', 'client_disconnected')
  AND (a.upstream_status > 0 OR a.usage_status IN ('complete', 'partial')
       OR a.error_code IN ('upstream_error', 'upstream_timeout'))
GROUP BY bucket_start, a.user_id, owner.name, owner.email, owner.phone, a.model
`, start, end.AddDate(0, 0, 1), request.Granularity)
	if err != nil {
		return activity.Snapshot{}, err
	}
	defer rows.Close()

	result := activity.Snapshot{GeneratedAt: time.Now(), Trend: []activity.TrendPoint{}, Models: []activity.ModelUsage{}, TokenUsageRanking: []activity.TokenUsageRank{}}
	points := map[int64]activity.TrendPoint{}
	models := map[string]activity.ModelUsage{}
	ranking := map[string]activity.TokenUsageRank{}
	var totalTokens int64
	for rows.Next() {
		var at time.Time
		var userID, name, model string
		var requests, known, incomplete int64
		var usage activity.Usage
		if err := rows.Scan(&at, &userID, &name, &model, &requests, &known, &incomplete,
			&usage.InputTokens, &usage.CachedInputTokens, &usage.OutputTokens, &usage.TotalTokens); err != nil {
			return activity.Snapshot{}, err
		}
		result.KnownUsageRequests += known
		result.IncompleteUsageRequests += incomplete
		totalTokens += usage.TotalTokens
		point := points[at.Unix()]
		point.BucketStart = at
		addModelUsage(&point.Usage, usage)
		points[at.Unix()] = point
		item := models[model]
		item.Model, item.Requests = model, item.Requests+requests
		addModelUsage(&item.Usage, usage)
		models[model] = item
		employee := ranking[userID]
		employee.Name, employee.Requests = name, employee.Requests+requests
		employee.TotalTokens += usage.TotalTokens
		ranking[userID] = employee
	}
	if err := rows.Err(); err != nil {
		return activity.Snapshot{}, err
	}
	for _, point := range points {
		result.Trend = append(result.Trend, point)
	}
	sort.Slice(result.Trend, func(i, j int) bool { return result.Trend[i].BucketStart.Before(result.Trend[j].BucketStart) })
	for _, model := range models {
		if totalTokens > 0 {
			model.Share = float64(model.TotalTokens) / float64(totalTokens)
		}
		result.Models = append(result.Models, model)
	}
	sort.Slice(result.Models, func(i, j int) bool {
		if result.Models[i].TotalTokens == result.Models[j].TotalTokens {
			return result.Models[i].Model < result.Models[j].Model
		}
		return result.Models[i].TotalTokens > result.Models[j].TotalTokens
	})
	// 先按稳定的用户 ID 排序，使同名、同用量员工的排行顺序保持稳定。
	userIDs := make([]string, 0, len(ranking))
	for userID := range ranking {
		userIDs = append(userIDs, userID)
	}
	sort.Strings(userIDs)
	for _, userID := range userIDs {
		result.TokenUsageRanking = append(result.TokenUsageRanking, ranking[userID])
	}
	sort.SliceStable(result.TokenUsageRanking, func(i, j int) bool {
		return result.TokenUsageRanking[i].TotalTokens > result.TokenUsageRanking[j].TotalTokens
	})
	if len(result.TokenUsageRanking) > 50 {
		result.TokenUsageRanking = result.TokenUsageRanking[:50]
	}
	for index := range result.TokenUsageRanking {
		result.TokenUsageRanking[index].Rank = index + 1
	}
	return result, nil
}

func addModelUsage(total *activity.Usage, usage activity.Usage) {
	total.InputTokens += usage.InputTokens
	total.CachedInputTokens += usage.CachedInputTokens
	total.OutputTokens += usage.OutputTokens
	total.TotalTokens += usage.TotalTokens
}
