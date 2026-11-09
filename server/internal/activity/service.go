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
	accountNames  AccountNameLoader
	timezone      string
	location      *time.Location
	clock         func() time.Time
}

type AccountNameLoader func(context.Context) ([]string, error)

func NewService(client SnapshotClient, store ActivityStore, mcpUsageStore MCPUsageStore, timezone string, accountNames ...AccountNameLoader) (*Service, error) {
	location, err := time.LoadLocation(strings.TrimSpace(timezone))
	if err != nil {
		return nil, err
	}
	var accountNameLoader AccountNameLoader
	if len(accountNames) > 0 {
		accountNameLoader = accountNames[0]
	}
	return &Service{client: client, store: store, mcpUsageStore: mcpUsageStore, accountNames: accountNameLoader, timezone: strings.TrimSpace(timezone), location: location, clock: time.Now}, nil
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
	if activity.SkillUsage == nil {
		activity.SkillUsage = []SkillUsage{}
	}
	if activity.EmployeeSkillUsage == nil {
		activity.EmployeeSkillUsage = []EmployeeSkillUsage{}
	}
	empty := Statistics{
		Range: r.Range, Timezone: r.Timezone, StartDate: request.StartDate, EndDate: request.EndDate,
		GeneratedAt: r.GeneratedAt,
		Organization: Organization{Usage: Usage{}, ActiveEmployees: activity.ActiveEmployees, ActiveAgents: activity.ActiveAgents,
			PlatformActivity: activity.PlatformActivity,
			CompletedTurns:   activity.CompletedTurns, MCPDistribution: mcpDistribution, SkillUsage: activity.SkillUsage,
			EmployeeSkillUsage: activity.EmployeeSkillUsage, SkillContributions: activity.SkillContributions, SkillUsageTotals: activity.SkillUsageTotals},
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
	if s.accountNames != nil {
		accountNames, err := s.accountNames(ctx)
		if err != nil {
			empty.DataStatus["model_usage"] = "unavailable"
			return empty, nil
		}
		snapshot.TokenUsageRanking = filterTokenUsageRanking(snapshot.TokenUsageRanking, accountNames)
	}
	return Statistics{
		Range: r.Range, Timezone: r.Timezone, StartDate: request.StartDate, EndDate: request.EndDate,
		GeneratedAt:  snapshot.GeneratedAt,
		Organization: Organization{Usage: usage, ActiveEmployees: activity.ActiveEmployees, ActiveAgents: activity.ActiveAgents, PlatformActivity: activity.PlatformActivity, CompletedTurns: activity.CompletedTurns, MCPDistribution: mcpDistribution, SkillUsage: activity.SkillUsage, EmployeeSkillUsage: activity.EmployeeSkillUsage, SkillContributions: activity.SkillContributions, SkillUsageTotals: activity.SkillUsageTotals},
		Trend:        Trend{Granularity: r.Granularity, Points: points}, ModelDistribution: snapshot.Models, TokenUsageRanking: snapshot.TokenUsageRanking,
		Agents: activity.Agents, DataStatus: map[string]string{"model_usage": "available", "activity": "available"},
	}, nil
}

func filterTokenUsageRanking(ranking []TokenUsageRank, accountNames []string) []TokenUsageRank {
	allowed := make(map[string]struct{}, len(accountNames))
	for _, name := range accountNames {
		if name = strings.TrimSpace(name); name != "" {
			allowed[name] = struct{}{}
		}
	}
	filtered := make([]TokenUsageRank, 0, len(ranking))
	for _, item := range ranking {
		if _, ok := allowed[strings.TrimSpace(item.Name)]; !ok {
			continue
		}
		item.Rank = len(filtered) + 1
		filtered = append(filtered, item)
	}
	return filtered
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
	if input.Limit < 1 || input.Limit > 20 || input.Offset < 0 || (input.SortBy != SortByTurnCount && input.SortBy != SortBySessionCount && input.SortBy != SortByLastActivityAt) {
		return AgentListResult{}, ErrInvalidAgentList
	}
	statistics, err := s.Statistics(ctx, input.Range)
	if err != nil {
		return AgentListResult{}, err
	}
	type agentKey struct{ employeeID, agentID string }
	byID := make(map[agentKey]AgentListItem, len(statistics.Agents))
	for _, agent := range statistics.Agents {
		if input.EmployeeID != "" && agent.EmployeeID != input.EmployeeID {
			continue
		}
		key := agentKey{agent.EmployeeID, agent.AgentID}
		item := byID[key]
		if item.AgentID == "" {
			item = AgentListItem{AgentID: agent.AgentID, Name: agent.Name, Status: agent.Status, EmployeeID: agent.EmployeeID, EmployeeName: agent.EmployeeName}
		}
		item.SessionCount += agent.SessionCount
		item.TurnCount += agent.TurnCount
		if agent.LastActivityAt != nil && (item.LastActivityAt == nil || agent.LastActivityAt.After(*item.LastActivityAt)) {
			value := *agent.LastActivityAt
			item.LastActivityAt = &value
			item.Name = agent.Name
			item.Status = agent.Status
		}
		byID[key] = item
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
		if left.AgentID != right.AgentID {
			return left.AgentID < right.AgentID
		}
		return left.EmployeeID < right.EmployeeID
	})
	for index := range agents {
		agents[index].Rank = index + 1
	}
	total := len(agents)
	start := min(input.Offset, total)
	agents = agents[start : start+min(input.Limit, total-start)]
	hasMore := input.Offset < total && len(agents) < total-input.Offset
	var nextOffset *int
	if hasMore {
		next := input.Offset + len(agents)
		nextOffset = &next
	}
	return AgentListResult{
		Range: statistics.Range, Timezone: statistics.Timezone, StartDate: statistics.StartDate, EndDate: statistics.EndDate,
		GeneratedAt: statistics.GeneratedAt, SortBy: input.SortBy, Agents: agents, DataStatus: statistics.DataStatus,
		Total: total, Limit: input.Limit, Offset: input.Offset, HasMore: hasMore, NextOffset: nextOffset,
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
