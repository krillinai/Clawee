package mcpauth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/oauthex"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type Config struct {
	Enabled              bool
	Resource             string
	ResourceMetadataURL  string
	AuthorizationServers []string
	RequiredScopes       []string
	DemoTokens           map[string]TokenConfig
	AccountTokenStore    mcpgateway.Store
	AccountService       *accounts.Service
}

type TokenConfig struct {
	Subject  string
	ClientID string
	AgentID  string
	Issuer   string
	TokenID  string
	Scopes   []string
}

func NewStaticTokenVerifier(cfg Config) auth.TokenVerifier {
	return func(ctx context.Context, token string, req *http.Request) (*auth.TokenInfo, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if cfg.AccountTokenStore == nil || cfg.AccountService == nil {
			return nil, fmt.Errorf("%w: account token verifier is not configured", auth.ErrInvalidToken)
		}
		return verifyAccountToken(ctx, cfg.AccountTokenStore, cfg.AccountService, token, req)
	}
}

func verifyAccountToken(ctx context.Context, store mcpgateway.Store, accountSvc *accounts.Service, plaintext string, req *http.Request) (*auth.TokenInfo, error) {
	invalid := func() (*auth.TokenInfo, error) {
		return nil, fmt.Errorf("%w: invalid account token", auth.ErrInvalidToken)
	}
	entry, err := store.GetAccountTokenByHash(ctx, mcpgateway.HashToken(plaintext))
	if err != nil {
		if errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
			return invalid()
		}
		return nil, err
	}
	if entry.Status != mcpgateway.StatusActive {
		return invalid()
	}
	if entry.ExpiresAt != nil && !entry.ExpiresAt.After(time.Now()) {
		return invalid()
	}
	account, err := accountSvc.Account(ctx, entry.UserID)
	if err != nil {
		if errors.Is(err, accounts.ErrAccountNotFound) {
			return invalid()
		}
		return nil, err
	}
	if account.Status != accounts.StatusActive {
		return invalid()
	}
	agentID := ""
	if req != nil {
		agentID = strings.TrimSpace(req.Header.Get("X-Claw-Agent-ID"))
	}
	if agentID == "" {
		return invalid()
	}
	owner, err := accountSvc.AccountForAgent(ctx, agentID)
	if err != nil {
		if errors.Is(err, accounts.ErrAccountAgentNotFound) {
			return invalid()
		}
		return nil, err
	}
	if owner.UserID != entry.UserID {
		return invalid()
	}
	agent, err := store.GetAgent(ctx, agentID)
	if err != nil {
		if errors.Is(err, mcpgateway.ErrAgentNotFound) {
			return invalid()
		}
		return nil, err
	}
	if agent.Status != mcpgateway.StatusActive {
		return invalid()
	}
	if err := store.TouchAccountToken(ctx, entry.ID, time.Now().UTC()); err != nil {
		return nil, err
	}
	expiration := time.Now().Add(time.Hour)
	if entry.ExpiresAt != nil {
		expiration = *entry.ExpiresAt
	}
	return &auth.TokenInfo{
		UserID:     account.UserID,
		Scopes:     append([]string(nil), entry.Scopes...),
		Expiration: expiration,
		Extra: map[string]any{
			"sub":       account.UserID,
			"user_id":   account.UserID,
			"client_id": "claw-mcp-account-token",
			"agent_id":  agent.AgentID,
			"iss":       entry.Issuer,
			"jti":       entry.ID,
		},
	}, nil
}

func IdentityFromTokenInfo(info *auth.TokenInfo) (mcpgateway.AgentIdentity, error) {
	if info == nil {
		return mcpgateway.AgentIdentity{}, errors.New("missing bearer token info")
	}
	clientID := stringExtra(info, "client_id")
	if clientID == "" {
		return mcpgateway.AgentIdentity{}, errors.New("missing token client_id")
	}
	agentID := stringExtra(info, "agent_id")
	if agentID == "" {
		agentID = clientID
	}

	subject := stringExtra(info, "sub")
	if subject == "" {
		subject = info.UserID
	}

	return mcpgateway.AgentIdentity{
		UserID:   stringExtra(info, "user_id"),
		Subject:  subject,
		ClientID: clientID,
		AgentID:  agentID,
		Scopes:   append([]string(nil), info.Scopes...),
		Issuer:   stringExtra(info, "iss"),
		TokenID:  stringExtra(info, "jti"),
	}, nil
}

func RequireBearerToken(cfg Config) func(http.Handler) http.Handler {
	return auth.RequireBearerToken(NewStaticTokenVerifier(cfg), &auth.RequireBearerTokenOptions{
		ResourceMetadataURL: cfg.ResourceMetadataURL,
		Scopes:              cfg.RequiredScopes,
	})
}

func ProtectedResourceMetadata(cfg Config) *oauthex.ProtectedResourceMetadata {
	return &oauthex.ProtectedResourceMetadata{
		Resource:               cfg.Resource,
		AuthorizationServers:   cfg.AuthorizationServers,
		ScopesSupported:        cfg.RequiredScopes,
		BearerMethodsSupported: []string{"header"},
		ResourceName:           "claw-mcp",
	}
}

func stringExtra(info *auth.TokenInfo, key string) string {
	if info == nil || info.Extra == nil {
		return ""
	}
	value, _ := info.Extra[key].(string)
	return value
}
