package agentprompt

import (
	"context"
	"time"
)

type Service struct {
	store Store
	clock func() time.Time
}

func NewService(store Store) *Service {
	if store == nil {
		store = NewMemoryStore()
	}
	return &Service{store: store, clock: time.Now}
}

func (s *Service) Get(ctx context.Context) (Policy, error) {
	return s.store.Get(ctx)
}

func (s *Service) Update(ctx context.Context, input UpdateInput) (Policy, error) {
	if err := ValidateInput(input); err != nil {
		return Policy{}, err
	}
	if input.UpdatedAt.IsZero() {
		input.UpdatedAt = s.clock().UTC()
	}
	return s.store.Update(ctx, input)
}
