package sub2api

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/activity"
)

const testAdminAPIKey = "test-admin-api-key"

func TestSnapshotUsesScopedAdminRequestAndConvertsUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("x-api-key") != testAdminAPIKey || r.Header.Get("Accept") != "application/json" {
			t.Fatalf("headers = %#v", r.Header)
		}
		switch r.URL.Path {
		case "/api/v1/admin/dashboard/snapshot-v2":
			for key, value := range map[string]string{"user_id": "12", "start_date": "2026-08-25", "end_date": "2026-08-25", "timezone": timezone, "granularity": "day"} {
				if r.URL.Query().Get(key) != value {
					t.Fatalf("query %s = %q, want %q", key, r.URL.Query().Get(key), value)
				}
			}
			for key, value := range map[string]string{"include_stats": "false", "include_trend": "true", "include_model_stats": "true", "include_group_stats": "false", "include_users_trend": "false"} {
				if r.URL.Query().Get(key) != value {
					t.Fatalf("query %s = %q, want %q", key, r.URL.Query().Get(key), value)
				}
			}
			_, _ = w.Write([]byte(`{"code":0,"data":{"generated_at":"2026-08-25T01:02:03Z","start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day","trend":[{"date":"2026-08-25","requests":2,"input_tokens":100,"output_tokens":20,"cache_creation_tokens":3,"cache_read_tokens":7,"total_tokens":999}],"models":[{"model":"deepseek-v4-flash","requests":2,"input_tokens":100,"output_tokens":20,"cache_creation_tokens":3,"cache_read_tokens":7,"total_tokens":999}]}}`))
		case "/api/v1/admin/users/12/api-keys":
			if r.URL.Query().Get("page") != "1" || r.URL.Query().Get("page_size") != strconv.Itoa(apiKeyPageSize) {
				t.Fatalf("API Key 分页参数 = %q", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"code":0,"data":{"items":[{"id":9,"user_id":12,"name":"李四"},{"id":7,"user_id":12,"name":"张三"}],"total":2,"page":1,"page_size":100,"pages":1}}`))
		case "/api/v1/admin/usage/stats":
			for key, value := range map[string]string{"user_id": "12", "start_date": "2026-08-25", "end_date": "2026-08-25", "timezone": timezone} {
				if r.URL.Query().Get(key) != value {
					t.Fatalf("query %s = %q, want %q", key, r.URL.Query().Get(key), value)
				}
			}
			switch r.URL.Query().Get("api_key_id") {
			case "9":
				_, _ = w.Write([]byte(`{"code":0,"data":{"total_requests":1,"total_tokens":40}}`))
			case "7":
				_, _ = w.Write([]byte(`{"code":0,"data":{"total_requests":2,"total_tokens":90}}`))
			default:
				t.Fatalf("api_key_id = %q", r.URL.Query().Get("api_key_id"))
			}
		default:
			t.Fatalf("request path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := newTestClient(t, server.URL)
	result, err := client.Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Trend) != 1 || result.Trend[0].InputTokens != 110 || result.Trend[0].CachedInputTokens != 10 || result.Trend[0].OutputTokens != 20 || result.Trend[0].TotalTokens != 130 {
		t.Fatalf("trend = %#v", result.Trend)
	}
	if len(result.Models) != 1 || result.Models[0].Model != "deepseek-v4-flash" || result.Models[0].Requests != 2 || result.Models[0].TotalTokens != 130 || result.Models[0].Share != 1 {
		t.Fatalf("models = %#v", result.Models)
	}
	if len(result.TokenUsageRanking) != 2 || result.TokenUsageRanking[0].Rank != 1 || result.TokenUsageRanking[0].Name != "张三" || result.TokenUsageRanking[0].TotalTokens != 90 {
		t.Fatalf("ranking = %#v", result.TokenUsageRanking)
	}
}

func TestSnapshotParsesHourlyBucket(t *testing.T) {
	server := snapshotServer(`{"code":0,"data":{"generated_at":"2026-08-25T01:02:03Z","start_date":"2026-08-25","end_date":"2026-08-25","granularity":"hour","trend":[{"date":"2026-08-25 09:00","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0}],"models":[]}}`)
	defer server.Close()
	result, err := newTestClient(t, server.URL).Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "hour"})
	if err != nil || len(result.Trend) != 1 || result.Trend[0].BucketStart.Format("2006-01-02 15:04 -07:00") != "2026-08-25 09:00 +08:00" {
		t.Fatalf("result = %#v, err = %v", result, err)
	}
}

func TestSnapshotSortsAPIKeyUsageAndOmitsUnusedKeys(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/admin/users/12/api-keys":
			_, _ = w.Write([]byte(`{"code":0,"data":{"items":[{"id":8,"user_id":12,"name":"研发"},{"id":7,"user_id":12,"name":"运营"},{"id":9,"user_id":12,"name":"空闲"}],"total":3,"page":1,"page_size":100,"pages":1}}`))
		case "/api/v1/admin/usage/stats":
			switch r.URL.Query().Get("api_key_id") {
			case "8":
				_, _ = w.Write([]byte(`{"code":0,"data":{"total_requests":5,"total_tokens":50}}`))
			case "7":
				_, _ = w.Write([]byte(`{"code":0,"data":{"total_requests":4,"total_tokens":50}}`))
			case "9":
				_, _ = w.Write([]byte(`{"code":0,"data":{"total_requests":0,"total_tokens":0}}`))
			}
		default:
			_, _ = w.Write([]byte(`{"code":0,"data":{"generated_at":"2026-08-26T01:02:03Z","start_date":"2026-08-25","end_date":"2026-08-26","granularity":"day","trend":[],"models":[]}}`))
		}
	}))
	defer server.Close()
	result, err := newTestClient(t, server.URL).Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-26", Granularity: "day"})
	if err != nil || len(result.TokenUsageRanking) != 2 || result.TokenUsageRanking[0].Name != "运营" || result.TokenUsageRanking[0].Rank != 1 || result.TokenUsageRanking[1].Name != "研发" || result.TokenUsageRanking[1].Requests != 5 || result.TokenUsageRanking[1].TotalTokens != 50 {
		t.Fatalf("ranking=%#v err=%v", result.TokenUsageRanking, err)
	}
}

