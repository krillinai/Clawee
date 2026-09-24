package skillhub

import (
	"sort"
	"time"
)

type localRequest struct {
	ID, SpaceID, Digest, Status string
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

func sameLocalRequestApprovers(item *localRequest, approvers []Approver) bool {
	if item == nil || len(item.Decisions) != len(approvers) {
		return false
	}
	for _, approver := range approvers {
		if _, ok := item.Decisions[approver.UserID]; !ok {
			return false
		}
	}
	return true
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

func (s *MemoryStore) createLocalLocked(version Version, space Space, now time.Time) {
	if space.ApprovalProvider != "local" || len(space.Approvers) == 0 {
		return
	}
	item := localRequest{ID: newID("approval"), SpaceID: space.SpaceID, Digest: version.PackageSHA256, Status: "pending", Decisions: map[string]ApprovalDecision{}}
	for _, approver := range space.Approvers {
		item.Decisions[approver.UserID] = ApprovalDecision{Approver: approver, Status: "pending"}
	}
	s.localApprovals[version.VersionID] = append(s.localApprovals[version.VersionID], item)
}

func (s *MemoryStore) resetStaleLocalLocked(version *Version, space Space, now time.Time) {
	if space.ApprovalProvider != "local" || len(space.Approvers) == 0 {
		return
	}
	request := s.currentLocalLocked(*version, space.SpaceID)
	if request != nil && request.Status == "approved" && sameLocalRequestApprovers(request, space.Approvers) {
		return
	}
	s.invalidateLocalLocked(version.VersionID)
	s.createLocalLocked(*version, space, now)
	version.ApprovalStatus, version.ApprovedSpaceID, version.ReviewedBy, version.ReviewedAt, version.ReviewComment = "pending", "", "", nil, ""
}
