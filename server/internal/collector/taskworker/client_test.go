package taskworker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestClientPullAndCompleteUseCollectorToken(t *testing.T) {
	var result collectorapi.TaskResultRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer collector-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/collector/tasks/pull":
			_ = json.NewEncoder(w).Encode(collectorapi.TaskDelivery{
				SchemaVersion: collectorapi.TaskSchemaVersion, TaskID: "task-1", ClaimID: "claim-1",
				Tool: "codex.ask", Arguments: map[string]any{"question": "处理"},
			})
		case "/api/v1/collector/tasks/result":
			if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := NewClient(ClientConfig{
		BaseURL: server.URL, CollectorToken: "collector-token", CollectorID: "collector-1", DeviceID: "device-1",
	})
	delivery, err := client.Pull(context.Background())
	if err != nil || delivery == nil || delivery.TaskID != "task-1" {
		t.Fatalf("Pull() = (%#v, %v)", delivery, err)
	}
	if err := client.Complete(context.Background(), collectorapi.TaskResultRequest{
		TaskID: delivery.TaskID, ClaimID: delivery.ClaimID, Status: collectorapi.TaskResultSucceeded,
		Output: &collectorapi.TaskResultOutput{Answer: "完成"},
	}); err != nil {
		t.Fatal(err)
	}
	if result.SchemaVersion != collectorapi.TaskSchemaVersion || result.CollectorID != "collector-1" || result.DeviceID != "device-1" {
		t.Fatalf("result identity = %#v", result)
	}
}

func TestClientPullReturnsNilForNoContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client := NewClient(ClientConfig{BaseURL: server.URL, HTTPClient: server.Client()})
	delivery, err := client.Pull(context.Background())
	if err != nil || delivery != nil {
		t.Fatalf("Pull() = (%#v, %v)", delivery, err)
	}
}
