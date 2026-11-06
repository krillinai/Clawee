package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestModelUsageRouteScopesResultsToCurrentAccount(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := mcpgateway.NewMemoryStore()
	service := mcpgateway.NewService(mcpgateway.Config{Store: store})
	createdAt := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	for _, record := range []mcpgateway.ModelProxyAuditRecord{
		{
			AuditID:        "usage_current",
			UserID:         "user_current",
			Model:          "clawee-vision",
			Endpoint:       "/v1/chat/completions",
			Status:         mcpgateway.ModelProxyAuditSucceeded,
			InputTokens:    10,
			OutputTokens:   20,
			TotalTokens:    30,
			UsageAvailable: true,
			RequestBody:    mcpgateway.JSONMap{"model": "clawee-vision"},
			CreatedAt:      createdAt,
		},
		{
			AuditID:   "usage_other",
			UserID:    "user_other",
			Model:     "other-model",
			Status:    mcpgateway.ModelProxyAuditFailed,
			CreatedAt: createdAt.Add(time.Minute),
		},
	} {
		if err := store.CreateModelProxyAuditRecord(context.Background(), record); err != nil {
			t.Fatalf("create audit record: %v", err)
		}
	}

	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(accountContextKey, accounts.Account{UserID: "user_current", Status: accounts.StatusActive})
		c.Next()
	})
	mountModelUsageRoutes(router.Group("/app"), Options{ProxyGateway: service})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/app/model-usage?limit=10&model=clawee-vision&created_from=2026-10-30T00:00:00Z&created_to=2026-11-01T00:00:00Z", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	var response struct {
		Data struct {
			Items   []map[string]any `json:"items"`
			Summary struct {
				RequestCount       int64   `json:"request_count"`
				TotalTokens        int64   `json:"total_tokens"`
				UsageCompleteCount int64   `json:"usage_complete_count"`
				UsageCoverageRate  float64 `json:"usage_coverage_rate"`
			} `json:"summary"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(response.Data.Items) != 1 || response.Data.Items[0]["audit_id"] != "usage_current" {
		t.Fatalf("items = %#v", response.Data.Items)
	}
	if _, ok := response.Data.Items[0]["request_body"]; ok {
		t.Fatalf("request body should not be exposed: %#v", response.Data.Items[0])
	}
	if response.Data.Summary.RequestCount != 1 || response.Data.Summary.TotalTokens != 30 || response.Data.Summary.UsageCompleteCount != 1 || response.Data.Summary.UsageCoverageRate != 1 {
		t.Fatalf("summary = %#v", response.Data.Summary)
	}
	if response.Data.Items[0]["usage_status"] != "complete" || response.Data.Items[0]["usage_source"] != "upstream" {
		t.Fatalf("usage contract = %#v", response.Data.Items[0])
	}
}
