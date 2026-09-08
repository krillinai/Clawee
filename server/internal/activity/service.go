package activity

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"
)

type Service struct {
	client        SnapshotClient
	store         ActivityStore
	mcpUsageStore MCPUsageStore
	timezone      string
	location      *time.Location
	clock         func() time.Time
}

func NewService(client SnapshotClient, store ActivityStore, mcpUsageStore MCPUsageStore, timezone string) (*Service, error) {
	location, err := time.LoadLocation(strings.TrimSpace(timezone))
	if err != nil {
		return nil, err
	}
	return &Service{client: client, store: store, mcpUsageStore: mcpUsageStore, timezone: strings.TrimSpace(timezone), location: location, clock: time.Now}, nil
}

func (s *Service) Statistics(ctx context.Context, requestedRange string) (Statistics, error) {
	r, err := s.DateRange(requestedRange)
	if err != nil {
		return Statistics{}, err
	}
	request := SnapshotRequest{StartDate: r.StartDate, EndDate: r.EndDate, Granularity: r.Granularity}

	if s.store == nil || s.mcpUsageStore == nil {
		return Statistics{}, ErrActivityUnavailable
	}
	activity, err := s.store.Statistics(ctx, r.Start, r.End)
	if err != nil {
		return Statistics{}, ErrActivityUnavailable
	}
	mcpDistribution, err := s.mcpUsageStore.MCPUsage(ctx, r.Start, r.End)
	if err != nil {
		return Statistics{}, ErrActivityUnavailable
	}
	if mcpDistribution == nil {
		mcpDistribution = []MCPUsage{}
	}
	if activity.Agents == nil {
		activity.Agents = []Agent{}
	}
	empty := Statistics{
		Range: r.Range, Timezone: r.Timezone, StartDate: request.StartDate, EndDate: request.EndDate,
		GeneratedAt: r.GeneratedAt,
		Organization: Organization{Usage: Usage{}, ActiveEmployees: activity.ActiveEmployees, ActiveAgents: activity.ActiveAgents,
			CompletedTurns: activity.CompletedTurns, MCPDistribution: mcpDistribution},
		Trend: Trend{Granularity: r.Granularity, Points: []TrendPoint{}}, ModelDistribution: []ModelUsage{}, TokenUsageRanking: []TokenUsageRank{},
		Agents: activity.Agents, DataStatus: map[string]string{"model_usage": "not_configured", "activity": "available"},
	}
	if s.client == nil {
		return empty, nil
	}
	snapshot, err := s.client.Snapshot(ctx, request)
	if err != nil {
		empty.DataStatus["model_usage"] = "unavailable"
		return empty, nil
	}
	usage := Usage{}
	for _, point := range snapshot.Trend {
		if usage.InputTokens > math.MaxInt64-point.InputTokens || usage.CachedInputTokens > math.MaxInt64-point.CachedInputTokens ||
			usage.OutputTokens > math.MaxInt64-point.OutputTokens || usage.TotalTokens > math.MaxInt64-point.TotalTokens {
			empty.DataStatus["model_usage"] = "unavailable"
			return empty, nil
		}
		usage.InputTokens += point.InputTokens
		usage.CachedInputTokens += point.CachedInputTokens
		usage.OutputTokens += point.OutputTokens
		usage.TotalTokens += point.TotalTokens
	}
	points := fillTrend(snapshot.Trend, r.Start, r.End, r.Granularity)
	if snapshot.Models == nil {
		snapshot.Models = []ModelUsage{}
	}
	if snapshot.TokenUsageRanking == nil {
		snapshot.TokenUsageRanking = []TokenUsageRank{}
	}
	return Statistics{
		Range: r.Range, Timezone: r.Timezone, StartDate: request.StartDate, EndDate: request.EndDate,
		GeneratedAt:  snapshot.GeneratedAt,
		Organization: Organization{Usage: usage, ActiveEmployees: activity.ActiveEmployees, ActiveAgents: activity.ActiveAgents, CompletedTurns: activity.CompletedTurns, MCPDistribution: mcpDistribution},
		Trend:        Trend{Granularity: r.Granularity, Points: points}, ModelDistribution: snapshot.Models, TokenUsageRanking: snapshot.TokenUsageRanking,
		Agents: activity.Agents, DataStatus: map[string]string{"model_usage": "available", "activity": "available"},
	}, nil
}

