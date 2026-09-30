package skillhub

import (
	"context"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/textutil"
)

func (s *Service) SetSpaceApprovers(ctx context.Context, spaceID, provider, template string, userIDs []string, confirmed bool, operator string) (int64, error) {
	return s.SetSpaceApprovalSubjects(ctx, spaceID, provider, template, userIDs, nil, confirmed, operator)
}

func (s *Service) SetSpaceApprovalSubjects(ctx context.Context, spaceID, provider, template string, userIDs, roleIDs []string, confirmed bool, operator string) (int64, error) {
	store, ok := s.store.(ReviewStore)
	if !ok || strings.TrimSpace(spaceID) == "" || strings.TrimSpace(operator) == "" || (provider != "local" && provider != "dingtalk") || provider == "dingtalk" && (template == "" || len(template) > 128 || len(userIDs) != 0 || len(roleIDs) != 0) {
		return 0, ErrInvalidRequest
	}
	for _, ids := range [][]string{userIDs, roleIDs} {
		seen := map[string]bool{}
		for _, id := range ids {
			if id == "" || id != strings.TrimSpace(id) || seen[id] {
				return 0, ErrInvalidRequest
			}
			seen[id] = true
		}
	}
	if roleStore, ok := s.store.(RoleReviewStore); ok {
		return roleStore.SetSpaceApprovalSubjects(ctx, strings.TrimSpace(spaceID), provider, strings.TrimSpace(template), userIDs, roleIDs, confirmed, operator, s.clock().UTC())
	}
	if len(roleIDs) != 0 {
		return 0, ErrInvalidRequest
	}
	return store.SetSpaceApprovers(ctx, strings.TrimSpace(spaceID), provider, strings.TrimSpace(template), userIDs, confirmed, operator, s.clock().UTC())
}

// SetSpaceApprover retains the service contract used by older callers; the HTTP API writes the complete list.
func (s *Service) SetSpaceApprover(ctx context.Context, spaceID, userID, operator string) error {
	space, err := s.GetSpace(ctx, spaceID)
	if err != nil {
		return err
	}
	if space.ApprovalProvider != "local" {
		return ErrReviewForbidden
	}
	ids := []string{}
	if userID != "" {
		ids = append(ids, userID)
	}
	_, err = s.SetSpaceApprovers(ctx, spaceID, "local", "", ids, true, operator)
	return err
}

func (s *Service) ReviewVersion(ctx context.Context, skillID, versionID, reviewer string, approve bool, comment string) (Version, error) {
	store, ok := s.store.(ReviewStore)
	comment = textutil.TrimInput(comment)
	if !ok || strings.TrimSpace(skillID) == "" || strings.TrimSpace(versionID) == "" || strings.TrimSpace(reviewer) == "" || len([]rune(comment)) > 2000 {
		return Version{}, ErrInvalidRequest
	}
	return store.ReviewVersion(ctx, skillID, versionID, reviewer, approve, comment, s.clock().UTC())
}

func (s *MemoryStore) SetSpaceApprovers(ctx context.Context, spaceID, provider, template string, userIDs []string, confirmed bool, operator string, now time.Time) (int64, error) {
	return s.SetSpaceApprovalSubjects(ctx, spaceID, provider, template, userIDs, nil, confirmed, operator, now)
}

