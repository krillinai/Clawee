package httpapi

import (
	"net/http"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
)

// RuntimeHandler returns the organization status without conversation bodies or tool payloads.
// Its app route requires the same data-view grant as activity statistics.
func (api *DashboardAPI) RuntimeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !requireGet(w, r) {
			return
		}
		snapshot, err := api.reader.OfficeSnapshot(r.Context(), api.receivedAt())
		if err != nil {
			writeDashboardError(w, err)
			return
		}
		type runtimeAgent struct {
			CollectorID string    `json:"collector_id"`
			AgentID     string    `json:"agent_id"`
			Status      string    `json:"status"`
			CurrentTask string    `json:"current_task,omitempty"`
			LastSeenAt  time.Time `json:"last_seen_at"`
		}
		agents := make([]runtimeAgent, 0, len(snapshot.Agents))
		for _, agent := range snapshot.Agents {
			item := runtimeAgent{CollectorID: agent.CollectorID, AgentID: agent.AgentID,
				Status: agent.Status, LastSeenAt: agent.LastSeenAt}
			if turn := agent.CurrentTurn; turn != nil && turn.CompletedAt == nil &&
				agent.Status != string(collectorapi.StatusIdle) && agent.Status != string(collectorapi.StatusOffline) &&
				turn.Status != string(collectorapi.StatusIdle) && turn.Status != string(collectorapi.StatusOffline) {
				title := []rune(turn.Title)
				if len(title) > 120 {
					title = title[:120]
				}
				item.CurrentTask = string(title)
			}
			agents = append(agents, item)
		}
		writeJSON(w, http.StatusOK, struct {
			SchemaVersion string                  `json:"schema_version"`
			Scope         string                  `json:"scope"`
			ServerTime    time.Time               `json:"server_time"`
			Summary       dashboard.OfficeSummary `json:"summary"`
			Agents        []runtimeAgent          `json:"agents"`
		}{dashboard.SchemaVersion, "organization", snapshot.ServerTime, snapshot.Summary, agents})
	})
}
