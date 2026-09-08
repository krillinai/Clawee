package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type failingAuditStore struct{ *dataaccess.MemoryStore }

func (s *failingAuditStore) RecordAudit(context.Context, dataaccess.Audit) error {
	return errors.New("audit unavailable")
}

func TestSummarizeDataResourceGrantsUsesGrantDimensions(t *testing.T) {
	now := time.Date(2026, 8, 7, 10, 30, 0, 0, time.UTC)
	grants := []dataaccess.Grant{
		{GrantID: "drg_1", UserID: "usr_1", ResourceType: dataaccess.ResourceSharedSpace, ResourceID: "space_1", Action: dataaccess.ActionRead, UpdatedAt: now},
		{GrantID: "drg_2", UserID: "usr_1", ResourceType: dataaccess.ResourceSharedSpace, ResourceID: "space_1", Action: dataaccess.ActionWrite, UpdatedAt: now},
		{GrantID: "drg_3", UserID: "usr_2", ResourceType: dataaccess.ResourceSharedSpace, ResourceID: "space_2", Action: dataaccess.ActionRead, UpdatedAt: now.Add(-time.Hour)},
	}

	resourceNames := map[string]map[string]string{
		dataaccess.ResourceSharedSpace: {"space_1": "市场资料库", "space_2": "财务共享盘"},
		dataaccess.ResourceDataView: {
			dataaccess.ViewAgentActivity:        "Agent 动态",
			dataaccess.ViewXiaohongshuOperation: "小红书运营",
			dataaccess.ViewDouyinAds:            "抖音投放",
			dataaccess.ViewBilibiliOperation:    "哔哩哔哩运营",
		},
	}
	types := summarizeDataResourceTypes(grants, resourceNames)
	if len(types) != 4 || types[0].ResourceType != dataaccess.ResourceSharedSpace || types[0].ResourceCount != 2 || types[0].ActionCount != 2 || types[0].UserCount != 2 {
		t.Fatalf("resource types = %#v", types)
	}
	if types[3].ResourceType != dataaccess.ResourceDataView || types[3].ResourceCount != 4 || types[3].ActionCount != 3 || types[3].UserCount != 0 {
		t.Fatalf("data view type = %#v", types[3])
	}
	resources := summarizeDataResources(dataaccess.ResourceSharedSpace, grants, resourceNames[dataaccess.ResourceSharedSpace], "市场")
	if len(resources) != 1 || resources[0].ResourceID != "space_1" || resources[0].Name != "市场资料库" || len(resources[0].Actions) != 2 || resources[0].UserCount != 1 {
		t.Fatalf("resources = %#v", resources)
	}
	dataViews := summarizeDataResources(dataaccess.ResourceDataView, nil, resourceNames[dataaccess.ResourceDataView], "")
	if len(dataViews) != 4 || dataViews[0].ResourceID != dataaccess.ViewAgentActivity || dataViews[0].Name != "Agent 动态" || len(dataViews[0].Actions) != 0 || dataViews[0].UserCount != 0 || dataViews[0].UpdatedAt != nil {
		t.Fatalf("data views = %#v", dataViews)
	}
	actions := summarizeDataResourceActions(dataaccess.ResourceSharedSpace, "space_1", grants[:2])
	if len(actions) != 2 || actions[0].Action != dataaccess.ActionRead || actions[1].Action != dataaccess.ActionWrite {
		t.Fatalf("actions = %#v", actions)
	}
	dataViewActions := summarizeDataResourceActions(dataaccess.ResourceDataView, dataaccess.ViewBilibiliOperation, nil)
	if len(dataViewActions) != 3 || dataViewActions[0].Action != dataaccess.ActionRead || dataViewActions[1].Action != dataaccess.ActionConnect || dataViewActions[2].Action != dataaccess.ActionManage {
		t.Fatalf("data view actions = %#v", dataViewActions)
	}
	users := dataResourceGrantUsers(grants[:1], []accounts.Account{{UserID: "usr_1", Name: "张三", Email: "zhang@example.com", Status: accounts.StatusActive}}, "张")
	if len(users) != 1 || users[0].GrantID != "drg_1" || users[0].Name != "张三" {
		t.Fatalf("users = %#v", users)
	}
	accountItems := []accounts.Account{
		{UserID: "usr_1", Name: "张三", Email: "zhang@example.com", Status: accounts.StatusActive},
		{UserID: "usr_3", Name: "李四", Email: "li@example.com", Status: accounts.StatusActive},
		{UserID: "usr_4", Name: "停用账户", Email: "disabled@example.com", Status: accounts.StatusDisabled},
	}
	members := dataResourceGrantMembers(grants[:2], accountItems, "")
	if len(members) != 1 || members[0].UserID != "usr_1" || len(members[0].Actions) != 2 {
		t.Fatalf("members = %#v", members)
	}
	candidates := dataResourceGrantMemberCandidates(grants[:2], accountItems, "")
	if len(candidates) != 1 || candidates[0].UserID != "usr_3" {
		t.Fatalf("candidates = %#v", candidates)
	}
}

