package dashboard

import (
	"context"
	"encoding/json"
	"time"
)

type NotifyReader interface {
	OfficeSnapshot(context.Context, time.Time) (OfficeSnapshot, error)
	Agents(context.Context, time.Time) ([]AgentListItem, error)
	AgentDetail(context.Context, string, string, time.Time) (AgentDetail, error)
	SubAgents(context.Context, string, string, time.Time) ([]SubAgentItem, error)
}

type CollectorChange struct {
	AgentID              string
	SubAgentID           string
	ActivityID           string
	SubAgentIDs          []string
	ActivityStartedIDs   []string
	ActivityCompletedIDs []string
	SessionID            string
	TurnID               string
	SessionIDs           []string
	TurnIDs              []string
	CompletedTurnIDs     []string
	HasSubAgentChange    bool
	HasActivityStarted   bool
	HasActivityCompleted bool
	HasSessionChange     bool
	HasTurnChange        bool
	HasTurnCompleted     bool
	RequiresSnapshot     bool
}

type RealtimePublishFunc func(string, RealtimeScope, json.RawMessage, time.Time)

type Notifier struct {
	reader  NotifyReader
	publish RealtimePublishFunc
	now     func() time.Time
}

func NewNotifier(reader NotifyReader, publish RealtimePublishFunc, now func() time.Time) *Notifier {
	return &Notifier{reader: reader, publish: publish, now: now}
}

func (n *Notifier) NotifyCollectorWriteApplied(ctx context.Context, collectorID string, changes []CollectorChange) {
	if n == nil || n.reader == nil || n.publish == nil {
		return
	}
	emittedAt := time.Now().UTC()
	if n.now != nil {
		emittedAt = n.now().UTC()
	}
	agents, err := n.reader.Agents(ctx, emittedAt)
	if err != nil {
		n.publish("snapshot.required", RealtimeScope{CollectorID: collectorID}, json.RawMessage(`{"reason":"dashboard_query_failed"}`), emittedAt)
		return
	}
	wanted := make(map[string]CollectorChange)
	for _, change := range changes {
		if change.AgentID == "" {
			continue
		}
		key := collectorID + "\x00" + change.AgentID
		merged := wanted[key]
		merged.AgentID = change.AgentID
		if change.SubAgentID != "" {
			merged.SubAgentID = change.SubAgentID
		}
		if change.ActivityID != "" {
			merged.ActivityID = change.ActivityID
		}
		merged.SubAgentIDs = mergeIDs(merged.SubAgentIDs, change.SubAgentIDs)
		if change.HasSubAgentChange {
			merged.SubAgentIDs = mergeIDs(merged.SubAgentIDs, nil, change.SubAgentID)
		}
		merged.ActivityStartedIDs = mergeIDs(merged.ActivityStartedIDs, change.ActivityStartedIDs)
		if change.HasActivityStarted {
			merged.ActivityStartedIDs = mergeIDs(merged.ActivityStartedIDs, nil, change.ActivityID)
		}
		merged.ActivityCompletedIDs = mergeIDs(merged.ActivityCompletedIDs, change.ActivityCompletedIDs)
		if change.HasActivityCompleted {
			merged.ActivityCompletedIDs = mergeIDs(merged.ActivityCompletedIDs, nil, change.ActivityID)
		}
		if change.SessionID != "" {
			merged.SessionID = change.SessionID
		}
		if change.TurnID != "" {
			merged.TurnID = change.TurnID
		}
		merged.SessionIDs = mergeIDs(merged.SessionIDs, change.SessionIDs)
		if change.HasSessionChange {
			merged.SessionIDs = mergeIDs(merged.SessionIDs, nil, change.SessionID)
		}
		merged.TurnIDs = mergeIDs(merged.TurnIDs, change.TurnIDs)
		if change.HasTurnChange {
			merged.TurnIDs = mergeIDs(merged.TurnIDs, nil, change.TurnID)
		}
		merged.CompletedTurnIDs = mergeIDs(merged.CompletedTurnIDs, change.CompletedTurnIDs)
		if change.HasTurnCompleted {
			merged.CompletedTurnIDs = mergeIDs(merged.CompletedTurnIDs, nil, change.TurnID)
		}
		merged.HasSubAgentChange = merged.HasSubAgentChange || change.HasSubAgentChange
		merged.HasActivityStarted = merged.HasActivityStarted || change.HasActivityStarted
		merged.HasActivityCompleted = merged.HasActivityCompleted || change.HasActivityCompleted
		merged.HasSessionChange = merged.HasSessionChange || change.HasSessionChange
		merged.HasTurnChange = merged.HasTurnChange || change.HasTurnChange
		merged.HasTurnCompleted = merged.HasTurnCompleted || change.HasTurnCompleted
		merged.RequiresSnapshot = merged.RequiresSnapshot || change.RequiresSnapshot
		wanted[key] = merged
	}
	for _, agent := range agents {
		change, ok := wanted[agent.CollectorID+"\x00"+agent.AgentID]
		if !ok {
			continue
		}
		body, err := json.Marshal(map[string]AgentListItem{"agent": agent})
		if err != nil {
			continue
		}
		n.publish("agent.upserted", RealtimeScope{
			CollectorID: agent.CollectorID,
			AgentID:     agent.AgentID,
			SessionID:   currentSessionID(agent),
			TurnID:      currentTurnID(agent),
		}, body, emittedAt)

		if change.RequiresSnapshot {
			n.publishSnapshotRequired(collectorID, agent.AgentID, "agent_snapshot_replaced", emittedAt)
			continue
		}
		n.publishSubAgentIfChanged(ctx, collectorID, agent.AgentID, change, emittedAt)
		n.publishSessionTurnIfChanged(ctx, collectorID, agent.AgentID, change, emittedAt)
		n.publishActivityIfChanged(ctx, collectorID, agent.AgentID, change, emittedAt)
	}
	n.publishOfficeStats(ctx, collectorID, emittedAt)
}