func (s *MemoryStore) SetSpaceApprovalSubjects(ctx context.Context, spaceID, provider, template string, userIDs, roleIDs []string, confirmed bool, operator string, now time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	space, ok := s.spaces[spaceID]
	if !ok {
		return 0, ErrSpaceNotFound
	}
	if provider == "dingtalk" {
		if len(roleIDs) != 0 {
			return 0, ErrInvalidRequest
		}
		userIDs = nil
	}
	if provider == "local" {
		template = ""
	}
	if space.ApprovalProvider == provider && space.ExternalApprovalTemplateID == template && sameApprovers(space.Approvers, userIDs) && sameIDSet(space.ApproverRoleIDs, roleIDs) {
		return 0, nil
	}
	configured := space
	configured.ApprovalProvider, configured.ExternalApprovalTemplateID = provider, template
	configured.Approvers = make([]Approver, 0, len(userIDs))
	for _, id := range userIDs {
		configured.Approvers = append(configured.Approvers, Approver{UserID: id, Name: id})
	}
	configured.ApproverRoleIDs = append([]string{}, roleIDs...)
	configured.ApproverRoles = []ApprovalRole{}
	for _, id := range roleIDs {
		if s.approvalRoleLookup == nil {
			return 0, ErrInvalidRequest
		}
		role, _, err := s.approvalRoleLookup(ctx, id)
		if err != nil {
			return 0, err
		}
		configured.ApproverRoles = append(configured.ApproverRoles, role)
	}
	if space.ApprovalProvider != provider || space.ExternalApprovalTemplateID != template {
		for _, skill := range s.skills {
			if skill.SpaceID == spaceID {
				for _, version := range s.versions[skill.SkillID] {
					for _, item := range s.approvals[version.VersionID] {
						if approvalActive(item.Status) {
							return 0, ErrExternalApprovalConflict
						}
					}
				}
			}
		}
	}
	var affected int64
	for _, skill := range s.skills {
		if skill.SpaceID != spaceID {
			continue
		}
		for _, version := range s.versions[skill.SkillID] {
			if skill.CurrentVersionID == nil || *skill.CurrentVersionID != version.VersionID {
				affected++
			}
		}
	}
	if affected > 0 && !confirmed {
		return affected, nil
	}
	var resolved []Approver
	if affected > 0 {
		var err error
		resolved, err = s.resolveLocalApproversLocked(ctx, configured)
		if err != nil {
			return 0, err
		}
	}
	space = configured
	space.UpdatedBy, space.UpdatedAt = operator, now
	s.spaces[spaceID] = space
	for _, skill := range s.skills {
		if skill.SpaceID == spaceID {
			for i := range s.versions[skill.SkillID] {
				v := &s.versions[skill.SkillID][i]
				s.invalidateApprovalsLocked(v.VersionID, now)
				if skill.CurrentVersionID != nil && *skill.CurrentVersionID == v.VersionID {
					continue
				}
				s.invalidateLocalLocked(v.VersionID)
				v.ApprovalStatus, v.ApprovedSpaceID, v.ReviewedBy, v.ReviewedAt, v.ReviewComment = "pending", "", "", nil, ""
				if provider == "local" {
					s.createLocalResolvedLocked(*v, space, resolved, now)
				}
			}
		}
	}
	return affected, nil
}

func (s *MemoryStore) ReviewVersion(_ context.Context, skillID, versionID, reviewer string, approve bool, comment string, now time.Time) (Version, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[skillID]
	if !ok {
		return Version{}, ErrNotFound
	}
	if s.spaces[skill.SpaceID].ApprovalProvider != "local" || reviewer == "" {
		return Version{}, ErrReviewForbidden
	}
	for i, version := range s.versions[skillID] {
		if version.VersionID != versionID {
			continue
		}
		request := s.currentLocalLocked(version, skill.SpaceID)
		if request == nil {
			return Version{}, ErrReviewForbidden
		}
		if request.Status != "pending" {
			return Version{}, ErrConflict
		}
		if _, ok := request.Decisions[reviewer]; !ok {
			return Version{}, ErrReviewForbidden
		}
		if request.Decisions[reviewer].Status != "pending" {
			return Version{}, ErrConflict
		}
		decision := request.Decisions[reviewer]
		decision.Status, decision.Comment, decision.DecidedAt = "rejected", comment, &now
		if approve {
			decision.Status = "approved"
		}
		request.Decisions[reviewer] = decision
		approved := 0
		for _, item := range request.Decisions {
			if item.Status == "approved" {
				approved++
			}
		}
		if !approve {
			request.Status = "rejected"
		} else if approved == len(request.Decisions) {
			request.Status = "approved"
		}
		version.ApprovalStatus = request.Status
		if request.Status != "pending" {
			request.FinishedAt = &now
		}
		if request.Status == "approved" {
			version.ApprovedSpaceID = skill.SpaceID
		}
		if request.Status == "pending" {
			version.ApprovedSpaceID = ""
		}
		if request.Status == "rejected" {
			version.ApprovedSpaceID = ""
		}
		if request.Status != "pending" {
			version.ReviewedBy, version.ReviewedAt, version.ReviewComment = reviewer, &now, comment
		}
		for j := range s.localApprovals[versionID] {
			if s.localApprovals[versionID][j].ID == request.ID {
				s.localApprovals[versionID][j] = *request
			}
		}
		version.LocalApproval = localProgress(request)
		s.versions[skillID][i] = version
		return version, nil
	}
	return Version{}, ErrNotFound
}
