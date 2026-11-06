package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestModelUpstreamAdminCRUD(t *testing.T) {
	router := newTestRouter(t, server.Options{
		ModelCredentialCipher: mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef")),
		ModelUpstreamStore:    mcpgateway.NewMemoryModelGroupStore(),
	})

	account := doJSON(t, router, http.MethodPost, "/api/v1/admin/model-proxy/upstream-accounts", `{
		"name":"主力账号",
		"base_url":"https://models.example.com/v1",
		"api_key":"upstream-secret",
		"synced_models":["gpt-4o","gpt-5"],
		"manual_models":[],
		"status":"active"
	}`, nil, http.StatusCreated)
	accountID := nestedString(t, account, "data", "id")
	updated := doJSON(t, router, http.MethodPut, "/api/v1/admin/model-proxy/upstream-accounts", `{
		"id":"`+accountID+`",
		"name":"主力账号",
		"base_url":"https://models.example.com/v1",
		"synced_models":["gpt-5"],
		"manual_models":[],
		"status":"active"
	}`, nil, http.StatusOK)
	updatedData, ok := updated["data"].(map[string]any)
	if !ok {
		t.Fatalf("updated account data = %#v", updated)
	}
	if models, ok := updatedData["models"].([]any); !ok || len(models) != 1 || models[0] != "gpt-5" {
		t.Fatalf("updated models = %#v", updatedData["models"])
	}
	accounts := doJSON(t, router, http.MethodGet, "/api/v1/admin/model-proxy/upstream-accounts", "", nil, http.StatusOK)
	if len(accounts["data"].([]any)) != 1 {
		t.Fatalf("upstream account list = %#v", accounts)
	}

	group := doJSON(t, router, http.MethodPost, "/api/v1/admin/model-proxy/groups", `{
		"name":"生产模型组",
		"route_strategy":"failover",
		"accounts":[{"upstream_account_id":"`+accountID+`","priority":0,"weight":1}],
		"status":"active"
	}`, nil, http.StatusCreated)
	groupID := nestedString(t, group, "data", "id")
	if groupID == "" {
		t.Fatal("group id is empty")
	}
	groups := doJSON(t, router, http.MethodGet, "/api/v1/admin/model-proxy/groups", "", nil, http.StatusOK)
	if len(groups["data"].([]any)) != 2 {
		t.Fatalf("group list = %#v", groups)
	}

	doJSON(t, router, http.MethodPost, "/api/v1/admin/model-proxy/upstream-accounts/remove", `{"id":"`+accountID+`"}`, nil, http.StatusNoContent)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/model-proxy/groups/remove", `{"id":"`+groupID+`"}`, nil, http.StatusNoContent)
}

func TestModelUpstreamAdminPreviewModelsDoesNotPersist(t *testing.T) {
	var authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}
		authorization = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4o"},{"id":"clawee-vision"}]}`))
	}))
	defer upstream.Close()

	store := mcpgateway.NewMemoryModelGroupStore()
	router := newTestRouter(t, server.Options{
		ModelCredentialCipher: mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef")),
		ModelUpstreamStore:    store,
	})

	preview := doJSON(t, router, http.MethodPost, "/api/v1/admin/model-proxy/upstream-accounts/preview-models", `{"base_url":"`+upstream.URL+`/v1","api_key":"preview-secret"}`, nil, http.StatusOK)
	data, ok := preview["data"].(map[string]any)
	if !ok {
		t.Fatalf("preview data = %#v", preview)
	}
	models, ok := data["models"].([]any)
	if !ok || len(models) != 2 || models[0] != "gpt-4o" || models[1] != "clawee-vision" {
		t.Fatalf("preview models = %#v", data["models"])
	}
	if authorization != "Bearer preview-secret" {
		t.Fatalf("authorization = %q", authorization)
	}

	accounts := doJSON(t, router, http.MethodGet, "/api/v1/admin/model-proxy/upstream-accounts", "", nil, http.StatusOK)
	if len(accounts["data"].([]any)) != 0 {
		t.Fatalf("preview persisted accounts = %#v", accounts)
	}

	saved := doJSON(t, router, http.MethodPost, "/api/v1/admin/model-proxy/upstream-accounts", `{"name":"预览账号","base_url":"`+upstream.URL+`/v1","api_key":"preview-secret","synced_models":["gpt-4o","clawee-vision"],"manual_models":[],"status":"active"}`, nil, http.StatusCreated)
	savedData, ok := saved["data"].(map[string]any)
	if !ok {
		t.Fatalf("saved data = %#v", saved)
	}
	if savedModels, ok := savedData["synced_models"].([]any); !ok || len(savedModels) != 2 {
		t.Fatalf("saved synced models = %#v", savedData["synced_models"])
	}
}

func TestModelUpstreamAdminTestAccountSendsHello(t *testing.T) {
	var authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}
		authorization = r.Header.Get("Authorization")
		var request struct {
			Model string `json:"model"`
			Input []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"input"`
			Stream bool `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Model != "gpt-4o" || len(request.Input) != 1 || request.Input[0].Role != "user" || request.Input[0].Content != "请只回复 OK" || !request.Stream {
			http.Error(w, "invalid test request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello from upstream\"}\n\n"))
		_, _ = w.Write([]byte("data: {\"type\":\"response.completed\"}\n\n"))
	}))
	defer upstream.Close()

	router := newTestRouter(t, server.Options{
		ModelCredentialCipher: mcpgateway.NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef")),
		ModelUpstreamStore:    mcpgateway.NewMemoryModelGroupStore(),
	})
	account := doJSON(t, router, http.MethodPost, "/api/v1/admin/model-proxy/upstream-accounts", `{"name":"测试账号","base_url":"`+upstream.URL+`/v1","api_key":"upstream-secret","models":["gpt-4o"],"status":"active"}`, nil, http.StatusCreated)
	accountID := nestedString(t, account, "data", "id")

	result := doJSON(t, router, http.MethodPost, "/api/v1/admin/model-proxy/upstream-accounts/test", `{"id":"`+accountID+`"}`, nil, http.StatusOK)
	data, ok := result["data"].(map[string]any)
	if !ok {
		t.Fatalf("test data = %#v", result)
	}
	if data["model"] != "gpt-4o" || data["reply"] != "hello from upstream" {
		t.Fatalf("test result = %#v", data)
	}
	if authorization != "Bearer upstream-secret" {
		t.Fatalf("authorization = %q", authorization)
	}
}
