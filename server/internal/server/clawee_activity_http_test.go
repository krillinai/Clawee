package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/claweeactivity"
)

func TestClaweeActivityHandlerUsesPrincipalOwnership(t *testing.T) {
	service := &captureClaweeActivityReporter{}
	router := gin.New()
	router.POST("/events", func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{
			UserID: "user_1", AgentID: "trusted_agent", ClientID: accounts.ClientClaweeAgent,
		})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{
			AgentID: "trusted_agent", Status: mcpgateway.StatusActive,
		})
		handleClaweeActivityEvents(service, true)(c)
	})
	body := `{
		"schema_version":"clawee.activity.v1",
		"client_version":"0.1.0",
		"sent_at":"2026-08-28T10:00:00Z",
		"agent_id":"forged_agent",
		"events":[{
			"event_id":"evt_1","run_id":"run_1","session_id":"thread_1","turn_id":"run_1",
			"sequence":1,"occurred_at":"2026-08-28T10:00:00Z","event_type":"assistant_message",
			"normalizer_version":1,"payload":{"text":"done"}
		}]
	}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/events", strings.NewReader(body))
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if service.userID != "user_1" || service.agentID != "trusted_agent" {
		t.Fatalf("ownership = %q/%q", service.userID, service.agentID)
	}
	if !strings.Contains(recorder.Body.String(), `"received_events":1`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestClaweeActivityHandlerRejectsBrowserPrincipalAndOversizedBody(t *testing.T) {
	validBody := `{"schema_version":"clawee.activity.v1","client_version":"0.1.0","sent_at":"2026-08-28T10:00:00Z","events":[{"event_id":"evt_1","run_id":"run_1","session_id":"thread_1","turn_id":"run_1","sequence":1,"occurred_at":"2026-08-28T10:00:00Z","event_type":"assistant_message","normalizer_version":1,"payload":{"text":"done"}}]}`
	tests := []struct {
		name      string
		principal accounts.Principal
		agent     bool
		body      string
		want      int
	}{
		{name: "browser", principal: accounts.Principal{UserID: "user_1", ClientID: accounts.ClientWeb}, body: `{}`, want: http.StatusForbidden},
		{name: "large", principal: accounts.Principal{UserID: "user_1", AgentID: "agent_1", ClientID: accounts.ClientClaweeAgent}, agent: true, body: `{"padding":"` + strings.Repeat("x", claweeactivity.MaxRequestBodyBytes) + `"}`, want: http.StatusRequestEntityTooLarge},
		{name: "large trailing whitespace", principal: accounts.Principal{UserID: "user_1", AgentID: "agent_1", ClientID: accounts.ClientClaweeAgent}, agent: true, body: validBody + strings.Repeat(" ", claweeactivity.MaxRequestBodyBytes), want: http.StatusRequestEntityTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := gin.New()
			router.POST("/events", func(c *gin.Context) {
				c.Set(principalContextKey, test.principal)
				if test.agent {
					c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{AgentID: test.principal.AgentID, Status: mcpgateway.StatusActive})
				}
				handleClaweeActivityEvents(&captureClaweeActivityReporter{}, true)(c)
			})
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/events", strings.NewReader(test.body))
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.want {
				t.Fatalf("status = %d, want %d body=%s", recorder.Code, test.want, recorder.Body.String())
			}
		})
	}
}

func TestClaweeActivityHandlerRejectsDisabledReportingBeforeDecodingBody(t *testing.T) {
	service := &captureClaweeActivityReporter{}
	router := gin.New()
	router.Use(unifiedAPIResponse())
	router.POST("/api/v1/app/agent-activity/events", func(c *gin.Context) {
		c.Set(principalContextKey, accounts.Principal{
			UserID: "user_1", AgentID: "agent_1", ClientID: accounts.ClientClaweeAgent,
		})
		c.Set(claweeAgentContextKey, mcpgateway.AgentRegistration{
			AgentID: "agent_1", Status: mcpgateway.StatusActive,
		})
		handleClaweeActivityEvents(service, false)(c)
	})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/app/agent-activity/events", strings.NewReader("not-json-sensitive-content"))
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"activity_reporting_disabled"`) {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if service.userID != "" || service.agentID != "" {
		t.Fatalf("disabled reporting called service with %q/%q", service.userID, service.agentID)
	}
}

type captureClaweeActivityReporter struct {
	userID  string
	agentID string
}

func (r *captureClaweeActivityReporter) Report(_ context.Context, userID, agentID string, _ claweeactivity.EventsRequest) error {
	r.userID, r.agentID = userID, agentID
	return nil
}
