package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestModelProxyRoutesAreNotMountedForEnterpriseManaged(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	mountModelProxyRoutes(router, Options{ModelAccessMode: ModelAccessEnterpriseManaged})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("enterprise model route status = %d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestWriteModelErrorUsesOpenAIErrorTypesAndRequestID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(requestIDMiddleware())
	router.GET("/error", func(c *gin.Context) {
		writeModelError(c, http.StatusUnauthorized, "invalid_api_key", "Invalid API key")
	})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/error", nil)
	request.Header.Set("X-Request-ID", "req-test-error")
	router.ServeHTTP(recorder, request)
	var body struct {
		Error struct {
			Type string `json:"type"`
			Code string `json:"code"`
		} `json:"error"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Type != "authentication_error" || body.Error.Code != "invalid_api_key" || body.RequestID != "req-test-error" {
		t.Fatalf("error body = %s", recorder.Body.String())
	}
}

func TestResolveModelBearerReturnsKnownTokenSnapshots(t *testing.T) {
	for _, test := range []struct {
		name   string
		status string
	}{
		{name: "revoked", status: mcpgateway.StatusRevoked},
		{name: "disabled", status: mcpgateway.StatusDisabled},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := mcpgateway.NewMemoryStore()
			const plaintext = "account-token"
			if err := store.RotateAccountToken(context.Background(), "user_model", mcpgateway.AccountToken{
				ID: "token_" + test.name, UserID: "user_model", TokenHash: mcpgateway.HashToken(plaintext),
				Status: test.status, Fingerprint: "fingerprint", Scopes: []string{mcpgateway.AccountTokenScopeMCPCall, mcpgateway.AccountTokenScopeModelCall}, CreatedAt: time.Now(), UpdatedAt: time.Now(),
			}); err != nil {
				t.Fatalf("seed api key: %v", err)
			}

			req := httptest.NewRequest("GET", "/v1/models", nil)
			req.Header.Set("Authorization", "Bearer "+plaintext)
			identity, err := resolveModelBearer(req, store)
			if err != nil {
				t.Fatalf("resolve known token: %v", err)
			}
			if identity.Token.ID != "token_"+test.name || identity.Token.Status != test.status {
				t.Fatalf("identity token = %#v, want id/status %q/%q", identity.Token, "token_"+test.name, test.status)
			}
		})
	}
}

func TestResolveModelBearerRejectsQueryAndCookieTokens(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	if err := store.RotateAccountToken(context.Background(), "user_model", mcpgateway.AccountToken{
		ID: "token_query", UserID: "user_model", TokenHash: mcpgateway.HashToken("model-token"), Status: mcpgateway.StatusActive,
		Fingerprint: "fingerprint", Scopes: []string{mcpgateway.AccountTokenScopeMCPCall, mcpgateway.AccountTokenScopeModelCall}, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("seed token: %v", err)
	}

	queryRequest := httptest.NewRequest("GET", "/v1/models?api_key=model-token", nil)
	if _, err := resolveModelBearer(queryRequest, store); !errors.Is(err, errInvalidModelToken) {
		t.Fatalf("query token error = %v, want %v", err, errInvalidModelToken)
	}

	cookieRequest := httptest.NewRequest("GET", "/v1/models", nil)
	cookieRequest.AddCookie(&http.Cookie{Name: "api_key", Value: "model-token"})
	if _, err := resolveModelBearer(cookieRequest, store); !errors.Is(err, errInvalidModelToken) {
		t.Fatalf("cookie token error = %v, want %v", err, errInvalidModelToken)
	}
}

func TestEvaluateModelPolicyRejectsKnownTokenBeforeTouchingIt(t *testing.T) {
	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	if err := accountStore.SaveAccount(ctx, accounts.Account{UserID: "user_model", Name: "模型用户", Status: accounts.StatusActive}); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	accountService := accounts.NewService(accounts.Config{Store: accountStore})
	store := mcpgateway.NewMemoryStore()
	if err := store.RotateAccountToken(ctx, "user_model", mcpgateway.AccountToken{
		ID: "token_inactive", UserID: "user_model", TokenHash: mcpgateway.HashToken("scope-token"), Status: mcpgateway.StatusRevoked,
		Fingerprint: "fingerprint", Scopes: []string{mcpgateway.AccountTokenScopeMCPCall, mcpgateway.AccountTokenScopeModelCall}, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("seed token: %v", err)
	}

	identity, err := resolveModelBearer(httptest.NewRequest("GET", "/v1/models", nil), store)
	if err == nil {
		t.Fatal("missing authorization unexpectedly resolved")
	}
	request := httptest.NewRequest("GET", "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer scope-token")
	identity, err = resolveModelBearer(request, store)
	if err != nil {
		t.Fatalf("resolve token: %v", err)
	}
	decision, err := evaluateModelPolicy(ctx, identity, store, accountService, time.Now().UTC())
	if err != nil {
		t.Fatalf("evaluate policy: %v", err)
	}
	if decision.Status != modelPolicyRejectedAPIKey {
		t.Fatalf("policy status = %q, want %q", decision.Status, modelPolicyRejectedAPIKey)
	}
	stored, err := store.GetAccountTokenByHash(ctx, mcpgateway.HashToken("scope-token"))
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	if stored.LastUsedAt != nil {
		t.Fatalf("rejected token was touched at %v", stored.LastUsedAt)
	}
}

func TestEvaluateModelPolicyRejectsTokenWithoutModelScope(t *testing.T) {
	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	if err := accountStore.SaveAccount(ctx, accounts.Account{UserID: "user_model", Name: "模型用户", Status: accounts.StatusActive}); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	accountService := accounts.NewService(accounts.Config{Store: accountStore})
	store := mcpgateway.NewMemoryStore()
	if err := store.RotateAccountToken(ctx, "user_model", mcpgateway.AccountToken{
		ID: "token_mcp_only", UserID: "user_model", TokenHash: mcpgateway.HashToken("mcp-only-token"), Status: mcpgateway.StatusActive,
		Fingerprint: "fingerprint", Scopes: []string{mcpgateway.AccountTokenScopeMCPCall}, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("seed token: %v", err)
	}

	request := httptest.NewRequest("GET", "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer mcp-only-token")
	identity, err := resolveModelBearer(request, store)
	if err != nil {
		t.Fatalf("resolve token: %v", err)
	}
	decision, err := evaluateModelPolicy(ctx, identity, store, accountService, time.Now().UTC())
	if err != nil {
		t.Fatalf("evaluate policy: %v", err)
	}
	if decision.Status != modelPolicyRejectedScope {
		t.Fatalf("policy status = %q, want %q", decision.Status, modelPolicyRejectedScope)
	}
	stored, err := store.GetAccountTokenByHash(ctx, mcpgateway.HashToken("mcp-only-token"))
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	if stored.LastUsedAt != nil {
		t.Fatalf("scope-rejected token was touched at %v", stored.LastUsedAt)
	}
}
