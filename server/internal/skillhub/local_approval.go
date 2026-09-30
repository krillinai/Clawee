package skillhub

import (
	"context"
	"sort"
	"time"
)

type localRequest struct {
	ID, SpaceID, Digest, Status string
	UserIDs, RoleIDs            []string
	Decisions                   map[string]ApprovalDecision
	FinishedAt                  *time.Time
}

func sameApprovers(items []Approver, ids []string) bool {
	if len(items) != len(ids) {
		return false
	}
	set := map[string]bool{}
	for _, item := range items {
		set[item.UserID] = true
	}
	for _, id := range ids {
		if !set[id] {
			return false
		}
	}
	return true
}

func localApprovalConfigured(space Space) bool {
	return len(space.Approvers) != 0 || len(space.ApproverRoleIDs) != 0
}

func (s *MemoryStore) SetApprovalRoleLookup(lookup ApprovalRoleLookup) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.approvalRoleLookup = lookup
}

func (s *MemoryStore) resolveLocalApproversLocked(ctx context.Context, space Space) ([]Approver, error) {
	if space.ApprovalProvider != "local" {
		return nil, nil
	}
	resolved := append([]Approver{}, space.Approvers...)
	for _, roleID := range space.ApproverRoleIDs {
		if s.approvalRoleLookup == nil {
			return nil, ErrInvalidRequest
		}
		_, members, err := s.approvalRoleLookup(ctx, roleID)
		if err != nil {
			return nil, err
		}
		resolved = append(resolved, members...)
	}
	if localApprovalConfigured(space) && len(resolved) == 0 {
		return nil, ErrMemberNotFound
	}
	return resolved, nil
}

func localProgress(item *localRequest) *LocalApproval {
	if item == nil {
		return nil
	}
	result := &LocalApproval{Status: item.Status, Total: len(item.Decisions), Approvers: make([]ApprovalDecision, 0, len(item.Decisions))}
	for _, decision := range item.Decisions {
		result.Approvers = append(result.Approvers, decision)
		if decision.Status == "approved" {
			result.Approved++
		}
	}
	sort.Slice(result.Approvers, func(i, j int) bool { return result.Approvers[i].UserID < result.Approvers[j].UserID })
	return result
}

func (s *MemoryStore) currentLocalLocked(version Version, spaceID string) *localRequest {
	for i := len(s.localApprovals[version.VersionID]) - 1; i >= 0; i-- {
		item := &s.localApprovals[version.VersionID][i]
		if item.Status != "invalidated" && item.SpaceID == spaceID && item.Digest == version.PackageSHA256 {
			return item
		}
	}
	return nil
}

func (s *MemoryStore) invalidateLocalLocked(versionID string) {
	for i := range s.localApprovals[versionID] {
		s.localApprovals[versionID][i].Status = "invalidated"
	}
}

func (s *MemoryStore) createLocalResolvedLocked(version Version, space Space, approvers []Approver, now time.Time) {
	if space.ApprovalProvider != "local" || !localApprovalConfigured(space) {
		return
	}
	item := localRequest{ID: newID("approval"), SpaceID: space.SpaceID, Digest: version.PackageSHA256, Status: "pending", Decisions: map[string]ApprovalDecision{}}
	for _, approver := range space.Approvers {
		item.UserIDs = append(item.UserIDs, approver.UserID)
	}
	item.RoleIDs = append([]string{}, space.ApproverRoleIDs...)
	for _, approver := range approvers {
		item.Decisions[approver.UserID] = ApprovalDecision{Approver: approver, Status: "pending"}
	}
	s.localApprovals[version.VersionID] = append(s.localApprovals[version.VersionID], item)
}

func (s *MemoryStore) resetStaleLocalLocked(ctx context.Context, version *Version, space Space, now time.Time) error {
	if space.ApprovalProvider != "local" || !localApprovalConfigured(space) {
		return nil
	}
	request := s.currentLocalLocked(*version, space.SpaceID)
	if request != nil && request.Status == "approved" && sameApprovers(space.Approvers, request.UserIDs) && sameIDSet(space.ApproverRoleIDs, request.RoleIDs) {
		return nil
	}
	resolved, err := s.resolveLocalApproversLocked(ctx, space)
	if err != nil {
		return err
	}
	s.invalidateLocalLocked(version.VersionID)
	s.createLocalResolvedLocked(*version, space, resolved, now)
	version.ApprovalStatus, version.ApprovedSpaceID, version.ReviewedBy, version.ReviewedAt, version.ReviewComment = "pending", "", "", nil, ""
	return nil
}
