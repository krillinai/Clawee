package skillhub

import (
	"context"
	"strings"
	"time"
)

func (s *Service) SetSpaceApprover(ctx context.Context, spaceID, userID, operator string) error {
	store, ok := s.store.(ReviewStore)
	if !ok || strings.TrimSpace(spaceID) == "" || strings.TrimSpace(operator) == "" {
		return ErrInvalidRequest
	}
	return store.SetSpaceApprover(ctx, strings.TrimSpace(spaceID), strings.TrimSpace(userID), operator, s.clock().UTC())
}

func (s *Service) ReviewVersion(ctx context.Context, skillID, versionID, reviewer string, approve bool, comment string) (Version, error) {
	store, ok := s.store.(ReviewStore)
	comment = strings.TrimSpace(comment)
	if !ok || strings.TrimSpace(skillID) == "" || strings.TrimSpace(versionID) == "" || strings.TrimSpace(reviewer) == "" || len([]rune(comment)) > 2000 {
		return Version{}, ErrInvalidRequest
	}
	return store.ReviewVersion(ctx, skillID, versionID, reviewer, approve, comment, s.clock().UTC())
}

func (s *MemoryStore) SetSpaceApprover(_ context.Context, spaceID, userID, operator string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	space, ok := s.spaces[spaceID]
	if !ok {
		return ErrSpaceNotFound
	}
	space.ApproverUserID, space.ApproverName = userID, userID
	space.UpdatedBy, space.UpdatedAt = operator, now
	s.spaces[spaceID] = space
	return nil
}

func (s *MemoryStore) ReviewVersion(_ context.Context, skillID, versionID, reviewer string, approve bool, comment string, now time.Time) (Version, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[skillID]
	if !ok {
		return Version{}, ErrNotFound
	}
	if s.spaces[skill.SpaceID].ApproverUserID != reviewer || reviewer == "" {
		return Version{}, ErrReviewForbidden
	}
	for i, version := range s.versions[skillID] {
		if version.VersionID != versionID {
			continue
		}
		if version.ApprovalStatus == "approved" {
			return Version{}, ErrConflict
		}
		version.ApprovalStatus = "rejected"
		if approve {
			version.ApprovalStatus = "approved"
		}
		version.ApprovedSpaceID, version.ReviewedBy, version.ReviewedAt, version.ReviewComment = skill.SpaceID, reviewer, &now, comment
		s.versions[skillID][i] = version
		return version, nil
	}
	return Version{}, ErrNotFound
}
