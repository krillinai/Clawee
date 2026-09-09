package platformbranding

import (
	"context"
	"sync"
)

type Store interface {
	Get(context.Context) (Configuration, error)
	Update(context.Context, UpdateInput) (Configuration, error)
}

type MemoryStore struct {
	mu            sync.RWMutex
	configuration Configuration
}

func NewMemoryStore() *MemoryStore { return &MemoryStore{} }

func (s *MemoryStore) Get(ctx context.Context) (Configuration, error) {
	if err := ctx.Err(); err != nil {
		return Configuration{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneConfiguration(s.configuration), nil
}

func (s *MemoryStore) Update(ctx context.Context, input UpdateInput) (Configuration, error) {
	if err := ctx.Err(); err != nil {
		return Configuration{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	configuration := cloneConfiguration(s.configuration)
	configuration.SidebarLogo = applyAction(configuration.SidebarLogo, input.SidebarLogoAction, input.SidebarLogo)
	configuration.SidebarCompactLogo = applyAction(configuration.SidebarCompactLogo, input.SidebarCompactLogoAction, input.SidebarCompactLogo)
	configuration.UpdatedBy = input.UpdatedBy
	configuration.UpdatedAt = input.UpdatedAt
	if configuration.CreatedAt.IsZero() {
		configuration.CreatedAt = input.UpdatedAt
	}
	s.configuration = configuration
	return cloneConfiguration(configuration), nil
}

func applyAction(current *Image, action Action, content []byte) *Image {
	switch action {
	case ActionKeep:
		return cloneImage(current)
	case ActionReplace:
		return &Image{Content: append([]byte(nil), content...), ContentType: detectContentType(content)}
	default:
		return nil
	}
}

func cloneConfiguration(configuration Configuration) Configuration {
	configuration.SidebarLogo = cloneImage(configuration.SidebarLogo)
	configuration.SidebarCompactLogo = cloneImage(configuration.SidebarCompactLogo)
	return configuration
}

func cloneImage(image *Image) *Image {
	if image == nil {
		return nil
	}
	return &Image{Content: append([]byte(nil), image.Content...), ContentType: image.ContentType}
}
