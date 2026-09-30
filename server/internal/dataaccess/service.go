package dataaccess

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strings"
	"time"
)

type Service struct {
	store Store
	clock func() time.Time
}

func NewService(store Store) *Service {
	return &Service{store: store, clock: func() time.Time { return time.Now().UTC() }}
}

func (s *Service) Create(ctx context.Context, input SetInput) ([]Grant, error) {
	grants, err := s.buildGrants(input)
	if err != nil {
		return nil, err
	}
	audit := s.audit(input, nil, actionsFromGrants(grants), "success")
	if err := s.store.CreateGrants(ctx, grants, audit); err != nil {
		return nil, err
	}
	return grants, nil
}

func (s *Service) Replace(ctx context.Context, input SetInput) ([]Grant, error) {
	grants, err := s.buildGrants(input)
	if err != nil {
		return nil, err
	}
	if err := s.store.ReplaceGrants(ctx, grants[0].UserID, grants[0].ResourceType, grants[0].ResourceID, grants, s.audit(input, nil, actionsFromGrants(grants), "success")); err != nil {
		return nil, err
	}
	return grants, nil
}

func (s *Service) Remove(ctx context.Context, userID, resourceType, resourceID string) error {
	return s.RemoveBy(ctx, userID, resourceType, resourceID, "system", "")
}

func (s *Service) RemoveBy(ctx context.Context, userID, resourceType, resourceID, operatorID, requestID string) error {
	return s.RemoveSubject(ctx, SetInput{UserID: userID, ResourceType: resourceType, ResourceID: resourceID, CreatedBy: operatorID, RequestID: requestID})
}

func (s *Service) RemoveSubject(ctx context.Context, input SetInput) error {
	input.UserID = strings.TrimSpace(input.UserID)
	input.RoleID = strings.TrimSpace(input.RoleID)
	input.ResourceType = strings.TrimSpace(input.ResourceType)
	input.ResourceID = strings.TrimSpace(input.ResourceID)
	if !validSubject(input.UserID, input.RoleID, input.ResourceType) || !validResource(input.ResourceType, input.ResourceID) || strings.TrimSpace(input.CreatedBy) == "" {
		return ErrInvalidRequest
	}
	return s.store.DeleteGrants(ctx, input.UserID, input.ResourceType, input.ResourceID, s.audit(input, nil, []string{}, "success"))
}

func (s *Service) List(ctx context.Context, filter Filter) ([]Grant, error) {
	filter.UserID = strings.TrimSpace(filter.UserID)
	filter.RoleID = strings.TrimSpace(filter.RoleID)
	filter.ResourceType = strings.TrimSpace(filter.ResourceType)
	filter.ResourceID = strings.TrimSpace(filter.ResourceID)
	filter.Action = strings.TrimSpace(filter.Action)
	if filter.RoleID != "" {
		filter.RoleGrants = true
	}
	if filter.RoleGrants && (filter.UserID != "" || filter.Effective || filter.ResourceType != ResourceSkillSpace) {
		return nil, ErrInvalidRequest
	}
	if filter.ResourceType != "" && !validResourceType(filter.ResourceType) {
		return nil, ErrInvalidRequest
	}
	if filter.Action != "" && (filter.ResourceType == "" || !validAction(filter.ResourceType, filter.ResourceID, filter.Action)) {
		return nil, ErrInvalidRequest
	}
	if filter.ResourceID != "" && (filter.ResourceType == "" || !validResource(filter.ResourceType, filter.ResourceID)) {
		return nil, ErrInvalidRequest
	}
	return s.store.ListGrants(ctx, filter)
}

func (s *Service) HasAction(ctx context.Context, userID, resourceType, resourceID, action string) (bool, error) {
	userID, resourceType, resourceID, action = strings.TrimSpace(userID), strings.TrimSpace(resourceType), strings.TrimSpace(resourceID), strings.TrimSpace(action)
	if userID == "" || !validResource(resourceType, resourceID) || !validAction(resourceType, resourceID, action) {
		return false, ErrInvalidRequest
	}
	items, err := s.List(ctx, Filter{UserID: userID, ResourceType: resourceType, ResourceID: resourceID, Action: action, Effective: true})
	return len(items) > 0, err
}

func (s *Service) HasResourceGrants(ctx context.Context, resourceType, resourceID string) (bool, error) {
	items, err := s.List(ctx, Filter{ResourceType: resourceType, ResourceID: resourceID})
	if err == nil && len(items) == 0 && resourceType == ResourceSkillSpace {
		items, err = s.List(ctx, Filter{ResourceType: resourceType, ResourceID: resourceID, RoleGrants: true})
	}
	return len(items) > 0, err
}

