package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/collectorpull"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

const collectorTaskLongPollTimeout = 25 * time.Second

type TaskBroker interface {
	Pull(context.Context, string) (collectorapi.TaskDelivery, bool, error)
	Complete(string, collectorapi.TaskResultRequest) error
}

func (api *CollectorAPI) handleTaskPull(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	identity, ok := api.authenticate(w, r)
	if !ok {
		return
	}
	var req collectorapi.TaskPullRequest
	if !decodeCollectorRequest(w, r, &req) || !validateTaskIdentity(w, identity, req.SchemaVersion, req.CollectorID, req.DeviceID) {
		return
	}
	if api.taskBroker == nil {
		writeError(w, http.StatusServiceUnavailable, "task_broker_unavailable", "collector task broker is unavailable")
		return
	}
	pullCtx, cancel := context.WithTimeout(r.Context(), collectorTaskLongPollTimeout)
	defer cancel()
	delivery, found, err := api.taskBroker.Pull(pullCtx, identity.CollectorID)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "failed to pull collector task")
		return
	}
	if !found {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, delivery)
}

func (api *CollectorAPI) handleTaskResult(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	identity, ok := api.authenticate(w, r)
	if !ok {
		return
	}
	var req collectorapi.TaskResultRequest
	if !decodeCollectorRequest(w, r, &req) || !validateTaskIdentity(w, identity, req.SchemaVersion, req.CollectorID, req.DeviceID) {
		return
	}
	if api.taskBroker == nil {
		writeError(w, http.StatusServiceUnavailable, "task_broker_unavailable", "collector task broker is unavailable")
		return
	}
	if err := api.taskBroker.Complete(identity.CollectorID, req); err != nil {
		switch {
		case errors.Is(err, collectorpull.ErrInvalid):
			writeError(w, http.StatusBadRequest, "invalid_task_result", "collector task result is invalid")
		case errors.Is(err, collectorpull.ErrConflict), errors.Is(err, collectorpull.ErrNotFound):
			writeError(w, http.StatusConflict, "task_state_conflict", "collector task is no longer awaiting this result")
		default:
			writeError(w, http.StatusInternalServerError, "internal_error", "failed to complete collector task")
		}
		return
	}
	writeAccepted(w, collectorapi.AcceptedResponse{Accepted: true, ServerTime: api.receivedAt()})
}

func validateTaskIdentity(w http.ResponseWriter, identity CollectorIdentity, schemaVersion, collectorID, deviceID string) bool {
	if schemaVersion != collectorapi.TaskSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_schema_version", "schema_version must be collector.task.v1")
		return false
	}
	collectorID = strings.TrimSpace(collectorID)
	if collectorID == "" {
		writeError(w, http.StatusBadRequest, "invalid_collector_id", "collector_id is required")
		return false
	}
	if strings.TrimSpace(deviceID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_device_id", "device_id is required")
		return false
	}
	if identity.CollectorID != collectorID {
		writeError(w, http.StatusForbidden, "collector_mismatch", "collector_id does not match bearer token")
		return false
	}
	return true
}
