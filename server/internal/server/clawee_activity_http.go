package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/claweeactivity"
)

type ClaweeActivityReporter interface {
	Report(context.Context, string, string, claweeactivity.EventsRequest) error
}

func handleClaweeActivityEvents(service ClaweeActivityReporter, reportingEnabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, principalOK := currentPrincipal(c)
		agent, agentOK := currentClaweeAgent(c)
		if !principalOK || principal.ClientID != accounts.ClientClaweeAgent || principal.AgentID == "" ||
			!agentOK || agent.AgentID != principal.AgentID || agent.Status != mcpgateway.StatusActive {
			abortAuthorizationError(c, http.StatusForbidden, "agent_forbidden", "Agent 不可用")
			return
		}
		if !reportingEnabled {
			abortAuthorizationError(c, http.StatusForbidden, "activity_reporting_disabled", "Agent 活动上报未启用")
			return
		}
		if service == nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "internal_error", "活动上报服务不可用")
			return
		}

		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, claweeactivity.MaxRequestBodyBytes)
		decoder := json.NewDecoder(c.Request.Body)
		var req claweeactivity.EventsRequest
		if err := decoder.Decode(&req); err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				abortAuthorizationError(c, http.StatusRequestEntityTooLarge, "request_too_large", "请求体过大")
				return
			}
			abortAuthorizationError(c, http.StatusBadRequest, "invalid_activity_event", "活动事件无效")
			return
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				abortAuthorizationError(c, http.StatusRequestEntityTooLarge, "request_too_large", "请求体过大")
				return
			}
			abortAuthorizationError(c, http.StatusBadRequest, "invalid_activity_event", "活动事件无效")
			return
		}
		if err := service.Report(c.Request.Context(), principal.UserID, principal.AgentID, req); err != nil {
			_ = c.Error(err)
			writeClaweeActivityError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": claweeactivity.AcceptedResponse{
			Accepted: true, ReceivedEvents: len(req.Events), ServerTime: time.Now().UTC(),
		}})
	}
}

func writeClaweeActivityError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, claweeactivity.ErrInvalidSchemaVersion):
		abortAuthorizationError(c, http.StatusBadRequest, "invalid_schema_version", "活动协议版本无效")
	case errors.Is(err, claweeactivity.ErrInvalidActivityEvent):
		abortAuthorizationError(c, http.StatusBadRequest, "invalid_activity_event", "活动事件无效")
	case errors.Is(err, claweeactivity.ErrActivityTooLarge):
		abortAuthorizationError(c, http.StatusBadRequest, "activity_content_too_large", "活动内容过大")
	case errors.Is(err, claweeactivity.ErrAgentForbidden):
		abortAuthorizationError(c, http.StatusForbidden, "agent_forbidden", "Agent 不可用")
	default:
		abortAuthorizationError(c, http.StatusInternalServerError, "internal_error", "活动上报失败")
	}
}
