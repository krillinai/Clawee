package state

import (
	"context"
	"encoding/json"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/privacy"
)

type Reducer struct {
	store Store
}

func NewReducer(store Store) *Reducer {
	return &Reducer{store: store}
}

func (r *Reducer) ApplyHeartbeat(ctx context.Context, req collectorapi.HeartbeatRequest, receivedAt time.Time) error {
	if err := r.store.UpsertDevice(ctx, DeviceHeartbeat{
		CollectorID:      req.CollectorID,
		DeviceID:         req.DeviceID,
		CollectorVersion: req.CollectorVersion,
		LastSeenAt:       receivedAt,
	}); err != nil {
		return err
	}

	for _, agent := range req.Agents {
		if err := r.store.UpsertAgent(ctx, AgentState{
			CollectorID:      req.CollectorID,
			DeviceID:         req.DeviceID,
			AgentID:          agent.AgentID,
			AgentType:        agent.AgentType,
			DisplayName:      agent.DisplayName,
			Version:          agent.Version,
			Status:           agent.Status,
			WorkspaceName:    agent.WorkspaceName,
			CurrentSessionID: agent.CurrentSessionID,
			CurrentTurnID:    agent.CurrentTurnID,
			LastSeenAt:       receivedAt,
			Metadata:         privacy.SafeMetadata(agent.Metadata),
		}); err != nil {
			return err
		}
	}

	return nil
}

func (r *Reducer) ApplyEvents(ctx context.Context, req collectorapi.EventsRequest, receivedAt time.Time) (int, error) {
	accepted := 0
	for _, event := range req.Events {
		payloadEvent := event
		payloadEvent.Metadata = privacy.SafeMetadata(payloadEvent.Metadata)
		if payloadEvent.Activity != nil {
			activity := *payloadEvent.Activity
			activity.Metadata = privacy.SafeMetadata(payloadEvent.Activity.Metadata)
			payloadEvent.Activity = &activity
		}
		if payloadEvent.Session != nil {
			session := *payloadEvent.Session
			payloadEvent.Session = &session
		}
		if payloadEvent.Turn != nil {
			turn := *payloadEvent.Turn
			turn.Metadata = privacy.SafeMetadata(payloadEvent.Turn.Metadata)
			payloadEvent.Turn = &turn
		}
		if payloadEvent.ToolCall != nil {
			toolCall := *payloadEvent.ToolCall
			toolCall.Metadata = privacy.SafeMetadata(payloadEvent.ToolCall.Metadata)
			payloadEvent.ToolCall = &toolCall
		}
		if payloadEvent.SubAgent != nil {
			subAgent := *payloadEvent.SubAgent
			subAgent.Metadata = privacy.SafeMetadata(payloadEvent.SubAgent.Metadata)
			payloadEvent.SubAgent = &subAgent
		}

		standardPayload, err := json.Marshal(payloadEvent)
		if err != nil {
			return accepted, err
		}
		rawPayload := standardPayload
		sourceEventID := event.EventID
		sourceType := event.SourceType
		sourceEventType := event.SourceEventType
		parseStatus := "parsed"
		parseError := ""
		if event.SourceEvent != nil {
			if event.SourceEvent.SourceEventID != "" {
				sourceEventID = event.SourceEvent.SourceEventID
			}
			if event.SourceEvent.SourceType != "" {
				sourceType = event.SourceEvent.SourceType
			}
			if event.SourceEvent.SourceEventType != "" {
				sourceEventType = event.SourceEvent.SourceEventType
			}
			if event.SourceEvent.ParseStatus != "" {
				parseStatus = event.SourceEvent.ParseStatus
			}
			parseError = event.SourceEvent.ParseError
			if event.SourceEvent.RawPayload != nil {
				if sourceRawPayload, err := json.Marshal(event.SourceEvent.RawPayload); err == nil {
					rawPayload = sourceRawPayload
				} else {
					return accepted, err
				}
			}
		}

		inserted, err := r.store.ApplySourceEvent(ctx, SourceEventState{
			CollectorID:       req.CollectorID,
			SourceEventID:     sourceEventID,
			SourceType:        sourceType,
			SourceEventType:   sourceEventType,
			StandardEventType: event.EventType,
			AgentID:           event.AgentID,
			SessionID:         event.SessionID,
			TurnID:            event.TurnID,
			SubAgentID:        subAgentIDValue(event.SubAgentID),
			ToolCallID:        toolCallID(event),
			OccurredAt:        event.OccurredAt,
			ReceivedAt:        receivedAt,
			RawPayload:        rawPayload,
			StandardPayload:   standardPayload,
			ParseStatus:       parseStatus,
			ParseError:        parseError,
		}, func(ctx context.Context, eventStore Store) error {
			if err := eventStore.UpsertAgent(ctx, AgentState{
				CollectorID:      req.CollectorID,
				DeviceID:         req.DeviceID,
				AgentID:          event.AgentID,
				AgentType:        event.AgentType,
				Status:           event.Status,
				CurrentSessionID: event.SessionID,
				CurrentTurnID:    event.TurnID,
				LastSeenAt:       receivedAt,
				Metadata:         privacy.SafeMetadata(event.Metadata),
			}); err != nil {
				return err
			}

			if err := r.applySession(ctx, eventStore, req.CollectorID, event); err != nil {
				return err
			}
			if err := r.applyTurn(ctx, eventStore, req.CollectorID, event); err != nil {
				return err
			}
			if err := r.applyToolCall(ctx, eventStore, req.CollectorID, event); err != nil {
				return err
			}
			if err := r.applySubAgent(ctx, eventStore, req.CollectorID, event); err != nil {
				return err
			}
			if err := r.applyActivity(ctx, eventStore, req.CollectorID, event); err != nil {
				return err
			}

			return nil
		})
		if err != nil {
			return accepted, err
		}
		if !inserted {
			continue
		}
		accepted++
	}

	return accepted, nil
}

