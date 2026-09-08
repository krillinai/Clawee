package claweeactivity

import (
	"context"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
)

type DirectSourceStore interface {
	GetOrCreateClaweeDirectSource(context.Context, string, string, time.Time) (string, error)
}

type Reducer interface {
	ApplyEvents(context.Context, collectorapi.EventsRequest, time.Time) (int, error)
}

type AgentBinder interface {
	BindMCPAgent(context.Context, string, string, string, time.Time) error
}

type DashboardNotifier interface {
	NotifyCollectorWriteApplied(context.Context, string, []dashboard.CollectorChange)
}

type Service struct {
	store    DirectSourceStore
	reducer  Reducer
	binder   AgentBinder
	notifier DashboardNotifier
	now      func() time.Time
}

func NewService(store DirectSourceStore, reducer Reducer, binder AgentBinder, notifier DashboardNotifier, now func() time.Time) *Service {
	return &Service{store: store, reducer: reducer, binder: binder, notifier: notifier, now: now}
}

func (s *Service) Report(ctx context.Context, userID, agentID string, req EventsRequest) error {
	if err := ValidateAndSanitize(&req); err != nil {
		return err
	}
	receivedAt := time.Now().UTC()
	if s.now != nil {
		receivedAt = s.now().UTC()
	}
	collectorID, err := s.store.GetOrCreateClaweeDirectSource(ctx, userID, agentID, receivedAt)
	if err != nil {
		return err
	}
	events := make([]collectorapi.CollectorEvent, 0, len(req.Events)*2)
	for _, event := range req.Events {
		mapped, err := MapEvent(event, agentID)
		if err != nil {
			return err
		}
		for i := range mapped {
			mapped[i].AgentID = agentID
			mapped[i].AgentType = collectorapi.AgentTypeCodex
			mapped[i].SourceType = collectorSourceType
		}
		events = append(events, mapped...)
	}
	accepted, err := s.reducer.ApplyEvents(ctx, collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   collectorID,
		DeviceID:      DirectDeviceID,
		SentAt:        req.SentAt,
		Events:        events,
	}, receivedAt)
	if err != nil {
		return err
	}
	if err := s.binder.BindMCPAgent(ctx, collectorID, agentID, agentID, receivedAt); err != nil {
		return err
	}
	if accepted > 0 && s.notifier != nil {
		s.notifier.NotifyCollectorWriteApplied(ctx, collectorID, []dashboard.CollectorChange{{
			AgentID: agentID, RequiresSnapshot: true,
		}})
	}
	return nil
}
