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

func TestModelProxyRequestsAndRecordsFinalStreamUsage(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		t.Run(path, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if path == "/v1/chat/completions" {
					options, _ := body["stream_options"].(map[string]any)
					if options["include_usage"] != true || options["other_option"] != "preserve" {
						t.Errorf("流式用量参数错误: %#v", body)
					}
				} else if body["stream_options"] != nil {
					t.Errorf("Responses 不应添加 Chat 参数: %#v", body)
				}
				writer.Header().Set("Content-Type", "text/event-stream")
				_, _ = writer.Write([]byte("data: {\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n\n"))
				writer.(http.Flusher).Flush()
				if path == "/v1/responses" {
					_, _ = writer.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":7,\"output_tokens\":4,\"input_tokens_details\":{\"cached_tokens\":3}}}}\n\n"))
				} else {
					_, _ = writer.Write([]byte("data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":3}}}\n\ndata: [DONE]\n\n"))
				}
			}))
			defer upstream.Close()
			router, store := modelProxyTestRouter(t, fixedModelConfiguration{configuration: clawadmin.ModelConfiguration{
				BaseURL: upstream.URL + "/v1", APIKey: "upstream-test-key", Model: "default-model", CredentialVersion: 1,
			}})
			body := `{"model":"default-model","messages":[],"input":"hello","stream":true}`
			if path == "/v1/chat/completions" {
				body = `{"model":"default-model","messages":[],"stream":true,"stream_options":{"include_usage":false,"other_option":"preserve"}}`
			}
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			request.Header.Set("Authorization", "Bearer model-token")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			page, err := store.ListModelProxyAuditRecords(context.Background(), mcpgateway.ModelProxyAuditFilter{Limit: 10})
			if err != nil || recorder.Code != 200 || len(page.Items) != 1 {
				t.Fatalf("调用失败: %d, %#v, %v", recorder.Code, page, err)
			}
			usage := page.Items[0]
			if usage.InputTokens != 7 || usage.OutputTokens != 4 || usage.TotalTokens != 11 || usage.CacheReadTokens != 3 || usage.UsageStatus != mcpgateway.ModelProxyUsageComplete {
				t.Fatalf("流式最终用量重复累计或缺失: %#v", usage)
			}
		})
	}
}

func TestModelProxyRecordsUsageBeyondAuditSnapshotLimit(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			body := "{\n\"content\":\"" + strings.Repeat("x", modelProxyAuditSnapshotLimit*3) + "\",\n\"usage\":{\"input_tokens\":7,\"output_tokens\":4,\"total_tokens\":11}}"
			upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(status)
				_, _ = writer.Write([]byte(body))
			}))
			defer upstream.Close()
			router, store := modelProxyTestRouter(t, fixedModelConfiguration{configuration: clawadmin.ModelConfiguration{
				BaseURL: upstream.URL + "/v1", APIKey: "upstream-test-key", Model: "default-model", CredentialVersion: 1,
			}})
			request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"messages":[]}`))
			request.Header.Set("Authorization", "Bearer model-token")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			page, err := store.ListModelProxyAuditRecords(context.Background(), mcpgateway.ModelProxyAuditFilter{Limit: 10})
			if err != nil || recorder.Code != status || recorder.Body.String() != body || len(page.Items) != 1 {
				t.Fatalf("响应转发或记录失败: status=%d, records=%d, err=%v", recorder.Code, len(page.Items), err)
			}
			usage := page.Items[0]
			if !usage.Truncated || usage.TotalTokens != 11 || usage.UsageStatus != mcpgateway.ModelProxyUsageComplete {
				t.Fatalf("审计快照截断不应影响用量: %#v", usage)
			}
		})
	}
}

func TestModelProxyFailoverOccursBeforeWritingResponse(t *testing.T) {
	firstCalls, secondCalls := 0, 0
	first := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		firstCalls++
		http.Error(writer, `{"error":{"code":"overloaded"},"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}`, http.StatusServiceUnavailable)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		secondCalls++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"id":"chatcmpl_failover","object":"chat.completion","usage":{"input_tokens":7,"output_tokens":4,"total_tokens":11}}`))
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
	page, err := modelStore.ListModelProxyAuditRecords(ctx, mcpgateway.ModelProxyAuditFilter{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].InputTokens != 9 || page.Items[0].OutputTokens != 5 || page.Items[0].TotalTokens != 14 || page.Items[0].UsageStatus != mcpgateway.ModelProxyUsageComplete {
		t.Fatalf("故障转移丢失已知用量: %#v, %v", page, err)
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