func (s *Service) buildGrants(input SetInput) ([]Grant, error) {
	input.UserID = strings.TrimSpace(input.UserID)
	input.RoleID = strings.TrimSpace(input.RoleID)
	input.ResourceType = strings.TrimSpace(input.ResourceType)
	input.ResourceID = strings.TrimSpace(input.ResourceID)
	input.CreatedBy = strings.TrimSpace(input.CreatedBy)
	if !validSubject(input.UserID, input.RoleID, input.ResourceType) || input.CreatedBy == "" || !validResource(input.ResourceType, input.ResourceID) {
		return nil, ErrInvalidRequest
	}
	actions, err := normalizeActions(input.ResourceType, input.ResourceID, input.Actions)
	if err != nil {
		return nil, err
	}
	now := s.clock()
	grants := make([]Grant, 0, len(actions))
	for _, action := range actions {
		grants = append(grants, Grant{
			GrantID: newGrantID(), UserID: input.UserID, RoleID: input.RoleID, ResourceType: input.ResourceType,
			ResourceID: input.ResourceID, Action: action, CreatedBy: input.CreatedBy,
			CreatedAt: now, UpdatedAt: now,
		})
	}
	return grants, nil
}

func validSubject(userID, roleID, resourceType string) bool {
	return (userID == "") != (roleID == "") && (roleID == "" || resourceType == ResourceSkillSpace)
}

func normalizeActions(resourceType, resourceID string, actions []string) ([]string, error) {
	seen := map[string]struct{}{}
	for _, action := range actions {
		action = strings.TrimSpace(action)
		if !validAction(resourceType, resourceID, action) {
			return nil, ErrInvalidRequest
		}
		seen[action] = struct{}{}
	}
	if len(seen) == 0 {
		return nil, ErrInvalidRequest
	}
	if resourceType == ResourceKnowledgeBase {
		if _, upload := seen[ActionUpload]; upload {
			if _, read := seen[ActionRead]; !read {
				return nil, ErrInvalidRequest
			}
		}
	}
	if resourceType == ResourceSharedSpace {
		if _, write := seen[ActionWrite]; write {
			if _, read := seen[ActionRead]; !read {
				return nil, ErrInvalidRequest
			}
		}
	}
	if resourceType == ResourceDataView {
		_, connect := seen[ActionConnect]
		_, manage := seen[ActionManage]
		if connect || manage {
			if _, read := seen[ActionRead]; !read {
				return nil, ErrInvalidRequest
			}
		}
	}
	out := make([]string, 0, len(seen))
	for action := range seen {
		out = append(out, action)
	}
	sort.Strings(out)
	return out, nil
}

func validResourceType(resourceType string) bool {
	_, ok := ResourceDefinitionFor(resourceType)
	return ok
}

func validAction(resourceType, resourceID, action string) bool {
	for _, actionDefinition := range ActionDefinitionsFor(resourceType, resourceID) {
		if actionDefinition.Action == action {
			return true
		}
	}
	return false
}

func validResource(resourceType, resourceID string) bool {
	if resourceType == ResourceFeedback {
		return resourceID == AllFeedback
	}
	if !validResourceType(resourceType) || strings.TrimSpace(resourceID) == "" {
		return false
	}
	if resourceType != ResourceDataView {
		return true
	}
	return resourceID == ViewAgentActivity || resourceID == ViewXiaohongshuOperation || resourceID == ViewDouyinAds || resourceID == ViewBilibiliOperation
}

func actionsFromGrants(grants []Grant) []string {
	actions := make([]string, 0, len(grants))
	for _, grant := range grants {
		actions = append(actions, grant.Action)
	}
	sort.Strings(actions)
	return actions
}

func (s *Service) audit(input SetInput, before, after []string, result string) Audit {
	operatorID := strings.TrimSpace(input.OperatorID)
	if operatorID == "" {
		operatorID = strings.TrimSpace(input.CreatedBy)
	}
	if before == nil {
		before = []string{}
	}
	if after == nil {
		after = []string{}
	}
	return Audit{
		AuditID: newAuditID(), OperatorID: operatorID, TargetUserID: strings.TrimSpace(input.UserID),
		TargetRoleID: strings.TrimSpace(input.RoleID),
		ResourceType: strings.TrimSpace(input.ResourceType), ResourceID: strings.TrimSpace(input.ResourceID),
		BeforeActions: append([]string{}, before...), AfterActions: append([]string{}, after...), Result: result,
		RequestID: strings.TrimSpace(input.RequestID), CreatedAt: s.clock(),
	}
}

func (s *Service) RecordFailure(ctx context.Context, input SetInput) error {
	var actions []string
	if validSubject(strings.TrimSpace(input.UserID), strings.TrimSpace(input.RoleID), strings.TrimSpace(input.ResourceType)) && validResource(strings.TrimSpace(input.ResourceType), strings.TrimSpace(input.ResourceID)) {
		grants, err := s.store.ListGrants(ctx, Filter{UserID: strings.TrimSpace(input.UserID), RoleID: strings.TrimSpace(input.RoleID), RoleGrants: strings.TrimSpace(input.RoleID) != "", ResourceType: strings.TrimSpace(input.ResourceType), ResourceID: strings.TrimSpace(input.ResourceID)})
		if err != nil {
			return err
		}
		actions = actionsFromGrants(grants)
	}
	return s.store.RecordAudit(ctx, s.audit(input, actions, actions, "failed"))
}

func newGrantID() string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "drg_" + hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return "drg_" + hex.EncodeToString(raw[:])
}

func newAuditID() string { return strings.Replace(newGrantID(), "drg_", "dga_", 1) }
