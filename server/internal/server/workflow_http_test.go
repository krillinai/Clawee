package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
	"github.com/krillinai/Clawee/server/internal/workflow"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestWorkflowHTTPAndMCPTaskAuthorization(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testpostgres.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	accountsService, rbacService := newJWTAccountAndRBAC(t)
	store := newClaweeOwnedAgentStore(accountsService)
	proxy := testProxyGateway(store)
	service := &workflow.Service{DB: pool}
	router := newTestRouter(t, server.Options{
		AccountService: accountsService, RBACService: rbacService, ProxyGateway: proxy,
		WorkflowService: service, MCPAuth: server.MCPAuthOptions{
			Enabled: true, RequiredScopes: []string{"mcp:call"}, AccountTokenStore: store, AccountService: accountsService,
		},
	})
	users := []struct{ email, agent string }{{"workflow-a@example.com", "workflow-agent-a"}, {"workflow-b@example.com", "workflow-agent-b"}}
	ids := make([]string, 0, len(users))
	for _, user := range users {
		cookies := register(t, router, `{"email":"`+user.email+`","name":"Workflow User","password":"passw0rd!"}`)
		createWebAgent(t, router, cookies, user.agent)
		account, err := accountsService.AuthenticateCredentials(ctx, accounts.LoginRequest{Email: user.email, Password: "passw0rd!"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, account.UserID)
		if _, err = pool.Exec(ctx, `INSERT INTO accounts (user_id,email,name,password_hash,status,created_at,updated_at) VALUES ($1,$2,'Workflow User','test','active',now(),now())`, account.UserID, user.email); err != nil {
			t.Fatal(err)
		}
	}
	nodes := []workflow.Node{{ID: "agent", Order: 0, Type: "agent", Title: "生成", Assignee: ids[0], Instruction: "生成"}, {ID: "review", Order: 1, Type: "approval", Title: "审核", Assignee: ids[1], Instruction: "审核"}}
	template, err := service.Save(ctx, ids[0], "", "授权测试", "", 0, nodes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetStatus(ctx, template.ID, ids[0], true); err != nil {
		t.Fatal(err)
	}
	started, err := service.Start(ctx, template.ID, ids[0], "start", []byte(`{"text":"private"}`))
	if err != nil {
		t.Fatal(err)
	}

	login := loginClawee(t, router, users[1].email, "passw0rd!", users[1].agent)
	if login.Status != http.StatusOK || login.AccessToken == "" {
		t.Fatalf("login status=%d error=%s", login.Status, login.ErrorCode)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/app/workflow-tasks/"+started.TaskID, nil)
	request.Header.Set("Authorization", "Bearer "+login.AccessToken)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || strings.Contains(recorder.Body.String(), "private") {
		t.Fatalf("other user's task: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	const token = "workflow-account-token"
	if err = store.RotateAccountToken(ctx, ids[1], mcpgateway.AccountToken{ID: "workflow-token", UserID: ids[1], TokenHash: mcpgateway.HashToken(token), Status: mcpgateway.StatusActive, Scopes: []string{"mcp:call"}}); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(router)
	defer httpServer.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "workflow-auth-test", Version: "1.0.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: httpServer.URL + "/mcp", HTTPClient: &http.Client{Transport: staticBearerTransport{token: token, agentID: users[1].agent}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "workflow_get_task", Arguments: map[string]any{"task_id": started.TaskID}})
	if err != nil || !result.IsError || len(result.Content) == 0 {
		t.Fatalf("other user's MCP task: result=%#v err=%v", result, err)
	}
}
