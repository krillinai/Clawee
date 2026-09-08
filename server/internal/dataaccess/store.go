package dataaccess

import (
	"context"
	"sort"
	"sync"
)

type Store interface {
	CreateGrants(context.Context, []Grant, Audit) error
	ReplaceGrants(context.Context, string, string, string, []Grant, Audit) error
	DeleteGrants(context.Context, string, string, string, Audit) error
	ListGrants(context.Context, Filter) ([]Grant, error)
	RecordAudit(context.Context, Audit) error
}

type MemoryStore struct {
	mu     sync.RWMutex
	grants map[string]Grant
	audits []Audit
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{grants: map[string]Grant{}}
}

func (s *MemoryStore) CreateGrants(ctx context.Context, grants []Grant, audit Audit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	audit.BeforeActions = audit.BeforeActions[:0]
	for _, existing := range s.grants {
		if len(grants) > 0 && existing.UserID == grants[0].UserID && existing.ResourceType == grants[0].ResourceType && existing.ResourceID == grants[0].ResourceID {
			audit.BeforeActions = append(audit.BeforeActions, existing.Action)
		}
		for _, grant := range grants {
			if sameGrantKey(existing, grant) {
				return ErrConflict
			}
		}
	}
	for _, grant := range grants {
		s.grants[grant.GrantID] = grant
	}
	audit.AfterActions = append(audit.BeforeActions[:len(audit.BeforeActions):len(audit.BeforeActions)], audit.AfterActions...)
	sort.Strings(audit.BeforeActions)
	sort.Strings(audit.AfterActions)
	s.audits = append(s.audits, audit)
	return nil
}

func (s *MemoryStore) ReplaceGrants(ctx context.Context, userID, resourceType, resourceID string, grants []Grant, audit Audit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	audit.BeforeActions = audit.BeforeActions[:0]
	for id, grant := range s.grants {
		if grant.UserID == userID && grant.ResourceType == resourceType && grant.ResourceID == resourceID {
			audit.BeforeActions = append(audit.BeforeActions, grant.Action)
			delete(s.grants, id)
			found = true
		}
	}
	sort.Strings(audit.BeforeActions)
	if !found {
		return ErrNotFound
	}
	for _, grant := range grants {
		s.grants[grant.GrantID] = grant
	}
	s.audits = append(s.audits, audit)
	return nil
}

func (s *MemoryStore) DeleteGrants(ctx context.Context, userID, resourceType, resourceID string, audit Audit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	audit.BeforeActions = audit.BeforeActions[:0]
	for id, grant := range s.grants {
		if grant.UserID == userID && grant.ResourceType == resourceType && grant.ResourceID == resourceID {
			audit.BeforeActions = append(audit.BeforeActions, grant.Action)
			delete(s.grants, id)
			found = true
		}
	}
	sort.Strings(audit.BeforeActions)
	if !found {
		return ErrNotFound
	}
	s.audits = append(s.audits, audit)
	return nil
}

func (s *MemoryStore) RecordAudit(ctx context.Context, audit Audit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.audits = append(s.audits, audit)
	return nil
}

func (s *MemoryStore) Audits() []Audit {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Audit, len(s.audits))
	copy(out, s.audits)
	return out
}

func (s *MemoryStore) ListGrants(ctx context.Context, filter Filter) ([]Grant, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Grant{}
	for _, grant := range s.grants {
		if filter.UserID != "" && grant.UserID != filter.UserID {
			continue
		}
		if filter.ResourceType != "" && grant.ResourceType != filter.ResourceType {
			continue
		}
		if filter.ResourceID != "" && grant.ResourceID != filter.ResourceID {
			continue
		}
		if filter.Action != "" && grant.Action != filter.Action {
			continue
		}
		out = append(out, grant)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UserID != out[j].UserID {
			return out[i].UserID < out[j].UserID
		}
		if out[i].ResourceID != out[j].ResourceID {
			return out[i].ResourceID < out[j].ResourceID
		}
		return out[i].Action < out[j].Action
	})
	return out, nil
}

func sameGrantKey(left, right Grant) bool {
	return left.UserID == right.UserID && left.ResourceType == right.ResourceType && left.ResourceID == right.ResourceID && left.Action == right.Action
}
