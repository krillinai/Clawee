package skillhub

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"sort"
	"time"
)

type PersonalApprovalQuery struct {
	View, Status, BeforeKind, BeforeID string
	BeforeTime                         time.Time
	Limit                              int
}

type PersonalApproval struct {
	RequestID, SkillID, VersionID, Version, Title string
	SpaceID, ContentDigest, Status, MyStatus      string
	InitiatedBy                                   string
	CreatedAt                                     time.Time
	ActedAt                                       *time.Time
	CanProcess                                    bool
}

type PersonalApprovalStore interface {
	ListPersonalApprovals(context.Context, string, PersonalApprovalQuery) ([]PersonalApproval, error)
	GetPersonalApproval(context.Context, string, string) (PersonalApproval, AdminDetail, error)
	CheckApprovalVersionBinding(context.Context, string, string, string) error
}

func (s *Service) ListPersonalApprovals(ctx context.Context, user string, query PersonalApprovalQuery) ([]PersonalApproval, error) {
	store, ok := s.store.(PersonalApprovalStore)
	if !ok || user == "" || query.Limit < 1 || query.Limit > 51 || (query.View != "todo" && query.View != "done" && query.View != "initiated") {
		return nil, ErrInvalidRequest
	}
	return store.ListPersonalApprovals(ctx, user, query)
}

func (s *Service) GetPersonalApproval(ctx context.Context, user, id string) (PersonalApproval, AdminDetail, error) {
	store, ok := s.store.(PersonalApprovalStore)
	if !ok || user == "" || id == "" {
		return PersonalApproval{}, AdminDetail{}, ErrNotFound
	}
	item, detail, err := store.GetPersonalApproval(ctx, user, id)
	if err != nil {
		return item, detail, err
	}
	if s.spaces == nil || s.spaces.CheckSpaceAccess(ctx, user, item.SpaceID, SpaceActionRead) != nil || s.spaces.CheckSpaceAccess(ctx, user, detail.Skill.SpaceID, SpaceActionRead) != nil {
		return PersonalApproval{}, AdminDetail{}, ErrNotFound
	}
	detail.Skill.CurrentVersionID = nil
	detail.Skill.LatestVersion = nil
	version := &detail.Versions[0]
	detail.Skill.Description = version.Description
	version.ApprovalInstance = nil
	version.ApprovalStatus = item.Status
	version.ReviewedBy, version.ReviewComment, version.ReviewedAt = "", "", nil
	if item.SpaceID != detail.Skill.SpaceID || item.ContentDigest != version.PackageSHA256 {
		detail.Skill.Description = ""
		version.Description, version.Changelog, version.PackagePath, version.PackageSHA256 = "", "", "", ""
		version.Source = nil
	}
	detail.CanReview = item.CanProcess
	return item, detail, nil
}

func (s *MemoryStore) personalApprovalLocked(user string, skill Skill, version Version, request *localRequest) (PersonalApproval, bool) {
	decision, reviewer := request.Decisions[user]
	if (!reviewer && version.UploadedByUserID != user) || !s.hasAccessLocked(user, request.SpaceID, SpaceActionRead) || !s.hasAccessLocked(user, skill.SpaceID, SpaceActionRead) {
		return PersonalApproval{}, false
	}
	current := s.currentLocalLocked(version, skill.SpaceID)
	space := s.spaces[skill.SpaceID]
	canProcess := reviewer && decision.Status == "pending" && request.Status == "pending" && current != nil && current.ID == request.ID && space.ApprovalProvider == "local" && localApprovalConfigured(space)
	return PersonalApproval{RequestID: request.ID, SkillID: skill.SkillID, VersionID: version.VersionID, Version: version.Version, Title: skill.Name, SpaceID: request.SpaceID, ContentDigest: request.Digest, Status: request.Status, MyStatus: decision.Status, InitiatedBy: version.UploadedByUserID, CreatedAt: request.CreatedAt, ActedAt: decision.DecidedAt, CanProcess: canProcess}, true
}

