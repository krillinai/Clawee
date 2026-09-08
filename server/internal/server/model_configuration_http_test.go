package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/clawadmin"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type modelConfigurationProviderStub struct {
	accounts []clawadmin.AccountReference
	err      error
}

func (p *modelConfigurationProviderStub) EnsureModelConfiguration(_ context.Context, account clawadmin.AccountReference) (clawadmin.ModelConfiguration, error) {
	p.accounts = append(p.accounts, account)
	if p.err != nil {
		return clawadmin.ModelConfiguration{}, p.err
	}
	return clawadmin.ModelConfiguration{BaseURL: "https://model.example/v1", APIKey: "generated-key", Model: "deepseek-v4-flash", CredentialVersion: 1}, nil
}

func TestModelConfigurationUsesTrustedClaweePrincipal(t *testing.T) {
	gin.SetMode(gin.TestMode)
	provider := &modelConfigurationProviderStub{}
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", AgentID: "trusted-agent", ClientID: accounts.ClientClaweeAgent})
		c.Set(accountContextKey, accounts.Account{UserID: "user-1", Name: "可信账户", Email: "user@example.com"})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: "trusted-agent", Status: mcpgateway.StatusActive})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{ModelConfigurationProvider: provider})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d cache-control=%q body=%s", recorder.Code, recorder.Header().Get("Cache-Control"), recorder.Body.String())
	}
	if len(provider.accounts) != 1 || provider.accounts[0].ID != "user-1" || provider.accounts[0].Name != "可信账户" || provider.accounts[0].Email != "user@example.com" {
		t.Fatalf("accounts = %v", provider.accounts)
	}
	for _, expected := range []string{`"mode":"platform_managed"`, `"base_url":"https://model.example/v1"`, `"model":"deepseek-v4-flash"`, `"api_key":"generated-key"`, `"credential_version":1`} {
		if !strings.Contains(recorder.Body.String(), expected) {
			t.Fatalf("response missing %s: %s", expected, recorder.Body.String())
		}
	}
}

func TestEnterpriseManagedModelConfigurationShortCircuitsProvider(t *testing.T) {
	gin.SetMode(gin.TestMode)
	provider := &modelConfigurationProviderStub{}
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", AgentID: "trusted-agent", ClientID: accounts.ClientClaweeAgent})
		c.Set(accountContextKey, accounts.Account{UserID: "user-1"})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: "trusted-agent", Status: mcpgateway.StatusActive})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{
		ModelAccessMode:            ModelAccessEnterpriseManaged,
		ModelConfigurationProvider: provider,
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil))
	body := recorder.Body.String()
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" || len(provider.accounts) != 0 {
		t.Fatalf("status=%d calls=%d headers=%v body=%s", recorder.Code, len(provider.accounts), recorder.Header(), body)
	}
	if !strings.Contains(body, `"data":{"mode":"enterprise_managed"}`) {
		t.Fatalf("unexpected response: %s", body)
	}
	for _, forbidden := range []string{"base_url", "model\"", "api_key", "credential_version"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("response contains %q: %s", forbidden, body)
		}
	}
}

func TestPlatformManagedModelConfigurationUnavailable(t *testing.T) {
	gin.SetMode(gin.TestMode)
	provider := &modelConfigurationProviderStub{err: errors.New("upstream unavailable")}
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", AgentID: "trusted-agent", ClientID: accounts.ClientClaweeAgent})
		c.Set(accountContextKey, accounts.Account{UserID: "user-1"})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: "trusted-agent", Status: mcpgateway.StatusActive})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{ModelAccessMode: ModelAccessPlatformManaged, ModelConfigurationProvider: provider})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"model_configuration_unavailable"`) || len(provider.accounts) != 1 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, len(provider.accounts), recorder.Body.String())
	}
}

func TestModelConfigurationRejectsWebSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	provider := &modelConfigurationProviderStub{}
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", ClientID: accounts.ClientWeb})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{ModelConfigurationProvider: provider})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || len(provider.accounts) != 0 {
		t.Fatalf("status=%d calls=%v body=%s", recorder.Code, provider.accounts, recorder.Body.String())
	}
}
