package skillhub

import (
	"context"
	"strings"
	"time"
)

func (s *Service) ResubmitReview(ctx context.Context, skillID, versionID, requestID, userID string) (Version, error) {
	store, ok := s.store.(ReviewStore)
	if !ok || strings.TrimSpace(skillID) == "" || strings.TrimSpace(versionID) == "" || strings.TrimSpace(requestID) == "" || strings.TrimSpace(userID) == "" {
		return Version{}, ErrInvalidRequest
	}
	return store.ResubmitReview(ctx, skillID, versionID, requestID, userID, s.clock().UTC())
}

func (s *MemoryStore) ResubmitReview(ctx context.Context, skillID, versionID, requestID, userID string, now time.Time) (Version, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[skillID]
	if !ok {
		return Version{}, ErrNotFound
	}
	space := s.spaces[skill.SpaceID]
	if space.ApprovalProvider != "local" || !localApprovalConfigured(space) || !s.hasAccessLocked(userID, skill.SpaceID, SpaceActionRead) {
		return Version{}, ErrReviewForbidden
	}
	for index, version := range s.versions[skillID] {
		if version.VersionID != versionID {
			continue
		}
		if version.Source != nil || version.UploadedByUserID == "" || version.UploadedByUserID != userID {
			return Version{}, ErrReviewForbidden
		}
		request := s.currentLocalLocked(version, skill.SpaceID)
		if skill.CurrentVersionID != nil && *skill.CurrentVersionID == versionID || version.ApprovalStatus != "rejected" || request == nil || request.Status != "rejected" || request.ID != requestID {
			return Version{}, ErrConflict
		}
		resolved, err := s.resolveLocalApproversLocked(ctx, space)
		if err != nil {
			return Version{}, err
		}
		s.createLocalResolvedLocked(version, space, resolved, now)
		version.ApprovalStatus, version.ApprovedSpaceID, version.ReviewedBy, version.ReviewedAt, version.ReviewComment = "pending", "", "", nil, ""
		version.LocalApproval = nil
		s.versions[skillID][index] = version
		version.LocalApproval = localProgress(s.currentLocalLocked(version, skill.SpaceID))
		return version, nil
	}
	return Version{}, ErrNotFound
}
