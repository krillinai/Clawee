package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/registration"
)

var handlerNow = time.Date(2026, 6, 2, 12, 0, 0, 0, time.UTC)

func TestCollectorHeartbeatNormalizesAndProvisionsUniqueAgentsBeforeReducerAndBindsAfter(t *testing.T) {
	log := &collectorCallLog{}
	provisioner := &fakeAgentProvisioner{log: log}
	binder := &fakeAgentBinder{log: log}
	reducer := &fakeReducer{log: log}
	notifier := &fakeDashboardNotifier{log: log}
	api := NewCollectorAPIWithOptions(CollectorAPIOptions{
		Authenticator: &fakeAuthenticator{identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1", UserID: "usr_1"},
		}},
		Reducer: reducer, Now: func() time.Time { return handlerNow },
		DashboardNotifier: notifier, AgentProvisioner: provisioner, AgentBinder: binder,
	})
	req := collectorapi.HeartbeatRequest{
		SchemaVersion: collectorapi.SchemaVersion, CollectorID: "collector_1", DeviceID: "device_1",
		Agents: []collectorapi.AgentSummary{
			{AgentID: " agent_1 ", AgentType: collectorapi.AgentTypeCodex, DisplayName: "Codex", Status: collectorapi.StatusIdle, LastSeenAt: handlerNow},
			{AgentID: "agent_1", AgentType: collectorapi.AgentTypeCodex, DisplayName: "Ignored duplicate", Status: collectorapi.StatusIdle, LastSeenAt: handlerNow},
		},
	}
	rec := httptest.NewRecorder()
	httpReq := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", jsonBody(t, req))
	httpReq.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, httpReq)

	if rec.Code != http.StatusAccepted || len(provisioner.requests) != 1 || reducer.heartbeatCalls != 1 || len(binder.calls) != 1 {
		t.Fatalf("status=%d provision=%#v heartbeat=%d bind=%#v body=%s", rec.Code, provisioner.requests, reducer.heartbeatCalls, binder.calls, rec.Body.String())
	}
	got := provisioner.requests[0]
	if got.UserID != "usr_1" || got.AgentID != "agent_1" || got.ClientID != "codex" || got.DisplayName != "" || got.Source != agentprovisioning.SourceCollector {
		t.Fatalf("provision request = %#v", got)
	}
	if got := binder.calls[0]; got.collectorID != "collector_1" || got.officeAgentID != "agent_1" || got.mcpAgentID != "agent_1" {
		t.Fatalf("bind call = %#v", got)
	}
	for i, agent := range reducer.lastHeartbeat.Agents {
		if agent.AgentID != "agent_1" || agent.DisplayName != "" {
			t.Fatalf("reducer heartbeat agent[%d] = %#v", i, agent)
		}
	}
	if !reflect.DeepEqual(notifier.agentIDs, []string{"agent_1"}) {
		t.Fatalf("notifier agent ids = %#v", notifier.agentIDs)
	}
	if !reflect.DeepEqual(log.calls, []string{"provision", "reduce-heartbeat", "bind", "notify"}) {
		t.Fatalf("calls = %#v", log.calls)
	}
}

