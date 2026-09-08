package skillhub

import (
	"context"
	"strings"
	"time"
)

func (s *MemoryStore) CreateSpace(_ context.Context, space Space) (SpaceSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.spaces {
		if strings.EqualFold(item.Name, space.Name) {
			return SpaceSummary{}, ErrSpaceNameConflict
		}
	}
	s.spaces[space.SpaceID] = space
	return s.spaceSummaryLocked(space), nil
}

func (s *MemoryStore) UpdateSpace(_ context.Context, space Space) (SpaceSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.spaces[space.SpaceID]
	if !ok {
		return SpaceSummary{}, ErrSpaceNotFound
	}
	for id, item := range s.spaces {
		if id != space.SpaceID && strings.EqualFold(item.Name, space.Name) {
			return SpaceSummary{}, ErrSpaceNameConflict
		}
	}
	current.Name, current.Description, current.UpdatedBy, current.UpdatedAt = space.Name, space.Description, space.UpdatedBy, space.UpdatedAt
	s.spaces[space.SpaceID] = current
	return s.spaceSummaryLocked(current), nil
}

func (s *MemoryStore) ListSpaces(_ context.Context) ([]SpaceSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]SpaceSummary, 0, len(s.spaces))
	for _, space := range s.spaces {
		items = append(items, s.spaceSummaryLocked(space))
	}
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j].UpdatedAt.After(items[j-1].UpdatedAt); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
	return items, nil
}

func (s *MemoryStore) GetSpace(_ context.Context, spaceID string) (SpaceSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	space, ok := s.spaces[spaceID]
	if !ok {
		return SpaceSummary{}, ErrSpaceNotFound
	}
	return s.spaceSummaryLocked(space), nil
}

func (s *MemoryStore) ListAuthorizedSpaces(_ context.Context, userID string) ([]Space, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []Space{}
	for id, space := range s.spaces {
		actions := s.grants[userID][id]
		if !actions[SpaceActionRead] && !(id == DefaultSpaceID && len(s.grants) == 0) {
			continue
		}
		space.Actions = sortedSpaceActions(actions)
		if id == DefaultSpaceID && len(space.Actions) == 0 {
			space.Actions = []string{SpaceActionRead}
		}
		items = append(items, space)
	}
	return items, nil
}

func (s *MemoryStore) CheckSpaceAccess(_ context.Context, userID, spaceID, action string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.spaces[spaceID]; !ok || !s.hasAccessLocked(userID, spaceID, action) {
		return ErrSpaceNotFound
	}
	return nil
}

func (s *MemoryStore) CheckSkillAccess(_ context.Context, userID, skillID, action string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[skillID]
	if !ok || !s.hasAccessLocked(userID, skill.SpaceID, action) {
		return ErrNotFound
	}
	return nil
}

func (s *MemoryStore) ListSpaceMembers(_ context.Context, spaceID string) ([]SpaceMemberGrant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.spaces[spaceID]; !ok {
		return nil, ErrSpaceNotFound
	}
	items := []SpaceMemberGrant{}
	for userID, spaces := range s.grants {
		if actions := spaces[spaceID]; len(actions) > 0 {
			items = append(items, SpaceMemberGrant{UserID: userID, Actions: sortedSpaceActions(actions), GrantStatus: grantStatus(actions)})
		}
	}
	return items, nil
}

func (s *MemoryStore) SetSpaceMember(_ context.Context, spaceID, userID string, actions []string, _ string, replace bool, now time.Time) (SpaceMemberGrant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.spaces[spaceID]; !ok {
		return SpaceMemberGrant{}, ErrSpaceNotFound
	}
	if s.grants[userID] == nil {
		s.grants[userID] = map[string]map[string]bool{}
	}
	existing := s.grants[userID][spaceID]
	if replace && len(existing) == 0 {
		return SpaceMemberGrant{}, ErrMemberNotFound
	}
	if !replace && len(existing) > 0 {
		return SpaceMemberGrant{}, ErrMemberAlreadyExists
	}
	joinedAt := now
	if len(existing) > 0 {
		joinedAt = now
	}
	grants := map[string]bool{}
	for _, action := range actions {
		grants[action] = true
	}
	s.grants[userID][spaceID] = grants
	return SpaceMemberGrant{UserID: userID, Actions: sortedSpaceActions(grants), GrantStatus: grantStatus(grants), JoinedAt: joinedAt, UpdatedAt: now}, nil
}

func (s *MemoryStore) RemoveSpaceMember(_ context.Context, spaceID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.grants[userID][spaceID]) == 0 {
		return ErrMemberNotFound
	}
	delete(s.grants[userID], spaceID)
	return nil
}

func (s *MemoryStore) hasAccessLocked(userID, spaceID, action string) bool {
	if action == SpaceActionRead && spaceID == DefaultSpaceID && len(s.grants) == 0 {
		return true
	}
	return s.grants[userID][spaceID][action]
}

func (s *MemoryStore) spaceSummaryLocked(space Space) SpaceSummary {
	var summary SpaceSummary
	summary.Space = space
	for _, spaces := range s.grants {
		if spaces[space.SpaceID][SpaceActionRead] {
			summary.MemberCount++
		}
	}
	for _, skill := range s.skills {
		if skill.SpaceID == space.SpaceID {
			summary.SkillCount++
			if skill.CurrentVersionID != nil {
				summary.PublishedCount++
			}
		}
	}
	return summary
}

func grantStatus(actions map[string]bool) string {
	if actions[SpaceActionRead] && actions[SpaceActionWrite] {
		return "complete"
	}
	return "incomplete"
}