func (n *Notifier) publishSubAgentIfChanged(ctx context.Context, collectorID string, agentID string, change CollectorChange, emittedAt time.Time) {
	if !change.HasSubAgentChange {
		return
	}
	items, err := n.reader.SubAgents(ctx, collectorID, agentID, emittedAt)
	if err != nil {
		n.publishSnapshotRequired(collectorID, agentID, "sub_agent_query_failed", emittedAt)
		return
	}
	subAgentIDs := idSet(change.SubAgentIDs, fallbackID(change.SubAgentIDs, change.SubAgentID))
	for _, item := range items {
		if len(subAgentIDs) > 0 && !subAgentIDs[item.SubAgentID] {
			continue
		}
		body, err := json.Marshal(map[string]SubAgentItem{"sub_agent": item})
		if err != nil {
			continue
		}
		n.publish("sub_agent.upserted", RealtimeScope{
			CollectorID: item.CollectorID,
			AgentID:     item.ParentAgentID,
			SessionID:   item.SessionID,
			TurnID:      item.ParentTurnID,
			SubAgentID:  item.SubAgentID,
		}, body, emittedAt)
	}
}

func (n *Notifier) publishSessionTurnIfChanged(ctx context.Context, collectorID string, agentID string, change CollectorChange, emittedAt time.Time) {
	if !change.HasSessionChange && !change.HasTurnChange && !change.HasTurnCompleted {
		return
	}
	detail, err := n.reader.AgentDetail(ctx, collectorID, agentID, emittedAt)
	if err != nil {
		n.publishSnapshotRequired(collectorID, agentID, "session_turn_query_failed", emittedAt)
		return
	}
	if change.HasSessionChange {
		sessionIDs := idSet(change.SessionIDs, fallbackID(change.SessionIDs, change.SessionID))
		foundSessionIDs := make(map[string]bool, len(sessionIDs))
		for _, item := range detail.Sessions {
			if len(sessionIDs) > 0 && !sessionIDs[item.SessionID] {
				continue
			}
			foundSessionIDs[item.SessionID] = true
			body, err := json.Marshal(map[string]SessionItem{"session": item})
			if err != nil {
				continue
			}
			n.publish("session.upserted", RealtimeScope{
				CollectorID: collectorID,
				AgentID:     agentID,
				SessionID:   item.SessionID,
			}, body, emittedAt)
		}
		if missingRequestedID(sessionIDs, foundSessionIDs) {
			n.publishSnapshotRequired(collectorID, agentID, "session_turn_event_not_found", emittedAt)
		}
	}
	if change.HasTurnChange {
		turnIDs := idSet(change.TurnIDs, fallbackID(change.TurnIDs, change.TurnID))
		foundTurnIDs := make(map[string]bool, len(turnIDs))
		for _, item := range detail.Turns {
			if len(turnIDs) > 0 && !turnIDs[item.TurnID] {
				continue
			}
			foundTurnIDs[item.TurnID] = true
			body, err := json.Marshal(map[string]TurnItem{"turn": item})
			if err != nil {
				continue
			}
			n.publish("turn.upserted", RealtimeScope{
				CollectorID: collectorID,
				AgentID:     agentID,
				SessionID:   item.SessionID,
				TurnID:      item.TurnID,
			}, body, emittedAt)
		}
		if missingRequestedID(turnIDs, foundTurnIDs) {
			n.publishSnapshotRequired(collectorID, agentID, "session_turn_event_not_found", emittedAt)
		}
	}
	if change.HasTurnCompleted {
		completedTurnIDs := idSet(change.CompletedTurnIDs, fallbackID(change.CompletedTurnIDs, change.TurnID))
		foundCompletedTurnIDs := make(map[string]bool, len(completedTurnIDs))
		for _, item := range detail.Turns {
			if len(completedTurnIDs) > 0 && !completedTurnIDs[item.TurnID] {
				continue
			}
			foundCompletedTurnIDs[item.TurnID] = true
			body, err := json.Marshal(map[string]TurnItem{"turn": item})
			if err != nil {
				continue
			}
			n.publish("turn.completed", RealtimeScope{
				CollectorID: collectorID,
				AgentID:     agentID,
				SessionID:   item.SessionID,
				TurnID:      item.TurnID,
			}, body, emittedAt)
		}
		if missingRequestedID(completedTurnIDs, foundCompletedTurnIDs) {
			n.publishSnapshotRequired(collectorID, agentID, "session_turn_event_not_found", emittedAt)
		}
	}
}