func TestCollectorEventsNormalizeTopLevelAgentsOnly(t *testing.T) {
	child := " sub_1 "
	log := &collectorCallLog{}
	provisioner := &fakeAgentProvisioner{log: log}
	binder := &fakeAgentBinder{log: log}
	reducer := &fakeReducer{log: log, eventsCount: 2}
	api := NewCollectorAPIWithOptions(CollectorAPIOptions{
		Authenticator: &fakeAuthenticator{identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1", UserID: "usr_1"},
		}},
		Reducer: reducer, Now: func() time.Time { return handlerNow },
		AgentProvisioner: provisioner, AgentBinder: binder,
	})
	events := []collectorapi.CollectorEvent{
		{EventID: "event_1", EventType: collectorapi.EventTurnStarted, OccurredAt: handlerNow, AgentID: " agent_1 ", AgentType: collectorapi.AgentTypeCodex, SubAgentID: &child, Status: collectorapi.StatusCoding, Turn: &collectorapi.TurnSummary{TurnID: "turn_1", SessionID: "session_1", ParentAgentID: " parent_1 ", Status: collectorapi.StatusCoding, StartedAt: handlerNow, UpdatedAt: handlerNow}},
		{EventID: "event_2", EventType: collectorapi.EventSubAgentCreated, OccurredAt: handlerNow, AgentID: "agent_1", AgentType: collectorapi.AgentTypeCodex, Status: collectorapi.StatusCoding, SubAgent: &collectorapi.SubAgentSummary{SubAgentID: child, ParentAgentID: " parent_1 ", Status: collectorapi.StatusCoding, StartedAt: handlerNow, UpdatedAt: handlerNow}},
	}
	rec := httptest.NewRecorder()
	httpReq := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{SchemaVersion: collectorapi.SchemaVersion, CollectorID: "collector_1", DeviceID: "device_1", Events: events}))
	httpReq.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, httpReq)

	if rec.Code != http.StatusAccepted || len(provisioner.requests) != 1 || len(binder.calls) != 1 {
		t.Fatalf("status=%d provision=%#v bind=%#v", rec.Code, provisioner.requests, binder.calls)
	}
	if got := provisioner.requests[0]; got.AgentID != "agent_1" || got.DisplayName != "" || got.ClientID != "codex" || got.Source != agentprovisioning.SourceCollector {
		t.Fatalf("provision request = %#v", got)
	}
	if len(reducer.lastEvents.Events) != 2 || reducer.lastEvents.Events[0].AgentID != "agent_1" || reducer.lastEvents.Events[1].AgentID != "agent_1" {
		t.Fatalf("reducer events = %#v", reducer.lastEvents.Events)
	}
	if got := reducer.lastEvents.Events[0]; got.SubAgentID == nil || *got.SubAgentID != " sub_1 " || got.Turn == nil || got.Turn.ParentAgentID != " parent_1 " {
		t.Fatalf("nested event ids changed = %#v", got)
	}
	if got := reducer.lastEvents.Events[1]; got.SubAgent == nil || got.SubAgent.SubAgentID != " sub_1 " || got.SubAgent.ParentAgentID != " parent_1 " {
		t.Fatalf("nested sub-agent ids changed = %#v", got)
	}
	if got := binder.calls[0]; got.officeAgentID != "agent_1" || got.mcpAgentID != "agent_1" {
		t.Fatalf("bind call = %#v", got)
	}
	if !reflect.DeepEqual(log.calls, []string{"provision", "reduce-events", "bind"}) {
		t.Fatalf("calls = %#v", log.calls)
	}
}

func TestCollectorProvisioningErrorsStopBeforeReducerAndBinder(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		statusCode int
		code       string
	}{
		{name: "invalid agent id", err: agentprovisioning.ErrInvalidAgentID, statusCode: http.StatusBadRequest, code: "invalid_agent_id"},
		{name: "agent id conflict", err: agentprovisioning.ErrAgentIDConflict, statusCode: http.StatusConflict, code: "agent_id_conflict"},
		{name: "internal error", err: errors.New("provision failed"), statusCode: http.StatusInternalServerError, code: "internal_error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provisioner := &fakeAgentProvisioner{err: tt.err}
			binder := &fakeAgentBinder{}
			reducer := &fakeReducer{}
			api := newProvisioningTestAPI(reducer, provisioner, binder, nil)
			rec := serveCollectorHeartbeat(t, api)

			if rec.Code != tt.statusCode {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec.Body.String(), tt.code)
			if reducer.heartbeatCalls != 0 || len(binder.calls) != 0 {
				t.Fatalf("reducer=%d binder=%#v", reducer.heartbeatCalls, binder.calls)
			}
		})
	}
}

func TestCollectorBindingErrorsStopBeforeNotifier(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		statusCode int
		code       string
	}{
		{name: "office agent already bound", err: management.ErrOfficeAgentAlreadyBound, statusCode: http.StatusConflict, code: "agent_binding_conflict"},
		{name: "mcp agent already bound", err: management.ErrMCPAgentAlreadyBound, statusCode: http.StatusConflict, code: "agent_binding_conflict"},
		{name: "internal error", err: errors.New("bind failed"), statusCode: http.StatusInternalServerError, code: "internal_error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reducer := &fakeReducer{}
			notifier := &fakeDashboardNotifier{}
			api := newProvisioningTestAPI(reducer, &fakeAgentProvisioner{}, &fakeAgentBinder{err: tt.err}, notifier)
			rec := serveCollectorHeartbeat(t, api)

			if rec.Code != tt.statusCode {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec.Body.String(), tt.code)
			if reducer.heartbeatCalls != 1 || notifier.calls != 0 {
				t.Fatalf("reducer=%d notifier=%d", reducer.heartbeatCalls, notifier.calls)
			}
		})
	}
}

