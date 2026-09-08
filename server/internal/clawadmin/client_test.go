package clawadmin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
)

func TestEnsureModelConfigurationUsesDeploymentCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/deployment/model-credentials/ensure" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer deployment-secret" {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		var request map[string]string
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request["account_id"] != "usr_001" || request["account_name"] != "测试账户" || request["account_email"] != "user@example.com" || request["agent_id"] != "" {
			t.Fatalf("request = %#v, err = %v", request, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":0,"data":{"base_url":"https://model.example/v1","api_key":"generated-key","model":"deepseek-v4-flash","credential_version":1}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL+"/", "deployment-secret", time.Second)
	configuration, err := client.EnsureModelConfiguration(context.Background(), AccountReference{ID: "usr_001", Name: "测试账户", Email: "User@Example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if configuration.BaseURL != "https://model.example/v1" || configuration.APIKey != "generated-key" || configuration.Model != "deepseek-v4-flash" {
		t.Fatalf("configuration = %#v", configuration)
	}
}

func TestEnsureModelConfigurationRejectsUpstreamFailureAndIncompleteResponse(t *testing.T) {
	for _, response := range []string{
		`{"error":1019,"data":null}`,
		`{"error":0,"data":{"base_url":"https://model.example/v1","model":"deepseek-v4-flash","credential_version":1}}`,
		`{"error":0,"data":{"base_url":"javascript://model.example/v1","api_key":"generated-key","model":"deepseek-v4-flash","credential_version":1}}`,
		`{"error":0,"data":{"base_url":"https://user@model.example/v1","api_key":"generated-key","model":"deepseek-v4-flash","credential_version":1}}`,
		`{"error":0,"data":{"base_url":"https://model.example/v1","api_key":"generated-key","model":"deepseek-v4-flash","credential_version":0}}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(response))
		}))
		client := NewClient(server.URL, "deployment-secret", time.Second)
		if _, err := client.EnsureModelConfiguration(context.Background(), AccountReference{ID: "usr_001", Email: "user@example.com"}); err == nil {
			server.Close()
			t.Fatalf("response must be rejected: %s", response)
		}
		server.Close()
	}
}

func TestUnconfiguredClientFailsClosed(t *testing.T) {
	client := NewClient("http://127.0.0.1:8790", "", time.Second)
	if client.Configured() {
		t.Fatal("client without deployment credential must be unconfigured")
	}
	if _, err := client.EnsureModelConfiguration(context.Background(), AccountReference{ID: "usr_001", Email: "user@example.com"}); err == nil {
		t.Fatal("unconfigured client must fail")
	}
}

func TestDisableModelCredentialUsesDeploymentCredentialAndAccountID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/deployment/model-credentials/disable" || r.Header.Get("Authorization") != "Bearer deployment-secret" {
			t.Fatalf("unexpected request: %s %s authorization=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		var request map[string]string
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request["account_id"] != "usr_001" {
			t.Fatalf("request = %#v, err = %v", request, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":0,"data":{"status":"disabled"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "deployment-secret", time.Second)
	if err := client.DisableModelCredential(context.Background(), "usr_001"); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotUsesDeploymentCredentialAndConvertsUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/deployment/billing/snapshot" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer deployment-secret" {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		if r.URL.Query().Get("start_date") != "2026-08-25" || r.URL.Query().Get("end_date") != "2026-08-25" || r.URL.Query().Get("granularity") != "day" {
			t.Fatalf("query = %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":0,"data":{"currency":"CNY","exchange_rate":7.5,"balance_cny":100,"start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day","generated_at":"2026-08-25T01:02:03Z","stats":{"requests":2,"input_tokens":100,"cached_input_tokens":10,"output_tokens":20,"total_tokens":130,"actual_cost_cny":9},"trend":[{"bucket_start":"2026-08-25T00:00:00+08:00","requests":2,"input_tokens":100,"cached_input_tokens":10,"output_tokens":20,"total_tokens":130,"actual_cost_cny":9}],"models":[{"model":"deepseek-v4-flash","requests":2,"input_tokens":100,"cached_input_tokens":10,"output_tokens":20,"total_tokens":130,"actual_cost_cny":9}],"token_usage_ranking":[{"rank":1,"name":"张三","requests":2,"total_tokens":130}]}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "deployment-secret", time.Second)
	result, err := client.Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Trend) != 1 || result.Trend[0].InputTokens != 110 || result.Trend[0].CachedInputTokens != 10 || result.Trend[0].TotalTokens != 130 {
		t.Fatalf("trend = %#v", result.Trend)
	}
	if len(result.Models) != 1 || result.Models[0].Share != 1 || result.Models[0].Model != "deepseek-v4-flash" {
		t.Fatalf("models = %#v", result.Models)
	}
	if len(result.TokenUsageRanking) != 1 || result.TokenUsageRanking[0].Rank != 1 || result.TokenUsageRanking[0].Name != "张三" || result.TokenUsageRanking[0].TotalTokens != 130 {
		t.Fatalf("ranking = %#v", result.TokenUsageRanking)
	}
}

func TestBillingSnapshotRejectsUnavailableAndInvalidData(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
	}{
		{name: "upstream unavailable", status: http.StatusBadGateway, body: `{}`},
		{name: "negative balance", status: http.StatusOK, body: `{"error":0,"data":{"currency":"CNY","exchange_rate":7.5,"balance_cny":-1,"start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day","generated_at":"2026-08-25T01:02:03Z","stats":{},"trend":[],"models":[]}}`},
		{name: "total mismatch", status: http.StatusOK, body: `{"error":0,"data":{"currency":"CNY","exchange_rate":7.5,"balance_cny":10,"start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day","generated_at":"2026-08-25T01:02:03Z","stats":{"input_tokens":1,"total_tokens":2},"trend":[],"models":[]}}`},
		{name: "duplicate bucket", status: http.StatusOK, body: `{"error":0,"data":{"currency":"CNY","exchange_rate":7.5,"balance_cny":10,"start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day","generated_at":"2026-08-25T01:02:03Z","stats":{"requests":2,"input_tokens":2,"total_tokens":2},"trend":[{"bucket_start":"2026-08-25T00:00:00+08:00","requests":1,"input_tokens":1,"total_tokens":1},{"bucket_start":"2026-08-25T00:00:00+08:00","requests":1,"input_tokens":1,"total_tokens":1}],"models":[]}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			client := NewClient(server.URL, "deployment-secret", time.Second)
			if _, err := client.Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day"}); err == nil {
				t.Fatal("无效账单响应必须被拒绝")
			}
		})
	}
}

func TestCreateRechargeSessionUsesDeploymentCredential(t *testing.T) {
	expiresAt := time.Now().Add(10 * time.Minute).UTC().Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/deployment/recharge-sessions" || r.Header.Get("Authorization") != "Bearer deployment-secret" {
			t.Fatalf("unexpected request: %s %s authorization=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":0,"data":{"recharge_url":"https://billing.example/recharge/session-token","expires_at":"` + expiresAt.Format(time.RFC3339) + `"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "deployment-secret", time.Second)
	result, err := client.CreateRechargeSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.RechargeURL != "https://billing.example/recharge/session-token" || !result.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("result = %+v", result)
	}
}

func TestCreateRechargeSessionRejectsInvalidResponse(t *testing.T) {
	for _, body := range []string{
		`{"error":1001,"data":null}`,
		`{"error":0,"data":{"recharge_url":"/relative/recharge","expires_at":"2099-01-01T00:00:00Z"}}`,
		`{"error":0,"data":{"recharge_url":"javascript://billing.example/recharge/session-token","expires_at":"2099-01-01T00:00:00Z"}}`,
		`{"error":0,"data":{"recharge_url":"http://billing.example/recharge/session-token","expires_at":"2099-01-01T00:00:00Z"}}`,
		`{"error":0,"data":{"recharge_url":"https://user@billing.example/recharge/session-token","expires_at":"2099-01-01T00:00:00Z"}}`,
		`{"error":0,"data":{"recharge_url":"https://billing.example/recharge/session-token","expires_at":"2020-01-01T00:00:00Z"}}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
		}))
		client := NewClient(server.URL, "deployment-secret", time.Second)
		if _, err := client.CreateRechargeSession(context.Background()); err == nil {
			server.Close()
			t.Fatalf("invalid response must be rejected: %s", body)
		}
		server.Close()
	}
}

func TestListRechargeOrdersUsesDeploymentCredentialAndPagination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/deployment/recharge-orders" || r.URL.Query().Get("page") != "2" || r.URL.Query().Get("page_size") != "20" {
			t.Fatalf("unexpected request: %s %s?%s", r.Method, r.URL.Path, r.URL.RawQuery)
		}
		if r.Header.Get("Authorization") != "Bearer deployment-secret" || r.Header.Get("Accept") != "application/json" {
			t.Fatalf("unexpected headers: %#v", r.Header)
		}
		_, _ = w.Write([]byte(`{"error":0,"data":{"items":[{"order_no":"PAY-TEST","amount_cents":10000,"currency":"CNY","channel":"alipay","status":"succeeded","payment_status":"paid","fulfillment_status":"succeeded","created_at":"2026-08-27T12:30:00+08:00","paid_at":"2026-08-27T12:31:00+08:00","fulfilled_at":"2026-08-27T12:32:00+08:00"}],"page":2,"page_size":20,"total":21}}`))
	}))
	defer server.Close()
	client := NewClient(server.URL, "deployment-secret", time.Second)
	result, err := client.ListRechargeOrders(context.Background(), 2, 20)
	if err != nil || result.Total != 21 || len(result.Items) != 1 || result.Items[0].OrderNo != "PAY-TEST" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestListRechargeOrdersNormalizesNilItems(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"error":0,"data":{"items":null,"page":1,"page_size":20,"total":0}}`))
	}))
	defer server.Close()
	result, err := NewClient(server.URL, "deployment-secret", time.Second).ListRechargeOrders(context.Background(), 1, 20)
	if err != nil || result.Items == nil || len(result.Items) != 0 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestListRechargeOrdersRejectsInvalidResponses(t *testing.T) {
	validOrder := func() map[string]any {
		return map[string]any{
			"order_no": "PAY-TEST", "amount_cents": 10000, "currency": "CNY", "channel": "manual",
			"status": "crediting", "payment_status": "paid", "fulfillment_status": "processing",
			"created_at": "2026-08-27T12:30:00+08:00", "paid_at": "2026-08-27T12:31:00+08:00", "fulfilled_at": nil,
		}
	}
	tests := []struct {
		name   string
		status int
		body   []byte
		mutate func(map[string]any, map[string]any)
	}{
		{name: "non 2xx", status: http.StatusBadGateway},
		{name: "business error", mutate: func(root, _ map[string]any) { root["error"] = 1001 }},
		{name: "invalid json", body: []byte(`{"error":`)},
		{name: "negative amount", mutate: func(_, order map[string]any) { order["amount_cents"] = -1 }},
		{name: "empty order number", mutate: func(_, order map[string]any) { order["order_no"] = " " }},
		{name: "zero created at", mutate: func(_, order map[string]any) { order["created_at"] = "0001-01-01T00:00:00Z" }},
		{name: "unknown channel", mutate: func(_, order map[string]any) { order["channel"] = "wechat" }},
		{name: "unknown status", mutate: func(_, order map[string]any) { order["status"] = "unknown" }},
		{name: "unknown payment status", mutate: func(_, order map[string]any) { order["payment_status"] = "failed" }},
		{name: "unknown fulfillment status", mutate: func(_, order map[string]any) { order["fulfillment_status"] = "unknown" }},
		{name: "wrong page", mutate: func(root, _ map[string]any) { root["data"].(map[string]any)["page"] = 2 }},
		{name: "wrong page size", mutate: func(root, _ map[string]any) { root["data"].(map[string]any)["page_size"] = 10 }},
		{name: "negative total", mutate: func(root, _ map[string]any) { root["data"].(map[string]any)["total"] = -1 }},
		{name: "oversized response", body: []byte(strings.Repeat("x", maxResponseBytes+1))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := test.body
			if body == nil {
				order := validOrder()
				root := map[string]any{"error": 0, "data": map[string]any{"items": []any{order}, "page": 1, "page_size": 20, "total": 1}}
				if test.mutate != nil {
					test.mutate(root, order)
				}
				body, _ = json.Marshal(root)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				status := test.status
				if status == 0 {
					status = http.StatusOK
				}
				w.WriteHeader(status)
				_, _ = w.Write(body)
			}))
			defer server.Close()
			_, err := NewClient(server.URL, "deployment-secret", time.Second).ListRechargeOrders(context.Background(), 1, 20)
			if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}
