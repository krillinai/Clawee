package skillhub

import (
	"context"
	"strings"
	"time"
)

func (s *Service) SetSpaceApproval(ctx context.Context, spaceID, provider, template, operator string) error {
	store, ok := s.store.(ExternalApprovalStore)
	spaceID, provider, template, operator = strings.TrimSpace(spaceID), strings.TrimSpace(provider), strings.TrimSpace(template), strings.TrimSpace(operator)
	if !ok || spaceID == "" || operator == "" || (provider != "local" && provider != "dingtalk") || provider == "dingtalk" && (template == "" || len(template) > 128) {
		return ErrInvalidRequest
	}
	if provider == "local" {
		template = ""
	}
	return store.SetSpaceApproval(ctx, spaceID, provider, template, operator, s.clock().UTC())
}

func (s *Service) BeginApproval(ctx context.Context, skillID, versionID, userID, externalUserID string, requireWrite bool) (ApprovalInstance, Version, Skill, error) {
	store, ok := s.store.(ExternalApprovalStore)
	if !ok || skillID == "" || versionID == "" || userID == "" || externalUserID == "" {
		return ApprovalInstance{}, Version{}, Skill{}, ErrInvalidRequest
	}
	if requireWrite {
		if err := s.spaces.CheckSkillAccess(ctx, userID, skillID, SpaceActionWrite); err != nil {
			return ApprovalInstance{}, Version{}, Skill{}, err
		}
	}
	return store.BeginApproval(ctx, skillID, versionID, userID, externalUserID, s.clock().UTC())
}

func (s *Service) FinishSubmission(ctx context.Context, id, instanceID, status string) (ApprovalInstance, error) {
	store, ok := s.store.(ExternalApprovalStore)
	if !ok || (status != "running" && status != "failed" && status != "uncertain") {
		return ApprovalInstance{}, ErrInvalidRequest
	}
	return store.FinishSubmission(ctx, id, instanceID, status, s.clock().UTC())
}

func (s *Service) GetApproval(ctx context.Context, skillID, versionID string) (ApprovalInstance, error) {
	store, ok := s.store.(ExternalApprovalStore)
	if !ok {
		return ApprovalInstance{}, ErrInvalidRequest
	}
	return store.GetApproval(ctx, skillID, versionID)
}

func (s *Service) GetApprovalByID(ctx context.Context, id string) (ApprovalInstance, error) {
	store, ok := s.store.(ExternalApprovalStore)
	if !ok || strings.TrimSpace(id) == "" {
		return ApprovalInstance{}, ErrInvalidRequest
	}
	return store.GetApprovalByID(ctx, strings.TrimSpace(id))
}

func (s *Service) ResolveApproval(ctx context.Context, id, resolution, providerID string) (ApprovalInstance, error) {
	store, ok := s.store.(ExternalApprovalStore)
	if !ok || id == "" || (resolution != "not_created" && resolution != "bind_instance") || resolution == "bind_instance" && providerID == "" {
		return ApprovalInstance{}, ErrInvalidRequest
	}
	return store.ResolveApproval(ctx, id, resolution, providerID, s.clock().UTC())
}

func (s *Service) ApplyApprovalResult(ctx context.Context, providerID, template, eventType, result string) error {
	store, ok := s.store.(ExternalApprovalStore)
	if !ok || providerID == "" || template == "" {
		return ErrInvalidRequest
	}
	if eventType != "finish" && eventType != "terminate" {
		return nil
	}
	if eventType == "finish" && result != "agree" && result != "refuse" {
		return nil
	}
	return store.ApplyApprovalResult(ctx, providerID, template, eventType, result, s.clock().UTC())
}

func approvalActive(status string) bool {
	return status == "submitting" || status == "running" || status == "uncertain"
}

func (s *MemoryStore) latestApprovalLocked(versionID string) *ApprovalInstance {
	for i := len(s.approvals[versionID]) - 1; i >= 0; i-- {
		item := s.approvals[versionID][i]
		if item.Status != "invalidated" {
			return &item
		}
	}
	return nil
}

func (s *MemoryStore) invalidateApprovalsLocked(versionID string, now time.Time) {
	for i := range s.approvals[versionID] {
		s.approvals[versionID][i].Status, s.approvals[versionID][i].UpdatedAt = "invalidated", now
	}
}

func (s *MemoryStore) hasValidApprovalLocked(version Version, space Space) bool {
	for _, item := range s.approvals[version.VersionID] {
		if item.Status == "finished" && item.Decision == "approved" && item.SpaceID == space.SpaceID && item.TemplateID == space.ExternalApprovalTemplateID && item.PackageSHA256 == version.PackageSHA256 {
			return true
		}
	}
	return false
}

func (s *MemoryStore) SetSpaceApproval(_ context.Context, spaceID, provider, template, operator string, now time.Time) error {
	_, err := s.SetSpaceApprovers(context.Background(), spaceID, provider, template, nil, true, operator, now)
	return err
}