func TestCollectorProvisioningRequiresBothDependencies(t *testing.T) {
	for _, opts := range []CollectorAPIOptions{
		{Authenticator: collectorTestAuthenticator(), Reducer: &fakeReducer{}, Now: func() time.Time { return handlerNow }, AgentProvisioner: &fakeAgentProvisioner{}},
		{Authenticator: collectorTestAuthenticator(), Reducer: &fakeReducer{}, Now: func() time.Time { return handlerNow }, AgentBinder: &fakeAgentBinder{}},
	} {
		api := NewCollectorAPIWithOptions(opts)
		rec := serveCollectorHeartbeat(t, api)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		assertErrorCode(t, rec.Body.String(), "internal_error")
	}
}

func TestCollectorHeartbeatMissingBearerTokenReturnsUnauthorized(t *testing.T) {
	api := newTestAPI(t, &fakeAuthenticator{}, &fakeReducer{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", strings.NewReader(`{}`))
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "unauthorized")
}

func TestCollectorHeartbeatValidRequestReturnsAcceptedAndCallsReducer(t *testing.T) {
	reducer := &fakeReducer{}
	api := newTestAPI(t, &fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, reducer)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", jsonBody(t, collectorapi.HeartbeatRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        handlerNow,
		Agents: []collectorapi.AgentSummary{{
			AgentID:     "agent_1",
			AgentType:   collectorapi.AgentTypeCodex,
			Status:      collectorapi.StatusIdle,
			LastSeenAt:  handlerNow,
			DisplayName: "Codex",
		}},
	}))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if reducer.heartbeatCalls != 1 {
		t.Fatalf("heartbeatCalls = %d", reducer.heartbeatCalls)
	}
	if reducer.lastHeartbeat.CollectorID != "collector_1" {
		t.Fatalf("lastHeartbeat = %#v", reducer.lastHeartbeat)
	}
	var resp collectorapi.AcceptedResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Accepted {
		t.Fatalf("accepted = false, body = %#v", resp)
	}
	if resp.ServerTime != handlerNow {
		t.Fatalf("server_time = %s", resp.ServerTime)
	}
	if resp.ReceivedAgents != 1 {
		t.Fatalf("received_agents = %d", resp.ReceivedAgents)
	}
}

func TestCollectorEventsReturnsReducerAcceptedCount(t *testing.T) {
	reducer := &fakeReducer{eventsCount: 1}
	api := newTestAPI(t, &fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, reducer)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        handlerNow,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "event_1",
			EventType:  collectorapi.EventAgentSeen,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusIdle,
		}, {
			EventID:    "event_1",
			EventType:  collectorapi.EventAgentSeen,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusIdle,
		}},
	}))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp collectorapi.AcceptedResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.ReceivedEvents != 1 {
		t.Fatalf("received_events = %d", resp.ReceivedEvents)
	}
	if reducer.eventsCalls != 1 {
		t.Fatalf("eventsCalls = %d", reducer.eventsCalls)
	}
}

func TestCollectorEventsInvalidEventReturnsBadRequest(t *testing.T) {
	tests := []struct {
		name  string
		event collectorapi.CollectorEvent
		code  string
	}{
		{
			name: "missing event id",
			event: collectorapi.CollectorEvent{
				EventType:  collectorapi.EventAgentSeen,
				OccurredAt: handlerNow,
				AgentID:    "agent_1",
				AgentType:  collectorapi.AgentTypeCodex,
				Status:     collectorapi.StatusIdle,
			},
			code: "invalid_event_id",
		},
		{
			name: "missing event type",
			event: collectorapi.CollectorEvent{
				EventID:    "event_1",
				OccurredAt: handlerNow,
				AgentID:    "agent_1",
				AgentType:  collectorapi.AgentTypeCodex,
				Status:     collectorapi.StatusIdle,
			},
			code: "invalid_event_type",
		},
		{
			name: "missing occurred at",
			event: collectorapi.CollectorEvent{
				EventID:   "event_1",
				EventType: collectorapi.EventAgentSeen,
				AgentID:   "agent_1",
				AgentType: collectorapi.AgentTypeCodex,
				Status:    collectorapi.StatusIdle,
			},
			code: "invalid_occurred_at",
		},
		{
			name: "missing agent id",
			event: collectorapi.CollectorEvent{
				EventID:    "event_1",
				EventType:  collectorapi.EventAgentSeen,
				OccurredAt: handlerNow,
				AgentType:  collectorapi.AgentTypeCodex,
				Status:     collectorapi.StatusIdle,
			},
			code: "invalid_agent_id",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reducer := &fakeReducer{}
			api := newTestAPI(t, &fakeAuthenticator{
				identities: map[string]CollectorIdentity{
					"token_1": {CollectorID: "collector_1"},
				},
			}, reducer)

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{
				SchemaVersion: collectorapi.SchemaVersion,
				CollectorID:   "collector_1",
				DeviceID:      "device_1",
				SentAt:        handlerNow,
				Events:        []collectorapi.CollectorEvent{tt.event},
			}))
			req.Header.Set("Authorization", "Bearer token_1")
			api.Handler().ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec.Body.String(), tt.code)
			if reducer.eventsCalls != 0 {
				t.Fatalf("eventsCalls = %d", reducer.eventsCalls)
			}
		})
	}
}