func TestDataResourceGrantResourceSearchIncludesUnassignedDataView(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/data-resource-grants/resources/search", strings.NewReader(`{"resource_type":"data_view"}`))
	c.Request.Header.Set("Content-Type", "application/json")

	handleDataResourceGrantResources(Options{
		DataAccessService: dataaccess.NewService(dataaccess.NewMemoryStore()),
	})(c)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"resource_type":"data_view"`) || !strings.Contains(body, `"resource_id":"bilibili_operation"`) || !strings.Contains(body, `"name":"哔哩哔哩运营"`) || !strings.Contains(body, `"action":"connect"`) || !strings.Contains(body, `"name":"连接与同步账号"`) {
		t.Fatalf("body=%s", body)
	}
	if strings.Contains(body, `"updated_at"`) {
		t.Fatalf("unassigned data view should not have updated_at: %s", body)
	}
}

func TestDataResourceGrantMutationRequiresManagePermissionAndAuditsJWTActor(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	bootstrap, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "bootstrap@example.com", Name: "Bootstrap", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	reader, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "reader@example.com", Name: "Reader", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	manager, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "manager@example.com", Name: "Manager", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	target, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "target@example.com", Name: "Target", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := rbacService.BootstrapAdmin(ctx, bootstrap.Account.UserID); err != nil {
		t.Fatal(err)
	}
	readRole, err := rbacService.CreateRole(ctx, bootstrap.Account.UserID, rbac.CreateRoleInput{Code: "grant_reader", Name: "Grant Reader", Permissions: []string{rbac.PermissionDataResourceGrantRead}})
	if err != nil {
		t.Fatal(err)
	}
	manageRole, err := rbacService.CreateRole(ctx, bootstrap.Account.UserID, rbac.CreateRoleInput{Code: "grant_manager", Name: "Grant Manager", Permissions: []string{rbac.PermissionDataResourceGrantManage}})
	if err != nil {
		t.Fatal(err)
	}
	if err := rbacService.AssignAccountRole(ctx, bootstrap.Account.UserID, reader.Account.UserID, readRole.RoleID); err != nil {
		t.Fatal(err)
	}
	if err := rbacService.AssignAccountRole(ctx, bootstrap.Account.UserID, manager.Account.UserID, manageRole.RoleID); err != nil {
		t.Fatal(err)
	}
	grantStore := dataaccess.NewMemoryStore()
	router := NewRouter(Options{AccountService: accountService, RBACService: rbacService, DataAccessService: dataaccess.NewService(grantStore)})
	adminToken := func(account accounts.Account) string {
		batch, err := accountService.IssueTokens(ctx, account, []accounts.TokenRequest{{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb}})
		if err != nil {
			t.Fatal(err)
		}
		return batch.Token(accounts.AudienceAdmin).Token
	}
	body := `{"user_id":"` + target.Account.UserID + `","resource_type":"data_view","resource_id":"agent_activity","actions":["read"],"created_by":"spoofed"}`
	request := func(method, path, token string, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: defaultAdminSessionCookieName, Value: token})
		req.Header.Set(requestIDHeader, "req_grant_mutation")
		router.ServeHTTP(recorder, req)
		return recorder
	}
	if recorder := request(http.MethodPost, "/api/v1/admin/data-resource-grants", adminToken(reader.Account), body); recorder.Code != http.StatusForbidden {
		t.Fatalf("reader write status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	managerToken := adminToken(manager.Account)
	if recorder := request(http.MethodPost, "/api/v1/admin/data-resource-grants", managerToken, body); recorder.Code != http.StatusCreated {
		t.Fatalf("manager create status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	searchBody := `{"resource_type":"data_view","resource_id":"agent_activity","page":1,"page_size":20}`
	if recorder := request(http.MethodPost, "/api/v1/admin/data-resource-grants/members/search", managerToken, searchBody); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), target.Account.UserID) || !strings.Contains(recorder.Body.String(), `"actions":["read"]`) {
		t.Fatalf("members status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodPost, "/api/v1/admin/data-resource-grants/member-candidates/search", managerToken, searchBody); recorder.Code != http.StatusOK || strings.Contains(recorder.Body.String(), target.Account.UserID) {
		t.Fatalf("candidates status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodPost, "/api/v1/admin/data-resource-grants", managerToken, body); recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"grant_conflict"`) {
		t.Fatalf("duplicate status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	audits := grantStore.Audits()
	if len(audits) < 1 || audits[0].OperatorID != manager.Account.UserID || audits[0].OperatorID == "spoofed" || audits[0].RequestID != "req_grant_mutation" {
		t.Fatalf("audits=%#v", audits)
	}
	removeBody := `{"user_id":"` + target.Account.UserID + `","resource_type":"data_view","resource_id":"agent_activity"}`
	if recorder := request(http.MethodPost, "/api/v1/admin/data-resource-grants/remove", managerToken, removeBody); recorder.Code != http.StatusNoContent {
		t.Fatalf("remove status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodPost, "/api/v1/admin/data-resource-grants/member-candidates/search", managerToken, searchBody); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), target.Account.UserID) {
		t.Fatalf("candidates after remove status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDataResourceGrantSearchRejectsURLParameters(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPost, "/data-resource-grants/resources/search?resource_type=shared_space", strings.NewReader(`{"resource_type":"shared_space"}`))
	context.Request.Header.Set("Content-Type", "application/json")

	var request dataResourceGrantSearchRequest
	if bindDataResourceGrantSearch(context, &request) {
		t.Fatal("bindDataResourceGrantSearch() = true, want false")
	}
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestDataResourceGrantFailureAuditErrorReturnsInternalServerError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/admin/data-resource-grants", nil)
	service := dataaccess.NewService(&failingAuditStore{MemoryStore: dataaccess.NewMemoryStore()})
	input := dataaccess.SetInput{UserID: "usr_1", ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewAgentActivity, CreatedBy: "usr_admin"}
	if recordDataResourceGrantFailure(c, Options{DataAccessService: service}, input) {
		t.Fatal("recordDataResourceGrantFailure() = true, want false")
	}
	if recorder.Code != http.StatusInternalServerError || !strings.Contains(recorder.Body.String(), `"code":"data_resource_grant_failed"`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