func (r *Reducer) applySession(ctx context.Context, eventStore Store, collectorID string, event collectorapi.CollectorEvent) error {
	if event.SessionID == "" {
		return nil
	}
	if event.EventType != collectorapi.EventSessionStarted &&
		event.EventType != collectorapi.EventSessionUpdated &&
		event.EventType != collectorapi.EventSessionCompleted {
		return nil
	}
	session := collectorapi.SessionSummary{
		SessionID: event.SessionID,
		Status:    event.Status,
		StartedAt: event.OccurredAt,
	}
	updateStartedAt := false
	if event.Session != nil {
		session = *event.Session
		updateStartedAt = !event.Session.StartedAt.IsZero()
	}
	if session.StartedAt.IsZero() {
		session.StartedAt = event.OccurredAt
	}
	if event.EventType == collectorapi.EventSessionCompleted {
		if session.EndedAt == nil {
			session.EndedAt = &event.OccurredAt
		}
	}
	return eventStore.UpsertSession(ctx, SessionState{
		CollectorID:     collectorID,
		AgentID:         event.AgentID,
		SessionID:       firstNonEmpty(session.SessionID, event.SessionID),
		Status:          firstStatus(session.Status, event.Status),
		Summary:         session.Summary,
		StartedAt:       session.StartedAt,
		UpdateStartedAt: updateStartedAt,
		EndedAt:         session.EndedAt,
		WorkspaceName:   session.WorkspaceName,
		UpdatedAt:       event.OccurredAt,
	})
}