func TestCollectorIDMismatchReturnsForbidden(t *testing.T) {
	api := newTestAPI(t, &fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, &fakeReducer{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", jsonBody(t, collectorapi.HeartbeatRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_2",
		DeviceID:      "device_1",
		SentAt:        handlerNow,
	}))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "collector_mismatch")
}

func TestCollectorPayloadTooLargeReturnsPayloadTooLarge(t *testing.T) {
	api := newTestAPI(t, &fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, &fakeReducer{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", strings.NewReader(strings.Repeat("x", 1024*1024+1)))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "payload_too_large")
}

func TestCollectorPayloadTooLargeWithInvalidJSONPrefixReturnsPayloadTooLarge(t *testing.T) {
	api := newTestAPI(t, &fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, &fakeReducer{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", strings.NewReader("{"+strings.Repeat("x", int(maxCollectorBodyBytes)+1)))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "payload_too_large")
}

func TestCollectorPayloadTooLargeAfterValidJSONReturnsPayloadTooLarge(t *testing.T) {
	api := newTestAPI(t, &fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, &fakeReducer{})

	body, err := json.Marshal(collectorapi.HeartbeatRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        handlerNow,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := string(body) + strings.Repeat(" ", int(maxCollectorBodyBytes)+1)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", strings.NewReader(payload))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "payload_too_large")
}

func TestCollectorInvalidJSONReturnsBadRequest(t *testing.T) {
	api := newTestAPI(t, &fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, &fakeReducer{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", strings.NewReader("{"))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "invalid_json")
}

func TestCollectorTrailingJSONReturnsBadRequest(t *testing.T) {
	tests := []struct {
		name     string
		trailing string
	}{
		{name: "second json value", trailing: `{}`},
		{name: "garbage", trailing: `garbage`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reducer := &fakeReducer{}
			api := newTestAPI(t, &fakeAuthenticator{
				identities: map[string]CollectorIdentity{
					"token_1": {CollectorID: "collector_1"},
				},
			}, reducer)

			body, err := json.Marshal(collectorapi.HeartbeatRequest{
				SchemaVersion: collectorapi.SchemaVersion,
				CollectorID:   "collector_1",
				DeviceID:      "device_1",
				SentAt:        handlerNow,
			})
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", strings.NewReader(string(body)+tt.trailing))
			req.Header.Set("Authorization", "Bearer token_1")
			api.Handler().ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec.Body.String(), "invalid_json")
			if reducer.heartbeatCalls != 0 {
				t.Fatalf("heartbeatCalls = %d", reducer.heartbeatCalls)
			}
		})
	}
}

func TestCollectorNonPostReturnsMethodNotAllowed(t *testing.T) {
	api := newTestAPI(t, &fakeAuthenticator{}, &fakeReducer{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/collector/heartbeat", nil)
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "method_not_allowed")
}

func TestCollectorAuthenticatorErrorReturnsInternalError(t *testing.T) {
	api := newTestAPI(t, &fakeAuthenticator{err: errors.New("lookup failed")}, &fakeReducer{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "internal_error")
}

func TestCollectorEventsAttachesReducerError(t *testing.T) {
	reducerErr := errors.New("insert office_agent_tool_calls: relation does not exist")
	api := newTestAPI(t, &fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, &fakeReducer{err: reducerErr})
	sink := NewRequestErrorSink()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        handlerNow,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "event_1",
			EventType:  collectorapi.EventAgentSeen,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusIdle,
		}},
	}))
	req = req.WithContext(ContextWithRequestErrorSink(req.Context(), sink))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	errs := sink.Errors()
	if len(errs) != 1 || !errors.Is(errs[0], reducerErr) {
		t.Fatalf("attached errors = %#v, want reducer error", errs)
	}
}

func TestCollectorRegisterValidRequestReturnsCreated(t *testing.T) {
	registrar := &fakeRegistrar{resp: collectorapi.RegistrationResponse{
		CollectorID:    "collector_123",
		CollectorToken: "collector_token",
		DeviceID:       "device_123",
		PrivacyMode:    "summary_only",
	}}
	api := newRegistrationTestAPI(t, registrar)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/register", jsonBody(t, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "ABCD-1234",
		AgentID:          " agent_1 ",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
	}))
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if registrar.calls != 1 {
		t.Fatalf("registrar calls = %d", registrar.calls)
	}
	if registrar.last.AgentID != "agent_1" {
		t.Fatalf("agent_id = %q, want trimmed value", registrar.last.AgentID)
	}
}

func TestCollectorRegisterRejectsInvalidAgentID(t *testing.T) {
	for _, agentID := range []string{"", "   ", strings.Repeat("a", 65), strings.Repeat("中", 65)} {
		t.Run(agentID, func(t *testing.T) {
			registrar := &fakeRegistrar{}
			api := newRegistrationTestAPI(t, registrar)
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/register", jsonBody(t, collectorapi.RegistrationRequest{
				SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "ABCD-1234", AgentID: agentID,
				OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
			}))
			api.Handler().ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec.Body.String(), "invalid_agent_id")
			if registrar.calls != 0 {
				t.Fatalf("registrar calls = %d", registrar.calls)
			}
		})
	}
}

