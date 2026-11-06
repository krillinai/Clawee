package activity

import (
	"context"
	"errors"
	"strings"
	"time"
)

func (s *Service) AgentUsage(ctx context.Context, userID, collectorID, agentID, requestedRange string) (AgentUsage, error) {
	r, err := s.DateRange(requestedRange)
	if err != nil {
		return AgentUsage{}, err
	}
	collectorID, agentID = strings.TrimSpace(collectorID), strings.TrimSpace(agentID)
	if collectorID == "" || agentID == "" {
		return AgentUsage{}, ErrAgentNotFound
	}
	store, ok := s.store.(AgentUsageStore)
	if !ok {
		return AgentUsage{}, ErrActivityUnavailable
	}
	result, err := store.AgentUsage(ctx, strings.TrimSpace(userID), collectorID, agentID, r)
	if err != nil {
		if errors.Is(err, ErrAgentNotFound) {
			return AgentUsage{}, ErrAgentNotFound
		}
		return AgentUsage{}, ErrActivityUnavailable
	}
	result.CollectorID, result.AgentID = collectorID, agentID
	result.Range, result.Timezone = r.Range, r.Timezone
	result.StartDate, result.EndDate, result.GeneratedAt = r.StartDate, r.EndDate, r.GeneratedAt
	result.Granularity = r.Granularity
	if result.MCPDistribution == nil {
		result.MCPDistribution = []MCPUsage{}
	}
	if result.SkillUsage == nil {
		result.SkillUsage = []SkillUsage{}
	}
	byBucket := map[int64]AgentUsagePoint{}
	for _, point := range result.Points {
		byBucket[point.BucketStart.Unix()] = point
	}
	result.Points = []AgentUsagePoint{}
	for at := r.Start; at.Before(r.End); {
		point := byBucket[at.Unix()]
		point.BucketStart = at
		result.Points = append(result.Points, point)
		if r.Granularity == "hour" {
			at = at.Add(time.Hour)
		} else {
			at = at.AddDate(0, 0, 1)
		}
	}
	return result, nil
}
