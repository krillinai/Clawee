package rbac

import (
	"context"
	"sort"
	"sync"
)

type Store interface {
	EnsureSystemRole(context.Context, Role) error
	ListRoles(context.Context) ([]Role, error)
	GetRole(context.Context, string) (Role, error)
	GetRoleByCode(context.Context, string) (Role, error)
	CreateRole(context.Context, Role, OperationAudit) error
	UpdateRole(context.Context, Role, OperationAudit) error
	DeleteRole(context.Context, string, OperationAudit) error
	ListAccountRoles(context.Context, string) ([]AccountRole, error)
	AssignAccountRole(context.Context, AccountRole, OperationAudit) error
	RemoveAccountRole(context.Context, string, string, OperationAudit) error
	CountRoleAccounts(context.Context, string) (int, error)
	RecordAudit(context.Context, OperationAudit) error
	HasActiveAdmin(context.Context) (bool, error)
}

func (s *MemoryStore) HasActiveAdmin(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, roles := range s.bindings {
		for roleID := range roles {
			role, ok := s.roles[roleID]
			if ok && role.Code == AdminRoleCode {
				return true, nil
			}
		}
	}
	return false, nil
}

type MemoryStore struct {
	mu       sync.RWMutex
	roles    map[string]Role
	bindings map[string]map[string]AccountRole
	audits   []OperationAudit
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		roles:    map[string]Role{},
		bindings: map[string]map[string]AccountRole{},
	}
}

func (s *MemoryStore) EnsureSystemRole(ctx context.Context, role Role) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.roles[role.RoleID]; !ok {
		s.roles[role.RoleID] = cloneRole(role)
	}
	return nil
}

func (s *MemoryStore) ListRoles(ctx context.Context) ([]Role, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Role, 0, len(s.roles))
	for _, role := range s.roles {
		out = append(out, cloneRole(role))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].System != out[j].System {
			return out[i].System
		}
		return out[i].Code < out[j].Code
	})
	return out, nil
}

func (s *MemoryStore) GetRole(ctx context.Context, roleID string) (Role, error) {
	if err := ctx.Err(); err != nil {
		return Role{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	role, ok := s.roles[roleID]
	if !ok {
		return Role{}, ErrRoleNotFound
	}
	return cloneRole(role), nil
}

func (s *MemoryStore) GetRoleByCode(ctx context.Context, code string) (Role, error) {
	if err := ctx.Err(); err != nil {
		return Role{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, role := range s.roles {
		if role.Code == code {
			return cloneRole(role), nil
		}
	}
	return Role{}, ErrRoleNotFound
}

func (s *MemoryStore) CreateRole(ctx context.Context, role Role, audit OperationAudit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.roles {
		if existing.Code == role.Code {
			return ErrRoleCodeExists
		}
	}
	s.roles[role.RoleID] = cloneRole(role)
	s.audits = append(s.audits, cloneAudit(audit))
	return nil
}

func (s *MemoryStore) UpdateRole(ctx context.Context, role Role, audit OperationAudit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.roles[role.RoleID]; !ok {
		return ErrRoleNotFound
	}
	s.roles[role.RoleID] = cloneRole(role)
	s.audits = append(s.audits, cloneAudit(audit))
	return nil
}

func (s *MemoryStore) DeleteRole(ctx context.Context, roleID string, audit OperationAudit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.roles[roleID]; !ok {
		return ErrRoleNotFound
	}
	for _, roles := range s.bindings {
		if _, ok := roles[roleID]; ok {
			return ErrRoleInUse
		}
	}
	delete(s.roles, roleID)
	s.audits = append(s.audits, cloneAudit(audit))
	return nil
}

func (s *MemoryStore) ListAccountRoles(ctx context.Context, userID string) ([]AccountRole, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	roles := s.bindings[userID]
	out := make([]AccountRole, 0, len(roles))
	for _, binding := range roles {
		role, ok := s.roles[binding.RoleID]
		if !ok {
			continue
		}
		binding.RoleCode = role.Code
		binding.RoleName = role.Name
		binding.System = role.System
		out = append(out, binding)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RoleCode < out[j].RoleCode })
	return out, nil
}

func (s *MemoryStore) AssignAccountRole(ctx context.Context, binding AccountRole, audit OperationAudit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.roles[binding.RoleID]; !ok {
		return ErrRoleNotFound
	}
	if s.bindings[binding.UserID] == nil {
		s.bindings[binding.UserID] = map[string]AccountRole{}
	}
	if _, ok := s.bindings[binding.UserID][binding.RoleID]; ok {
		return ErrAccountRoleExists
	}
	s.bindings[binding.UserID][binding.RoleID] = binding
	s.audits = append(s.audits, cloneAudit(audit))
	return nil
}

func (s *MemoryStore) RemoveAccountRole(ctx context.Context, userID, roleID string, audit OperationAudit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.bindings[userID][roleID]; !ok {
		return ErrAccountRoleNotFound
	}
	delete(s.bindings[userID], roleID)
	s.audits = append(s.audits, cloneAudit(audit))
	return nil
}

func (s *MemoryStore) CountRoleAccounts(ctx context.Context, roleID string) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, roles := range s.bindings {
		if _, ok := roles[roleID]; ok {
			count++
		}
	}
	return count, nil
}

func (s *MemoryStore) RecordAudit(ctx context.Context, audit OperationAudit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.audits = append(s.audits, cloneAudit(audit))
	return nil
}

func (s *MemoryStore) Audits() []OperationAudit {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]OperationAudit, len(s.audits))
	for i, audit := range s.audits {
		out[i] = cloneAudit(audit)
	}
	return out
}

func cloneRole(role Role) Role {
	role.Permissions = append([]string(nil), role.Permissions...)
	return role
}

func cloneAudit(audit OperationAudit) OperationAudit {
	audit.Before = append([]byte(nil), audit.Before...)
	audit.After = append([]byte(nil), audit.After...)
	return audit
}