func TestCollectorRegisterMissingArchReturnsInvalidDevice(t *testing.T) {
	registrar := &fakeRegistrar{}
	api := newRegistrationTestAPI(t, registrar)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/register", jsonBody(t, collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "ABCD-1234",
		AgentID:          "agent_1",
		OS:               "darwin",
		CollectorVersion: "0.1.0",
	}))
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "invalid_device")
	if registrar.calls != 0 {
		t.Fatalf("registrar calls = %d", registrar.calls)
	}
}

func TestCollectorRegisterRegistrationErrorsReturnUnauthorized(t *testing.T) {
	tests := []struct {
		name string
		err  error
		code string
	}{
		{
			name: "invalid code",
			err:  registration.ErrInvalidRegistrationCode,
			code: "invalid_registration_code",
		},
		{
			name: "expired code",
			err:  registration.ErrRegistrationCodeExpired,
			code: "registration_code_expired",
		},
		{
			name: "revoked code",
			err:  registration.ErrRegistrationCodeRevoked,
			code: "registration_code_revoked",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			registrar := &fakeRegistrar{err: tt.err}
			api := newRegistrationTestAPI(t, registrar)

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/register", jsonBody(t, collectorapi.RegistrationRequest{
				SchemaVersion:    collectorapi.SchemaVersion,
				RegistrationCode: "ABCD-1234",
				AgentID:          "agent_1",
				OS:               "darwin",
				Arch:             "arm64",
				CollectorVersion: "0.1.0",
			}))
			api.Handler().ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec.Body.String(), tt.code)
			if registrar.calls != 1 {
				t.Fatalf("registrar calls = %d", registrar.calls)
			}
		})
	}
}

func TestCollectorRegisterAgentIDConflictReturnsConflict(t *testing.T) {
	registrar := &fakeRegistrar{err: registration.ErrAgentIDConflict}
	api := newRegistrationTestAPI(t, registrar)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/register", jsonBody(t, collectorapi.RegistrationRequest{
		SchemaVersion: collectorapi.SchemaVersion, RegistrationCode: "ABCD-1234", AgentID: "agent_1",
		OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0",
	}))
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "agent_id_conflict")
}

func TestCollectorEventsNotifyChangedAgentsAfterReducerSuccess(t *testing.T) {
	reducer := &fakeReducer{eventsCount: 2}
	notifier := &fakeDashboardNotifier{}
	api := NewCollectorAPIWithNotifier(&fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, reducer, nil, func() time.Time {
		return handlerNow
	}, notifier)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        handlerNow,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "event_1",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusSearching,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "activity_1",
				ActivityType: collectorapi.ActivitySearching,
				StartedAt:    handlerNow,
			},
		}, {
			EventID:    "event_2",
			EventType:  collectorapi.EventTurnUpdated,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusCoding,
		}, {
			EventID:    "event_3",
			EventType:  collectorapi.EventTurnUpdated,
			OccurredAt: handlerNow,
			AgentID:    "agent_2",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusThinking,
		}},
	}))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if notifier.calls != 1 {
		t.Fatalf("notifier calls = %d", notifier.calls)
	}
	if notifier.collectorID != "collector_1" {
		t.Fatalf("collectorID = %q", notifier.collectorID)
	}
	if strings.Join(notifier.agentIDs, ",") != "agent_1,agent_2" {
		t.Fatalf("agentIDs = %#v", notifier.agentIDs)
	}
	if !notifier.changes[0].HasActivityStarted {
		t.Fatalf("first change did not mark activity started: %#v", notifier.changes[0])
	}
	if !notifier.changes[0].HasTurnChange {
		t.Fatalf("first change did not merge turn change: %#v", notifier.changes[0])
	}
	if got := strings.Join(notifier.changes[0].TurnIDs, ","); got != "" {
		t.Fatalf("first change TurnIDs = %q", got)
	}
	if !notifier.changes[1].HasTurnChange {
		t.Fatalf("second change did not mark turn change: %#v", notifier.changes[1])
	}
}

