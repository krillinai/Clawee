package skillhub

import (
	"context"
	"time"
)

func (s *MemoryStore) GetAIReviewConfig(_ context.Context, space string) (AIReviewConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.spaces[space]; !ok {
		return AIReviewConfig{}, ErrSpaceNotFound
	}
	return s.aiConfigs[space], nil
}

func (s *MemoryStore) SetAIReviewConfig(ctx context.Context, spaceID string, config AIReviewConfig, user string, _ time.Time) (AIReviewConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	space, ok := s.spaces[spaceID]
	if !ok {
		return AIReviewConfig{}, ErrSpaceNotFound
	}
	if s.aiIdentityLookup == nil || s.aiIdentityLookup(ctx, user, "") != nil {
		return AIReviewConfig{}, ErrReviewForbidden
	}
	if config.Enabled {
		if space.ApprovalProvider != "local" || !localApprovalConfigured(space) {
			return AIReviewConfig{}, ErrInvalidRequest
		}
		if s.aiIdentityLookup(ctx, "", config.AgentID) != nil {
			return AIReviewConfig{}, ErrInvalidRequest
		}
	}
	s.aiConfigs[spaceID] = config
	return config, nil
}

func (s *MemoryStore) listAIReviewRequests(_ context.Context, agent string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := []string{}
	for _, requests := range s.localApprovals {
		for _, request := range requests {
			if len(request.AIAttempts) == 0 {
				continue
			}
			current := request.AIAttempts[len(request.AIAttempts)-1]
			if current.AgentID == agent && (current.Status == "pending" || current.Status == "running") {
				ids = append(ids, request.ID)
			}
		}
	}
	return ids, nil
}

func (s *MemoryStore) withAIReview(ctx context.Context, id, user string, reviewer bool, now time.Time, apply func(*aiReviewState) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for skillID, versions := range s.versions {
		for _, version := range versions {
			for index := range s.localApprovals[version.VersionID] {
				request := &s.localApprovals[version.VersionID][index]
				if request.ID != id {
					continue
				}
				skill := s.skills[skillID]
				space := s.spaces[skill.SpaceID]
				current := s.currentLocalLocked(version, skill.SpaceID)
				if current == nil || current.ID != id || request.Status != "pending" || version.ApprovalStatus != "pending" || version.Source != nil || space.ApprovalProvider != "local" || !localApprovalConfigured(space) || len(request.AIAttempts) == 0 {
					return ErrConflict
				}
				if !s.hasAccessLocked(user, skill.SpaceID, SpaceActionRead) || s.aiIdentityLookup == nil {
					return ErrReviewForbidden
				}
				agent := request.AIAttempts[len(request.AIAttempts)-1].AgentID
				if reviewer {
					agent = ""
				}
				if err := s.aiIdentityLookup(ctx, user, agent); err != nil {
					return ErrReviewForbidden
				}
				if reviewer {
					decision, member := request.Decisions[user]
					if !member || decision.Status != "pending" {
						return ErrReviewForbidden
					}
				}
				expireAIAttempts(request.AIAttempts, now)
				state := &aiReviewState{Skill: skill, Version: version, Request: *request}
				err := apply(state)
				request.AIAttempts = state.Request.AIAttempts
				return err
			}
		}
	}
	return ErrNotFound
}
