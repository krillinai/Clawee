package businessdata

import (
	"context"
	"testing"
)

type fixtureConnector struct {
	provider string
	pull     func(context.Context, Source, PullRequest) (Batch, error)
}

func (f fixtureConnector) Provider() string { return f.provider }
func (f fixtureConnector) Pull(ctx context.Context, source Source, request PullRequest) (Batch, error) {
	if f.pull == nil {
		return Batch{}, nil
	}
	return f.pull(ctx, source, request)
}

func TestConnectorRegistry(t *testing.T) {
	registry := NewConnectorRegistry()
	connector := fixtureConnector{provider: ProviderXiaohongshu}
	if err := registry.Register(connector); err != nil {
		t.Fatal(err)
	}
	if stored, ok := registry.Get(ProviderXiaohongshu); !ok || stored.Provider() != ProviderXiaohongshu {
		t.Fatalf("connector not registered: %#v %v", stored, ok)
	}
	for _, invalid := range []Connector{
		fixtureConnector{provider: ""},
		fixtureConnector{provider: "fixture"},
		connector,
	} {
		if err := registry.Register(invalid); err == nil {
			t.Fatalf("expected registration error for provider %q", invalid.Provider())
		}
	}
}
