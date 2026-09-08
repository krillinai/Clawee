package skillhub

import (
	"context"
	"sync"
	"time"
)

type Store interface {
	CreateVersion(context.Context, Skill, Version, CreateVersionOptions) (Skill, Version, error)
	ListAdmin(context.Context) ([]Skill, error)
	GetAdmin(context.Context, string) (AdminDetail, error)
	ListPublished(context.Context) ([]PublishedItem, error)
	ListPublishedForUser(context.Context, string) ([]PublishedItem, error)
	GetPublished(context.Context, string) (PublishedDetail, error)
	MoveSkillsToSpace(context.Context, []string, string, time.Time) (SkillSpaceMoveResult, error)
	SetCurrentVersion(context.Context, string, string, time.Time) (Skill, Version, error)
	ClearCurrentVersion(context.Context, string, time.Time) (*Version, error)
}

type SpaceStore interface {
	CreateSpace(context.Context, Space) (SpaceSummary, error)
	UpdateSpace(context.Context, Space) (SpaceSummary, error)
	ListSpaces(context.Context) ([]SpaceSummary, error)
	GetSpace(context.Context, string) (SpaceSummary, error)
	ListAuthorizedSpaces(context.Context, string) ([]Space, error)
	CheckSpaceAccess(context.Context, string, string, string) error
	CheckSkillAccess(context.Context, string, string, string) error
	ListSpaceMembers(context.Context, string) ([]SpaceMemberGrant, error)
	SetSpaceMember(context.Context, string, string, []string, string, bool, time.Time) (SpaceMemberGrant, error)
	RemoveSpaceMember(context.Context, string, string) error
}

type CreateVersionOptions struct {
	Publish       bool
	Resolution    string
	TargetSkillID string
}

type MemoryStore struct {
	mu       sync.Mutex
	skills   map[string]Skill
	byName   map[string]string
	versions map[string][]Version
	spaces   map[string]Space
	grants   map[string]map[string]map[string]bool
}

func NewMemoryStore() *MemoryStore {
	now := time.Now().UTC()
	return &MemoryStore{
		skills: map[string]Skill{}, byName: map[string]string{}, versions: map[string][]Version{},
		spaces: map[string]Space{DefaultSpaceID: {SpaceID: DefaultSpaceID, Name: "默认技能空间", CreatedBy: "system", UpdatedBy: "system", CreatedAt: now, UpdatedAt: now}},
		grants: map[string]map[string]map[string]bool{},
	}
}

func (s *MemoryStore) CreateVersion(_ context.Context, proposed Skill, version Version, options CreateVersionOptions) (Skill, Version, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if proposed.SpaceID == "" {
		proposed.SpaceID = DefaultSpaceID
	}
	if _, exists := s.spaces[proposed.SpaceID]; !exists {
		return Skill{}, Version{}, ErrSpaceNotFound
	}
	var skill Skill
	newSkill := false
	switch options.Resolution {
	case VersionResolutionByName:
		skill = s.skills[s.byName[proposed.Name]]
		if skill.SkillID == "" {
			skill = proposed
			newSkill = true
		} else if skill.SpaceID != proposed.SpaceID {
			return Skill{}, Version{}, ErrConflict
		}
	case VersionResolutionCreateOnly:
		if _, exists := s.byName[proposed.Name]; exists {
			return Skill{}, Version{}, ErrConflict
		}
		skill = proposed
		newSkill = true
	case VersionResolutionTarget:
		var exists bool
		skill, exists = s.skills[options.TargetSkillID]
		if !exists {
			return Skill{}, Version{}, ErrNotFound
		}
		if skill.Name != proposed.Name {
			return Skill{}, Version{}, ErrConflict
		}
	default:
		return Skill{}, Version{}, ErrInvalidRequest
	}

	for _, item := range s.versions[skill.SkillID] {
		if item.Version == version.Version {
			return Skill{}, Version{}, ErrConflict
		}
	}
	if version.Source != nil {
		for _, versions := range s.versions {
			for _, item := range versions {
				if item.Source != nil && item.Source.SourceID == version.Source.SourceID && item.Source.Path == version.Source.Path && item.Source.CommitSHA == version.Source.CommitSHA {
					return Skill{}, Version{}, ErrConflict
				}
			}
		}
	}
	if newSkill {
		s.skills[skill.SkillID] = skill
		s.byName[skill.Name] = skill.SkillID
	}
	version.SkillID = skill.SkillID
	s.versions[skill.SkillID] = append([]Version{version}, s.versions[skill.SkillID]...)
	if options.Publish {
		currentVersionID := version.VersionID
		skill.CurrentVersionID = &currentVersionID
		skill.UpdatedAt = version.CreatedAt
	}
	s.skills[skill.SkillID] = skill
	return s.adminSkill(skill), version, nil
}

func (s *MemoryStore) ListAdmin(_ context.Context) ([]Skill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]Skill, 0, len(s.skills))
	for _, skill := range s.skills {
		items = append(items, s.adminSkill(skill))
	}
	sortSkills(items)
	return items, nil
}

