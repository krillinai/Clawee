package codex

import (
	"strings"
	"sync"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type ActivityMerger struct {
	window time.Duration
	mu     sync.Mutex
}

func NewActivityMerger(window time.Duration) *ActivityMerger {
	return &ActivityMerger{window: window}
}

func (m *ActivityMerger) Merge(events []collectorapi.CollectorEvent) []collectorapi.CollectorEvent {
	m.mu.Lock()
	defer m.mu.Unlock()

	merged := make([]collectorapi.CollectorEvent, 0, len(events))
	outputIndex := map[string]int{}

	for _, event := range events {
		if event.EventType != collectorapi.EventActivityStarted || event.Activity == nil {
			merged = append(merged, event)
			continue
		}

		key := activityKey(event)
		index, ok := outputIndex[key]
		if ok {
			previous := merged[index]
			lastSeenAt := previous.OccurredAt
			if previous.Activity.CompletedAt != nil {
				lastSeenAt = *previous.Activity.CompletedAt
			}
			if event.OccurredAt.Sub(lastSeenAt) <= m.window {
				completedAt := event.OccurredAt
				previous.Activity = cloneActivitySummary(previous.Activity)
				previous.Activity.CompletedAt = &completedAt
				merged[index] = previous
				continue
			}
		}

		outputIndex[key] = len(merged)
		merged = append(merged, cloneActivityEvent(event))
	}

	return merged
}

func cloneActivityEvent(event collectorapi.CollectorEvent) collectorapi.CollectorEvent {
	event.Activity = cloneActivitySummary(event.Activity)
	return event
}

func cloneActivitySummary(activity *collectorapi.ActivitySummary) *collectorapi.ActivitySummary {
	if activity == nil {
		return nil
	}

	clone := *activity
	if activity.Metadata != nil {
		clone.Metadata = make(map[string]string, len(activity.Metadata))
		for key, value := range activity.Metadata {
			clone.Metadata[key] = value
		}
	}
	return &clone
}

func activityKey(event collectorapi.CollectorEvent) string {
	subAgentID := ""
	if event.SubAgentID != nil {
		subAgentID = *event.SubAgentID
	}

	return strings.Join([]string{
		event.AgentID,
		subAgentID,
		event.SessionID,
		event.TurnID,
		string(event.Activity.ActivityType),
	}, "\x00")
}
