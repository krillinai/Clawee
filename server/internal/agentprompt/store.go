package agentprompt

import (
	"context"
	"sync"
	"time"
)

type MemoryStore struct {
	mu     sync.RWMutex
	policy Policy
}

func NewMemoryStore() *MemoryStore { return &MemoryStore{} }

func (s *MemoryStore) Get(ctx context.Context) (Policy, error) {
	if err := ctx.Err(); err != nil {
		return Policy{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.policy, nil
}

func (s *MemoryStore) Update(ctx context.Context, input UpdateInput) (Policy, error) {
	if err := ctx.Err(); err != nil {
		return Policy{}, err
	}
	if err := ValidateInput(input); err != nil {
		return Policy{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := input.UpdatedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if s.policy.CreatedAt.IsZero() {
		s.policy.CreatedAt = now
	}
	s.policy.Version++
	s.policy.ServerPrompt = input.ServerPrompt
	s.policy.ClaweePrompt = input.ClaweePrompt
	s.policy.UpdatedBy = input.UpdatedBy
	s.policy.UpdatedAt = now
	return s.policy, nil
}