func TestCollectorEventsNotifyPreservesMultipleSessionAndTurnIDsForSameAgent(t *testing.T) {
	reducer := &fakeReducer{eventsCount: 5}
	notifier := &fakeDashboardNotifier{}
	api := NewCollectorAPIWithNotifier(&fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, reducer, nil, func() time.Time {
		return handlerNow
	}, notifier)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        handlerNow,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "session_1",
			EventType:  collectorapi.EventSessionUpdated,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_1",
			Status:     collectorapi.StatusCoding,
		}, {
			EventID:    "session_2",
			EventType:  collectorapi.EventSessionUpdated,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_2",
			Status:     collectorapi.StatusThinking,
		}, {
			EventID:    "turn_1",
			EventType:  collectorapi.EventTurnUpdated,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_1",
			TurnID:     "turn_1",
			Status:     collectorapi.StatusCoding,
		}, {
			EventID:    "turn_2",
			EventType:  collectorapi.EventTurnUpdated,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_2",
			TurnID:     "turn_2",
			Status:     collectorapi.StatusThinking,
		}, {
			EventID:    "turn_3",
			EventType:  collectorapi.EventTurnCompleted,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SessionID:  "session_2",
			TurnID:     "turn_3",
			Status:     collectorapi.StatusIdle,
		}},
	}))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if notifier.calls != 1 || len(notifier.changes) != 1 {
		t.Fatalf("notifier calls=%d changes=%#v", notifier.calls, notifier.changes)
	}
	change := notifier.changes[0]
	if got := strings.Join(change.SessionIDs, ","); got != "session_1,session_2" {
		t.Fatalf("SessionIDs = %q", got)
	}
	if got := strings.Join(change.TurnIDs, ","); got != "turn_1,turn_2" {
		t.Fatalf("TurnIDs = %q", got)
	}
	if got := strings.Join(change.CompletedTurnIDs, ","); got != "turn_3" {
		t.Fatalf("CompletedTurnIDs = %q", got)
	}
}

func TestCollectorEventsNotifyPreservesMultipleActivityAndSubAgentIDsForSameAgent(t *testing.T) {
	child1 := "sub_1"
	child2 := "sub_2"
	reducer := &fakeReducer{eventsCount: 6}
	notifier := &fakeDashboardNotifier{}
	api := NewCollectorAPIWithNotifier(&fakeAuthenticator{
		identities: map[string]CollectorIdentity{
			"token_1": {CollectorID: "collector_1"},
		},
	}, reducer, nil, func() time.Time {
		return handlerNow
	}, notifier)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", jsonBody(t, collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        handlerNow,
		Events: []collectorapi.CollectorEvent{{
			EventID:    "activity_started_1",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusCoding,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "activity_started_1",
				ActivityType: collectorapi.ActivityCoding,
				StartedAt:    handlerNow,
			},
		}, {
			EventID:    "activity_started_2",
			EventType:  collectorapi.EventActivityStarted,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusReadingFiles,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "activity_started_2",
				ActivityType: collectorapi.ActivityReadingFiles,
				StartedAt:    handlerNow,
			},
		}, {
			EventID:    "activity_completed_1",
			EventType:  collectorapi.EventActivityCompleted,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusIdle,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "activity_completed_1",
				ActivityType: collectorapi.ActivityRunningCommands,
				StartedAt:    handlerNow.Add(-time.Minute),
			},
		}, {
			EventID:    "activity_completed_2",
			EventType:  collectorapi.EventToolCallCompleted,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			Status:     collectorapi.StatusIdle,
			Activity: &collectorapi.ActivitySummary{
				ActivityID:   "activity_completed_2",
				ActivityType: collectorapi.ActivitySearching,
				StartedAt:    handlerNow.Add(-time.Minute),
			},
		}, {
			EventID:    "sub_1",
			EventType:  collectorapi.EventSubAgentStatusChanged,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SubAgentID: &child1,
			Status:     collectorapi.StatusCoding,
		}, {
			EventID:    "sub_2",
			EventType:  collectorapi.EventSubAgentStatusChanged,
			OccurredAt: handlerNow,
			AgentID:    "agent_1",
			AgentType:  collectorapi.AgentTypeCodex,
			SubAgentID: &child2,
			Status:     collectorapi.StatusSearching,
		}},
	}))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if notifier.calls != 1 || len(notifier.changes) != 1 {
		t.Fatalf("notifier calls=%d changes=%#v", notifier.calls, notifier.changes)
	}
	change := notifier.changes[0]
	if got := strings.Join(change.ActivityStartedIDs, ","); got != "activity_started_1,activity_started_2" {
		t.Fatalf("ActivityStartedIDs = %q", got)
	}
	if got := strings.Join(change.ActivityCompletedIDs, ","); got != "activity_completed_1,activity_completed_2" {
		t.Fatalf("ActivityCompletedIDs = %q", got)
	}
	if got := strings.Join(change.SubAgentIDs, ","); got != "sub_1,sub_2" {
		t.Fatalf("SubAgentIDs = %q", got)
	}
}