func (r *Reducer) applyTurn(ctx context.Context, eventStore Store, collectorID string, event collectorapi.CollectorEvent) error {
	if event.TurnID == "" {
		return nil
	}
	if event.EventType == collectorapi.EventTurnCompleted {
		if event.Turn != nil {
			turn := *event.Turn
			if err := eventStore.UpsertTurn(ctx, TurnState{
				CollectorID:          collectorID,
				AgentID:              event.AgentID,
				TurnID:               firstNonEmpty(turn.TurnID, event.TurnID),
				SessionID:            firstNonEmpty(turn.SessionID, event.SessionID),
				SubAgentID:           firstNonEmpty(turn.SubAgentID, subAgentIDValue(event.SubAgentID)),
				ParentAgentID:        turn.ParentAgentID,
				ParentTurnID:         turn.ParentTurnID,
				SpawnToolCallID:      turn.SpawnToolCallID,
				Title:                turn.Title,
				UserPrompt:           turn.UserPrompt,
				AssistantSummary:     turn.AssistantSummary,
				LastAssistantMessage: turn.LastAssistantMessage,
				Status:               firstStatus(turn.Status, event.Status),
				StartedAt:            turn.StartedAt,
				UpdatedAt:            turn.UpdatedAt,
				CompletedAt:          turn.CompletedAt,
				Metadata:             privacy.SafeMetadata(turn.Metadata),
			}); err != nil {
				return err
			}
		}
		return eventStore.CompleteTurn(ctx, TurnCompletion{
			CollectorID: collectorID,
			AgentID:     event.AgentID,
			TurnID:      event.TurnID,
			CompletedAt: event.OccurredAt,
		})
	}
	if event.EventType != collectorapi.EventTurnStarted && event.EventType != collectorapi.EventTurnUpdated {
		return nil
	}
	turn := collectorapi.TurnSummary{
		TurnID:    event.TurnID,
		SessionID: event.SessionID,
		Status:    event.Status,
		StartedAt: event.OccurredAt,
		UpdatedAt: event.OccurredAt,
	}
	if event.Turn != nil {
		turn = *event.Turn
	}
	return eventStore.UpsertTurn(ctx, TurnState{
		CollectorID:          collectorID,
		AgentID:              event.AgentID,
		TurnID:               firstNonEmpty(turn.TurnID, event.TurnID),
		SessionID:            firstNonEmpty(turn.SessionID, event.SessionID),
		SubAgentID:           firstNonEmpty(turn.SubAgentID, subAgentIDValue(event.SubAgentID)),
		ParentAgentID:        turn.ParentAgentID,
		ParentTurnID:         turn.ParentTurnID,
		SpawnToolCallID:      turn.SpawnToolCallID,
		Title:                turn.Title,
		UserPrompt:           turn.UserPrompt,
		AssistantSummary:     turn.AssistantSummary,
		LastAssistantMessage: turn.LastAssistantMessage,
		Status:               firstStatus(turn.Status, event.Status),
		StartedAt:            turn.StartedAt,
		UpdatedAt:            turn.UpdatedAt,
		CompletedAt:          turn.CompletedAt,
		Metadata:             privacy.SafeMetadata(turn.Metadata),
	})
}

