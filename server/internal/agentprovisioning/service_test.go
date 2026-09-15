package agentprovisioning

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func newProvisioningTestService(t *testing.T) (*Service, *accounts.Service, *mcpgateway.MemoryStore) {
	t.Helper()
	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	for _, account := range []accounts.Account{
		{UserID: "usr_1", Email: "one@example.com", Name: "One", Status: accounts.StatusActive},
		{UserID: "usr_2", Email: "two@example.com", Name: "Two", Status: accounts.StatusActive},
	} {
		if err := accountStore.SaveAccount(ctx, account); err != nil {
			t.Fatal(err)
		}
	}
	accountSvc := accounts.NewService(accounts.Config{Store: accountStore})
	gatewayStore := mcpgateway.NewMemoryStore()
	gatewayStore.SetOwnedAgentBinder(func(ctx context.Context, userID, agentID string, createdAt time.Time) error {
		err := accountStore.SaveActiveAccountAgent(ctx, accounts.AccountAgent{UserID: userID, AgentID: agentID, CreatedAt: createdAt})
		if errors.Is(err, accounts.ErrAccountNotFound) || errors.Is(err, accounts.ErrAccountNotActive) {
			return mcpgateway.ErrAgentOwnerUnavailable
		}
		return err
	})
	cipher, err := mcpgateway.NewTokenCipher([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	gateway := mcpgateway.NewService(mcpgateway.Config{Store: gatewayStore, TokenCipher: cipher})
	return NewService(accountSvc, gateway), accountSvc, gatewayStore
}

func TestEnsureOwnedAgentCreatesUsingSourcePolicy(t *testing.T) {
	for _, test := range []struct {
		name       string
		req        EnsureRequest
		wantClient string
		wantName   string
		wantSource string
	}{
		{
			name:       "clawee",
			req:        EnsureRequest{UserID: "usr_1", AgentID: " clawee_1 ", ClientID: "ignored", DisplayName: "Alice", Source: SourceClaweeLogin},
			wantClient: accounts.ClientClaweeAgent, wantName: "Alice", wantSource: mcpgateway.AgentCreationSourceClaweeLogin,
		},
		{
			name:       "collector uses account display name",
			req:        EnsureRequest{UserID: "usr_1", AgentID: "codex_1", ClientID: "codex", DisplayName: "Untrusted Collector Name", Source: SourceCollector},
			wantClient: "codex", wantName: "One的Codex", wantSource: mcpgateway.AgentCreationSourceCollector,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, accountSvc, gatewayStore := newProvisioningTestService(t)
			result, err := svc.EnsureOwnedAgent(context.Background(), test.req)
			if err != nil || !result.Created {
				t.Fatalf("EnsureOwnedAgent() = %#v, %v", result, err)
			}
			if result.Agent.AgentID != strings.TrimSpace(test.req.AgentID) || result.Agent.ClientID != test.wantClient || result.Agent.Name != test.wantName || result.Agent.ActorID != test.req.UserID || result.Agent.CreationSource != test.wantSource {
				t.Fatalf("agent = %#v", result.Agent)
			}
			owner, err := accountSvc.AccountForAgent(context.Background(), result.Agent.AgentID)
			if err != nil || owner.UserID != test.req.UserID {
				t.Fatalf("owner = %#v, %v", owner, err)
			}
			if token, err := gatewayStore.GetActiveAccountToken(context.Background(), test.req.UserID); err != nil || token.UserID != test.req.UserID {
				t.Fatalf("agent creation did not create account token: token=%#v err=%v", token, err)
			}
		})
	}
}

func TestEnsureOwnedAgentReusesOwnedAgentWithoutMutationOrTokenRotation(t *testing.T) {
	svc, _, store := newProvisioningTestService(t)
	first, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{
		UserID: "usr_1", AgentID: "stable_1", ClientID: "codex", DisplayName: "Original", Source: SourceCollector,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{
		UserID: "usr_1", AgentID: "stable_1", ClientID: accounts.ClientClaweeAgent, DisplayName: "Changed", Source: SourceClaweeLogin,
	})
	if err != nil || second.Created {
		t.Fatalf("second = %#v, %v", second, err)
	}
	if second.Agent.Name != first.Agent.Name || second.Agent.ClientID != first.Agent.ClientID {
		t.Fatalf("agent mutated: %#v", second)
	}
	firstToken, err := store.GetActiveAccountToken(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("first account token: %v", err)
	}
	secondToken, err := store.GetActiveAccountToken(context.Background(), "usr_1")
	if err != nil || secondToken.ID != firstToken.ID {
		t.Fatalf("agent reuse rotated account token: first=%#v second=%#v err=%v", firstToken, secondToken, err)
	}
	if _, err := svc.proxyGateway.RevokeAccountToken(context.Background(), "usr_1"); err != nil {
		t.Fatalf("revoke account token: %v", err)
	}
	if _, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{
		UserID: "usr_1", AgentID: "stable_1", Source: SourceCollector,
	}); err != nil {
		t.Fatalf("reuse revoked-token agent: %v", err)
	}
	if _, err := store.GetActiveAccountToken(context.Background(), "usr_1"); !errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
		t.Fatalf("agent reuse reissued revoked account token: %v", err)
	}
	if err := svc.proxyGateway.EnsureAccountToken(context.Background(), "usr_1"); err != nil {
		t.Fatalf("ensure account token after revoke: %v", err)
	}
	latest, err := store.GetLatestAccountToken(context.Background(), "usr_1")
	if err != nil || latest.Status != mcpgateway.StatusRevoked {
		t.Fatalf("ensure account token resurrected revoked token: token=%#v err=%v", latest, err)
	}
}

