package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/clawadmin"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type fixedModelConfiguration struct {
	configuration clawadmin.ModelConfiguration
}

func TestModelProxyForwardsDefaultModelAndMultimodalJSON(t *testing.T) {
	var receivedPath string
	var receivedBody map[string]any
	var receivedAuthorization string
	var receivedCookie string
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		receivedPath = request.URL.Path
		receivedAuthorization = request.Header.Get("Authorization")
		receivedCookie = request.Header.Get("Cookie")
		body, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(body, &receivedBody)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"id":"chatcmpl_1","object":"chat.completion","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`))
	}))
	defer upstream.Close()

	router, store := modelProxyTestRouter(t, fixedModelConfiguration{configuration: clawadmin.ModelConfiguration{
		BaseURL: upstream.URL + "/v1", APIKey: "upstream-secret", Model: "default-model", CredentialVersion: 1,
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,aGk="}}]}],"unknown_field":"preserve"}`))
	request.Header.Set("Authorization", "Bearer model-token")
	request.Header.Set("Cookie", "session=must-not-forward")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("proxy status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if receivedPath != "/v1/chat/completions" || receivedAuthorization != "Bearer upstream-secret" || receivedCookie != "" {
		t.Fatalf("upstream request path=%q authorization=%q cookie=%q", receivedPath, receivedAuthorization, receivedCookie)
	}
	if receivedBody["model"] != "default-model" || receivedBody["unknown_field"] != "preserve" {
		t.Fatalf("upstream body = %#v", receivedBody)
	}
	page, err := store.ListModelProxyAuditRecords(context.Background(), mcpgateway.ModelProxyAuditFilter{Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("audit page = %#v, %v", page.Items, err)
	}
	if page.Items[0].Status != mcpgateway.ModelProxyAuditSucceeded || page.Items[0].Model != "default-model" ||
		page.Items[0].RequestType != "non_stream" || !page.Items[0].UsageAvailable || page.Items[0].FirstByteMS < 0 {
		t.Fatalf("audit record = %#v", page.Items[0])
	}
}

func TestModelProxyModelsReturnsFixedListAndRejectsURLCredentials(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Fatal("models endpoint unexpectedly called upstream")
	}))
	defer upstream.Close()
	router, store := modelProxyTestRouter(t, fixedModelConfiguration{configuration: clawadmin.ModelConfiguration{
		BaseURL: upstream.URL + "/v1", APIKey: "upstream-secret", Model: "default-model", CredentialVersion: 1,
	}})

	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer model-token")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"id":"default-model"`) {
		t.Fatalf("models response = %d %s", recorder.Code, recorder.Body.String())
	}

	queryRequest := httptest.NewRequest(http.MethodGet, "/v1/models?api_key=model-token", nil)
	queryRecorder := httptest.NewRecorder()
	router.ServeHTTP(queryRecorder, queryRequest)
	if queryRecorder.Code != http.StatusUnauthorized || !strings.Contains(queryRecorder.Body.String(), `"code":"invalid_api_key"`) {
		t.Fatalf("query credential response = %d %s", queryRecorder.Code, queryRecorder.Body.String())
	}
	page, err := store.ListModelProxyAuditRecords(context.Background(), mcpgateway.ModelProxyAuditFilter{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].Status != mcpgateway.ModelProxyAuditSucceeded {
		t.Fatalf("known key audit records = %#v, %v", page.Items, err)
	}
	if page.Items[0].RequestType != "list" {
		t.Fatalf("model list request type = %q", page.Items[0].RequestType)
	}
}