func (r *Reducer) applyToolCall(ctx context.Context, eventStore Store, collectorID string, event collectorapi.CollectorEvent) error {
	if event.ToolCall == nil {
		return nil
	}
	input, err := json.Marshal(event.ToolCall.Input)
	if err != nil {
		return err
	}
	response, err := json.Marshal(event.ToolCall.Response)
	if err != nil {
		return err
	}
	tool := event.ToolCall
	if event.EventType == collectorapi.EventToolCallCompleted || event.EventType == collectorapi.EventToolCallFailed || event.EventType == collectorapi.EventAgentError {
		completedAt := event.OccurredAt
		if tool.CompletedAt != nil {
			completedAt = *tool.CompletedAt
		}
		if err := eventStore.UpsertToolCall(ctx, ToolCallState{
			CollectorID:        collectorID,
			AgentID:            event.AgentID,
			ToolCallID:         tool.ToolCallID,
			ExternalToolCallID: tool.ExternalToolCallID,
			SessionID:          event.SessionID,
			TurnID:             event.TurnID,
			SubAgentID:         subAgentIDValue(event.SubAgentID),
			ToolName:           tool.ToolName,
			ToolType:           tool.ToolType,
			Status:             tool.Status,
			Input:              input,
			Response:           response,
			ResponseText:       tool.ResponseText,
			StartedAt:          tool.StartedAt,
			CompletedAt:        &completedAt,
			DurationMS:         tool.DurationMS,
			SourceEventEndID:   event.EventID,
			Metadata:           privacy.SafeMetadata(tool.Metadata),
		}); err != nil {
			return err
		}
		return eventStore.CompleteToolCall(ctx, ToolCallCompletion{
			CollectorID:      collectorID,
			AgentID:          event.AgentID,
			ToolCallID:       tool.ToolCallID,
			Status:           tool.Status,
			Response:         response,
			ResponseText:     tool.ResponseText,
			CompletedAt:      completedAt,
			DurationMS:       tool.DurationMS,
			SourceEventEndID: event.EventID,
			Metadata:         privacy.SafeMetadata(tool.Metadata),
		})
	}
	if event.EventType != collectorapi.EventToolCallStarted {
		return nil
	}
	return eventStore.UpsertToolCall(ctx, ToolCallState{
		CollectorID:        collectorID,
		AgentID:            event.AgentID,
		ToolCallID:         tool.ToolCallID,
		ExternalToolCallID: tool.ExternalToolCallID,
		SessionID:          event.SessionID,
		TurnID:             event.TurnID,
		SubAgentID:         subAgentIDValue(event.SubAgentID),
		ToolName:           tool.ToolName,
		ToolType:           tool.ToolType,
		Status:             tool.Status,
		Input:              input,
		Response:           response,
		ResponseText:       tool.ResponseText,
		StartedAt:          tool.StartedAt,
		CompletedAt:        tool.CompletedAt,
		DurationMS:         tool.DurationMS,
		SourceEventStartID: event.EventID,
		Metadata:           privacy.SafeMetadata(tool.Metadata),
	})
}

func (r *Reducer) applySubAgent(ctx context.Context, eventStore Store, collectorID string, event collectorapi.CollectorEvent) error {
	if event.SubAgent == nil && (event.SubAgentID == nil || *event.SubAgentID == "") {
		return nil
	}

	if event.EventType == collectorapi.EventSubAgentCompleted {
		subAgentID := subAgentIDValue(event.SubAgentID)
		parentAgentID := event.AgentID
		status := event.Status
		if status == "" {
			status = collectorapi.StatusIdle
		}
		if event.SubAgent != nil {
			subAgentID = event.SubAgent.SubAgentID
			parentAgentID = firstNonEmpty(event.SubAgent.ParentAgentID, parentAgentID)
			status = firstStatus(event.SubAgent.Status, status)
		}
		return eventStore.CompleteSubAgent(ctx, SubAgentCompletion{
			CollectorID:   collectorID,
			ParentAgentID: parentAgentID,
			SubAgentID:    subAgentID,
			Status:        status,
			CompletedAt:   event.OccurredAt,
		})
	}

	if event.SubAgent != nil {
		summary := event.SubAgent
		return eventStore.UpsertSubAgent(ctx, SubAgentState{
			CollectorID:     collectorID,
			ParentAgentID:   firstNonEmpty(summary.ParentAgentID, event.AgentID),
			SubAgentID:      summary.SubAgentID,
			SessionID:       firstNonEmpty(summary.SessionID, event.SessionID),
			ParentTurnID:    firstNonEmpty(summary.ParentTurnID, event.TurnID),
			SpawnToolCallID: summary.SpawnToolCallID,
			Name:            summary.Name,
			Nickname:        summary.Nickname,
			Role:            summary.Role,
			Status:          summary.Status,
			CurrentActivity: summary.CurrentActivity,
			StartedAt:       summary.StartedAt,
			UpdatedAt:       summary.UpdatedAt,
			CompletedAt:     summary.CompletedAt,
			Metadata:        privacy.SafeMetadata(summary.Metadata),
		})
	}

	return eventStore.UpsertSubAgent(ctx, SubAgentState{
		CollectorID:     collectorID,
		ParentAgentID:   event.AgentID,
		SubAgentID:      subAgentIDValue(event.SubAgentID),
		SessionID:       event.SessionID,
		ParentTurnID:    event.TurnID,
		Status:          event.Status,
		CurrentActivity: subAgentCurrentActivity(event),
		StartedAt:       event.OccurredAt,
		UpdatedAt:       event.OccurredAt,
		Metadata:        privacy.SafeMetadata(event.Metadata),
	})
}