func (s *MemoryStore) ListPersonalApprovals(_ context.Context, user string, query PersonalApprovalQuery) ([]PersonalApproval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []PersonalApproval{}
	for skillID, versions := range s.versions {
		for _, version := range versions {
			for index := range s.localApprovals[version.VersionID] {
				item, visible := s.personalApprovalLocked(user, s.skills[skillID], version, &s.localApprovals[version.VersionID][index])
				if !visible || (query.Status != "all" && query.Status != "" && item.Status != query.Status) || (query.View == "todo" && !item.CanProcess) || (query.View == "done" && item.MyStatus != "approved" && item.MyStatus != "rejected") || (query.View == "initiated" && item.InitiatedBy != user) {
					continue
				}
				if !query.BeforeTime.IsZero() && (item.CreatedAt.After(query.BeforeTime) || (item.CreatedAt.Equal(query.BeforeTime) && ("skill" > query.BeforeKind || ("skill" == query.BeforeKind && item.RequestID >= query.BeforeID)))) {
					continue
				}
				items = append(items, item)
			}
		}
	}
	sort.Slice(items, func(left, right int) bool {
		if items[left].CreatedAt.Equal(items[right].CreatedAt) {
			return items[left].RequestID > items[right].RequestID
		}
		return items[left].CreatedAt.After(items[right].CreatedAt)
	})
	if len(items) > query.Limit {
		items = items[:query.Limit]
	}
	return items, nil
}

func (s *MemoryStore) GetPersonalApproval(_ context.Context, user, id string) (PersonalApproval, AdminDetail, error) {
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
				item, visible := s.personalApprovalLocked(user, skill, version, request)
				if !visible {
					return PersonalApproval{}, AdminDetail{}, ErrNotFound
				}
				version.LocalApproval = localProgress(request)
				skill.SpaceName = s.spaces[skill.SpaceID].Name
				return item, AdminDetail{Skill: skill, Versions: []Version{version}}, nil
			}
		}
	}
	return PersonalApproval{}, AdminDetail{}, ErrNotFound
}

func (s *MemoryStore) CheckApprovalVersionBinding(_ context.Context, user, skillID, versionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, exists := s.skills[skillID]
	if !exists || !s.hasAccessLocked(user, skill.SpaceID, SpaceActionRead) {
		return ErrNotFound
	}
	for _, version := range s.versions[skillID] {
		if version.VersionID != versionID {
			continue
		}
		request := s.currentLocalLocked(version, skill.SpaceID)
		external := s.latestApprovalLocked(versionID)
		validLocal := request != nil && s.hasAccessLocked(user, request.SpaceID, SpaceActionRead)
		validExternal := external != nil && external.Status != "invalidated" && external.SpaceID == skill.SpaceID && external.PackageSHA256 == version.PackageSHA256
		if (len(s.localApprovals[versionID]) != 0 || external != nil) && !validLocal && !validExternal {
			return ErrConflict
		}
		return nil
	}
	return ErrNotFound
}

func (s *Service) approvalRequestVersion(ctx context.Context, user, id string) (Skill, Version, error) {
	item, detail, err := s.GetPersonalApproval(ctx, user, id)
	if err != nil {
		return Skill{}, Version{}, err
	}
	version := detail.Versions[0]
	if item.Status == "invalidated" || item.SpaceID != detail.Skill.SpaceID || item.ContentDigest != version.PackageSHA256 {
		return Skill{}, Version{}, ErrConflict
	}
	if err := s.verifyApprovalVersionDigest(version); err != nil {
		return Skill{}, Version{}, err
	}
	return detail.Skill, version, nil
}

func (s *Service) verifyApprovalVersionDigest(version Version) error {
	file, _, err := s.openVersionFile(version)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err = io.Copy(digest, file); err != nil {
		return err
	}
	if fmt.Sprintf("%x", digest.Sum(nil)) != version.PackageSHA256 {
		return ErrConflict
	}
	return nil
}

func (s *Service) ListApprovalRequestFiles(ctx context.Context, user, id string) ([]PackageFile, error) {
	_, version, err := s.approvalRequestVersion(ctx, user, id)
	if err != nil {
		return nil, err
	}
	return s.listVersionFiles(version)
}

func (s *Service) ReadApprovalRequestFile(ctx context.Context, user, id, requestedPath string) (PackageFileContent, error) {
	if cleaned, err := validateEntryName(requestedPath); err != nil || cleaned != requestedPath {
		return PackageFileContent{}, ErrInvalidRequest
	}
	_, version, err := s.approvalRequestVersion(ctx, user, id)
	if err != nil {
		return PackageFileContent{}, err
	}
	return s.readVersionFile(version, requestedPath)
}

func (s *Service) OpenApprovalRequestPackage(ctx context.Context, user, id string) (PackageDownload, error) {
	skill, version, err := s.approvalRequestVersion(ctx, user, id)
	if err != nil {
		return PackageDownload{}, err
	}
	file, info, err := s.openVersionFile(version)
	if err != nil {
		return PackageDownload{}, err
	}
	return PackageDownload{Filename: skill.Name + "-" + version.Version + ".zip", Size: info.Size(), Reader: file, Detail: PublishedDetail{PublishedItem: PublishedItem{SkillID: skill.SkillID, Name: skill.Name, VersionID: version.VersionID, Version: version.Version, PackageSHA256: version.PackageSHA256}}}, nil
}
