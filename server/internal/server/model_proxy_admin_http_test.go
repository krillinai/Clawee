package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestModelProxyAuditAdminRoutesListDetailAndSummary(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(store)})
	userID := testAdminUserID(t, router)
	createdAt := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	if err := store.CreateModelProxyAuditRecord(context.Background(), mcpgateway.ModelProxyAuditRecord{
		AuditID:             "model_audit_admin_1",
		RequestID:           "request_admin_1",
		UserID:              userID,
		UserNameSnapshot:    "Test Admin",
		APIKeyID:            "token_admin_1",
		APIKeyFingerprint:   "sha256:fingerprint",
		Endpoint:            "/v1/chat/completions",
		Method:              http.MethodPost,
		Model:               "clawee-vision",
		RequestedModel:      "clawee-vision",
		UpstreamModel:       "clawee-vision-4",
		ResponseModel:       "clawee-vision-4",
		Status:              mcpgateway.ModelProxyAuditSucceeded,
		InputTokens:         10,
		OutputTokens:        20,
		TotalTokens:         30,
		CacheReadTokens:     4,
		CacheCreationTokens: 2,
		ReasoningTokens:     6,
		UsageAvailable:      true,
		UsageStatus:         mcpgateway.ModelProxyUsageComplete,
		UsageSource:         mcpgateway.ModelProxyUsageSourceUpstream,
		RequestBody:         mcpgateway.JSONMap{"model": "clawee-vision"},
		CreatedAt:           createdAt,
	}); err != nil {
		t.Fatalf("create audit: %v", err)
	}

	for _, test := range []struct {
		name string
		path string
		want int
	}{
		{name: "list", path: "/api/v1/admin/model-proxy/audits?user_id=" + userID + "&usage_status=complete", want: http.StatusOK},
		{name: "summary", path: "/api/v1/admin/model-proxy/audits/summary?model=clawee-vision", want: http.StatusOK},
		{name: "detail", path: "/api/v1/admin/model-proxy/audits/detail?audit_id=model_audit_admin_1", want: http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, test.path, nil)
			router.ServeHTTP(recorder, req)
			if recorder.Code != test.want {
				t.Fatalf("GET %s status = %d, want %d; body=%s", test.path, recorder.Code, test.want, recorder.Body.String())
			}
		})
	}

	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/model-proxy/audits", nil)
	router.ServeHTTP(recorder, req)
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	data, ok := response["data"].([]any)
	if !ok {
		t.Fatalf("list response data = %#v", response)
	}
	if len(data) != 1 {
		t.Fatalf("list items = %#v", data)
	}
	item := data[0].(map[string]any)
	if item["api_key_fingerprint"] != "sha256:fingerprint" {
		t.Fatalf("fingerprint = %#v", item["api_key_fingerprint"])
	}
	if item["cache_creation_tokens"] != float64(2) || item["reasoning_tokens"] != float64(6) || item["usage_status"] != "complete" || item["requested_model"] != "clawee-vision" {
		t.Fatalf("usage contract = %#v", item)
	}
}
