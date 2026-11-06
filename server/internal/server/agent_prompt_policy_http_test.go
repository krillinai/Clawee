package server_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentprompt"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestAgentPromptPolicyAdminRoutePersistsBothPrompts(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	registered, err := accountService.Register(t.Context(), accounts.RegisterRequest{
		Email: "agent-prompt-admin@example.com", Name: "Agent Prompt Admin", Password: "passw0rd!",
	})
	if err != nil {
		t.Fatal(err)
	}
	auditStore := rbac.NewMemoryStore()
	rbacService := rbac.NewService(rbac.Config{Store: auditStore, Accounts: accountService})
	if err := rbacService.Initialize(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := rbacService.BootstrapAdmin(t.Context(), registered.Account.UserID); err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(t.Context(), registered.Account, []accounts.TokenRequest{
		{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb},
	})
	if err != nil {
		t.Fatal(err)
	}
	router := authenticatedTestHandler{
		next: server.NewRouter(server.Options{
			AgentPromptPolicyService: agentprompt.NewService(agentprompt.NewMemoryStore()),
			OfficeManagementAPI:      httpapi.NewManagementAPI(fakeManagementStoreForRouteTest{}, func() time.Time { return time.Now().UTC() }),
			AccountService:           accountService,
			RBACService:              rbacService,
		}),
		cookies: []*http.Cookie{{Name: "claw_admin_token", Value: tokens.Token(accounts.AudienceAdmin).Token}},
		userID:  registered.Account.UserID,
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/admin/agent-prompt-policy", strings.NewReader(`{"server_agent_prompt":"server rule","clawee_agent_prompt":"clawee rule"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"version":1`) {
		t.Fatalf("update status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	audited := false
	for _, audit := range auditStore.Audits() {
		if audit.Action == rbac.AuditAgentPromptPolicyUpdate {
			audited = true
			break
		}
	}
	if !audited {
		t.Fatalf("agent prompt policy update was not audited: %#v", auditStore.Audits())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/agent-prompt-policy", nil)
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"server_agent_prompt":"server rule"`) || !strings.Contains(recorder.Body.String(), `"clawee_agent_prompt":"clawee rule"`) {
		t.Fatalf("read status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestAgentPromptPolicyRouteFollowsAgentManagementFeature(t *testing.T) {
	router := newTestRouter(t, server.Options{
		AgentPromptPolicyService: agentprompt.NewService(agentprompt.NewMemoryStore()),
	})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/admin/agent-prompt-policy", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("disabled feature status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}
