package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestDataResourceRoleGrantHTTP(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	admin, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "admin@example.com", Name: "管理员", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	member, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "member@example.com", Name: "成员", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := rbacService.BootstrapAdmin(ctx, admin.Account.UserID); err != nil {
		t.Fatal(err)
	}
	role, err := rbacService.CreateRole(ctx, admin.Account.UserID, rbac.CreateRoleInput{Code: "reviewers", Name: "审核角色"})
	if err != nil {
		t.Fatal(err)
	}
	skillService := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore()})
	space, err := skillService.CreateSpace(ctx, "技能空间", "", admin.Account.UserID)
	if err != nil {
		t.Fatal(err)
	}
	grantStore := dataaccess.NewMemoryStore()
	router := NewRouter(Options{AccountService: accountService, RBACService: rbacService,
		DataAccessService: dataaccess.NewService(grantStore), SkillHubService: skillService})
	issueToken := func(account accounts.Account) string {
		batch, err := accountService.IssueTokens(ctx, account, []accounts.TokenRequest{{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb}})
		if err != nil {
			t.Fatal(err)
		}
		return batch.Token(accounts.AudienceAdmin).Token
	}
	adminToken, memberToken := issueToken(admin.Account), issueToken(member.Account)
	request := func(method, path, token string, body any) *httptest.ResponseRecorder {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/api/v1/admin/data-resource-grants"+path, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(requestIDHeader, "role-grant-request")
		req.AddCookie(&http.Cookie{Name: defaultAdminSessionCookieName, Value: token})
		router.ServeHTTP(recorder, req)
		return recorder
	}
	input := dataResourceGrantMutationRequest{RoleID: role.RoleID, ResourceType: "skill_space", ResourceID: space.SpaceID, Actions: []string{"read", "write"}}
	for _, path := range []string{"", "/remove", "/roles/search", "/role-members/search", "/role-candidates/search"} {
		if response := request(http.MethodPost, path, memberToken, input); response.Code != http.StatusForbidden {
			t.Fatalf("non-admin %s status=%d", path, response.Code)
		}
	}
	for _, test := range []struct {
		name  string
		input dataResourceGrantMutationRequest
		want  int
	}{
		{name: "无主体", input: dataResourceGrantMutationRequest{ResourceType: "skill_space", ResourceID: space.SpaceID, Actions: []string{"read"}}, want: http.StatusBadRequest},
		{name: "双主体", input: dataResourceGrantMutationRequest{UserID: member.Account.UserID, RoleID: role.RoleID, ResourceType: "skill_space", ResourceID: space.SpaceID, Actions: []string{"read"}}, want: http.StatusBadRequest},
		{name: "未知角色", input: dataResourceGrantMutationRequest{RoleID: "missing", ResourceType: "skill_space", ResourceID: space.SpaceID, Actions: []string{"read"}}, want: http.StatusNotFound},
		{name: "未知空间", input: dataResourceGrantMutationRequest{RoleID: role.RoleID, ResourceType: "skill_space", ResourceID: "missing", Actions: []string{"read"}}, want: http.StatusNotFound},
		{name: "非技能空间", input: dataResourceGrantMutationRequest{RoleID: role.RoleID, ResourceType: "shared_space", ResourceID: space.SpaceID, Actions: []string{"read"}}, want: http.StatusBadRequest},
		{name: "非法动作", input: dataResourceGrantMutationRequest{RoleID: role.RoleID, ResourceType: "skill_space", ResourceID: space.SpaceID, Actions: []string{"upload"}}, want: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			if response := request(http.MethodPost, "", adminToken, test.input); response.Code != test.want {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if response := request(http.MethodPost, "", adminToken, input); response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"role_id":"`+role.RoleID+`"`) || !strings.Contains(response.Body.String(), `"user_id":""`) {
		t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
	}
	if response := request(http.MethodPost, "", adminToken, input); response.Code != http.StatusConflict {
		t.Fatalf("duplicate status=%d", response.Code)
	}
	search := dataResourceGrantSearchRequest{ResourceType: "skill_space", ResourceID: space.SpaceID, Query: "审核", Page: 1, PageSize: 1}
	for _, path := range []string{"/role-members/search", "/roles/search", "/role-candidates/search", "/members/search"} {
		search.Action = ""
		if path == "/roles/search" {
			search.Action = "read"
		}
		response := request(http.MethodPost, path, adminToken, search)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, response.Code, response.Body.String())
		}
		var body struct {
			Data []dataResourceGrantRoleResponse `json:"data"`
			Meta struct {
				Page, Total int
				PageSize    int `json:"page_size"`
			} `json:"meta"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if path == "/role-candidates/search" || path == "/members/search" {
			if len(body.Data) != 0 || body.Meta.Total != 0 {
				t.Fatalf("%s inherited grants leaked into candidates/accounts: %s", path, response.Body.String())
			}
			continue
		}
		wantActions := 2
		if path == "/roles/search" {
			wantActions = 1
		}
		if len(body.Data) != 1 || body.Data[0].RoleID != role.RoleID || body.Data[0].Name != role.Name || !body.Data[0].Granted || len(body.Data[0].Actions) != wantActions || body.Data[0].UpdatedAt == nil || body.Meta.Total != 1 || body.Meta.PageSize != 1 {
			t.Fatalf("%s body=%s", path, response.Body.String())
		}
	}
	for _, path := range []string{"/roles/search", "/role-members/search", "/role-candidates/search"} {
		search.Action = ""
		if response := request(http.MethodPost, path+"?page=1", adminToken, search); response.Code != http.StatusBadRequest {
			t.Fatalf("URL parameters %s status=%d", path, response.Code)
		}
		search.ResourceType = "shared_space"
		if response := request(http.MethodPost, path, adminToken, search); response.Code != http.StatusBadRequest {
			t.Fatalf("non-skill search %s status=%d", path, response.Code)
		}
		search.ResourceType = "skill_space"
	}
	input.Actions = []string{"read"}
	if response := request(http.MethodPut, "", adminToken, input); response.Code != http.StatusOK {
		t.Fatalf("replace status=%d body=%s", response.Code, response.Body.String())
	}
	if response := request(http.MethodPost, "/remove", adminToken, input); response.Code != http.StatusBadRequest {
		t.Fatalf("remove with actions status=%d", response.Code)
	}
	input.Actions = nil
	removeBody := map[string]string{"role_id": input.RoleID, "resource_type": input.ResourceType, "resource_id": input.ResourceID}
	if response := request(http.MethodPost, "/remove", adminToken, removeBody); response.Code != http.StatusNoContent {
		t.Fatalf("remove status=%d body=%s", response.Code, response.Body.String())
	}
	search.Action = ""
	response := request(http.MethodPost, "/role-candidates/search", adminToken, search)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"role_id":"`+role.RoleID+`"`) || !strings.Contains(response.Body.String(), `"actions":[]`) || !strings.Contains(response.Body.String(), `"granted":false`) {
		t.Fatalf("candidates status=%d body=%s", response.Code, response.Body.String())
	}
	audits := grantStore.Audits()
	last := audits[len(audits)-1]
	if last.OperatorID != admin.Account.UserID || last.TargetRoleID != role.RoleID || last.TargetUserID != "" || last.RequestID != "role-grant-request" || len(last.BeforeActions) != 1 || len(last.AfterActions) != 0 {
		t.Fatalf("remove audit=%#v", last)
	}
}
