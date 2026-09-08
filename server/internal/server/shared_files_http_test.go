package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

func TestSharedFileCallerRequiresBearerBoundClaweeAgent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name      string
		bearer    bool
		principal accounts.Principal
		agent     bool
		want      int
	}{
		{name: "web cookie identity", principal: accounts.Principal{ClientID: accounts.ClientWeb}, want: http.StatusForbidden},
		{name: "clawee without bearer", principal: accounts.Principal{ClientID: accounts.ClientClaweeAgent, AgentID: "agent_1"}, agent: true, want: http.StatusForbidden},
		{name: "clawee without bound agent", bearer: true, principal: accounts.Principal{ClientID: accounts.ClientClaweeAgent, AgentID: "agent_1"}, want: http.StatusForbidden},
		{name: "bound clawee bearer", bearer: true, principal: accounts.Principal{ClientID: accounts.ClientClaweeAgent, AgentID: "agent_1"}, agent: true, want: http.StatusNoContent},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := gin.New()
			router.Use(func(c *gin.Context) {
				c.Set(principalContextKey, test.principal)
				if test.agent {
					c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: "agent_1"})
				}
				c.Next()
			})
			router.GET("/file", requireClaweeFileCaller(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
			req := httptest.NewRequest(http.MethodGet, "/file", nil)
			if test.bearer {
				req.Header.Set("Authorization", "Bearer token")
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)
			if recorder.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.want, recorder.Body.String())
			}
		})
	}
}