func (s *Service) DateRange(requestedRange string) (DateRange, error) {
	requestedRange = strings.TrimSpace(requestedRange)
	if requestedRange == "" {
		requestedRange = Range7Days
	}
	days, granularity, err := rangeSettings(requestedRange)
	if err != nil {
		return DateRange{}, err
	}
	now := s.clock().In(s.location)
	endDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, s.location)
	start := endDay.AddDate(0, 0, -(days - 1))
	return DateRange{
		Range: requestedRange, Timezone: s.timezone, StartDate: start.Format("2006-01-02"), EndDate: endDay.Format("2006-01-02"),
		GeneratedAt: now, Start: start, End: endDay.AddDate(0, 0, 1), Granularity: granularity,
	}, nil
}

func (s *Service) Agents(ctx context.Context, input AgentListRequest) (AgentListResult, error) {
	if strings.TrimSpace(input.Range) == "" {
		input.Range = Range7Days
	}
	if strings.TrimSpace(input.SortBy) == "" {
		input.SortBy = SortByTurnCount
	}
	if input.Limit == 0 {
		input.Limit = 10
	}
	if input.Limit < 1 || input.Limit > 20 || (input.SortBy != SortByTurnCount && input.SortBy != SortBySessionCount && input.SortBy != SortByLastActivityAt) {
		return AgentListResult{}, ErrInvalidAgentList
	}
	statistics, err := s.Statistics(ctx, input.Range)
	if err != nil {
		return AgentListResult{}, err
	}
	byID := make(map[string]AgentListItem, len(statistics.Agents))
	for _, agent := range statistics.Agents {
		item := byID[agent.AgentID]
		if item.AgentID == "" {
			item = AgentListItem{AgentID: agent.AgentID, Name: agent.Name, Status: agent.Status}
		}
		item.SessionCount += agent.SessionCount
		item.TurnCount += agent.TurnCount
		if agent.LastActivityAt != nil && (item.LastActivityAt == nil || agent.LastActivityAt.After(*item.LastActivityAt)) {
			value := *agent.LastActivityAt
			item.LastActivityAt = &value
			item.Name = agent.Name
			item.Status = agent.Status
		}
		byID[agent.AgentID] = item
	}
	agents := make([]AgentListItem, 0, len(byID))
	for _, item := range byID {
		agents = append(agents, item)
	}
	sort.SliceStable(agents, func(i, j int) bool {
		left, right := agents[i], agents[j]
		switch input.SortBy {
		case SortBySessionCount:
			if left.SessionCount != right.SessionCount {
				return left.SessionCount > right.SessionCount
			}
		case SortByLastActivityAt:
			if left.LastActivityAt != nil || right.LastActivityAt != nil {
				if left.LastActivityAt == nil {
					return false
				}
				if right.LastActivityAt == nil {
					return true
				}
				if !left.LastActivityAt.Equal(*right.LastActivityAt) {
					return left.LastActivityAt.After(*right.LastActivityAt)
				}
			}
		default:
			if left.TurnCount != right.TurnCount {
				return left.TurnCount > right.TurnCount
			}
		}
		return left.AgentID < right.AgentID
	})
	if len(agents) > input.Limit {
		agents = agents[:input.Limit]
	}
	for index := range agents {
		agents[index].Rank = index + 1
	}
	return AgentListResult{
		Range: statistics.Range, Timezone: statistics.Timezone, StartDate: statistics.StartDate, EndDate: statistics.EndDate,
		GeneratedAt: statistics.GeneratedAt, SortBy: input.SortBy, Agents: agents, DataStatus: statistics.DataStatus,
	}, nil
}

func rangeSettings(value string) (int, string, error) {
	switch value {
	case RangeToday:
		return 1, "hour", nil
	case Range7Days:
		return 7, "day", nil
	case Range30Days:
		return 30, "day", nil
	default:
		return 0, "", ErrInvalidRange
	}
}

func fillTrend(raw []TrendPoint, start, end time.Time, granularity string) []TrendPoint {
	byBucket := make(map[int64]TrendPoint, len(raw))
	for _, point := range raw {
		byBucket[point.BucketStart.Unix()] = point
	}
	step := func(value time.Time) time.Time { return value.AddDate(0, 0, 1) }
	if granularity == "hour" {
		step = func(value time.Time) time.Time { return value.Add(time.Hour) }
	}
	out := []TrendPoint{}
	for bucket := start; bucket.Before(end); bucket = step(bucket) {
		point, ok := byBucket[bucket.Unix()]
		if !ok {
			point = TrendPoint{BucketStart: bucket}
		}
		out = append(out, point)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].BucketStart.Before(out[j].BucketStart) })
	return out
}