func TestCollectorChangeFromEventMarksSessionAndTurnChanges(t *testing.T) {
	tests := []struct {
		name              string
		eventType         collectorapi.EventType
		wantSessionChange bool
		wantTurnChange    bool
		wantTurnCompleted bool
	}{
		{name: "session started", eventType: collectorapi.EventSessionStarted, wantSessionChange: true},
		{name: "session updated", eventType: collectorapi.EventSessionUpdated, wantSessionChange: true},
		{name: "session completed", eventType: collectorapi.EventSessionCompleted, wantSessionChange: true},
		{name: "turn started", eventType: collectorapi.EventTurnStarted, wantTurnChange: true},
		{name: "turn updated", eventType: collectorapi.EventTurnUpdated, wantTurnChange: true},
		{name: "turn completed", eventType: collectorapi.EventTurnCompleted, wantTurnCompleted: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			change := collectorChangeFromEvent(collectorapi.CollectorEvent{
				EventID:    "event_1",
				EventType:  tt.eventType,
				OccurredAt: handlerNow,
				AgentID:    "agent_1",
				AgentType:  collectorapi.AgentTypeCodex,
				SessionID:  "session_1",
				TurnID:     "turn_1",
				Status:     collectorapi.StatusCoding,
			})

			if change.SessionID != "session_1" || change.TurnID != "turn_1" {
				t.Fatalf("scope IDs = %#v", change)
			}
			if change.HasSessionChange != tt.wantSessionChange ||
				change.HasTurnChange != tt.wantTurnChange ||
				change.HasTurnCompleted != tt.wantTurnCompleted {
				t.Fatalf("change = %#v", change)
			}
		})
	}
}

func newTestAPI(t *testing.T, authenticator Authenticator, reducer *fakeReducer) *CollectorAPI {
	t.Helper()
	return NewCollectorAPI(authenticator, reducer, nil, func() time.Time {
		return handlerNow
	})
}

func newRegistrationTestAPI(t *testing.T, registrar *fakeRegistrar) *CollectorAPI {
	t.Helper()
	return NewCollectorAPI(&fakeAuthenticator{}, &fakeReducer{}, registrar, func() time.Time {
		return handlerNow
	})
}

func newProvisioningTestAPI(reducer *fakeReducer, provisioner AgentProvisioner, binder AgentBinder, notifier DashboardNotifier) *CollectorAPI {
	return NewCollectorAPIWithOptions(CollectorAPIOptions{
		Authenticator:     collectorTestAuthenticator(),
		Reducer:           reducer,
		Now:               func() time.Time { return handlerNow },
		DashboardNotifier: notifier,
		AgentProvisioner:  provisioner,
		AgentBinder:       binder,
	})
}

func collectorTestAuthenticator() *fakeAuthenticator {
	return &fakeAuthenticator{identities: map[string]CollectorIdentity{
		"token_1": {CollectorID: "collector_1", UserID: "usr_1"},
	}}
}