func TestClaweeAgentBindingRejectsOwnerMismatchAsAgentForbidden(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	if err := accountStore.SaveAccount(ctx, accounts.Account{UserID: "owner", Email: "owner@example.com", Status: accounts.StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := accountStore.SaveActiveAccountAgent(ctx, accounts.AccountAgent{UserID: "owner", AgentID: "agent_1"}); err != nil {
		t.Fatal(err)
	}
	accountService := accounts.NewService(accounts.Config{Store: accountStore})
	proxyGateway := mcpgateway.NewService(mcpgateway.Config{Store: mcpgateway.NewMemoryStore()})
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{UserID: "other", AgentID: "agent_1", ClientID: accounts.ClientClaweeAgent})
		c.Next()
	})
	router.GET("/api/v1/app/file", requireClaweeAgentBinding(accountService, proxyGateway), func(c *gin.Context) { c.Status(http.StatusNoContent) })

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/app/file", nil))
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"agent_forbidden"`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSharedFileHTTPUploadDownloadContract(t *testing.T) {
	service, spaceID := newSharedFileHTTPService(t)
	router := sharedFileHandlerRouter(service)
	contents := "共享内容"
	digest := sharedFileDigest(contents)
	uploadPath := "/content?space_id=" + url.QueryEscape(spaceID) + "&logical_path=" + url.QueryEscape("docs/design.md")
	recorder := sharedFileRequest(router, http.MethodPost, uploadPath, strings.NewReader(contents), int64(len(contents)), digest)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Data sharedfiles.UploadResult `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data.FileID == "" || response.Data.Revision != 1 || !response.Data.Created {
		t.Fatalf("upload response = %#v", response.Data)
	}

	recorder = sharedFileRequest(router, http.MethodGet, "/content?file_id="+url.QueryEscape(response.Data.FileID), nil, 0, "")
	if recorder.Code != http.StatusOK || recorder.Body.String() != contents {
		t.Fatalf("download status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	for name, want := range map[string]string{
		"Content-Type":     "text/plain",
		"Content-Length":   "12",
		"ETag":             `"sha256:` + digest + `"`,
		"X-Shared-File-ID": response.Data.FileID,
		"X-File-Revision":  "1",
		"X-Content-SHA256": digest,
	} {
		if got := recorder.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if disposition := recorder.Header().Get("Content-Disposition"); !strings.HasPrefix(disposition, "attachment;") || !strings.Contains(disposition, "design.md") {
		t.Errorf("Content-Disposition = %q", disposition)
	}
}

func TestSharedFileHTTPRejectsShortRequestBody(t *testing.T) {
	service, spaceID := newSharedFileHTTPService(t)
	router := sharedFileHandlerRouter(service)
	body := io.MultiReader(strings.NewReader("short"), httpUnexpectedEOFReader{})
	path := "/content?space_id=" + url.QueryEscape(spaceID) + "&logical_path=short.txt"
	recorder := sharedFileRequest(router, http.MethodPost, path, body, 7, sharedFileDigest("shortxx"))
	if recorder.Code != http.StatusUnprocessableEntity || !strings.Contains(recorder.Body.String(), `"code":"content_length_mismatch"`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSharedFileHTTPRejectsMissingAndOversizedContentLength(t *testing.T) {
	service, spaceID := newSharedFileHTTPService(t)
	router := sharedFileHandlerRouter(service)
	path := "/content?space_id=" + url.QueryEscape(spaceID) + "&logical_path=file.txt"
	missing := sharedFileRequest(router, http.MethodPost, path, strings.NewReader("content"), -1, sharedFileDigest("content"))
	if missing.Code != http.StatusLengthRequired || !strings.Contains(missing.Body.String(), `"code":"length_required"`) {
		t.Fatalf("missing length status=%d body=%s", missing.Code, missing.Body.String())
	}
	oversized := sharedFileRequest(router, http.MethodPost, path, strings.NewReader(""), sharedfiles.MaxFileSizeBytes+1, sharedFileDigest(""))
	if oversized.Code != http.StatusRequestEntityTooLarge || !strings.Contains(oversized.Body.String(), `"code":"file_too_large"`) {
		t.Fatalf("oversized status=%d body=%s", oversized.Code, oversized.Body.String())
	}
}

func TestSharedFileStableErrorMapping(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{sharedfiles.ErrInvalidRequest, 400, "invalid_request"},
		{sharedfiles.ErrInvalidLogicalPath, 400, "invalid_logical_path"},
		{sharedfiles.ErrInvalidDigest, 400, "invalid_digest"},
		{sharedfiles.ErrInvalidCursor, 400, "invalid_cursor"},
		{sharedfiles.ErrSharedSpaceNotFound, 404, "shared_space_not_found"},
		{sharedfiles.ErrSharedFileNotFound, 404, "shared_file_not_found"},
		{sharedfiles.ErrMemberNotFound, 404, "member_not_found"},
		{sharedfiles.ErrSpaceNameConflict, 409, "space_name_conflict"},
		{sharedfiles.ErrMemberAlreadyExists, 409, "member_already_exists"},
		{sharedfiles.ErrFileAlreadyExists, 409, "file_already_exists"},
		{&sharedfiles.RevisionConflictError{CurrentRevision: 3}, 409, "revision_conflict"},
		{sharedfiles.ErrFileTooLarge, 413, "file_too_large"},
		{sharedfiles.ErrContentLengthMismatch, 422, "content_length_mismatch"},
		{sharedfiles.ErrDigestMismatch, 422, "digest_mismatch"},
		{sharedfiles.ErrStorageUnavailable, 500, "storage_unavailable"},
		{errors.New("unknown"), 500, "internal_error"},
	}
	for _, test := range tests {
		t.Run(test.code, func(t *testing.T) {
			router := gin.New()
			router.GET("/error", func(c *gin.Context) { writeSharedFileError(c, test.err) })
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/error", nil))
			if recorder.Code != test.status || !strings.Contains(recorder.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestSharedFileAdminRoutesEnforceReadAndManagePermissions(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore()})
	reader, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "reader@example.com", Name: "只读", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	manager, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "manager@example.com", Name: "管理", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "full.member@example.com", Name: "候选成员", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	readRole, err := rbacService.CreateRole(ctx, "admin", rbac.CreateRoleInput{Code: "shared_reader", Name: "网盘查看", Permissions: []string{rbac.PermissionSharedFilesRead}})
	if err != nil {
		t.Fatal(err)
	}
	manageRole, err := rbacService.CreateRole(ctx, "admin", rbac.CreateRoleInput{Code: "shared_manager", Name: "网盘管理", Permissions: []string{rbac.PermissionSharedFilesManage}})
	if err != nil {
		t.Fatal(err)
	}
	if err := rbacService.AssignAccountRole(ctx, "admin", reader.Account.UserID, readRole.RoleID); err != nil {
		t.Fatal(err)
	}
	if err := rbacService.AssignAccountRole(ctx, "admin", manager.Account.UserID, manageRole.RoleID); err != nil {
		t.Fatal(err)
	}
	storage, err := sharedfiles.NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sharedStore := sharedfiles.NewMemoryStore()
	sharedStore.SetAccount(candidate.Account.UserID, candidate.Account.Name, candidate.Account.Email, candidate.Account.Status)
	service := sharedfiles.NewService(sharedStore, storage, nil)
	space, err := service.CreateSpace(ctx, "后台文件空间", "", manager.Account.UserID)
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.UploadAdmin(ctx, manager.Account.UserID, space.SpaceID, "docs/admin.txt", "text/plain", 5, nil, strings.NewReader("first"))
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(func(c *gin.Context) {
		switch c.GetHeader("X-Test-User") {
		case "reader":
			c.Set(accountContextKey, reader.Account)
		case "manager":
			c.Set(accountContextKey, manager.Account)
		}
		c.Next()
	})
	mountSharedFileRoutes(router.Group("/app"), router.Group("/admin"), Options{SharedFilesService: service, AccountService: accountService, RBACService: rbacService})

	request := func(method, path, user, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if user != "" {
			req.Header.Set("X-Test-User", user)
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}
	if recorder := request(http.MethodGet, "/admin/shared-spaces", "", ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodGet, "/admin/shared-spaces", "reader", ""); recorder.Code != http.StatusOK {
		t.Fatalf("reader list status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodPost, "/admin/shared-spaces", "reader", `{"name":"只读不可创建","description":""}`); recorder.Code != http.StatusForbidden {
		t.Fatalf("reader create status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodPost, "/admin/shared-spaces", "manager", `{"name":"管理创建","description":""}`); recorder.Code != http.StatusCreated {
		t.Fatalf("manager create status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	listPath := "/admin/shared-files?space_id=" + url.QueryEscape(space.SpaceID)
	if recorder := request(http.MethodGet, listPath, "reader", ""); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), created.FileID) || !strings.Contains(recorder.Body.String(), `"updated_by_user_name":"管理"`) {
		t.Fatalf("reader file list status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	downloadPath := "/admin/shared-files/content?file_id=" + url.QueryEscape(created.FileID)
	if recorder := request(http.MethodGet, downloadPath, "reader", ""); recorder.Code != http.StatusForbidden {
		t.Fatalf("reader download status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodGet, downloadPath, "manager", ""); recorder.Code != http.StatusOK || recorder.Body.String() != "first" {
		t.Fatalf("manager download status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	uploadPath := "/admin/shared-files/content?space_id=" + url.QueryEscape(space.SpaceID) + "&logical_path=docs%2Fsecond.txt"
	if recorder := request(http.MethodPost, uploadPath, "reader", "second"); recorder.Code != http.StatusForbidden {
		t.Fatalf("reader upload status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodPost, uploadPath, "manager", "second"); recorder.Code != http.StatusCreated || !strings.Contains(recorder.Body.String(), `"created":true`) {
		t.Fatalf("manager upload status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	candidatePath := "/admin/shared-spaces/member-candidates?space_id=" + url.QueryEscape(space.SpaceID) + "&query=full.member%40example.com"
	if recorder := request(http.MethodGet, candidatePath, "reader", ""); recorder.Code != http.StatusForbidden {
		t.Fatalf("reader candidates status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodGet, candidatePath, "manager", ""); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"email":"full.member@example.com"`) || strings.Contains(recorder.Body.String(), "***") {
		t.Fatalf("manager candidates status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	grantBody := `{"space_id":"` + space.SpaceID + `","user_id":"` + candidate.Account.UserID + `","actions":["read"]}`
	if recorder := request(http.MethodPost, "/admin/shared-spaces/account-grants", "manager", grantBody); recorder.Code != http.StatusCreated || !strings.Contains(recorder.Body.String(), `"actions":["read"]`) {
		t.Fatalf("create member status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	membersPath := "/admin/shared-spaces/account-grants?space_id=" + url.QueryEscape(space.SpaceID) + "&query=full.member%40example.com"
	if recorder := request(http.MethodGet, membersPath, "reader", ""); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"email":"full.member@example.com"`) {
		t.Fatalf("reader members status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	updateBody := `{"space_id":"` + space.SpaceID + `","user_id":"` + candidate.Account.UserID + `","actions":["read","write"]}`
	if recorder := request(http.MethodPatch, "/admin/shared-spaces/account-grants", "reader", updateBody); recorder.Code != http.StatusForbidden {
		t.Fatalf("reader update member status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodPatch, "/admin/shared-spaces/account-grants", "manager", updateBody); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"actions":["read","write"]`) {
		t.Fatalf("manager update member status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	invalidBody := `{"space_id":"` + space.SpaceID + `","user_id":"` + candidate.Account.UserID + `","actions":["write"]}`
	if recorder := request(http.MethodPatch, "/admin/shared-spaces/account-grants", "manager", invalidBody); recorder.Code != http.StatusBadRequest {
		t.Fatalf("update without read status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func newSharedFileHTTPService(t *testing.T) (*sharedfiles.Service, string) {
	t.Helper()
	ctx := context.Background()
	store := sharedfiles.NewMemoryStore()
	store.SetAccount("user_1", "员工", "user@example.com", "active")
	storage, err := sharedfiles.NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := sharedfiles.NewService(store, storage, nil)
	space, err := service.CreateSpace(ctx, "项目空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddMember(ctx, space.SpaceID, "user_1", "admin"); err != nil {
		t.Fatal(err)
	}
	return service, space.SpaceID
}

func sharedFileHandlerRouter(service *sharedfiles.Service) http.Handler {
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(accountContextKey, accounts.Account{UserID: "user_1"})
		c.Set(principalContextKey, accounts.Principal{AgentID: "agent_1"})
		c.Next()
	})
	router.POST("/content", handleAppSharedFileUpload(service))
	router.GET("/content", handleAppSharedFileDownload(service))
	return router
}

func sharedFileRequest(handler http.Handler, method, path string, body io.Reader, contentLength int64, digest string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, body)
	request.ContentLength = contentLength
	if method == http.MethodPost {
		request.Header.Set("Content-Type", "text/plain")
		request.Header.Set("X-Content-SHA256", digest)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func sharedFileDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

type httpUnexpectedEOFReader struct{}

func (httpUnexpectedEOFReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