func TestSnapshotLimitsAPIKeyRankingTo50(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/admin/users/12/api-keys":
			items := make([]map[string]any, 0, 51)
			for id := int64(1); id <= 51; id++ {
				items = append(items, map[string]any{"id": id, "user_id": int64(12), "name": "key"})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0, "data": map[string]any{"items": items, "total": 51, "page": 1, "page_size": apiKeyPageSize, "pages": 1},
			})
		case "/api/v1/admin/usage/stats":
			id, _ := strconv.ParseInt(r.URL.Query().Get("api_key_id"), 10, 64)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"total_requests": 1, "total_tokens": id}})
		default:
			_, _ = w.Write([]byte(`{"code":0,"data":{"generated_at":"2026-08-25T01:02:03Z","start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day","trend":[],"models":[]}}`))
		}
	}))
	defer server.Close()
	result, err := newTestClient(t, server.URL).Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day"})
	if err != nil || len(result.TokenUsageRanking) != 50 || result.TokenUsageRanking[0].TotalTokens != 51 || result.TokenUsageRanking[49].TotalTokens != 2 {
		t.Fatalf("ranking=%#v err=%v", result.TokenUsageRanking, err)
	}
}

func TestSnapshotRejectsInvalidAPIKeyUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/admin/users/12/api-keys":
			_, _ = w.Write([]byte(`{"code":0,"data":{"items":[{"id":8,"user_id":12,"name":"研发"}],"total":1,"page":1,"page_size":100,"pages":1}}`))
		case "/api/v1/admin/usage/stats":
			_, _ = w.Write([]byte(`{"code":0,"data":{"total_requests":1,"total_tokens":-1}}`))
		default:
			_, _ = w.Write([]byte(responseWithTrend(`{"date":"2026-08-25","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0}`)))
		}
	}))
	defer server.Close()
	if _, err := newTestClient(t, server.URL).Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day"}); err == nil {
		t.Fatal("invalid API key usage must fail")
	}
}

