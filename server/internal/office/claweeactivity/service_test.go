package claweeactivity

import (
	"context"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
)

func TestServiceUsesTrustedAgentAndDirectDevice(t *testing.T) {
	req := validRequest(`{"text":"完成"}`)
	store := &fakeDirectStore{collectorID: "collector_direct"}
	reducer := &captureReducer{}
	binder := &captureBinder{}
	notifier := &captureNotifier{}
	service := NewService(store, reducer, binder, notifier, func() time.Time { return req.SentAt })

	if err := service.Report(context.Background(), "user_1", "trusted_agent", req); err != nil {
		t.Fatal(err)
	}
	if store.userID != "user_1" || store.agentID != "trusted_agent" {
		t.Fatalf("source ownership = %q/%q", store.userID, store.agentID)
	}
	if reducer.req.CollectorID != "collector_direct" || reducer.req.DeviceID != DirectDeviceID {
		t.Fatalf("reducer request = %#v", reducer.req)
	}
	for _, event := range reducer.req.Events {
		if event.AgentID != "trusted_agent" {
			t.Fatalf("event agent = %q", event.AgentID)
		}
	}
	if binder.agentID != "trusted_agent" || notifier.calls != 1 {
		t.Fatalf("binder/notifier = %#v calls=%d", binder, notifier.calls)
	}
}

type fakeDirectStore struct {
	collectorID string
	userID      string
	agentID     string
}

func (s *fakeDirectStore) GetOrCreateClaweeDirectSource(_ context.Context, userID, agentID string, _ time.Time) (string, error) {
	s.userID, s.agentID = userID, agentID
	return s.collectorID, nil
}

type captureReducer struct{ req collectorapi.EventsRequest }

func (r *captureReducer) ApplyEvents(_ context.Context, req collectorapi.EventsRequest, _ time.Time) (int, error) {
	r.req = req
	return len(req.Events), nil
}

type captureBinder struct{ agentID string }

func (b *captureBinder) BindMCPAgent(_ context.Context, _, agentID, _ string, _ time.Time) error {
	b.agentID = agentID
	return nil
}

type captureNotifier struct{ calls int }

func (n *captureNotifier) NotifyCollectorWriteApplied(_ context.Context, _ string, _ []dashboard.CollectorChange) {
	n.calls++
}
