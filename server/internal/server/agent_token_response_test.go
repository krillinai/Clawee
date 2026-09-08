package server_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestAgentTokenRevealResponseContainsOnlyBasicAgentTokenFields(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{
		ProxyGateway:   testProxyGateway(mcpgateway.NewMemoryStore()),
		AccountService: accountSvc,
	})
	register(t, router, `{"email":"admin-token-contract@example.com","name":"Admin Token Contract","password":"passw0rd!"}`)
	cookies := register(t, router, `{"email":"user-token-contract@example.com","name":"User Token Contract","password":"passw0rd!"}`)
	createWebAgent(t, router, cookies, "user-token-contract-agent")

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/app/mcp/token/reveal", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookies[0])
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	response := unwrapAPIDataMap(t, recorder.Body.Bytes())
	token, _ := response["token"].(string)
	if token == "" || response["authorization_header"] != "Authorization: Bearer "+token {
		t.Fatalf("reveal response = %#v", response)
	}
	tokenInfo, ok := response["token_info"].(map[string]any)
	if !ok || tokenInfo["token_status"] != mcpgateway.StatusActive || tokenInfo["user_id"] == "" {
		t.Fatalf("token info = %#v", response["token_info"])
	}
	for _, field := range []string{"plaintext", "agent_id", "mcp_config"} {
		if _, ok := response[field]; ok {
			t.Fatalf("reveal response retains %s: %#v", field, response)
		}
	}
}
