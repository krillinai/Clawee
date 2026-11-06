package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func seedPlatformModelGroup(t *testing.T, groups *mcpgateway.MemoryModelGroupStore, cipher mcpgateway.TokenCipher) {
	t.Helper()
	ctx := context.Background()
	key, err := cipher.Encrypt([]byte("upstream-secret"))
	if err != nil {
		t.Fatalf("encrypt upstream key: %v", err)
	}
	now := time.Now().UTC()
	if err := groups.SaveModelUpstreamAccount(ctx, mcpgateway.ModelUpstreamAccount{
		ID: "upstream-1", Name: "测试上游", BaseURL: "https://models.example/v1", APIKeyCiphertext: key,
		ManualModels: []string{"deepseek-v4-flash"}, Status: mcpgateway.ModelGroupStatusActive,
		HealthStatus: "healthy", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("save upstream: %v", err)
	}
	if err := groups.SaveModelGroup(ctx, mcpgateway.ModelGroupConfig{
		ModelGroup: mcpgateway.ModelGroup{ID: "default", Name: "默认模型组", RouteStrategy: mcpgateway.ModelGroupRouteFailover, DefaultModel: "deepseek-v4-flash", Status: mcpgateway.ModelGroupStatusActive, CreatedAt: now, UpdatedAt: now},
		Accounts:   []mcpgateway.ModelGroupAccount{{UpstreamAccountID: "upstream-1", Priority: 0, Weight: 1}},
	}); err != nil {
		t.Fatalf("save model group: %v", err)
	}
}

func TestModelConfigurationUsesTrustedClaweePrincipal(t *testing.T) {
	gin.SetMode(gin.TestMode)
	groups := mcpgateway.NewMemoryModelGroupStore()
	cipher := mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef"))
	seedPlatformModelGroup(t, groups, cipher)
	gatewayStore := mcpgateway.NewMemoryStore()
	gateway := mcpgateway.NewService(mcpgateway.Config{Store: gatewayStore, TokenCipher: cipher})
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", AgentID: "trusted-agent", ClientID: accounts.ClientClaweeAgent})
		c.Set(accountContextKey, accounts.Account{UserID: "user-1", Name: "可信账户", Email: "user@example.com"})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: "trusted-agent", Status: mcpgateway.StatusActive})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{ProxyGateway: gateway, ModelCredentialCipher: cipher, ModelGroupStore: groups, ModelUpstreamStore: groups, ModelGatewayBaseURL: "https://gateway.example.com"})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d cache-control=%q body=%s", recorder.Code, recorder.Header().Get("Cache-Control"), recorder.Body.String())
	}
	for _, expected := range []string{`"mode":"platform_managed"`, `"base_url":"https://gateway.example.com/v1"`, `"model":"deepseek-v4-flash"`, `"api_key":"sk-`, `"credential_version":1`} {
		if !strings.Contains(recorder.Body.String(), expected) {
			t.Fatalf("response missing %s: %s", expected, recorder.Body.String())
		}
	}
}

func TestModelConfigurationEnsuresGatewayAccessTokenAndGroup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	gatewayStore := mcpgateway.NewMemoryStore()
	groups := mcpgateway.NewMemoryModelGroupStore()
	cipher := mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef"))
	seedPlatformModelGroup(t, groups, cipher)
	gateway := mcpgateway.NewService(mcpgateway.Config{Store: gatewayStore, TokenCipher: cipher})
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", AgentID: "trusted-agent", ClientID: accounts.ClientClaweeAgent})
		c.Set(accountContextKey, accounts.Account{UserID: "user-1", Name: "可信账户", Email: "user@example.com"})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: "trusted-agent", Status: mcpgateway.StatusActive})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{
		ProxyGateway:          gateway,
		ModelCredentialCipher: cipher,
		ModelGroupStore:       groups,
		ModelUpstreamStore:    groups,
		ModelGatewayBaseURL:   "https://gateway.example.com",
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil))
	body := recorder.Body.String()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, body)
	}
	for _, expected := range []string{`"base_url":"https://gateway.example.com/v1"`, `"model":"deepseek-v4-flash"`, `"credential_version":1`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("response missing %s: %s", expected, body)
		}
	}
	if strings.Contains(body, "generated-key") || strings.Contains(body, "https://model.example") {
		t.Fatalf("response leaked upstream configuration: %s", body)
	}
	active, err := gatewayStore.GetActiveAccountToken(t.Context(), "user-1")
	if err != nil || len(active.TokenCiphertext) == 0 || len(active.Scopes) != 2 {
		t.Fatalf("active account token = %#v, %v", active, err)
	}
	group, err := groups.GetUserModelGroup(t.Context(), "user-1")
	if err != nil || group.ID == "" {
		t.Fatalf("user model group = %#v, %v", group, err)
	}
}

func TestEnterpriseManagedModelConfigurationReturnsModeOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", AgentID: "trusted-agent", ClientID: accounts.ClientClaweeAgent})
		c.Set(accountContextKey, accounts.Account{UserID: "user-1", Name: "可信账户"})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: "trusted-agent", Status: mcpgateway.StatusActive})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{
		ModelAccessMode: ModelAccessEnterpriseManaged,
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil))
	body := recorder.Body.String()
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d headers=%v body=%s", recorder.Code, recorder.Header(), body)
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
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", AgentID: "trusted-agent", ClientID: accounts.ClientClaweeAgent})
		c.Set(accountContextKey, accounts.Account{UserID: "user-1", Name: "可信账户"})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: "trusted-agent", Status: mcpgateway.StatusActive})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{ModelAccessMode: ModelAccessPlatformManaged})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"model_configuration_unavailable"`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestModelConfigurationRejectsWebSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	app := router.Group("/api/v1/app")
	app.Use(unifiedAPIResponse())
	app.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "user-1", ClientID: accounts.ClientWeb})
		c.Next()
	})
	mountModelConfigurationRoutes(app, Options{})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/app/model-configuration", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