func (s *MemoryStore) GetAdmin(_ context.Context, id string) (AdminDetail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[id]
	if !ok {
		return AdminDetail{}, ErrNotFound
	}
	versions := append([]Version(nil), s.versions[id]...)
	return AdminDetail{Skill: s.adminSkill(skill), Versions: versions}, nil
}

func (s *MemoryStore) ListPublished(_ context.Context) ([]PublishedItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]PublishedItem, 0, len(s.skills))
	for _, skill := range s.skills {
		if detail, ok := s.published(skill); ok {
			items = append(items, detail.PublishedItem)
		}
	}
	sortPublished(items)
	return items, nil
}

func (s *MemoryStore) ListPublishedForUser(_ context.Context, userID string) ([]PublishedItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []PublishedItem{}
	for _, skill := range s.skills {
		if !s.hasAccessLocked(userID, skill.SpaceID, SpaceActionRead) {
			continue
		}
		if detail, ok := s.published(skill); ok {
			items = append(items, detail.PublishedItem)
		}
	}
	sortPublished(items)
	return items, nil
}

func (s *MemoryStore) GetPublished(_ context.Context, id string) (PublishedDetail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[id]
	if !ok {
		return PublishedDetail{}, ErrNotFound
	}
	detail, ok := s.published(skill)
	if !ok {
		return PublishedDetail{}, ErrNotFound
	}
	return detail, nil
}

func (s *MemoryStore) SetCurrentVersion(_ context.Context, skillID, versionID string, now time.Time) (Skill, Version, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[skillID]
	if !ok {
		return Skill{}, Version{}, ErrNotFound
	}
	var target Version
	targetSkillID := ""
	for ownerID, versions := range s.versions {
		for _, version := range versions {
			if version.VersionID == versionID {
				target = version
				targetSkillID = ownerID
				break
			}
		}
	}
	if targetSkillID == "" {
		return Skill{}, Version{}, ErrNotFound
	}
	if targetSkillID != skillID {
		return Skill{}, Version{}, ErrConflict
	}
	if skill.CurrentVersionID == nil || *skill.CurrentVersionID != versionID {
		value := versionID
		skill.CurrentVersionID = &value
		skill.UpdatedAt = now
		s.skills[skillID] = skill
	}
	return s.adminSkill(skill), target, nil
}

func (s *MemoryStore) MoveSkillsToSpace(_ context.Context, skillIDs []string, targetSpaceID string, now time.Time) (SkillSpaceMoveResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := SkillSpaceMoveResult{TargetSpaceID: targetSpaceID}
	if _, exists := s.spaces[targetSpaceID]; !exists {
		return SkillSpaceMoveResult{}, ErrSpaceNotFound
	}
	for _, skillID := range skillIDs {
		if _, exists := s.skills[skillID]; !exists {
			return SkillSpaceMoveResult{}, ErrNotFound
		}
	}
	for _, skillID := range skillIDs {
		skill := s.skills[skillID]
		if skill.SpaceID == targetSpaceID {
			result.UnchangedCount++
			continue
		}
		skill.SpaceID = targetSpaceID
		skill.UpdatedAt = now
		s.skills[skillID] = skill
		result.MovedCount++
	}
	return result, nil
}

func (s *MemoryStore) ClearCurrentVersion(_ context.Context, skillID string, now time.Time) (*Version, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	skill, ok := s.skills[skillID]
	if !ok {
		return nil, ErrNotFound
	}
	var cleared *Version
	if skill.CurrentVersionID != nil {
		for _, version := range s.versions[skillID] {
			if version.VersionID == *skill.CurrentVersionID {
				copy := version
				cleared = &copy
				break
			}
		}
		skill.CurrentVersionID = nil
		skill.UpdatedAt = now
		s.skills[skillID] = skill
	}
	return cleared, nil
}

func (s *MemoryStore) adminSkill(skill Skill) Skill {
	skill.SpaceName = s.spaces[skill.SpaceID].Name
	versions := s.versions[skill.SkillID]
	if skill.CurrentVersionID != nil {
		for _, version := range versions {
			if version.VersionID == *skill.CurrentVersionID {
				skill.Description = version.Description
				return skill
			}
		}
	}
	if len(versions) > 0 {
		skill.Description = versions[0].Description
	}
	return skill
}

func (s *MemoryStore) published(skill Skill) (PublishedDetail, bool) {
	if skill.CurrentVersionID == nil {
		return PublishedDetail{}, false
	}
	for _, version := range s.versions[skill.SkillID] {
		if version.VersionID == *skill.CurrentVersionID {
			spaceName := s.spaces[skill.SpaceID].Name
			return PublishedDetail{PublishedItem: PublishedItem{
				SkillID: skill.SkillID, SpaceID: skill.SpaceID, SpaceName: spaceName, Name: skill.Name, Description: version.Description,
				VersionID: version.VersionID, Version: version.Version, PackageSHA256: version.PackageSHA256,
				UpdatedAt: skill.UpdatedAt,
			}, Changelog: version.Changelog, PackagePath: version.PackagePath}, true
		}
	}
	return PublishedDetail{}, false
}

func sortSkills(items []Skill) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j].UpdatedAt.After(items[j-1].UpdatedAt); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

func sortPublished(items []PublishedItem) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j].UpdatedAt.After(items[j-1].UpdatedAt); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}
