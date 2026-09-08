package mcpauth

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type tokenLookupErrorStore struct {
	*mcpgateway.MemoryStore
	err error
}

func (s *tokenLookupErrorStore) GetAccountTokenByHash(context.Context, string) (mcpgateway.AccountToken, error) {
	return mcpgateway.AccountToken{}, s.err
}

type agentLookupErrorStore struct {
	*mcpgateway.MemoryStore
	err error
}

func (s *agentLookupErrorStore) GetAgent(context.Context, string) (mcpgateway.AgentRegistration, error) {
	return mcpgateway.AgentRegistration{}, s.err
}

type accountLookupErrorStore struct {
	*accounts.MemoryStore
	accountErr error
	ownerErr   error
}

func (s *accountLookupErrorStore) GetAccount(ctx context.Context, userID string) (accounts.Account, error) {
	if s.accountErr != nil {
		return accounts.Account{}, s.accountErr
	}
	return s.MemoryStore.GetAccount(ctx, userID)
}

func (s *accountLookupErrorStore) GetAccountForAgent(ctx context.Context, agentID string) (accounts.Account, error) {
	if s.ownerErr != nil {
		return accounts.Account{}, s.ownerErr
	}
	return s.MemoryStore.GetAccountForAgent(ctx, agentID)
}

func TestStaticTokenVerifierRejectsConfiguredDemoToken(t *testing.T) {
	verifier := NewStaticTokenVerifier(Config{DemoTokens: map[string]TokenConfig{
		"demo-token": {Subject: "user", AgentID: "agent", Scopes: []string{"mcp:call"}},
	}})
	if _, err := verifier(context.Background(), "demo-token", httptest.NewRequest("POST", "/mcp", nil)); err == nil {
		t.Fatal("demo token was accepted in account token mode")
	}
}

func TestStaticTokenVerifierRejectsUnknownToken(t *testing.T) {
	verifier := NewStaticTokenVerifier(Config{})
	if _, err := verifier(context.Background(), "missing-token", httptest.NewRequest("POST", "/mcp", nil)); err == nil {
		t.Fatal("expected invalid token error")
	}
}

func TestIdentityFromTokenInfoRequiresClientID(t *testing.T) {
	if _, err := IdentityFromTokenInfo(nil); err == nil {
		t.Fatal("expected missing token info error")
	}
}

func TestAccountTokenVerifierAcceptsOwnedActiveAgent(t *testing.T) {
	ctx := context.Background()
	accountSvc, store, _ := accountTokenVerifierFixture(t, accounts.StatusActive, mcpgateway.StatusActive)
	verifier := NewStaticTokenVerifier(Config{AccountTokenStore: store, AccountService: accountSvc})
	req := httptest.NewRequest("POST", "/mcp", nil)
	req.Header.Set("X-Claw-Agent-ID", "agent_owned")
	info, err := verifier(ctx, "account-token", req)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := IdentityFromTokenInfo(info)
	if err != nil {
		t.Fatal(err)
	}
	if identity.UserID != "usr_owner" || identity.Subject != "usr_owner" || identity.AgentID != "agent_owned" || identity.ClientID != "claw-mcp-account-token" {
		t.Fatalf("identity = %#v", identity)
	}
	stored, err := store.GetAccountTokenByHash(ctx, mcpgateway.HashToken("account-token"))
	if err != nil || stored.LastUsedAt == nil {
		t.Fatalf("stored token = %#v, %v", stored, err)
	}
}

func TestAccountTokenVerifierRejectsInvalidAccountOrAgentContext(t *testing.T) {
	tests := []struct {
		name          string
		accountStatus string
		agentStatus   string
		header        string
	}{
		{name: "missing header", accountStatus: accounts.StatusActive, agentStatus: mcpgateway.StatusActive},
		{name: "disabled account", accountStatus: accounts.StatusDisabled, agentStatus: mcpgateway.StatusActive, header: "agent_owned"},
		{name: "disabled agent", accountStatus: accounts.StatusActive, agentStatus: mcpgateway.StatusDisabled, header: "agent_owned"},
		{name: "unknown agent", accountStatus: accounts.StatusActive, agentStatus: mcpgateway.StatusActive, header: "agent_unknown"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			accountSvc, store, _ := accountTokenVerifierFixture(t, test.accountStatus, test.agentStatus)
			verifier := NewStaticTokenVerifier(Config{AccountTokenStore: store, AccountService: accountSvc})
			req := httptest.NewRequest("POST", "/mcp", nil)
			if test.header != "" {
				req.Header.Set("X-Claw-Agent-ID", test.header)
			}
			if _, err := verifier(context.Background(), "account-token", req); err == nil {
				t.Fatal("invalid account or agent context was accepted")
			}
		})
	}
}

func TestAccountTokenVerifierPropagatesStoreFailures(t *testing.T) {
	backendErr := errors.New("database unavailable")
	accountSvc, store, accountStore := accountTokenVerifierFixture(t, accounts.StatusActive, mcpgateway.StatusActive)
	req := httptest.NewRequest("POST", "/mcp", nil)
	req.Header.Set("X-Claw-Agent-ID", "agent_owned")
	tests := []struct {
		name       string
		gateway    mcpgateway.Store
		accountSvc *accounts.Service
	}{
		{name: "token lookup", gateway: &tokenLookupErrorStore{MemoryStore: store, err: backendErr}, accountSvc: accountSvc},
		{name: "account lookup", gateway: store, accountSvc: accounts.NewService(accounts.Config{Store: &accountLookupErrorStore{MemoryStore: accountStore, accountErr: backendErr}})},
		{name: "owner lookup", gateway: store, accountSvc: accounts.NewService(accounts.Config{Store: &accountLookupErrorStore{MemoryStore: accountStore, ownerErr: backendErr}})},
		{name: "agent lookup", gateway: &agentLookupErrorStore{MemoryStore: store, err: backendErr}, accountSvc: accountSvc},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			verifier := NewStaticTokenVerifier(Config{AccountTokenStore: test.gateway, AccountService: test.accountSvc})
			if _, err := verifier(context.Background(), "account-token", req); !errors.Is(err, backendErr) {
				t.Fatalf("verifier() error = %v, want %v", err, backendErr)
			}
		})
	}
}

func accountTokenVerifierFixture(t *testing.T, accountStatus, agentStatus string) (*accounts.Service, *mcpgateway.MemoryStore, *accounts.MemoryStore) {
	t.Helper()
	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: accountStore})
	owner := accounts.Account{UserID: "usr_owner", Email: "owner@example.com", Status: accountStatus}
	if err := accountStore.SaveAccount(ctx, owner); err != nil {
		t.Fatal(err)
	}
	if err := accountSvc.BindAgent(ctx, owner.UserID, "agent_owned"); err != nil {
		t.Fatal(err)
	}
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "agent_owned", ActorID: owner.UserID, Status: agentStatus}); err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Now().Add(time.Hour)
	token := mcpgateway.AccountToken{
		ID: "token_owned", UserID: owner.UserID, TokenHash: mcpgateway.HashToken("account-token"),
		Status: mcpgateway.StatusActive, ExpiresAt: &expiresAt, Scopes: []string{"mcp:call"},
	}
	if err := store.RotateAccountToken(ctx, owner.UserID, token); err != nil {
		t.Fatal(err)
	}
	return accountSvc, store, accountStore
}
