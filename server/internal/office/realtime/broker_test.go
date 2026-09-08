package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/dashboard"
)

func TestBrokerPublishDeliversEventToSubscriber(t *testing.T) {
	broker := NewBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sub := broker.Subscribe(ctx)
	broker.Publish("agent.upserted", dashboard.RealtimeScope{
		CollectorID: "collector_1",
		AgentID:     "agent_same",
	}, json.RawMessage(`{"agent":{"collector_id":"collector_1","agent_id":"agent_same"}}`), time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC))

	select {
	case event := <-sub.Events:
		if event.Type != "agent.upserted" {
			t.Fatalf("Type = %q", event.Type)
		}
		if event.ID != "1" {
			t.Fatalf("ID = %q", event.ID)
		}
		if event.Envelope.Scope.CollectorID != "collector_1" || event.Envelope.Scope.AgentID != "agent_same" {
			t.Fatalf("scope = %#v", event.Envelope.Scope)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestBrokerUnsubscribeStopsDelivery(t *testing.T) {
	broker := NewBroker()
	ctx, cancel := context.WithCancel(context.Background())
	sub := broker.Subscribe(ctx)
	cancel()
	time.Sleep(10 * time.Millisecond)

	broker.Publish("agent.upserted", dashboard.RealtimeScope{CollectorID: "collector_1", AgentID: "agent_same"}, json.RawMessage(`{}`), time.Now().UTC())

	select {
	case event, ok := <-sub.Events:
		if ok {
			t.Fatalf("received event after unsubscribe: %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber channel did not close")
	}
}

func TestBrokerHelloIsOnlyWrittenToCurrentConnection(t *testing.T) {
	broker := NewBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := broker.Subscribe(ctx)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/realtime/events", nil)
	reqCtx, reqCancel := context.WithCancel(req.Context())
	req = req.WithContext(reqCtx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		broker.ServeHTTP(rec, req)
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	reqCancel()
	<-done

	if !strings.Contains(rec.Body.String(), "event: hello") {
		t.Fatalf("connection body does not contain hello: %s", rec.Body.String())
	}
	select {
	case event := <-sub.Events:
		t.Fatalf("existing subscriber received hello for another connection: %#v", event)
	default:
	}
}

func TestBrokerFilteredStreamOnlyWritesAllowedCollectorEvents(t *testing.T) {
	broker := NewBroker()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/activity/events", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		broker.ServeFilteredHTTP(rec, req, func(scope dashboard.RealtimeScope) bool {
			return scope.CollectorID == "collector_owned"
		})
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)

	broker.Publish("agent.upserted", dashboard.RealtimeScope{CollectorID: "collector_other"}, json.RawMessage(`{"marker":"other"}`), time.Now().UTC())
	broker.Publish("agent.upserted", dashboard.RealtimeScope{CollectorID: "collector_owned"}, json.RawMessage(`{"marker":"owned"}`), time.Now().UTC())
	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done

	body := rec.Body.String()
	if strings.Contains(body, `"marker":"other"`) {
		t.Fatalf("filtered stream leaked another collector event: %s", body)
	}
	if !strings.Contains(body, `"marker":"owned"`) {
		t.Fatalf("filtered stream omitted allowed collector event: %s", body)
	}
}
