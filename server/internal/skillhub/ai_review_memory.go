package skillhub

import (
	"context"
	"time"
)

func (s *MemoryStore) findSkillByName(ctx context.Context, name string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if id := s.byName[name]; id != "" {
		return id, nil
	}
	return "", ErrNotFound
}

func (s *MemoryStore) GetAIReviewConfig(_ context.Context, space string) (AIReviewConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.spaces[space]; !ok {
		return AIReviewConfig{}, ErrSpaceNotFound
	}
	return s.aiConfigs[space], nil
}

func (s *MemoryStore) SetAIReviewConfig(ctx context.Context, spaceID string, config AIReviewConfig, user string, _ time.Time) (AIReviewConfig, error) {
	return AIReviewConfig{}, ErrReviewForbidden
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
			if current.Status == "pending" || current.Status == "running" {
				ids = append(ids, request.ID)
			}
		}
	}
	return ids, nil
}

func (s *MemoryStore) withAIReview(ctx context.Context, id, user, agent string, administrator bool, now time.Time, apply func(*aiReviewState) error) error {
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
				if current == nil || current.ID != id || request.Status == "invalidated" || version.Source != nil || space.ApprovalProvider != "local" || !localApprovalConfigured(space) || len(request.AIAttempts) == 0 {
					return ErrConflict
				}
				if !s.hasAccessLocked(user, skill.SpaceID, SpaceActionRead) || s.aiIdentityLookup == nil {
					return ErrReviewForbidden
				}
				if err := s.aiIdentityLookup(ctx, user, agent); err != nil {
					return ErrReviewForbidden
				}
				if agent == "" && version.UploadedByUserID != user && !administrator {
					return ErrReviewForbidden
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
