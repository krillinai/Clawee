package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/collectorpull"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type fakeTaskBroker struct {
	delivery    collectorapi.TaskDelivery
	found       bool
	pullID      string
	completeID  string
	completeReq collectorapi.TaskResultRequest
	completeErr error
}

func (b *fakeTaskBroker) Pull(_ context.Context, collectorID string) (collectorapi.TaskDelivery, bool, error) {
	b.pullID = collectorID
	return b.delivery, b.found, nil
}

func (b *fakeTaskBroker) Complete(collectorID string, req collectorapi.TaskResultRequest) error {
	b.completeID = collectorID
	b.completeReq = req
	return b.completeErr
}

func TestCollectorTaskPullAuthenticatesAndReturnsDelivery(t *testing.T) {
	broker := &fakeTaskBroker{found: true, delivery: collectorapi.TaskDelivery{
		SchemaVersion: collectorapi.TaskSchemaVersion, TaskID: "task-1", ClaimID: "claim-1", Tool: "codex.ask",
	}}
	api := NewCollectorAPIWithOptions(CollectorAPIOptions{
		Authenticator: &fakeAuthenticator{identities: map[string]CollectorIdentity{"token-1": {CollectorID: "collector-1"}}},
		TaskBroker:    broker, Now: func() time.Time { return handlerNow },
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/tasks/pull", jsonBody(t, collectorapi.TaskPullRequest{
		SchemaVersion: collectorapi.TaskSchemaVersion, CollectorID: "collector-1", DeviceID: "device-1",
	}))
	req.Header.Set("Authorization", "Bearer token-1")
	api.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || broker.pullID != "collector-1" {
		t.Fatalf("status=%d pullID=%q body=%s", rec.Code, broker.pullID, rec.Body.String())
	}
	var delivery collectorapi.TaskDelivery
	if err := json.Unmarshal(rec.Body.Bytes(), &delivery); err != nil || delivery.TaskID != "task-1" {
		t.Fatalf("delivery=%#v err=%v", delivery, err)
	}
}

func TestCollectorTaskPullRejectsCollectorMismatch(t *testing.T) {
	broker := &fakeTaskBroker{}
	api := NewCollectorAPIWithOptions(CollectorAPIOptions{
		Authenticator: &fakeAuthenticator{identities: map[string]CollectorIdentity{"token-1": {CollectorID: "collector-1"}}},
		TaskBroker:    broker,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/tasks/pull", jsonBody(t, collectorapi.TaskPullRequest{
		SchemaVersion: collectorapi.TaskSchemaVersion, CollectorID: "collector-2", DeviceID: "device-1",
	}))
	req.Header.Set("Authorization", "Bearer token-1")
	api.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || broker.pullID != "" {
		t.Fatalf("status=%d pullID=%q body=%s", rec.Code, broker.pullID, rec.Body.String())
	}
}

func TestCollectorTaskResultMapsConflictAndAcceptsIdempotentCompletion(t *testing.T) {
	result := collectorapi.TaskResultRequest{
		SchemaVersion: collectorapi.TaskSchemaVersion, CollectorID: "collector-1", DeviceID: "device-1",
		TaskID: "task-1", ClaimID: "claim-1", Status: collectorapi.TaskResultSucceeded,
		Output: &collectorapi.TaskResultOutput{Answer: "完成"},
	}
	for _, tt := range []struct {
		name string
		err  error
		want int
	}{
		{name: "accepted", want: http.StatusAccepted},
		{name: "conflict", err: collectorpull.ErrConflict, want: http.StatusConflict},
		{name: "invalid", err: collectorpull.ErrInvalid, want: http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			broker := &fakeTaskBroker{completeErr: tt.err}
			api := NewCollectorAPIWithOptions(CollectorAPIOptions{
				Authenticator: &fakeAuthenticator{identities: map[string]CollectorIdentity{"token-1": {CollectorID: "collector-1"}}},
				TaskBroker:    broker, Now: func() time.Time { return handlerNow },
			})
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/tasks/result", jsonBody(t, result))
			req.Header.Set("Authorization", "Bearer token-1")
			api.Handler().ServeHTTP(rec, req)
			if rec.Code != tt.want || broker.completeID != "collector-1" {
				t.Fatalf("status=%d completeID=%q body=%s", rec.Code, broker.completeID, rec.Body.String())
			}
		})
	}
}
