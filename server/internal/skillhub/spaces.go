package skillhub

import (
	"context"
	"sort"
	"strings"
	"time"
)

func (s *Service) CreateSpace(ctx context.Context, name, description, operator string) (SpaceSummary, error) {
	name, description, operator = strings.TrimSpace(name), strings.TrimSpace(description), strings.TrimSpace(operator)
	if s == nil || s.spaces == nil || name == "" || len([]rune(name)) > 100 || len([]rune(description)) > 500 || operator == "" {
		return SpaceSummary{}, ErrInvalidRequest
	}
	now := s.clock().UTC()
	return s.spaces.CreateSpace(ctx, Space{
		SpaceID: newID("skillspace"), Name: name, Description: description,
		CreatedBy: operator, UpdatedBy: operator, CreatedAt: now, UpdatedAt: now,
	})
}

func (s *Service) UpdateSpace(ctx context.Context, spaceID, name, description, operator string) (SpaceSummary, error) {
	spaceID, name, description, operator = strings.TrimSpace(spaceID), strings.TrimSpace(name), strings.TrimSpace(description), strings.TrimSpace(operator)
	if s == nil || s.spaces == nil || spaceID == "" || name == "" || len([]rune(name)) > 100 || len([]rune(description)) > 500 || operator == "" {
		return SpaceSummary{}, ErrInvalidRequest
	}
	return s.spaces.UpdateSpace(ctx, Space{SpaceID: spaceID, Name: name, Description: description, UpdatedBy: operator, UpdatedAt: s.clock().UTC()})
}

func (s *Service) ListSpaces(ctx context.Context) ([]SpaceSummary, error) {
	if s == nil || s.spaces == nil {
		return nil, ErrInvalidRequest
	}
	return s.spaces.ListSpaces(ctx)
}

func (s *Service) GetSpace(ctx context.Context, spaceID string) (SpaceSummary, error) {
	if s == nil || s.spaces == nil || strings.TrimSpace(spaceID) == "" {
		return SpaceSummary{}, ErrInvalidRequest
	}
	return s.spaces.GetSpace(ctx, strings.TrimSpace(spaceID))
}

func (s *Service) MoveSkillsToSpace(ctx context.Context, skillIDs []string, targetSpaceID string) (SkillSpaceMoveResult, error) {
	targetSpaceID = strings.TrimSpace(targetSpaceID)
	if s == nil || s.store == nil || targetSpaceID == "" || len(skillIDs) == 0 {
		return SkillSpaceMoveResult{}, ErrInvalidRequest
	}
	seen := make(map[string]bool, len(skillIDs))
	normalized := make([]string, 0, len(skillIDs))
	for _, skillID := range skillIDs {
		skillID = strings.TrimSpace(skillID)
		if skillID == "" {
			return SkillSpaceMoveResult{}, ErrInvalidRequest
		}
		if !seen[skillID] {
			seen[skillID] = true
			normalized = append(normalized, skillID)
		}
	}
	return s.store.MoveSkillsToSpace(ctx, normalized, targetSpaceID, s.clock().UTC())
}

func (s *Service) ListAuthorizedSpaces(ctx context.Context, userID string) ([]Space, error) {
	if s == nil || s.spaces == nil || strings.TrimSpace(userID) == "" {
		return nil, ErrInvalidRequest
	}
	return s.spaces.ListAuthorizedSpaces(ctx, strings.TrimSpace(userID))
}

func (s *Service) ListSpaceMembers(ctx context.Context, spaceID string) ([]SpaceMemberGrant, error) {
	if s == nil || s.spaces == nil || strings.TrimSpace(spaceID) == "" {
		return nil, ErrInvalidRequest
	}
	return s.spaces.ListSpaceMembers(ctx, strings.TrimSpace(spaceID))
}

func (s *Service) SetSpaceMember(ctx context.Context, spaceID, userID string, actions []string, operator string, replace bool) (SpaceMemberGrant, error) {
	spaceID, userID, operator = strings.TrimSpace(spaceID), strings.TrimSpace(userID), strings.TrimSpace(operator)
	if s == nil || s.spaces == nil || spaceID == "" || userID == "" || operator == "" {
		return SpaceMemberGrant{}, ErrInvalidRequest
	}
	actions, err := normalizeSpaceActions(actions)
	if err != nil {
		return SpaceMemberGrant{}, err
	}
	return s.spaces.SetSpaceMember(ctx, spaceID, userID, actions, operator, replace, s.clock().UTC())
}

func (s *Service) RemoveSpaceMember(ctx context.Context, spaceID, userID string) error {
	if s == nil || s.spaces == nil || strings.TrimSpace(spaceID) == "" || strings.TrimSpace(userID) == "" {
		return ErrInvalidRequest
	}
	return s.spaces.RemoveSpaceMember(ctx, strings.TrimSpace(spaceID), strings.TrimSpace(userID))
}

func normalizeSpaceActions(actions []string) ([]string, error) {
	seen := map[string]bool{}
	for _, action := range actions {
		action = strings.TrimSpace(action)
		if action != SpaceActionRead && action != SpaceActionWrite {
			return nil, ErrInvalidRequest
		}
		seen[action] = true
	}
	if !seen[SpaceActionRead] {
		return nil, ErrInvalidRequest
	}
	result := []string{SpaceActionRead}
	if seen[SpaceActionWrite] {
		result = append(result, SpaceActionWrite)
	}
	return result, nil
}

func (s *Service) UploadVersionForUser(ctx context.Context, userID, agentID string, input UploadVersionInput) (MutationResult, error) {
	if s == nil || s.spaces == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(input.SpaceID) == "" {
		return MutationResult{}, ErrInvalidRequest
	}
	if err := s.spaces.CheckSpaceAccess(ctx, userID, input.SpaceID, SpaceActionWrite); err != nil {
		return MutationResult{}, err
	}
	input.UploadedByUserID = userID
	input.UploadedByAgentID = strings.TrimSpace(agentID)
	return s.UploadVersion(ctx, input)
}

func (s *Service) ListPublishedForUser(ctx context.Context, userID string) ([]PublishedItem, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, ErrInvalidRequest
	}
	return s.store.ListPublishedForUser(ctx, strings.TrimSpace(userID))
}

func (s *Service) GetPublishedForUser(ctx context.Context, userID, skillID string) (PublishedDetail, error) {
	if s == nil || s.spaces == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(skillID) == "" {
		return PublishedDetail{}, ErrNotFound
	}
	if err := s.spaces.CheckSkillAccess(ctx, userID, skillID, SpaceActionRead); err != nil {
		return PublishedDetail{}, err
	}
	return s.GetPublished(ctx, skillID)
}

func sortedSpaceActions(actions map[string]bool) []string {
	result := []string{}
	for action, allowed := range actions {
		if allowed {
			result = append(result, action)
		}
	}
	sort.Strings(result)
	return result
}

func earliestTime(left, right time.Time) time.Time {
	if left.IsZero() || (!right.IsZero() && right.Before(left)) {
		return right
	}
	return left
}
