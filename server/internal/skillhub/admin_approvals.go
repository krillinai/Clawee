package skillhub

import (
	"context"

	"github.com/krillinai/Clawee/server/internal/approvals"
)

type AdminApprovalStore interface {
	ListAdminApprovals(context.Context, string, approvals.Filter, int, bool) ([]approvals.Record, error)
	AdminApprovalSummary(context.Context, string, approvals.Filter) (approvals.Summary, error)
	GetAdminApproval(context.Context, string, string, string) (approvals.Record, AdminDetail, error)
}

func (s *Service) ListAdminApprovals(ctx context.Context, user string, filter approvals.Filter, limit int, administrator bool) ([]approvals.Record, error) {
	store, ok := s.store.(AdminApprovalStore)
	if !ok || user == "" || limit < 1 || limit > 51 {
		return nil, ErrInvalidRequest
	}
	return store.ListAdminApprovals(ctx, user, filter, limit, administrator)
}

func (s *Service) AdminApprovalSummary(ctx context.Context, user string, filter approvals.Filter) (approvals.Summary, error) {
	store, ok := s.store.(AdminApprovalStore)
	if !ok || user == "" {
		return approvals.Summary{}, ErrInvalidRequest
	}
	return store.AdminApprovalSummary(ctx, user, filter)
}

func (s *Service) GetAdminApproval(ctx context.Context, user, kind, id string) (approvals.Record, AdminDetail, error) {
	store, ok := s.store.(AdminApprovalStore)
	if !ok || user == "" || id == "" || kind != "skill" && kind != "skill_external" {
		return approvals.Record{}, AdminDetail{}, ErrNotFound
	}
	item, detail, err := store.GetAdminApproval(ctx, user, kind, id)
	if err != nil {
		return item, detail, err
	}
	if s.CheckSpaceRead(ctx, user, item.SpaceID) != nil || s.CheckSpaceRead(ctx, user, detail.Skill.SpaceID) != nil {
		return approvals.Record{}, AdminDetail{}, ErrNotFound
	}
	detail.Skill.CurrentVersionID, detail.Skill.LatestVersion = nil, nil
	detail.CanReview = item.CanProcess
	version := &detail.Versions[0]
	if progress := version.LocalApproval; progress != nil {
		item.WorkflowStage = progress.WorkflowStage
		item.CanSubmitReview = item.CanProcess
	}
	detail.Skill.Description = version.Description
	if !item.MaterialsAvailable {
		detail.Skill.Description = ""
		version.Description, version.Changelog, version.PackagePath, version.PackageSHA256 = "", "", "", ""
		version.Source = nil
	}
	s.attachAIReviewAgentPresence(&detail)
	return item, detail, nil
}

func (s *Service) adminApprovalVersion(ctx context.Context, user, kind, id string) (Skill, Version, error) {
	item, detail, err := s.GetAdminApproval(ctx, user, kind, id)
	if err != nil {
		return Skill{}, Version{}, err
	}
	if !item.MaterialsAvailable {
		return Skill{}, Version{}, ErrConflict
	}
	version := detail.Versions[0]
	if err = s.verifyApprovalVersionDigest(version); err != nil {
		return Skill{}, Version{}, err
	}
	return detail.Skill, version, nil
}

func (s *Service) ListAdminApprovalFiles(ctx context.Context, user, kind, id string) ([]PackageFile, error) {
	_, version, err := s.adminApprovalVersion(ctx, user, kind, id)
	if err != nil {
		return nil, err
	}
	return s.listVersionFiles(version)
}

func (s *Service) ReadAdminApprovalFile(ctx context.Context, user, kind, id, requestedPath string) (PackageFileContent, error) {
	if cleaned, err := validateEntryName(requestedPath); err != nil || cleaned != requestedPath {
		return PackageFileContent{}, ErrInvalidRequest
	}
	_, version, err := s.adminApprovalVersion(ctx, user, kind, id)
	if err != nil {
		return PackageFileContent{}, err
	}
	return s.readVersionFile(version, requestedPath)
}

func (s *Service) OpenAdminApprovalPackage(ctx context.Context, user, kind, id string) (PackageDownload, error) {
	skill, version, err := s.adminApprovalVersion(ctx, user, kind, id)
	if err != nil {
		return PackageDownload{}, err
	}
	file, info, err := s.openVersionFile(version)
	if err != nil {
		return PackageDownload{}, err
	}
	return PackageDownload{Filename: skill.Name + "-" + version.Version + ".zip", Size: info.Size(), Reader: file, Detail: PublishedDetail{PublishedItem: PublishedItem{SkillID: skill.SkillID, Name: skill.Name, VersionID: version.VersionID, Version: version.Version, PackageSHA256: version.PackageSHA256}}}, nil
}