func (n *Notifier) publishActivityIfChanged(ctx context.Context, collectorID string, agentID string, change CollectorChange, emittedAt time.Time) {
	if !change.HasActivityStarted && !change.HasActivityCompleted {
		return
	}
	detail, err := n.reader.AgentDetail(ctx, collectorID, agentID, emittedAt)
	if err != nil {
		n.publishSnapshotRequired(collectorID, agentID, "activity_query_failed", emittedAt)
		return
	}
	if change.HasActivityStarted {
		activityIDs := idSet(change.ActivityStartedIDs, fallbackID(change.ActivityStartedIDs, change.ActivityID))
		foundIDs := n.publishActivities("activity.upserted", detail.RecentActivities, activityIDs, emittedAt)
		if missingRequestedID(activityIDs, foundIDs) {
			n.publishSnapshotRequired(collectorID, agentID, "activity_event_not_found", emittedAt)
		}
	}
	if change.HasActivityCompleted {
		activityIDs := idSet(change.ActivityCompletedIDs, fallbackID(change.ActivityCompletedIDs, change.ActivityID))
		foundIDs := n.publishActivities("activity.completed", detail.RecentActivities, activityIDs, emittedAt)
		if missingRequestedID(activityIDs, foundIDs) {
			n.publishSnapshotRequired(collectorID, agentID, "activity_event_not_found", emittedAt)
		}
	}
}

func (n *Notifier) publishActivities(eventType string, activities []ActivityItem, activityIDs map[string]bool, emittedAt time.Time) map[string]bool {
	foundIDs := make(map[string]bool, len(activityIDs))
	for _, item := range activities {
		if len(activityIDs) > 0 && !activityIDs[item.ActivityID] {
			continue
		}
		foundIDs[item.ActivityID] = true
		body, err := json.Marshal(map[string]ActivityItem{"activity": item})
		if err != nil {
			continue
		}
		n.publish(eventType, RealtimeScope{
			CollectorID: item.CollectorID,
			AgentID:     item.AgentID,
			SessionID:   item.SessionID,
			TurnID:      item.TurnID,
			SubAgentID:  item.SubAgentID,
		}, body, emittedAt)
	}
	return foundIDs
}

func (n *Notifier) publishOfficeStats(ctx context.Context, collectorID string, emittedAt time.Time) {
	snapshot, err := n.reader.OfficeSnapshot(ctx, emittedAt)
	if err != nil {
		n.publish("snapshot.required", RealtimeScope{CollectorID: collectorID}, snapshotRequiredBody("office_stats_query_failed"), emittedAt)
		return
	}
	body, err := json.Marshal(map[string]any{
		"summary": snapshot.Summary,
		"filters": snapshot.Filters,
	})
	if err != nil {
		return
	}
	n.publish("office.stats.updated", RealtimeScope{CollectorID: collectorID}, body, emittedAt)
}

func (n *Notifier) publishSnapshotRequired(collectorID string, agentID string, reason string, emittedAt time.Time) {
	n.publish("snapshot.required", RealtimeScope{CollectorID: collectorID, AgentID: agentID}, snapshotRequiredBody(reason), emittedAt)
}

func snapshotRequiredBody(reason string) json.RawMessage {
	body, err := json.Marshal(map[string]string{"reason": reason})
	if err != nil {
		return json.RawMessage(`{"reason":"unknown"}`)
	}
	return body
}

func missingRequestedID(requested map[string]bool, found map[string]bool) bool {
	if len(requested) == 0 {
		return false
	}
	for id := range requested {
		if !found[id] {
			return true
		}
	}
	return false
}

func currentSessionID(agent AgentListItem) string {
	if agent.CurrentSession == nil {
		return ""
	}
	return agent.CurrentSession.SessionID
}

func currentTurnID(agent AgentListItem) string {
	if agent.CurrentTurn == nil {
		return ""
	}
	return agent.CurrentTurn.TurnID
}

func mergeIDs(existing []string, incoming []string, single ...string) []string {
	seen := make(map[string]bool, len(existing)+len(incoming)+len(single))
	out := make([]string, 0, len(existing)+len(incoming)+len(single))
	for _, id := range existing {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	for _, id := range incoming {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	for _, id := range single {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func idSet(ids []string, single string) map[string]bool {
	out := make(map[string]bool, len(ids)+1)
	for _, id := range ids {
		if id != "" {
			out[id] = true
		}
	}
	if single != "" {
		out[single] = true
	}
	return out
}

func fallbackID(ids []string, single string) string {
	if len(ids) > 0 {
		return ""
	}
	return single
}