func serveCollectorHeartbeat(t *testing.T, api *CollectorAPI) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", jsonBody(t, collectorapi.HeartbeatRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		Agents: []collectorapi.AgentSummary{{
			AgentID:     "agent_1",
			AgentType:   collectorapi.AgentTypeCodex,
			DisplayName: "Codex",
			Status:      collectorapi.StatusIdle,
			LastSeenAt:  handlerNow,
		}},
	}))
	req.Header.Set("Authorization", "Bearer token_1")
	api.Handler().ServeHTTP(rec, req)
	return rec
}

func jsonBody(t *testing.T, payload any) *bytes.Reader {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(body)
}

func assertErrorCode(t *testing.T, body string, want string) {
	t.Helper()
	if !strings.Contains(body, `"code":"`+want+`"`) {
		t.Fatalf("body does not contain code %q: %s", want, body)
	}
}

type fakeAuthenticator struct {
	identities map[string]CollectorIdentity
	err        error
}

func (a *fakeAuthenticator) Authenticate(ctx context.Context, token string) (CollectorIdentity, bool, error) {
	if a.err != nil {
		return CollectorIdentity{}, false, a.err
	}
	identity, ok := a.identities[token]
	return identity, ok, nil
}

type fakeReducer struct {
	heartbeatCalls int
	eventsCalls    int
	lastHeartbeat  collectorapi.HeartbeatRequest
	lastEvents     collectorapi.EventsRequest
	eventsCount    int
	err            error
	log            *collectorCallLog
}

func (r *fakeReducer) ApplyHeartbeat(ctx context.Context, req collectorapi.HeartbeatRequest, receivedAt time.Time) error {
	if r.log != nil {
		r.log.calls = append(r.log.calls, "reduce-heartbeat")
	}
	r.heartbeatCalls++
	r.lastHeartbeat = req
	return r.err
}

func (r *fakeReducer) ApplyEvents(ctx context.Context, req collectorapi.EventsRequest, receivedAt time.Time) (int, error) {
	if r.log != nil {
		r.log.calls = append(r.log.calls, "reduce-events")
	}
	r.eventsCalls++
	r.lastEvents = req
	if r.err != nil {
		return 0, r.err
	}
	return r.eventsCount, nil
}

type fakeRegistrar struct {
	resp  collectorapi.RegistrationResponse
	err   error
	calls int
	last  collectorapi.RegistrationRequest
}

func (r *fakeRegistrar) RegisterCollector(ctx context.Context, req collectorapi.RegistrationRequest, registeredAt time.Time) (collectorapi.RegistrationResponse, error) {
	r.calls++
	r.last = req
	return r.resp, r.err
}

type fakeDashboardNotifier struct {
	calls       int
	collectorID string
	agentIDs    []string
	changes     []dashboard.CollectorChange
	log         *collectorCallLog
}

func (n *fakeDashboardNotifier) NotifyCollectorWriteApplied(ctx context.Context, collectorID string, changes []dashboard.CollectorChange) {
	if n.log != nil {
		n.log.calls = append(n.log.calls, "notify")
	}
	n.calls++
	n.collectorID = collectorID
	n.changes = append([]dashboard.CollectorChange(nil), changes...)
	seen := map[string]struct{}{}
	for _, change := range changes {
		if change.AgentID == "" {
			continue
		}
		if _, exists := seen[change.AgentID]; exists {
			continue
		}
		seen[change.AgentID] = struct{}{}
		n.agentIDs = append(n.agentIDs, change.AgentID)
	}
}

type collectorCallLog struct{ calls []string }

type fakeAgentProvisioner struct {
	log      *collectorCallLog
	requests []agentprovisioning.EnsureRequest
	err      error
}

func (p *fakeAgentProvisioner) EnsureOwnedAgent(_ context.Context, req agentprovisioning.EnsureRequest) (agentprovisioning.EnsureResult, error) {
	if p.log != nil {
		p.log.calls = append(p.log.calls, "provision")
	}
	p.requests = append(p.requests, req)
	return agentprovisioning.EnsureResult{Agent: mcpgateway.AgentRegistration{AgentID: strings.TrimSpace(req.AgentID)}}, p.err
}

type agentBindCall struct{ collectorID, officeAgentID, mcpAgentID string }

type fakeAgentBinder struct {
	log   *collectorCallLog
	calls []agentBindCall
	err   error
}

func (b *fakeAgentBinder) BindMCPAgent(_ context.Context, collectorID, officeAgentID, mcpAgentID string, _ time.Time) error {
	if b.log != nil {
		b.log.calls = append(b.log.calls, "bind")
	}
	b.calls = append(b.calls, agentBindCall{collectorID, officeAgentID, mcpAgentID})
	return b.err
}