func (s *MemoryStore) adminApprovalRecordsLocked(user string, administrator bool) []approvals.Record {
	items := []approvals.Record{}
	for skillID, versions := range s.versions {
		skill := s.skills[skillID]
		if !s.hasAccessLocked(user, skill.SpaceID, SpaceActionRead) {
			continue
		}
		for _, version := range versions {
			base := approvals.Record{Type: "skill", Title: skill.Name, SkillID: skillID, VersionID: version.VersionID, Version: version.Version, CurrentApprovers: []string{}, CurrentApproverNames: []string{}}
			for _, request := range s.localApprovals[version.VersionID] {
				if !s.hasAccessLocked(user, request.SpaceID, SpaceActionRead) {
					continue
				}
				item := base
				item.Kind, item.ID, item.Channel = "skill", request.ID, "local"
				item.SpaceID, item.SpaceName = request.SpaceID, s.spaces[request.SpaceID].Name
				item.Status, item.BusinessStatus, item.CreatedAt = request.Status, request.Status, request.CreatedAt
				item.InitiatedBy, item.ContentDigest = version.UploadedByUserID, request.Digest
				item.MaterialsAvailable = request.Status != "invalidated" && request.SpaceID == skill.SpaceID && request.Digest == version.PackageSHA256
				progress := localProgress(&request)
				item.WorkflowStage = progress.WorkflowStage
				item.ProgressTotal = progress.Total
				for _, decision := range progress.Approvers {
					if decision.Status != "pending" {
						item.ProgressCompleted++
					} else if request.Status == "pending" {
						item.CurrentApprovers = append(item.CurrentApprovers, decision.UserID)
						item.CurrentApproverNames = append(item.CurrentApproverNames, decision.Name)
					}
				}
				personal, _ := s.personalApprovalLocked(user, skill, version, &request)
				item.CanProcess = personal.CanProcess
				item.CanSubmitReview = personal.CanProcess
				item.CanRetryAI = personal.CanRetryAI
				if administrator {
					current := s.currentLocalLocked(version, skill.SpaceID)
					item.CanRetryAI = current != nil && current.ID == request.ID && request.Status == "pending" && version.ApprovalStatus == "pending" && canRetryAI(progress.AIReview)
				}
				items = append(items, item)
			}
			for _, external := range s.approvals[version.VersionID] {
				if !s.hasAccessLocked(user, external.SpaceID, SpaceActionRead) {
					continue
				}
				item := base
				item.Kind, item.ID, item.Channel = "skill_external", external.ID, "dingtalk"
				item.SpaceID, item.SpaceName = external.SpaceID, s.spaces[external.SpaceID].Name
				item.BusinessStatus, item.CreatedAt, item.InitiatedBy = external.Status, external.CreatedAt, external.InitiatorUserID
				item.ContentDigest = external.PackageSHA256
				item.MaterialsAvailable = external.Status != "invalidated" && external.SpaceID == skill.SpaceID && external.PackageSHA256 == version.PackageSHA256
				switch external.Status {
				case "failed", "uncertain":
					item.Status = "error"
				case "submitting", "running":
					item.Status = "running"
				case "finished":
					item.Status = external.Decision
				default:
					item.Status = external.Status
				}
				items = append(items, item)
			}
		}
	}
	return items
}

func (s *MemoryStore) ListAdminApprovals(_ context.Context, user string, filter approvals.Filter, limit int, administrator bool) ([]approvals.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []approvals.Record{}
	for _, item := range s.adminApprovalRecordsLocked(user, administrator) {
		if filter.Matches(item) && filter.Before(item) {
			items = append(items, item)
		}
	}
	approvals.Sort(items)
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) AdminApprovalSummary(_ context.Context, user string, filter approvals.Filter) (approvals.Summary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var summary approvals.Summary
	for _, item := range s.adminApprovalRecordsLocked(user, false) {
		if filter.Matches(item) {
			summary.Count(item)
		}
	}
	return summary, nil
}

func (s *MemoryStore) GetAdminApproval(_ context.Context, user, kind, id string) (approvals.Record, AdminDetail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.adminApprovalRecordsLocked(user, false) {
		if item.Kind != kind || item.ID != id {
			continue
		}
		for _, version := range s.versions[item.SkillID] {
			if version.VersionID != item.VersionID {
				continue
			}
			version.LocalApproval, version.ApprovalInstance = nil, nil
			for _, request := range s.localApprovals[version.VersionID] {
				if kind == "skill" && request.ID == id {
					version.LocalApproval = localProgress(&request)
				}
			}
			for _, external := range s.approvals[version.VersionID] {
				if kind == "skill_external" && external.ID == id {
					copied := external
					version.ApprovalInstance = &copied
				}
			}
			skill := s.skills[item.SkillID]
			skill.SpaceName = s.spaces[skill.SpaceID].Name
			return item, AdminDetail{Skill: skill, Versions: []Version{version}}, nil
		}
	}
	return approvals.Record{}, AdminDetail{}, ErrNotFound
}
