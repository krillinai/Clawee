package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/knowledge"
	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestClaweeKnowledgeRoutesUseCurrentAccountGrants(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := newClaweeOwnedAgentStore(accountService)
	dataAccessService := dataaccess.NewService(dataaccess.NewMemoryStore())
	knowledgeService := knowledge.NewService(knowledge.NewMemoryStore(), successfulKnowledgeHTTPProvider{})
	allowed, err := knowledgeService.CreateKnowledgeBase(ctx, knowledge.CreateKnowledgeBaseInput{Name: "公司制度", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	hidden, err := knowledgeService.CreateKnowledgeBase(ctx, knowledge.CreateKnowledgeBaseInput{Name: "财务资料", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "clawee-owner@example.com", Name: "Claw 所有者", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "clawee-other@example.com", Name: "其他账户", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dataAccessService.Create(ctx, dataaccess.SetInput{
		UserID: owner.Account.UserID, ResourceType: dataaccess.ResourceKnowledgeBase,
		ResourceID: allowed.KnowledgeBaseID, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := dataAccessService.Create(ctx, dataaccess.SetInput{
		UserID: other.Account.UserID, ResourceType: dataaccess.ResourceKnowledgeBase,
		ResourceID: hidden.KnowledgeBaseID, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		AccountService: accountService, ProxyGateway: testProxyGateway(proxyStore),
		KnowledgeService: knowledgeService, DataAccessService: dataAccessService,
	})
	ownerLogin := loginClawee(t, router, owner.Account.Email, "passw0rd!", "clawee-owner-agent")
	if ownerLogin.Status != http.StatusOK {
		t.Fatalf("owner login status = %d code=%s", ownerLogin.Status, ownerLogin.ErrorCode)
	}
	otherLogin := loginClawee(t, router, other.Account.Email, "passw0rd!", "clawee-other-agent")
	if otherLogin.Status != http.StatusOK {
		t.Fatalf("other login status = %d code=%s", otherLogin.Status, otherLogin.ErrorCode)
	}

	request := func(method, path, token string, body *bytes.Buffer, contentType string) *httptest.ResponseRecorder {
		t.Helper()
		var source = strings.NewReader("")
		if body != nil {
			source = strings.NewReader(body.String())
		}
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, source)
		req.Header.Set("Authorization", "Bearer "+token)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}

	recorder := request(http.MethodGet, "/api/v1/app/knowledge-bases", ownerLogin.AccessToken, nil, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), allowed.KnowledgeBaseID) || strings.Contains(recorder.Body.String(), hidden.KnowledgeBaseID) {
		t.Fatalf("owner list status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = request(http.MethodGet, "/api/v1/app/knowledge-bases/documents?knowledge_base_id="+hidden.KnowledgeBaseID, ownerLogin.AccessToken, nil, "")
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), "knowledge_base_not_found") {
		t.Fatalf("hidden documents status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = request(http.MethodGet, "/api/v1/app/knowledge-bases/documents?knowledge_base_id="+allowed.KnowledgeBaseID, otherLogin.AccessToken, nil, "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("cross-account documents status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	body, contentType := knowledgeUploadBody(t, allowed.KnowledgeBaseID, "guide.txt", "hello")
	recorder = request(http.MethodPost, "/api/v1/app/knowledge-bases/documents", ownerLogin.AccessToken, body, contentType)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "document_upload_forbidden") {
		t.Fatalf("read-only upload status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	largeBody, largeContentType := knowledgeUploadBody(t, allowed.KnowledgeBaseID, "large.txt", strings.Repeat("x", 2<<20))
	tracked := &countingReader{reader: bytes.NewReader(largeBody.Bytes())}
	recorder = httptest.NewRecorder()
	largeRequest := httptest.NewRequest(http.MethodPost, "/api/v1/app/knowledge-bases/documents", tracked)
	largeRequest.Header.Set("Authorization", "Bearer "+ownerLogin.AccessToken)
	largeRequest.Header.Set("Content-Type", largeContentType)
	router.ServeHTTP(recorder, largeRequest)
	if recorder.Code != http.StatusForbidden || tracked.read >= largeBody.Len()/2 {
		t.Fatalf("unauthorized upload status=%d bytes_read=%d body_size=%d", recorder.Code, tracked.read, largeBody.Len())
	}
	if _, err := dataAccessService.Replace(ctx, dataaccess.SetInput{
		UserID: owner.Account.UserID, ResourceType: dataaccess.ResourceKnowledgeBase,
		ResourceID: allowed.KnowledgeBaseID, Actions: []string{dataaccess.ActionRead, dataaccess.ActionUpload}, CreatedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}
	body, contentType = knowledgeUploadBody(t, allowed.KnowledgeBaseID, "guide.txt", "hello")
	recorder = request(http.MethodPost, "/api/v1/app/knowledge-bases/documents", ownerLogin.AccessToken, body, contentType)
	if recorder.Code != http.StatusCreated || !strings.Contains(recorder.Body.String(), `"knowledge_base_id":"`+allowed.KnowledgeBaseID+`"`) {
		t.Fatalf("authorized upload status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestKnowledgeAccountGrantAdminLifecycleAndValidation(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	dataAccessService := dataaccess.NewService(dataaccess.NewMemoryStore())
	knowledgeService := knowledge.NewService(knowledge.NewMemoryStore(), successfulKnowledgeHTTPProvider{})
	kb, err := knowledgeService.CreateKnowledgeBase(ctx, knowledge.CreateKnowledgeBaseInput{Name: "公司制度", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		AccountService: accountService, ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()),
		KnowledgeService: knowledgeService, DataAccessService: dataAccessService,
	})
	adminCookies := register(t, router, `{"email":"grant-admin@example.com","name":"数据权限管理员","password":"passw0rd!"}`)
	target, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "knowledge-user@example.com", Name: "知识用户", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "full.member@example.com", Name: "候选知识用户", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}

	call := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(adminCookie(t, adminCookies))
		router.ServeHTTP(recorder, request)
		return recorder
	}
	prefix := `{"user_id":"` + target.Account.UserID + `","knowledge_base_id":"` + kb.KnowledgeBaseID + `","actions":`
	for _, actions := range []string{`["upload"]}`, `["read","unknown"]}`} {
		recorder := call(http.MethodPost, "/api/v1/admin/knowledge-bases/account-grants", prefix+actions)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("invalid actions %s status=%d body=%s", actions, recorder.Code, recorder.Body.String())
		}
	}

	recorder := call(http.MethodPost, "/api/v1/admin/knowledge-bases/account-grants", prefix+`["read"]}`)
	if recorder.Code != http.StatusCreated || !strings.Contains(recorder.Body.String(), `"created_by":"数据权限管理员"`) {
		t.Fatalf("create grant status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = call(http.MethodGet, "/api/v1/admin/knowledge-bases/account-grants?knowledge_base_id="+kb.KnowledgeBaseID, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), target.Account.UserID) {
		t.Fatalf("list grants status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = call(http.MethodGet, "/api/v1/admin/knowledge-bases/members?knowledge_base_id="+kb.KnowledgeBaseID+"&query=knowledge-user%40example.com", "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"email":"knowledge-user@example.com"`) || !strings.Contains(recorder.Body.String(), `"actions":["read"]`) {
		t.Fatalf("list members status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = call(http.MethodGet, "/api/v1/admin/knowledge-bases/member-candidates?knowledge_base_id="+kb.KnowledgeBaseID+"&query=full.member%40example.com", "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"user_id":"`+candidate.Account.UserID+`"`) || !strings.Contains(recorder.Body.String(), `"email":"full.member@example.com"`) || strings.Contains(recorder.Body.String(), "***") {
		t.Fatalf("list candidates status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = call(http.MethodPatch, "/api/v1/admin/knowledge-bases/account-grants", prefix+`["read","upload","mcp"]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("replace grant status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var replaced struct {
		Data []dataaccess.Grant `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &replaced); err != nil {
		t.Fatal(err)
	}
	if len(replaced.Data) != 3 {
		t.Fatalf("replaced grants = %#v", replaced.Data)
	}
	recorder = call(http.MethodPost, "/api/v1/admin/knowledge-bases/remove", `{"knowledge_base_id":"`+kb.KnowledgeBaseID+`"}`)
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "该知识库仍有账户授权") {
		t.Fatalf("delete granted knowledge base status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = call(http.MethodPost, "/api/v1/admin/knowledge-bases/account-grants/remove", `{"user_id":"`+target.Account.UserID+`","knowledge_base_id":"`+kb.KnowledgeBaseID+`"}`)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("remove grant status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	recorder = call(http.MethodGet, "/api/v1/admin/knowledge-bases/account-grants?knowledge_base_id="+kb.KnowledgeBaseID, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"data":[]`) {
		t.Fatalf("empty grants status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func knowledgeUploadBody(t *testing.T, knowledgeBaseID, name, content string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("knowledge_base_id", knowledgeBaseID); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}

type countingReader struct {
	reader *bytes.Reader
	read   int
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.read += n
	return n, err
}

func TestKnowledgeGrantRouteUsesAccountManagedScope(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	proxyStore := mcpgateway.NewMemoryStore()
	if err := proxyStore.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "agent-1", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := mcpgateway.Capability{ID: "cap-knowledge", UpstreamServerID: "knowledge-adapter", Type: mcpgateway.CapabilityTool, UpstreamName: "search", ExposedName: "enterprise.policy.search", Status: mcpgateway.StatusActive}
	if err := proxyStore.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		ProxyGateway: testMCPGatewayService(proxyStore, fakeAdminUpstreamClient{}), AccountService: accountService,
	})
	adminCookies := register(t, router, `{"email":"knowledge-grant-admin@example.com","name":"知识授权管理员","password":"passw0rd!"}`)
	adminLogin, err := accountService.AuthenticateCredentials(ctx, accounts.LoginRequest{Email: "knowledge-grant-admin@example.com", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	adminUserID := adminLogin.UserID

	body := `{"user_id":"` + adminUserID + `","capability_id":"cap-knowledge","grant_type":"tool","data_scope":{"knowledge_base_ids":["kb-1"]}}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/grants", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "managed by account mcp permission") {
		t.Fatalf("scoped grant status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	body = `{"user_id":"` + adminUserID + `","capability_id":"cap-knowledge","grant_type":"prompt"}`
	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/grants", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "knowledge.search requires tool grant") {
		t.Fatalf("non-tool grant status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	body = `{"user_id":"` + adminUserID + `","capability_id":"cap-knowledge","grant_type":"tool","created_by":"伪造用户"}`
	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/v1/admin/mcp/grants", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("unscoped grant status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	response := unwrapAPIDataMap(t, recorder.Body.Bytes())
	grantID, _ := response["id"].(string)
	if !regexp.MustCompile(`^grt_[0-9a-f]{24}$`).MatchString(grantID) {
		t.Fatalf("grant_id = %q, want short opaque ID", grantID)
	}
	if response["data_scope"] != nil {
		t.Fatalf("data_scope = %#v, want nil", response["data_scope"])
	}
	if response["created_by"] != "知识授权管理员" {
		t.Fatalf("response created_by = %q, want 知识授权管理员", response["created_by"])
	}
	grants, err := proxyStore.ListGrants(ctx, mcpgateway.GrantFilter{UserID: adminUserID})
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 1 || grants[0].ID != grantID || grants[0].CreatedBy != "知识授权管理员" || grants[0].DataScope != nil {
		t.Fatalf("stored grants = %#v", grants)
	}
}

func TestKnowledgeBaseCreateStoresCreatorNameSnapshot(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	service := knowledge.NewService(knowledge.NewMemoryStore(), knowledgeHTTPProvider{})
	router := newTestRouter(t, server.Options{
		ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, KnowledgeService: service,
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","name":"知识管理员","password":"passw0rd!"}`)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/knowledge-bases", strings.NewReader(`{"name":"公司制度","description":"内部制度"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(adminCookie(t, adminCookies))
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	created := decodeAPIJSONResource[knowledge.KnowledgeBase](t, recorder.Body.Bytes())
	if created.CreatedBy != "知识管理员" {
		t.Fatalf("created_by=%q, want 知识管理员", created.CreatedBy)
	}
}

func TestKnowledgeUploadReturnsBadGatewayForEmptyProviderMapping(t *testing.T) {
	ctx := context.Background()
	service := knowledge.NewService(knowledge.NewMemoryStore(), knowledgeHTTPProvider{})
	kb, err := service.CreateKnowledgeBase(ctx, knowledge.CreateKnowledgeBaseInput{Name: "公司制度", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{KnowledgeService: service})
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "guide.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("hello"))
	if err := writer.WriteField("knowledge_base_id", kb.KnowledgeBaseID); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/knowledge-bases/documents", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestKnowledgeSyncRejectsQueryOnlyKnowledgeBaseID(t *testing.T) {
	ctx := context.Background()
	service := knowledge.NewService(knowledge.NewMemoryStore(), knowledgeHTTPProvider{})
	kb, err := service.CreateKnowledgeBase(ctx, knowledge.CreateKnowledgeBaseInput{Name: "公司制度", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{KnowledgeService: service})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/knowledge-bases/documents/sync?knowledge_base_id="+kb.KnowledgeBaseID, strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s, want %d", recorder.Code, recorder.Body.String(), http.StatusBadRequest)
	}
}

func TestKnowledgeUploadRejectsQueryOnlyKnowledgeBaseID(t *testing.T) {
	ctx := context.Background()
	service := knowledge.NewService(knowledge.NewMemoryStore(), knowledgeHTTPProvider{})
	kb, err := service.CreateKnowledgeBase(ctx, knowledge.CreateKnowledgeBaseInput{Name: "公司制度", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{KnowledgeService: service})
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "guide.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("hello"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/knowledge-bases/documents?knowledge_base_id="+kb.KnowledgeBaseID, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()

	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s, want %d", recorder.Code, recorder.Body.String(), http.StatusBadRequest)
	}
}

func TestKnowledgeBasePatchUpdatesMetadata(t *testing.T) {
	ctx := context.Background()
	service := knowledge.NewService(knowledge.NewMemoryStore(), knowledgeHTTPProvider{})
	kb, err := service.CreateKnowledgeBase(ctx, knowledge.CreateKnowledgeBaseInput{Name: "公司制度", Description: "旧描述", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{KnowledgeService: service})
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/knowledge-bases", strings.NewReader(`{"knowledge_base_id":"`+kb.KnowledgeBaseID+`","name":"新制度","description":"新描述"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	response := unwrapAPIDataMap(t, recorder.Body.Bytes())
	if response["name"] != "新制度" || response["description"] != "新描述" {
		t.Fatalf("response = %#v", response)
	}

	request = httptest.NewRequest(http.MethodPatch, "/api/v1/admin/knowledge-bases", strings.NewReader(`{"knowledge_base_id":"`+kb.KnowledgeBaseID+`","description":""}`))
	request.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("clear description status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	response = unwrapAPIDataMap(t, recorder.Body.Bytes())
	if response["name"] != "新制度" || response["description"] != "" {
		t.Fatalf("response after clearing description = %#v", response)
	}
}

func TestKnowledgeBasePatchRejectsEmptyUpdate(t *testing.T) {
	ctx := context.Background()
	service := knowledge.NewService(knowledge.NewMemoryStore(), knowledgeHTTPProvider{})
	kb, err := service.CreateKnowledgeBase(ctx, knowledge.CreateKnowledgeBaseInput{Name: "公司制度", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{KnowledgeService: service})
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/knowledge-bases", strings.NewReader(`{"knowledge_base_id":"`+kb.KnowledgeBaseID+`"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s, want %d", recorder.Code, recorder.Body.String(), http.StatusBadRequest)
	}
}

type knowledgeHTTPProvider struct{}

type successfulKnowledgeHTTPProvider struct{ knowledgeHTTPProvider }

func (successfulKnowledgeHTTPProvider) UploadDocument(context.Context, string, provider.DocumentFile) (provider.ProviderDocument, error) {
	return provider.ProviderDocument{ExternalID: "provider-doc", Status: provider.DocumentProcessing}, nil
}

func (knowledgeHTTPProvider) CreateKnowledgeBase(context.Context, provider.CreateKnowledgeBaseRequest) (provider.ProviderKnowledgeBase, error) {
	return provider.ProviderKnowledgeBase{ExternalID: "provider-kb"}, nil
}
func (knowledgeHTTPProvider) DeleteKnowledgeBase(context.Context, string) error { return nil }
func (knowledgeHTTPProvider) UploadDocument(context.Context, string, provider.DocumentFile) (provider.ProviderDocument, error) {
	return provider.ProviderDocument{}, nil
}
func (knowledgeHTTPProvider) ListDocuments(context.Context, string) ([]provider.ProviderDocument, error) {
	return []provider.ProviderDocument{}, nil
}
func (knowledgeHTTPProvider) DeleteDocument(context.Context, string, string) error { return nil }
func (knowledgeHTTPProvider) Search(context.Context, provider.SearchRequest) (provider.SearchResult, error) {
	return provider.SearchResult{Chunks: []provider.SearchChunk{}}, nil
}