func TestListOrganizationAPIKeysRejectsOtherUser(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"data":{"items":[{"id":8,"user_id":99,"name":"其他账户"}],"total":1,"page":1,"page_size":100,"pages":1}}`))
	}))
	defer server.Close()
	if _, err := newTestClient(t, server.URL).listOrganizationAPIKeys(context.Background()); err == nil {
		t.Fatal("other user's API key must fail")
	}
}

func TestListOrganizationAPIKeysPaginates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		items := make([]map[string]any, 0, apiKeyPageSize)
		if page == 1 {
			for id := int64(1); id <= apiKeyPageSize; id++ {
				items = append(items, map[string]any{"id": id, "user_id": int64(12), "name": "key"})
			}
		} else if page == 2 {
			items = append(items, map[string]any{"id": int64(101), "user_id": int64(12), "name": "key"})
		} else {
			t.Fatalf("page = %d", page)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 0, "data": map[string]any{"items": items, "total": 101, "page": page, "page_size": apiKeyPageSize, "pages": 2},
		})
	}))
	defer server.Close()
	keys, err := newTestClient(t, server.URL).listOrganizationAPIKeys(context.Background())
	if err != nil || len(keys) != 101 || keys[100].ID != 101 {
		t.Fatalf("keys=%d err=%v", len(keys), err)
	}
}

func TestSnapshotRejectsInvalidResponses(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{name: "http error", status: http.StatusBadGateway, body: `{}`},
		{name: "invalid json", body: `{"code":`},
		{name: "missing code", body: `{"data":{}}`},
		{name: "business error", body: `{"code":1,"data":{}}`},
		{name: "null data", body: `{"code":0,"data":null}`},
		{name: "missing arrays", body: `{"code":0,"data":{"generated_at":"2026-08-25T01:02:03Z","start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day"}}`},
		{name: "missing trend value", body: responseWithTrend(`{"date":"2026-08-25","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0}`)},
		{name: "null trend value", body: responseWithTrend(`{"date":"2026-08-25","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":null}`)},
		{name: "missing model value", body: responseWithModels(`{"model":"m","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0}`)},
		{name: "null model value", body: responseWithModels(`{"model":"m","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":null}`)},
		{name: "wrong range", body: `{"code":0,"data":{"generated_at":"2026-08-25T01:02:03Z","start_date":"2026-08-24","end_date":"2026-08-25","granularity":"day","trend":[],"models":[]}}`},
		{name: "negative token", body: responseWithTrend(`{"date":"2026-08-25","requests":1,"input_tokens":-1,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0}`)},
		{name: "duplicate bucket", body: responseWithTrend(`{"date":"2026-08-25","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0},{"date":"2026-08-25","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0}`)},
		{name: "bucket out of range", body: responseWithTrend(`{"date":"2026-08-26"}`)},
		{name: "empty model", body: responseWithModels(`{"model":" ","requests":1}`)},
		{name: "negative requests", body: responseWithModels(`{"model":"m","requests":-1,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0}`)},
		{name: "usage overflow", body: responseWithTrend(`{"date":"2026-08-25","requests":0,"input_tokens":` + strconvInt(math.MaxInt64) + `,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":1,"total_tokens":0}`)},
		{name: "model total overflow", body: responseWithModels(`{"model":"a","requests":0,"input_tokens":` + strconvInt(math.MaxInt64) + `,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0},{"model":"b","requests":0,"input_tokens":1,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0}`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				status := test.status
				if status == 0 {
					status = http.StatusOK
				}
				w.WriteHeader(status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			_, err := newTestClient(t, server.URL).Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day"})
			if err == nil || strings.Contains(err.Error(), testAdminAPIKey) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestSnapshotRejectsUnalignedHourlyBucket(t *testing.T) {
	server := snapshotServer(`{"code":0,"data":{"generated_at":"2026-08-25T01:02:03Z","start_date":"2026-08-25","end_date":"2026-08-25","granularity":"hour","trend":[{"date":"2026-08-25 09:30","requests":0,"input_tokens":0,"output_tokens":0,"cache_creation_tokens":0,"cache_read_tokens":0,"total_tokens":0}],"models":[]}}`)
	defer server.Close()
	_, err := newTestClient(t, server.URL).Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "hour"})
	if err == nil {
		t.Fatal("unaligned hourly bucket must fail")
	}
}

func TestSnapshotRejectsOversizedResponseAndRedirect(t *testing.T) {
	t.Run("oversized", func(t *testing.T) {
		server := snapshotServer(strings.Repeat("x", maxResponseBytes+1))
		defer server.Close()
		_, err := newTestClient(t, server.URL).Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day"})
		if err == nil {
			t.Fatal("oversized response must fail")
		}
	})
	t.Run("redirect", func(t *testing.T) {
		var targetCalls int
		target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { targetCalls++ }))
		defer target.Close()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
		defer server.Close()
		_, err := newTestClient(t, server.URL).Snapshot(context.Background(), activity.SnapshotRequest{StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day"})
		if err == nil || targetCalls != 0 || strings.Contains(err.Error(), testAdminAPIKey) {
			t.Fatalf("error = %v, target calls = %d", err, targetCalls)
		}
	})
}

func TestNewClientValidatesConfigWithoutLeakingKey(t *testing.T) {
	for _, cfg := range []Config{
		{BaseURL: "/relative", AdminAPIKey: testAdminAPIKey, OrganizationUserID: 1},
		{BaseURL: "ftp://example.com", AdminAPIKey: testAdminAPIKey, OrganizationUserID: 1},
		{BaseURL: "https://user@example.com", AdminAPIKey: testAdminAPIKey, OrganizationUserID: 1},
		{BaseURL: "https://example.com/#fragment", AdminAPIKey: testAdminAPIKey, OrganizationUserID: 1},
		{BaseURL: "https://example.com", AdminAPIKey: " ", OrganizationUserID: 1},
		{BaseURL: "https://example.com", AdminAPIKey: testAdminAPIKey, OrganizationUserID: 0},
	} {
		_, err := NewClient(cfg)
		if err == nil || strings.Contains(err.Error(), testAdminAPIKey) {
			t.Fatalf("NewClient(%#v) error = %v", cfg, err)
		}
	}
}

func newTestClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	client, err := NewClient(Config{BaseURL: baseURL, AdminAPIKey: testAdminAPIKey, OrganizationUserID: 12})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func snapshotServer(body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/admin/users/12/api-keys" {
			_, _ = w.Write([]byte(`{"code":0,"data":{"items":[],"total":0,"page":1,"page_size":100,"pages":1}}`))
			return
		}
		_, _ = w.Write([]byte(body))
	}))
}

func responseWithTrend(points string) string {
	return `{"code":0,"data":{"generated_at":"2026-08-25T01:02:03Z","start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day","trend":[` + points + `],"models":[]}}`
}

func responseWithModels(models string) string {
	return `{"code":0,"data":{"generated_at":"2026-08-25T01:02:03Z","start_date":"2026-08-25","end_date":"2026-08-25","granularity":"day","trend":[],"models":[` + models + `]}}`
}

func strconvInt(value int64) string {
	return strconv.FormatInt(value, 10)
}