func subAgentCurrentActivity(event collectorapi.CollectorEvent) string {
	if event.Activity == nil {
		return ""
	}
	if event.Activity.Title != "" {
		return event.Activity.Title
	}
	return event.Activity.Summary
}

func subAgentIDValue(input *string) string {
	if input == nil {
		return ""
	}
	return *input
}

func toolCallID(event collectorapi.CollectorEvent) string {
	if event.ToolCall == nil {
		return ""
	}
	return event.ToolCall.ToolCallID
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func firstStatus(values ...collectorapi.Status) collectorapi.Status {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return collectorapi.StatusThinking
}

func (r *Reducer) applyActivity(ctx context.Context, eventStore Store, collectorID string, event collectorapi.CollectorEvent) error {
	if event.Activity == nil {
		return nil
	}

	scope := ActivityScope{
		CollectorID: collectorID,
		AgentID:     event.AgentID,
		SessionID:   event.SessionID,
		TurnID:      event.TurnID,
	}
	if event.SubAgentID != nil {
		scope.SubAgentID = *event.SubAgentID
	}

	switch event.EventType {
	case collectorapi.EventActivityCompleted, collectorapi.EventToolCallCompleted, collectorapi.EventToolCallFailed, collectorapi.EventAgentError:
		if event.EventType != collectorapi.EventAgentError && event.Activity.ActivityID != "" {
			if err := eventStore.UpsertActivity(ctx, ActivityState{
				CollectorID:  collectorID,
				ActivityID:   event.Activity.ActivityID,
				AgentID:      event.AgentID,
				SubAgentID:   scope.SubAgentID,
				SessionID:    event.SessionID,
				TurnID:       event.TurnID,
				ToolCallID:   event.Activity.ToolCallID,
				ActivityType: event.Activity.ActivityType,
				Status:       event.Status,
				Title:        event.Activity.Title,
				Summary:      event.Activity.Summary,
				StartedAt:    event.Activity.StartedAt,
				CompletedAt:  event.Activity.CompletedAt,
				Metadata:     privacy.SafeMetadata(event.Activity.Metadata),
			}); err != nil {
				return err
			}
		}
		return r.completeActivity(ctx, eventStore, scope, event)
	case collectorapi.EventActivityStarted:
		if err := eventStore.CloseOpenActivities(ctx, scope, event.Activity.StartedAt); err != nil {
			return err
		}
		return eventStore.UpsertActivity(ctx, ActivityState{
			CollectorID:  collectorID,
			ActivityID:   event.Activity.ActivityID,
			AgentID:      event.AgentID,
			SubAgentID:   scope.SubAgentID,
			SessionID:    event.SessionID,
			TurnID:       event.TurnID,
			ToolCallID:   event.Activity.ToolCallID,
			ActivityType: event.Activity.ActivityType,
			Status:       event.Status,
			Title:        event.Activity.Title,
			Summary:      event.Activity.Summary,
			StartedAt:    event.Activity.StartedAt,
			CompletedAt:  event.Activity.CompletedAt,
			Metadata:     privacy.SafeMetadata(event.Activity.Metadata),
		})
	default:
		return nil
	}
}

func (r *Reducer) completeActivity(ctx context.Context, eventStore Store, scope ActivityScope, event collectorapi.CollectorEvent) error {
	completedAt := event.OccurredAt
	if event.Activity.CompletedAt != nil {
		completedAt = *event.Activity.CompletedAt
	}

	return eventStore.CompleteActivity(ctx, ActivityCompletion{
		ActivityID:   event.Activity.ActivityID,
		Scope:        scope,
		ActivityType: event.Activity.ActivityType,
		CompletedAt:  completedAt,
	})
}