func TestEnsureOwnedAgentClaweeLoginBackfillsMissingAccountToken(t *testing.T) {
	svc, _, store := newProvisioningTestService(t)
	ctx := context.Background()
	if err := store.CreateOwnedAgent(ctx, "usr_1", mcpgateway.AgentRegistration{
		AgentID: "legacy-agent", ClientID: accounts.ClientClaweeAgent, ActorID: "usr_1", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatalf("create legacy agent: %v", err)
	}
	if _, err := svc.EnsureOwnedAgent(ctx, EnsureRequest{
		UserID: "usr_1", AgentID: "legacy-agent", Source: SourceClaweeLogin,
	}); err != nil {
		t.Fatalf("clawee login did not backfill account token: %v", err)
	}
	if token, err := store.GetActiveAccountToken(ctx, "usr_1"); err != nil || token.UserID != "usr_1" {
		t.Fatalf("backfilled token = %#v err=%v", token, err)
	}
}

func TestEnsureOwnedAgentRejectsInvalidID(t *testing.T) {
	svc, _, _ := newProvisioningTestService(t)
	for _, id := range []string{"", "   ", strings.Repeat("界", 65)} {
		_, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{UserID: "usr_1", AgentID: id, Source: SourceCollector})
		if !errors.Is(err, ErrInvalidAgentID) {
			t.Fatalf("agent_id %q error = %v", id, err)
		}
	}
}

func TestEnsureOwnedAgentRejectsDifferentOwnerAndOrphan(t *testing.T) {
	svc, _, store := newProvisioningTestService(t)
	if _, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{UserID: "usr_1", AgentID: "owned", ClientID: "codex", Source: SourceCollector}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{UserID: "usr_2", AgentID: "owned", Source: SourceCollector}); !errors.Is(err, ErrAgentIDConflict) {
		t.Fatalf("different owner error = %v", err)
	}
	if err := store.SaveAgent(context.Background(), mcpgateway.AgentRegistration{AgentID: "orphan", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{UserID: "usr_1", AgentID: "orphan", Source: SourceCollector}); !errors.Is(err, ErrAgentIDConflict) {
		t.Fatalf("orphan error = %v", err)
	}
}

func TestEnsureOwnedAgentAppliesDisabledRuleBySource(t *testing.T) {
	svc, _, store := newProvisioningTestService(t)
	created, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{UserID: "usr_1", AgentID: "disabled", ClientID: "codex", Source: SourceCollector})
	if err != nil {
		t.Fatal(err)
	}
	created.Agent.Status = mcpgateway.StatusDisabled
	if err := store.SaveAgent(context.Background(), created.Agent); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{UserID: "usr_1", AgentID: "disabled", Source: SourceClaweeLogin}); !errors.Is(err, ErrAgentForbidden) {
		t.Fatalf("clawee error = %v", err)
	}
	result, err := svc.EnsureOwnedAgent(context.Background(), EnsureRequest{UserID: "usr_1", AgentID: "disabled", Source: SourceCollector})
	if err != nil || result.Agent.Status != mcpgateway.StatusDisabled || result.Created {
		t.Fatalf("collector result = %#v, %v", result, err)
	}
}

type concurrentCreateStore struct {
	*mcpgateway.MemoryStore
	arrived atomic.Int32
	release chan struct{}
}

func (s *concurrentCreateStore) CreateOwnedAgent(ctx context.Context, userID string, agent mcpgateway.AgentRegistration) error {
	if s.arrived.Add(1) == 2 {
		close(s.release)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.release:
	}
	return s.MemoryStore.CreateOwnedAgent(ctx, userID, agent)
}

func TestEnsureOwnedAgentConcurrentCreateReusesWinner(t *testing.T) {
	_, accountSvc, baseStore := newProvisioningTestService(t)
	store := &concurrentCreateStore{MemoryStore: baseStore, release: make(chan struct{})}
	cipher, err := mcpgateway.NewTokenCipher([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(accountSvc, mcpgateway.NewService(mcpgateway.Config{Store: store, TokenCipher: cipher}))
	req := EnsureRequest{UserID: "usr_1", AgentID: "concurrent", ClientID: "codex", Source: SourceCollector}

	results := make(chan EnsureResult, 2)
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			result, err := svc.EnsureOwnedAgent(context.Background(), req)
			results <- result
			errs <- err
		}()
	}
	created := 0
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		if (<-results).Created {
			created++
		}
	}
	if created != 1 {
		t.Fatalf("created results = %d, want 1", created)
	}
	agents, err := baseStore.ListAgents(context.Background(), mcpgateway.AgentFilter{})
	if err != nil || len(agents) != 1 {
		t.Fatalf("agents = %#v, %v", agents, err)
	}
	if token, err := baseStore.GetActiveAccountToken(context.Background(), "usr_1"); err != nil || token.UserID != "usr_1" {
		t.Fatalf("concurrent agent create did not create account token: token=%#v err=%v", token, err)
	}
}