func (s *MemoryStore) BeginApproval(_ context.Context, skillID, versionID, userID, externalUserID string, now time.Time) (ApprovalInstance, Version, Skill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[skillID]
	if !ok {
		return ApprovalInstance{}, Version{}, Skill{}, ErrNotFound
	}
	space := s.spaces[skill.SpaceID]
	if space.ApprovalProvider != "dingtalk" {
		return ApprovalInstance{}, Version{}, Skill{}, ErrInvalidRequest
	}
	for _, version := range s.versions[skillID] {
		if version.VersionID != versionID {
			continue
		}
		if version.Source != nil || version.UploadedByUserID != userID || skill.CurrentVersionID != nil && *skill.CurrentVersionID == versionID {
			return ApprovalInstance{}, Version{}, Skill{}, ErrApprovalRequired
		}
		for _, item := range s.approvals[versionID] {
			if approvalActive(item.Status) || item.Status == "finished" && item.Decision == "approved" {
				return ApprovalInstance{}, Version{}, Skill{}, ErrExternalApprovalConflict
			}
		}
		item := ApprovalInstance{ID: newID("skillapproval"), VersionID: versionID, SpaceID: skill.SpaceID, PackageSHA256: version.PackageSHA256, TemplateID: space.ExternalApprovalTemplateID, InitiatorUserID: userID, InitiatorExternalUserID: externalUserID, Status: "submitting", CreatedAt: now, UpdatedAt: now}
		for i := range s.versions[skillID] {
			if s.versions[skillID][i].VersionID == versionID {
				s.versions[skillID][i].ApprovalStatus, s.versions[skillID][i].ApprovedSpaceID = "pending", ""
			}
		}
		s.approvals[versionID] = append(s.approvals[versionID], item)
		return item, version, skill, nil
	}
	return ApprovalInstance{}, Version{}, Skill{}, ErrNotFound
}

func (s *MemoryStore) updateApprovalLocked(id string, update func(*ApprovalInstance) error) (ApprovalInstance, error) {
	for versionID := range s.approvals {
		for i := range s.approvals[versionID] {
			item := &s.approvals[versionID][i]
			if item.ID == id {
				if err := update(item); err != nil {
					return ApprovalInstance{}, err
				}
				return *item, nil
			}
		}
	}
	return ApprovalInstance{}, ErrNotFound
}

func (s *MemoryStore) FinishSubmission(_ context.Context, id, providerID, status string, now time.Time) (ApprovalInstance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.updateApprovalLocked(id, func(item *ApprovalInstance) error {
		if item.Status != "submitting" {
			return ErrExternalApprovalConflict
		}
		if status == "running" && providerID == "" {
			return ErrInvalidRequest
		}
		for _, versions := range s.approvals {
			for _, other := range versions {
				if providerID != "" && other.ProviderInstanceID == providerID {
					return ErrExternalApprovalConflict
				}
			}
		}
		item.ProviderInstanceID, item.Status, item.UpdatedAt = providerID, status, now
		return nil
	})
}

func (s *MemoryStore) GetApproval(_ context.Context, skillID, versionID string) (ApprovalInstance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, version := range s.versions[skillID] {
		if version.VersionID == versionID {
			if item := s.latestApprovalLocked(versionID); item != nil {
				return *item, nil
			}
			return ApprovalInstance{}, ErrNotFound
		}
	}
	return ApprovalInstance{}, ErrNotFound
}

func (s *MemoryStore) GetApprovalByID(_ context.Context, id string) (ApprovalInstance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, versions := range s.approvals {
		for _, item := range versions {
			if item.ID == id {
				return item, nil
			}
		}
	}
	return ApprovalInstance{}, ErrNotFound
}

func (s *MemoryStore) ResolveApproval(_ context.Context, id, resolution, providerID string, now time.Time) (ApprovalInstance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.updateApprovalLocked(id, func(item *ApprovalInstance) error {
		if item.Status != "submitting" && item.Status != "uncertain" {
			return ErrExternalApprovalConflict
		}
		if resolution == "not_created" {
			item.Status = "failed"
		} else {
			for _, versions := range s.approvals {
				for _, other := range versions {
					if other.ID != id && other.ProviderInstanceID == providerID {
						return ErrExternalApprovalConflict
					}
				}
			}
			item.ProviderInstanceID, item.Status = providerID, "running"
		}
		item.UpdatedAt = now
		return nil
	})
}

func (s *MemoryStore) ApplyApprovalResult(_ context.Context, providerID, template, eventType, result string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for versionID, versions := range s.approvals {
		for i := range versions {
			item := &s.approvals[versionID][i]
			if item.ProviderInstanceID != providerID {
				continue
			}
			if item.TemplateID != template || item.Status != "running" {
				return nil
			}
			for skillID, skillVersions := range s.versions {
				for j, version := range skillVersions {
					if version.VersionID != versionID {
						continue
					}
					skill := s.skills[skillID]
					space := s.spaces[skill.SpaceID]
					if skill.SpaceID != item.SpaceID || space.ApprovalProvider != "dingtalk" || space.ExternalApprovalTemplateID != template || version.PackageSHA256 != item.PackageSHA256 {
						return nil
					}
					if eventType == "terminate" {
						item.Status = "terminated"
					} else {
						item.Status = "finished"
						item.Decision = "rejected"
						if result == "agree" {
							item.Decision = "approved"
						}
						version.ApprovalStatus, version.ApprovedSpaceID, version.ReviewedAt = item.Decision, skill.SpaceID, &now
						s.versions[skillID][j] = version
					}
					item.UpdatedAt = now
					return nil
				}
			}
			return nil
		}
	}
	return nil
}