func TestModelProxyForwardsResponsesSSE(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/responses" || request.Header.Get("Accept") != "text/event-stream" {
			t.Fatalf("responses request path=%q accept=%q", request.URL.Path, request.Header.Get("Accept"))
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := writer.(http.Flusher)
		if !ok {
			t.Fatal("upstream response is not flushable")
		}
		_, _ = writer.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n"))
		flusher.Flush()
		_, _ = writer.Write([]byte("data: {\"type\":\"response.completed\"}\n\n"))
	}))
	defer upstream.Close()

	router, store := modelProxyTestRouter(t, fixedModelConfiguration{configuration: clawadmin.ModelConfiguration{
		BaseURL: upstream.URL + "/v1", APIKey: "upstream-secret", Model: "default-model", CredentialVersion: 1,
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"input":[{"role":"user","content":"hello"}],"stream":true}`))
	request.Header.Set("Authorization", "Bearer model-token")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "text/event-stream" || !strings.Contains(recorder.Body.String(), "response.output_text.delta") || !strings.Contains(recorder.Body.String(), `"delta":"OK"`) {
		t.Fatalf("responses proxy = %d content-type=%q body=%s", recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body.String())
	}
	page, err := store.ListModelProxyAuditRecords(context.Background(), mcpgateway.ModelProxyAuditFilter{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].Endpoint != "/v1/responses" || page.Items[0].Status != mcpgateway.ModelProxyAuditSucceeded {
		t.Fatalf("responses audit = %#v, %v", page.Items, err)
	}
}

func TestModelProxyFailoverOccursBeforeWritingResponse(t *testing.T) {
	firstCalls, secondCalls := 0, 0
	first := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		firstCalls++
		http.Error(writer, `{"error":{"code":"overloaded"}}`, http.StatusServiceUnavailable)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		secondCalls++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"id":"chatcmpl_failover","object":"chat.completion"}`))
	}))
	defer second.Close()

	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	if err := accountStore.SaveAccount(ctx, accounts.Account{UserID: "user_model", Name: "模型用户", Status: accounts.StatusActive}); err != nil {
		t.Fatal(err)
	}
	modelStore := mcpgateway.NewMemoryStore()
	accountService := accounts.NewService(accounts.Config{Store: accountStore})
	if err := modelStore.RotateAccountToken(ctx, "user_model", mcpgateway.AccountToken{
		ID: "token_model", UserID: "user_model", TokenHash: mcpgateway.HashToken("model-token"), Status: mcpgateway.StatusActive,
		Scopes: []string{mcpgateway.AccountTokenScopeMCPCall, mcpgateway.AccountTokenScopeModelCall}, Fingerprint: "fingerprint", CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("seed account token: %v", err)
	}
	cipher := mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef"))
	groups := mcpgateway.NewMemoryModelGroupStore()
	now := time.Now().UTC()
	for index, baseURL := range []string{first.URL + "/v1", second.URL + "/v1"} {
		apiKey, err := cipher.Encrypt([]byte("upstream-secret"))
		if err != nil {
			t.Fatal(err)
		}
		if err := groups.SaveModelUpstreamAccount(ctx, mcpgateway.ModelUpstreamAccount{ID: fmt.Sprintf("upstream-%d", index), Name: fmt.Sprintf("上游%d", index), BaseURL: baseURL, APIKeyCiphertext: apiKey, ManualModels: []string{"default-model"}, Status: mcpgateway.ModelGroupStatusActive, HealthStatus: "healthy", CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err := groups.SaveModelGroup(ctx, mcpgateway.ModelGroupConfig{ModelGroup: mcpgateway.ModelGroup{ID: "default", Name: "默认模型组", RouteStrategy: mcpgateway.ModelGroupRouteFailover, DefaultModel: "default-model", Status: mcpgateway.ModelGroupStatusActive, CreatedAt: now, UpdatedAt: now}, Accounts: []mcpgateway.ModelGroupAccount{{UpstreamAccountID: "upstream-0", Priority: 0, Weight: 1}, {UpstreamAccountID: "upstream-1", Priority: 1, Weight: 1}}}); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(requestIDMiddleware())
	mountModelProxyRoutes(router, Options{AccountService: accountService, ModelCredentialCipher: cipher, ModelGroupStore: groups, ModelUpstreamStore: groups, ProxyGateway: mcpgateway.NewService(mcpgateway.Config{Store: modelStore})})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"messages":[{"role":"user","content":"hello"}]}`))
	request.Header.Set("Authorization", "Bearer model-token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || firstCalls != 1 || secondCalls != 1 || !strings.Contains(recorder.Body.String(), "chatcmpl_failover") {
		t.Fatalf("failover response = %d first=%d second=%d body=%s", recorder.Code, firstCalls, secondCalls, recorder.Body.String())
	}
}

func modelProxyTestRouter(t *testing.T, provider fixedModelConfiguration) (*gin.Engine, *mcpgateway.MemoryStore) {
	t.Helper()
	ctx := context.Background()
	accountStore := accounts.NewMemoryStore()
	if err := accountStore.SaveAccount(ctx, accounts.Account{UserID: "user_model", Email: "model@example.com", Name: "模型用户", Status: accounts.StatusActive}); err != nil {
		t.Fatalf("save account: %v", err)
	}
	accountService := accounts.NewService(accounts.Config{Store: accountStore})
	store := mcpgateway.NewMemoryStore()
	if err := store.RotateAccountToken(ctx, "user_model", mcpgateway.AccountToken{
		ID: "token_model", UserID: "user_model", TokenHash: mcpgateway.HashToken("model-token"), Status: mcpgateway.StatusActive,
		Scopes: []string{mcpgateway.AccountTokenScopeMCPCall, mcpgateway.AccountTokenScopeModelCall}, Fingerprint: "fingerprint", CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("save account token: %v", err)
	}
	modelGroups := mcpgateway.NewMemoryModelGroupStore()
	cipher := mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef"))
	upstreamKey, err := cipher.Encrypt([]byte(provider.configuration.APIKey))
	if err != nil {
		t.Fatalf("encrypt upstream key: %v", err)
	}
	now := time.Now().UTC()
	if err := modelGroups.SaveModelUpstreamAccount(ctx, mcpgateway.ModelUpstreamAccount{
		ID: "upstream-model", Name: "测试上游", BaseURL: provider.configuration.BaseURL, APIKeyCiphertext: upstreamKey,
		ManualModels: []string{provider.configuration.Model}, Status: mcpgateway.ModelGroupStatusActive,
		HealthStatus: "healthy", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("save model upstream: %v", err)
	}
	if err := modelGroups.SaveModelGroup(ctx, mcpgateway.ModelGroupConfig{
		ModelGroup: mcpgateway.ModelGroup{ID: "default", Name: "默认模型组", RouteStrategy: mcpgateway.ModelGroupRouteFailover, DefaultModel: provider.configuration.Model, Status: mcpgateway.ModelGroupStatusActive, CreatedAt: now, UpdatedAt: now},
		Accounts:   []mcpgateway.ModelGroupAccount{{UpstreamAccountID: "upstream-model", Priority: 0, Weight: 1}},
	}); err != nil {
		t.Fatalf("save model group: %v", err)
	}
	router := gin.New()
	router.Use(requestIDMiddleware())
	mountModelProxyRoutes(router, Options{AccountService: accountService, ModelCredentialCipher: cipher, ModelGroupStore: modelGroups, ModelUpstreamStore: modelGroups, ProxyGateway: mcpgateway.NewService(mcpgateway.Config{Store: store})})
	return router, store
}
