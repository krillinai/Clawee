package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
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
	var adminCookies []*http.Cookie
	for _, user := range users {
		cookies := register(t, router, `{"email":"`+user.email+`","name":"Workflow User","password":"passw0rd!"}`)
		if adminCookies == nil {
			adminCookies = cookies
		}
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
	const ownerToken = "workflow-owner-token"
	if err := store.RotateAccountToken(ctx, ids[0], mcpgateway.AccountToken{ID: "workflow-owner-token", UserID: ids[0], TokenHash: mcpgateway.HashToken(ownerToken), Status: mcpgateway.StatusActive, Scopes: []string{"mcp:call"}}); err != nil {
		t.Fatal(err)
	}
	ownerClient := mcp.NewClient(&mcp.Implementation{Name: "legacy-workflow-owner", Version: "1.0.0"}, nil)
	ownerSession, err := ownerClient.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: httpServer.URL + "/mcp", HTTPClient: &http.Client{Transport: staticBearerTransport{token: ownerToken, agentID: users[0].agent}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ownerSession.Close()
	legacyTask, err := ownerSession.CallTool(ctx, &mcp.CallToolParams{Name: "workflow_get_task", Arguments: map[string]any{"task_id": started.TaskID}})
	if err != nil || legacyTask.IsError {
		t.Fatalf("旧模板 MCP 详情: %+v %v", legacyTask, err)
	}
	raw, err := json.Marshal(legacyTask.StructuredContent)
	var task workflow.Task
	if err != nil || json.Unmarshal(raw, &task) != nil || !reflect.DeepEqual(task.AssigneeUsers, []string{ids[0]}) {
		t.Fatalf("旧模板候选数组: %s %v", raw, err)
	}
	legacyCompleted, err := ownerSession.CallTool(ctx, &mcp.CallToolParams{Name: "workflow_complete_task", Arguments: map[string]any{"task_id": started.TaskID, "idempotency_key": "legacy-done", "output": map[string]any{"done": true}}})
	if err != nil || legacyCompleted.IsError {
		t.Fatalf("旧模板 MCP 完成: %+v %v", legacyCompleted, err)
	}
	raw, err = json.Marshal(legacyCompleted.StructuredContent)
	var legacyResult workflow.Result
	if err != nil || json.Unmarshal(raw, &legacyResult) != nil || legacyResult.NextTask == nil || legacyResult.NextTask.ID != "" || !reflect.DeepEqual(legacyResult.NextTask.AssigneeUsers, []string{ids[1]}) {
		t.Fatalf("旧模板非候选下一节点隐藏 ID: %s %v", raw, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE user_id=$1`, ids[1]); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/admin/workflow-instances", "/api/v1/admin/workflow-instances/" + started.InstanceID} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.AddCookie(adminCookie(t, adminCookies))
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("instance status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		var body struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		var items []workflow.Instance
		if path == "/api/v1/admin/workflow-instances" {
			if err := json.Unmarshal(body.Data, &items); err != nil {
				t.Fatal(err)
			}
		} else {
			var item workflow.Instance
			if err := json.Unmarshal(body.Data, &item); err != nil {
				t.Fatal(err)
			}
			items = []workflow.Instance{item}
		}
		if len(items) != 1 || items[0].UserNames[ids[0]] != "Workflow User" || items[0].UserNames[ids[1]] != "Workflow User" {
			t.Fatalf("instance names missing: %+v", items)
		}
	}
}

func TestWorkflowSharedCandidatesHTTPAndMCP(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testpostgres.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	accountsService, rbacService := newJWTAccountAndRBAC(t)
	store := newClaweeOwnedAgentStore(accountsService)
	service := &workflow.Service{DB: pool}
	router := newTestRouter(t, server.Options{
		AccountService: accountsService, RBACService: rbacService, ProxyGateway: testProxyGateway(store),
		WorkflowService: service, MCPAuth: server.MCPAuthOptions{
			Enabled: true, RequiredScopes: []string{"mcp:call"}, AccountTokenStore: store, AccountService: accountsService,
		},
	})
	ids, tokens := []string{}, []string{}
	cookies := [][]*http.Cookie{}
	for index := 0; index < 3; index++ {
		email, agent := fmt.Sprintf("shared-%d@example.com", index), fmt.Sprintf("shared-agent-%d", index)
		userCookies := register(t, router, `{"email":"`+email+`","name":"共同候选","password":"passw0rd!"}`)
		cookies = append(cookies, userCookies)
		createWebAgent(t, router, userCookies, agent)
		account, err := accountsService.AuthenticateCredentials(ctx, accounts.LoginRequest{Email: email, Password: "passw0rd!"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, account.UserID)
		if _, err := pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES ($1,$2,'共同候选','test','active',now(),now())`, account.UserID, email); err != nil {
			t.Fatal(err)
		}
		login := loginClawee(t, router, email, "passw0rd!", agent)
		if login.Status != http.StatusOK {
			t.Fatalf("登录失败: %d %s", login.Status, login.ErrorCode)
		}
		tokens = append(tokens, login.AccessToken)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO rbac_roles(role_id,code,name,created_at,updated_at) VALUES
		('shared','workflow_shared','共同候选角色',now(),now()),('empty','workflow_empty','空角色',now(),now())`); err != nil {
		t.Fatal(err)
	}
	for _, user := range ids[:2] {
		if _, err := pool.Exec(ctx, `INSERT INTO account_roles(user_id,role_id,created_at) VALUES ($1,'shared',now())`, user); err != nil {
			t.Fatal(err)
		}
	}
	reader := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"workflow_reader","name":"流程查看员","permission_codes":["console:workflow:instance_read"]}`, cookies[0], http.StatusCreated)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+ids[1]+`","role_id":"`+nestedString(t, reader, "data", "role_id")+`"}`, cookies[0], http.StatusCreated)
	cookies[1] = loginCookies(t, router, `{"email":"shared-1@example.com","password":"passw0rd!"}`)
	request := func(method, path, body string, user int, admin bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if admin {
			req.AddCookie(adminCookie(t, cookies[user]))
		} else {
			req.Header.Set("Authorization", "Bearer "+tokens[user])
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		return recorder
	}
	roles := request(http.MethodGet, "/api/v1/admin/workflow-assignee-roles?q=共同", "", 0, true)
	if roles.Code != http.StatusOK || !strings.Contains(roles.Body.String(), `"role_id":"shared"`) || !strings.Contains(roles.Body.String(), `"has_next":false`) {
		t.Fatalf("角色候选端点: %d %s", roles.Code, roles.Body.String())
	}
	if response := request(http.MethodGet, "/api/v1/admin/workflow-assignee-roles", "", 1, true); response.Code != http.StatusForbidden {
		t.Fatalf("角色候选权限: %d %s", response.Code, response.Body.String())
	}
	if response := request(http.MethodGet, "/api/v1/admin/workflow-assignee-roles?q="+strings.Repeat("x", 101), "", 0, true); response.Code != http.StatusBadRequest {
		t.Fatalf("角色候选查询校验: %d", response.Code)
	}
	if response := request(http.MethodPost, "/api/v1/admin/workflow-templates", `{"name":"空角色","nodes":[{"node_id":"first","order":0,"type":"agent","assignee_role_ids":["empty"]}]}`, 0, true); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"invalid_assignees"`) {
		t.Fatalf("无有效角色候选错误契约: %d %s", response.Code, response.Body.String())
	}
	nodes := []workflow.Node{
		{ID: "agent", Type: "agent", Title: "执行", Instruction: "执行", Assignee: ids[0], AssigneeUsers: []string{ids[0]}, AssigneeRoles: []string{"shared"}, ResolvedUsers: []string{ids[2]}},
		{ID: "review", Order: 1, Type: "approval", Title: "审核", Instruction: "审核", Assignee: ids[0], AssigneeRoles: []string{"shared"}},
		{ID: "last", Order: 2, Type: "agent", Title: "后续", Instruction: "后续", AssigneeUsers: []string{ids[2]}},
	}
	payload, err := json.Marshal(map[string]any{"name": "共同待办", "nodes": nodes})
	if err != nil {
		t.Fatal(err)
	}
	created := request(http.MethodPost, "/api/v1/admin/workflow-templates", string(payload), 0, true)
	var templateBody struct {
		Data workflow.Template `json:"data"`
	}
	if created.Code != http.StatusOK || json.Unmarshal(created.Body.Bytes(), &templateBody) != nil || len(templateBody.Data.Nodes[0].ResolvedUsers) != 0 {
		t.Fatalf("保存候选/忽略预填: %d %s", created.Code, created.Body.String())
	}
	templateID := templateBody.Data.ID
	if response := request(http.MethodPost, "/api/v1/admin/workflow-templates/"+templateID+"/enable", "", 0, true); response.Code != http.StatusOK {
		t.Fatalf("启用: %d %s", response.Code, response.Body.String())
	}
	for index := range ids {
		response := request(http.MethodGet, "/api/v1/app/workflow-templates", "", index, false)
		var list struct {
			Data []workflow.Template `json:"data"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &list) != nil || (index < 2 && len(list.Data) != 1) || (index == 2 && len(list.Data) != 0) {
			t.Fatalf("候选模板列表 %d: %d %s", index, response.Code, response.Body.String())
		}
		response = request(http.MethodGet, "/api/v1/app/workflow-templates/"+templateID, "", index, false)
		if (index < 2 && response.Code != http.StatusOK) || (index == 2 && response.Code != http.StatusNotFound) {
			t.Fatalf("候选模板详情 %d: %d %s", index, response.Code, response.Body.String())
		}
	}
	if response := request(http.MethodPost, "/api/v1/app/workflow-templates/"+templateID+"/instances", `{"idempotency_key":"denied"}`, 2, false); response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), `"code":"not_found"`) {
		t.Fatalf("后续节点参与人不能发起: %d %s", response.Code, response.Body.String())
	}
	startResponse := request(http.MethodPost, "/api/v1/app/workflow-templates/"+templateID+"/instances", `{"idempotency_key":"start","input":{"private":true}}`, 1, false)
	var started struct {
		Data workflow.Result `json:"data"`
	}
	if startResponse.Code != http.StatusOK || json.Unmarshal(startResponse.Body.Bytes(), &started) != nil {
		t.Fatalf("非旧单负责人发起: %d %s", startResponse.Code, startResponse.Body.String())
	}
	httpServer := httptest.NewServer(router)
	defer httpServer.Close()
	sessions := []*mcp.ClientSession{}
	for index, user := range ids {
		token := fmt.Sprintf("shared-token-%d", index)
		if err := store.RotateAccountToken(ctx, user, mcpgateway.AccountToken{ID: token, UserID: user, TokenHash: mcpgateway.HashToken(token), Status: mcpgateway.StatusActive, Scopes: []string{"mcp:call"}}); err != nil {
			t.Fatal(err)
		}
		client := mcp.NewClient(&mcp.Implementation{Name: "shared-workflow", Version: "1.0.0"}, nil)
		session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: httpServer.URL + "/mcp", HTTPClient: &http.Client{Transport: staticBearerTransport{token: token, agentID: fmt.Sprintf("shared-agent-%d", index)}}}, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = session.Close() })
		sessions = append(sessions, session)
		response := request(http.MethodGet, "/api/v1/app/workflow-tasks/"+started.Data.TaskID, "", index, false)
		if (index < 2 && response.Code != http.StatusOK) || (index == 2 && response.Code != http.StatusNotFound) {
			t.Fatalf("候选 HTTP 详情 %d: %d %s", index, response.Code, response.Body.String())
		}
		response = request(http.MethodGet, "/api/v1/app/workflow-tasks", "", index, false)
		var tasks struct {
			Data []workflow.Task `json:"data"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &tasks) != nil || (index < 2 && (len(tasks.Data) != 1 || len(tasks.Data[0].AssigneeUsers) != 2)) || (index == 2 && len(tasks.Data) != 0) {
			t.Fatalf("候选 HTTP 待办 %d: %d %s", index, response.Code, response.Body.String())
		}
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "workflow_get_task", Arguments: map[string]any{"task_id": started.Data.TaskID}})
		if err != nil || result.IsError != (index == 2) {
			t.Fatalf("候选 MCP 详情 %d: %+v %v", index, result, err)
		}
		result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "workflow_list_tasks", Arguments: map[string]any{}})
		if err != nil || result.IsError {
			t.Fatalf("候选 MCP 列表 %d: %+v %v", index, result, err)
		}
		raw, err := json.Marshal(result.StructuredContent)
		var list struct {
			Tasks []workflow.Task `json:"tasks"`
		}
		if err != nil || json.Unmarshal(raw, &list) != nil || (index < 2 && (len(list.Tasks) != 1 || len(list.Tasks[0].AssigneeUsers) != 2)) || (index == 2 && len(list.Tasks) != 0) {
			t.Fatalf("MCP 列表候选集合: %s %v", raw, err)
		}
	}
	arguments := map[string]any{"task_id": started.Data.TaskID, "idempotency_key": "done", "output": map[string]any{"done": true}}
	if result, err := sessions[2].CallTool(ctx, &mcp.CallToolParams{Name: "workflow_complete_task", Arguments: arguments}); err != nil || !result.IsError {
		t.Fatalf("非候选 MCP 完成: %+v %v", result, err)
	}
	completed, err := sessions[1].CallTool(ctx, &mcp.CallToolParams{Name: "workflow_complete_task", Arguments: arguments})
	if err != nil || completed.IsError {
		t.Fatalf("共同候选 MCP 完成: %+v %v", completed, err)
	}
	raw, err := json.Marshal(completed.StructuredContent)
	var result workflow.Result
	if err != nil || json.Unmarshal(raw, &result) != nil || result.NextTask == nil || result.NextTask.ID == "" || len(result.NextTask.AssigneeUsers) != 2 {
		t.Fatalf("非旧单负责人获得下一节点 ID: %s %v", raw, err)
	}
	if replay, err := sessions[1].CallTool(ctx, &mcp.CallToolParams{Name: "workflow_complete_task", Arguments: arguments}); err != nil || replay.IsError {
		t.Fatalf("本人 MCP 重试: %+v %v", replay, err)
	}
	if replay, err := sessions[0].CallTool(ctx, &mcp.CallToolParams{Name: "workflow_complete_task", Arguments: arguments}); err != nil || !replay.IsError || len(replay.Content) == 0 || replay.Content[0].(*mcp.TextContent).Text != "conflict" {
		t.Fatalf("他人 MCP 冒领幂等键: %+v %v", replay, err)
	}
	if response := request(http.MethodGet, "/api/v1/app/workflow-tasks/"+result.NextTask.ID, "", 2, false); response.Code != http.StatusNotFound {
		t.Fatalf("实例参与人不是审核候选: %d %s", response.Code, response.Body.String())
	}
	approvalPath := "/api/v1/app/workflow-tasks/" + result.NextTask.ID + "/decision"
	if response := request(http.MethodPost, approvalPath, `{"decision":"approve","idempotency_key":"denied"}`, 2, false); response.Code != http.StatusNotFound {
		t.Fatalf("非候选 HTTP 审核: %d %s", response.Code, response.Body.String())
	}
	approved := request(http.MethodPost, approvalPath, `{"decision":"approve","idempotency_key":"approve"}`, 1, false)
	var approval struct {
		Data workflow.Result `json:"data"`
	}
	if approved.Code != http.StatusOK || json.Unmarshal(approved.Body.Bytes(), &approval) != nil || approval.Data.NextTask == nil || !reflect.DeepEqual(approval.Data.NextTask.AssigneeUsers, []string{ids[2]}) {
		t.Fatalf("共同候选 HTTP 审核流转: %d %s", approved.Code, approved.Body.String())
	}
	if response := request(http.MethodPost, approvalPath, `{"decision":"approve","idempotency_key":"approve"}`, 0, false); response.Code != http.StatusConflict {
		t.Fatalf("他人 HTTP 冒领幂等键: %d %s", response.Code, response.Body.String())
	}
	if response := request(http.MethodPost, approvalPath, `{"decision":"approve","idempotency_key":"approve"}`, 1, false); response.Code != http.StatusOK {
		t.Fatalf("本人 HTTP 重试: %d %s", response.Code, response.Body.String())
	}
	instanceResponse := request(http.MethodGet, "/api/v1/admin/workflow-instances/"+started.Data.InstanceID, "", 0, true)
	var instance struct {
		Data workflow.Instance `json:"data"`
	}
	if instanceResponse.Code != http.StatusOK || json.Unmarshal(instanceResponse.Body.Bytes(), &instance) != nil || len(instance.Data.UserNames) != 3 || instance.Data.Tasks[0].HandledBy != ids[1] || instance.Data.Tasks[1].HandledBy != ids[1] {
		t.Fatalf("实例候选名称和实际完成人: %d %s", instanceResponse.Code, instanceResponse.Body.String())
	}
}
