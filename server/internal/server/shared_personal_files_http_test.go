package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

func TestAppSharedFileDefaultAndManagedCrossUserUpload(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore()})
	register := func(email string) accounts.Account {
		t.Helper()
		result, err := accountService.Register(ctx, accounts.RegisterRequest{Email: email, Name: email, Password: "passw0rd!"})
		if err != nil {
			t.Fatal(err)
		}
		return result.Account
	}
	operator := register("server@test.local")
	employee := register("employee@test.local")
	permissions := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	store := sharedfiles.NewMemoryStore()
	for _, account := range []accounts.Account{operator, employee} {
		store.SetAccount(account.UserID, account.Name, account.Email, "active")
	}
	storage, err := sharedfiles.NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := sharedfiles.NewService(store, storage, nil)
	current := operator
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(accountContextKey, current)
		c.Set(principalContextKey, accounts.Principal{AgentID: "agent_server"})
		c.Next()
	})
	router.POST("/content", handleAppSharedFileUpload(service, permissions))
	router.GET("/content", handleAppSharedFileDownload(service))
	payload := "report"
	digest := sharedFileDigest(payload)
	target := "/content?logical_path=tasks/run/report.txt&for_user_id=" + url.QueryEscape(employee.UserID)
	request := func(path string) *sharedfiles.UploadResult {
		t.Helper()
		response := sharedFileRequest(router, http.MethodPost, path, strings.NewReader(payload), 6, digest)
		if response.Code != http.StatusCreated && response.Code != http.StatusOK {
			t.Fatalf("upload=%d %s", response.Code, response.Body.String())
		}
		var body struct {
			Data sharedfiles.UploadResult `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return &body.Data
	}
	denied := sharedFileRequest(router, http.MethodPost, target, strings.NewReader(payload), 6, digest)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("unprivileged for_user_id=%d %s", denied.Code, denied.Body.String())
	}
	if page, err := service.ListAdminSpaces(ctx, "", 10, ""); err != nil || len(page.Items) != 0 {
		t.Fatal("拒绝请求不应创建空间")
	}
	role, err := permissions.CreateRole(ctx, operator.UserID, rbac.CreateRoleInput{Code: "file_uploader", Name: "网盘上传", Permissions: []string{rbac.PermissionSharedFilesUpload}})
	if err != nil {
		t.Fatal(err)
	}
	if err := permissions.AssignAccountRole(ctx, operator.UserID, operator.UserID, role.RoleID); err != nil {
		t.Fatal(err)
	}
	result := request(target)
	space, err := service.GetSpaceSummary(ctx, result.SpaceID)
	if err != nil || space.PersonalOwnerUserID != employee.UserID {
		t.Fatalf("wrong owner=%#v %v", space, err)
	}
	file, err := service.GetAdminFile(ctx, result.FileID)
	if err != nil || file.CreatedByUserID != operator.UserID || file.CreatedByAgentID != "agent_server" {
		t.Fatalf("actor=%#v %v", file, err)
	}
	denied = sharedFileRequest(router, http.MethodGet, "/content?file_id="+result.FileID, nil, 0, "")
	if denied.Code != http.StatusNotFound {
		t.Fatalf("cross read=%d", denied.Code)
	}
	personal := request("/content?logical_path=tasks/own/report.txt")
	if personal.SpaceID == result.SpaceID {
		t.Fatal("operator default unexpectedly uses employee space")
	}
	denied = sharedFileRequest(router, http.MethodPost, target+"&space_id="+personal.SpaceID, strings.NewReader(payload), 6, digest)
	if denied.Code != http.StatusNotFound {
		t.Fatalf("cross arbitrary space=%d", denied.Code)
	}
	current = employee
	downloaded := sharedFileRequest(router, http.MethodGet, "/content?file_id="+result.FileID, nil, 0, "")
	if downloaded.Code != http.StatusOK || downloaded.Body.String() != payload {
		t.Fatalf("owner download=%d", downloaded.Code)
	}
}
