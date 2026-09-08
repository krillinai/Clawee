package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/dashboard"
)

// dashboard 列表里每个 Agent 最多展示的 session 与 sub agent 数量，
// 超出部分留给 Agent 详情页，避免单个 Agent 在总览表里铺得太长。
const (
	sessionPreviewLimit  = 5
	subAgentPreviewLimit = 5
	dashboardStaleAfter  = 8 * time.Hour
)

func (s *PostgresStore) OfficeSnapshot(ctx context.Context, now time.Time) (dashboard.OfficeSnapshot, error) {
	agents, err := s.dashboardAgents(ctx, "", "", now)
	if err != nil {
		return dashboard.OfficeSnapshot{}, err
	}
	summaryMetrics, err := s.officeSummaryMetrics(ctx, now)
	if err != nil {
		return dashboard.OfficeSnapshot{}, err
	}
	feed, err := s.RecentActivities(ctx, 20, now)
	if err != nil {
		return dashboard.OfficeSnapshot{}, err
	}
	return dashboard.OfficeSnapshot{
		SchemaVersion: dashboard.SchemaVersion,
		ServerTime:    now,
		SSEURL:        "/api/v1/admin/activity/events",
		Filters:       buildOfficeFilters(agents),
		Summary:       buildOfficeSummary(agents, summaryMetrics),
		Agents:        agents,
		RecentFeed:    feed,
	}, nil
}

func (s *PostgresStore) UserOfficeSnapshot(ctx context.Context, userID string, now time.Time) (dashboard.OfficeSnapshot, error) {
	agents, err := s.dashboardAgentsScoped(ctx, userID, "", "", now)
	if err != nil {
		return dashboard.OfficeSnapshot{}, err
	}
	metrics, err := s.officeSummaryMetricsForUser(ctx, userID, now)
	if err != nil {
		return dashboard.OfficeSnapshot{}, err
	}
	feed, err := s.UserRecentActivities(ctx, userID, 20, now)
	if err != nil {
		return dashboard.OfficeSnapshot{}, err
	}
	return dashboard.OfficeSnapshot{
		SchemaVersion: dashboard.SchemaVersion,
		ServerTime:    now,
		SSEURL:        "/api/v1/app/activity/events",
		Filters:       buildOfficeFilters(agents),
		Summary:       buildOfficeSummary(agents, metrics),
		Agents:        agents,
		RecentFeed:    feed,
	}, nil
}

func (s *PostgresStore) Agents(ctx context.Context, now time.Time) ([]dashboard.AgentListItem, error) {
	return s.dashboardAgents(ctx, "", "", now)
}

func (s *PostgresStore) UserAgents(ctx context.Context, userID string, now time.Time) ([]dashboard.AgentListItem, error) {
	return s.dashboardAgentsScoped(ctx, userID, "", "", now)
}

func (s *PostgresStore) AgentDetail(ctx context.Context, collectorID string, agentID string, now time.Time) (dashboard.AgentDetail, error) {
	return s.AgentDetailWithOptions(ctx, collectorID, agentID, now, dashboard.AgentDetailOptions{IncludeHistory: true})
}

func (s *PostgresStore) AgentDetailWithOptions(ctx context.Context, collectorID string, agentID string, now time.Time, options dashboard.AgentDetailOptions) (dashboard.AgentDetail, error) {
	return s.agentDetail(ctx, "", collectorID, agentID, now, options)
}

func (s *PostgresStore) UserAgentDetail(ctx context.Context, userID, collectorID, agentID string, now time.Time) (dashboard.AgentDetail, error) {
	return s.UserAgentDetailWithOptions(ctx, userID, collectorID, agentID, now, dashboard.AgentDetailOptions{IncludeHistory: true})
}

func (s *PostgresStore) UserAgentDetailWithOptions(ctx context.Context, userID, collectorID, agentID string, now time.Time, options dashboard.AgentDetailOptions) (dashboard.AgentDetail, error) {
	return s.agentDetail(ctx, userID, collectorID, agentID, now, options)
}

func (s *PostgresStore) agentDetail(ctx context.Context, userID, collectorID, agentID string, now time.Time, options dashboard.AgentDetailOptions) (dashboard.AgentDetail, error) {
	agents, err := s.dashboardAgentsScoped(ctx, userID, collectorID, agentID, now)
	if err != nil {
		return dashboard.AgentDetail{}, err
	}
	if len(agents) == 0 {
		return dashboard.AgentDetail{}, sql.ErrNoRows
	}
	agent := agents[0]
	sessions, err := s.agentSessions(ctx, collectorID, agentID, 50, now)
	if err != nil {
		return dashboard.AgentDetail{}, err
	}
	turns, err := s.agentTurns(ctx, collectorID, agentID, 100, now)
	if err != nil {
		return dashboard.AgentDetail{}, err
	}
	subAgents := []dashboard.SubAgentItem{}
	agentActivities := []dashboard.ActivityItem{}
	toolCalls := []dashboard.ToolCallItem{}
	timeline := []dashboard.TimelineItem{}
	if options.IncludeHistory {
		subAgents, err = s.SubAgents(ctx, collectorID, agentID, now)
		if err != nil {
			return dashboard.AgentDetail{}, err
		}
		agentActivities, err = s.agentActivities(ctx, collectorID, agentID, 100, now)
		if err != nil {
			return dashboard.AgentDetail{}, err
		}
		toolCalls, err = s.agentToolCalls(ctx, collectorID, agentID, 250, now)
		if err != nil {
			return dashboard.AgentDetail{}, err
		}
		timeline = make([]dashboard.TimelineItem, 0, len(agentActivities)+len(toolCalls))
	}
	statsMetrics, err := s.agentStatsMetrics(ctx, collectorID, agentID, now)
	if err != nil {
		return dashboard.AgentDetail{}, err
	}
	for _, tool := range toolCalls {
		timeline = append(timeline, dashboard.TimelineItem{
			EventType:    "tool_call",
			Title:        tool.ToolName,
			Summary:      tool.ResponseText,
			Status:       tool.Status,
			ActivityType: tool.ToolType,
			OccurredAt:   tool.StartedAt,
			CompletedAt:  tool.CompletedAt,
		})
	}
	for _, activity := range agentActivities {
		timeline = append(timeline, dashboard.TimelineItem{
			EventType:    "activity",
			Title:        activity.Title,
			Summary:      activity.Summary,
			Status:       activity.Status,
			ActivityType: activity.ActivityType,
			OccurredAt:   activity.StartedAt,
			CompletedAt:  activity.CompletedAt,
		})
	}
	stats := dashboard.AgentStats{
		ActiveSubAgents:     agent.SubAgents.ActiveCount,
		TotalSubAgents:      agent.SubAgents.TotalCount,
		RecentActivityCount: statsMetrics.RecentActivityCount,
		BusinessRiskLevel:   "unknown",
		ActiveSessions:      statsMetrics.ActiveSessions,
		ActiveWorkMS:        statsMetrics.ActiveWorkMS,
		ToolTypeVariety:     statsMetrics.ToolTypeVariety,
		ToolCallCount:       statsMetrics.ToolCallCount,
	}
	if agent.CurrentSession != nil {
		stats.SessionDurationMS = agent.CurrentSession.DurationMS
	}
	if agent.ActiveBusinessCall != nil {
		stats.BusinessRiskLevel = agent.ActiveBusinessCall.RiskLevel
	}
	return dashboard.AgentDetail{
		SchemaVersion:      dashboard.SchemaVersion,
		ServerTime:         now,
		Agent:              agent,
		CurrentSession:     agent.CurrentSession,
		CurrentTurn:        agent.CurrentTurn,
		Sessions:           sessions,
		Turns:              turns,
		SubAgents:          subAgents,
		ToolCalls:          toolCalls,
		StatusTimeline:     timeline,
		RecentActivities:   agentActivities,
		ActiveBusinessCall: agent.ActiveBusinessCall,
		Stats:              stats,
	}, nil
}

func (s *PostgresStore) SubAgents(ctx context.Context, collectorID string, agentID string, now time.Time) ([]dashboard.SubAgentItem, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT
	sa.collector_id,
	sa.parent_agent_id,
	sa.sub_agent_id,
	sa.session_id,
	sa.parent_turn_id,
	COALESCE(t.title, '') AS turn_title,
	sa.nickname,
	sa.spawn_tool_call_id,
	sa.name,
	sa.role,
	sa.status,
	sa.current_activity,
	sa.started_at,
	sa.updated_at,
	sa.completed_at
FROM office_agent_sub_agents sa
LEFT JOIN office_agent_turns t
  ON t.collector_id = sa.collector_id
 AND t.agent_id = sa.parent_agent_id
 AND t.turn_id = sa.parent_turn_id
WHERE sa.collector_id = $1 AND sa.parent_agent_id = $2
ORDER BY sa.completed_at NULLS FIRST, sa.updated_at DESC
`, collectorID, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []dashboard.SubAgentItem{}
	for rows.Next() {
		var item dashboard.SubAgentItem
		if err := rows.Scan(
			&item.CollectorID,
			&item.ParentAgentID,
			&item.SubAgentID,
			&item.SessionID,
			&item.ParentTurnID,
			&item.TurnTitle,
			&item.Nickname,
			&item.SpawnToolCallID,
			&item.Name,
			&item.Role,
			&item.Status,
			&item.CurrentActivity,
			&item.StartedAt,
			&item.UpdatedAt,
			&item.CompletedAt,
		); err != nil {
			return nil, err
		}
		end := now
		if item.CompletedAt != nil {
			end = *item.CompletedAt
		}
		if !item.StartedAt.IsZero() && end.After(item.StartedAt) {
			item.DurationMS = end.Sub(item.StartedAt).Milliseconds()
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *PostgresStore) UserSubAgents(ctx context.Context, userID, collectorID, agentID string, now time.Time) ([]dashboard.SubAgentItem, error) {
	owned, err := s.userOwnsCollector(ctx, userID, collectorID)
	if err != nil {
		return nil, err
	}
	if !owned {
		return nil, sql.ErrNoRows
	}
	return s.SubAgents(ctx, collectorID, agentID, now)
}

func (s *PostgresStore) RecentActivities(ctx context.Context, limit int, now time.Time) ([]dashboard.ActivityFeedItem, error) {
	return s.recentActivities(ctx, "", limit, now)
}

func (s *PostgresStore) UserRecentActivities(ctx context.Context, userID string, limit int, now time.Time) ([]dashboard.ActivityFeedItem, error) {
	return s.recentActivities(ctx, userID, limit, now)
}

func (s *PostgresStore) recentActivities(ctx context.Context, userID string, limit int, now time.Time) ([]dashboard.ActivityFeedItem, error) {
	if limit <= 0 {
		limit = 20
	}
	ownerJoin := ""
	where := ""
	args := []any{limit}
	if userID != "" {
		ownerJoin = "JOIN office_collector_tokens owner ON owner.collector_id = a.collector_id"
		where = "WHERE owner.user_id = $2"
		args = append(args, userID)
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT
	a.collector_id,
	a.agent_id,
	a.activity_id,
	COALESCE(NULLIF(mcp.name, ''), NULLIF(ag.display_name, ''), a.agent_id) AS display_name,
	a.activity_type,
	a.status,
	a.title,
	COALESCE(NULLIF(tc.input->>'command', ''), a.summary) AS summary,
	a.started_at
FROM office_agent_activities a
JOIN office_agents ag ON ag.collector_id = a.collector_id AND ag.agent_id = a.agent_id
`+ownerJoin+`
LEFT JOIN mcp_agents mcp ON mcp.agent_id = ag.mcp_agent_id
LEFT JOIN office_agent_tool_calls tc
  ON tc.collector_id = a.collector_id
 AND tc.agent_id = a.agent_id
 AND tc.tool_call_id = a.tool_call_id
`+where+`
ORDER BY a.started_at DESC
LIMIT $1
`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []dashboard.ActivityFeedItem{}
	for rows.Next() {
		var collectorID, agentID, activityID, displayName, activityType, status, title, summary string
		var occurredAt time.Time
		if err := rows.Scan(&collectorID, &agentID, &activityID, &displayName, &activityType, &status, &title, &summary, &occurredAt); err != nil {
			return nil, err
		}
		text := fmt.Sprintf("%s %s", displayName, activityType)
		if title != "" {
			text = fmt.Sprintf("%s: %s", text, title)
		} else if summary != "" {
			text = fmt.Sprintf("%s: %s", text, summary)
		}
		out = append(out, dashboard.ActivityFeedItem{
			CollectorID:  collectorID,
			AgentID:      agentID,
			ActivityID:   activityID,
			ActivityType: activityType,
			Status:       status,
			Title:        title,
			Summary:      summary,
			OccurredAt:   occurredAt,
			Text:         text,
		})
	}
	return out, rows.Err()
}

func (s *PostgresStore) dashboardAgents(ctx context.Context, collectorID string, agentID string, now time.Time) ([]dashboard.AgentListItem, error) {
	return s.dashboardAgentsScoped(ctx, "", collectorID, agentID, now)
}

func (s *PostgresStore) dashboardAgentsScoped(ctx context.Context, userID, collectorID, agentID string, now time.Time) ([]dashboard.AgentListItem, error) {
	ownerJoin := ""
	conditions := []string{}
	args := []any{}
	if userID != "" {
		ownerJoin = "JOIN office_collector_tokens owner ON owner.collector_id = a.collector_id"
		args = append(args, userID)
		conditions = append(conditions, fmt.Sprintf("owner.user_id = $%d", len(args)))
	}
	if collectorID != "" && agentID != "" {
		args = append(args, collectorID)
		conditions = append(conditions, fmt.Sprintf("a.collector_id = $%d", len(args)))
		args = append(args, agentID)
		conditions = append(conditions, fmt.Sprintf("a.agent_id = $%d", len(args)))
	}
	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT
	a.collector_id,
	a.agent_id,
	COALESCE(a.mcp_agent_id, '') AS mcp_agent_id,
	a.device_id,
	a.agent_type,
	COALESCE(NULLIF(mcp.name, ''), NULLIF(a.display_name, ''), a.agent_id) AS display_name,
	COALESCE(responsibility.user_id, '') AS owner_user_id,
	COALESCE(responsibility_account.name, '') AS owner_name,
	COALESCE(responsibility_account.email, '') AS owner_email,
	a.status,
	a.workspace_name,
	a.current_session_id,
	a.current_turn_id,
	a.last_seen_at,
	a.updated_at,
	a.metadata,
	s.session_id,
	s.status,
	s.summary,
	s.started_at,
	s.ended_at,
	s.workspace_name,
	s.updated_at,
	t.turn_id,
	t.session_id,
	t.sub_agent_id,
	t.parent_agent_id,
	t.parent_turn_id,
	t.spawn_tool_call_id,
	t.title,
	t.user_prompt,
	t.assistant_summary,
	t.last_assistant_message,
	t.status,
	t.started_at,
	t.updated_at,
	t.completed_at
FROM office_agents a
`+ownerJoin+`
LEFT JOIN mcp_agents mcp ON mcp.agent_id = a.mcp_agent_id
LEFT JOIN office_collector_tokens responsibility
  ON responsibility.collector_id = a.collector_id
LEFT JOIN accounts responsibility_account
  ON responsibility_account.user_id = responsibility.user_id
LEFT JOIN office_agent_sessions s
  ON s.collector_id = a.collector_id
 AND s.agent_id = a.agent_id
 AND s.session_id = a.current_session_id
LEFT JOIN office_agent_turns t
  ON t.collector_id = a.collector_id
 AND t.agent_id = a.agent_id
 AND t.turn_id = a.current_turn_id
`+where+`
ORDER BY a.last_seen_at DESC, a.collector_id, a.agent_id
`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []dashboard.AgentListItem{}
	for rows.Next() {
		item, err := scanDashboardAgent(rows, now)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for i := range out {
		var err error
		out[i].SubAgents, err = s.subAgentSummary(ctx, out[i].CollectorID, out[i].AgentID, now)
		if err != nil {
			return nil, err
		}
		out[i].ActiveBusinessCall, err = s.activeBusinessCall(ctx, out[i].CollectorID, out[i].AgentID)
		if err != nil {
			return nil, err
		}
	}
	if err := s.fillAgentThroughput(ctx, out, now); err != nil {
		return nil, err
	}
	return out, nil
}

func scanDashboardAgent(rows *sql.Rows, now time.Time) (dashboard.AgentListItem, error) {
	var item dashboard.AgentListItem
	var metadataBytes []byte
	var currentSessionID, currentTurnID string
	var sessionID, sessionStatus, sessionSummary, sessionWorkspace sql.NullString
	var sessionStarted, sessionEnded, sessionUpdated sql.NullTime
	var turnID, turnSessionID, turnSubAgentID, turnParentAgentID, turnParentTurnID, turnSpawnToolCallID sql.NullString
	var turnTitle, turnUserPrompt, turnAssistantSummary, turnLastAssistantMessage, turnStatus sql.NullString
	var turnStarted, turnUpdated, turnCompleted sql.NullTime
	if err := rows.Scan(
		&item.CollectorID,
		&item.AgentID,
		&item.MCPAgentID,
		&item.DeviceID,
		&item.AgentType,
		&item.DisplayName,
		&item.OwnerUserID,
		&item.OwnerName,
		&item.OwnerEmail,
		&item.Status,
		&item.WorkspaceName,
		&currentSessionID,
		&currentTurnID,
		&item.LastSeenAt,
		&item.UpdatedAt,
		&metadataBytes,
		&sessionID,
		&sessionStatus,
		&sessionSummary,
		&sessionStarted,
		&sessionEnded,
		&sessionWorkspace,
		&sessionUpdated,
		&turnID,
		&turnSessionID,
		&turnSubAgentID,
		&turnParentAgentID,
		&turnParentTurnID,
		&turnSpawnToolCallID,
		&turnTitle,
		&turnUserPrompt,
		&turnAssistantSummary,
		&turnLastAssistantMessage,
		&turnStatus,
		&turnStarted,
		&turnUpdated,
		&turnCompleted,
	); err != nil {
		return dashboard.AgentListItem{}, err
	}

	metadata := map[string]string{}
	if len(metadataBytes) > 0 {
		if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
			return dashboard.AgentListItem{}, err
		}
	}
	item.RoleLabel = firstNonEmpty(metadata["role_label"], item.AgentType)
	item.AvatarLabel = dashboard.AvatarLabel(item.DisplayName, item.AgentID)
	if isDashboardStale(now, item.LastSeenAt) {
		item.Status = string(collectorapi.StatusOffline)
	}
	if sessionID.Valid && sessionStarted.Valid {
		var endedAt *time.Time
		if sessionEnded.Valid {
			endedAt = &sessionEnded.Time
		}
		status := sessionStatus.String
		if endedAt == nil && sessionUpdated.Valid && isDashboardStale(now, sessionUpdated.Time) {
			status = string(collectorapi.StatusIdle)
		}
		item.CurrentSession = &dashboard.SessionItem{
			SessionID:     sessionID.String,
			Status:        status,
			Summary:       sessionSummary.String,
			StartedAt:     sessionStarted.Time,
			EndedAt:       endedAt,
			WorkspaceName: sessionWorkspace.String,
			DurationMS:    dashboard.DurationMillis(sessionStarted.Time, endedAt, now),
		}
	}
	if turnID.Valid && turnStarted.Valid && turnUpdated.Valid {
		var completedAt *time.Time
		if turnCompleted.Valid {
			completedAt = &turnCompleted.Time
		}
		status := turnStatus.String
		if completedAt == nil && isDashboardStale(now, turnUpdated.Time) {
			status = string(collectorapi.StatusIdle)
		}
		item.CurrentTurn = &dashboard.TurnItem{
			TurnID:               turnID.String,
			SessionID:            turnSessionID.String,
			SubAgentID:           turnSubAgentID.String,
			ParentAgentID:        turnParentAgentID.String,
			ParentTurnID:         turnParentTurnID.String,
			SpawnToolCallID:      turnSpawnToolCallID.String,
			Title:                turnTitle.String,
			UserPrompt:           turnUserPrompt.String,
			AssistantSummary:     turnAssistantSummary.String,
			LastAssistantMessage: turnLastAssistantMessage.String,
			Status:               status,
			StartedAt:            turnStarted.Time,
			UpdatedAt:            turnUpdated.Time,
			CompletedAt:          completedAt,
		}
	}
	return item, nil
}

func (s *PostgresStore) subAgentSummary(ctx context.Context, collectorID string, agentID string, now time.Time) (dashboard.SubAgentSummary, error) {
	items, err := s.SubAgents(ctx, collectorID, agentID, now)
	if err != nil {
		return dashboard.SubAgentSummary{}, err
	}
	summary := dashboard.SubAgentSummary{TotalCount: len(items), Preview: []dashboard.SubAgentItem{}}
	for _, item := range items {
		if item.CompletedAt == nil {
			summary.ActiveCount++
		}
		if len(summary.Preview) < subAgentPreviewLimit {
			summary.Preview = append(summary.Preview, item)
		}
	}
	return summary, nil
}

func (s *PostgresStore) agentSessions(ctx context.Context, collectorID string, agentID string, limit int, now time.Time) ([]dashboard.SessionItem, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT session_id, status, summary, started_at, ended_at, workspace_name, updated_at
FROM office_agent_sessions
WHERE collector_id = $1 AND agent_id = $2
ORDER BY ended_at IS NULL DESC, started_at DESC, session_id
LIMIT $3
`, collectorID, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []dashboard.SessionItem{}
	for rows.Next() {
		var item dashboard.SessionItem
		var endedAt, updatedAt sql.NullTime
		if err := rows.Scan(
			&item.SessionID,
			&item.Status,
			&item.Summary,
			&item.StartedAt,
			&endedAt,
			&item.WorkspaceName,
			&updatedAt,
		); err != nil {
			return nil, err
		}
		if endedAt.Valid {
			item.EndedAt = &endedAt.Time
		}
		if item.EndedAt == nil && updatedAt.Valid && isDashboardStale(now, updatedAt.Time) {
			item.Status = string(collectorapi.StatusIdle)
		}
		item.DurationMS = dashboard.DurationMillis(item.StartedAt, item.EndedAt, now)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *PostgresStore) agentTurns(ctx context.Context, collectorID string, agentID string, limit int, now time.Time) ([]dashboard.TurnItem, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT turn_id, session_id, sub_agent_id, parent_agent_id, parent_turn_id, spawn_tool_call_id,
       title, user_prompt, assistant_summary, last_assistant_message, status,
       started_at, updated_at, completed_at
FROM office_agent_turns
WHERE collector_id = $1 AND agent_id = $2
ORDER BY started_at DESC, turn_id
LIMIT $3
`, collectorID, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []dashboard.TurnItem{}
	for rows.Next() {
		var item dashboard.TurnItem
		var completedAt sql.NullTime
		if err := rows.Scan(
			&item.TurnID,
			&item.SessionID,
			&item.SubAgentID,
			&item.ParentAgentID,
			&item.ParentTurnID,
			&item.SpawnToolCallID,
			&item.Title,
			&item.UserPrompt,
			&item.AssistantSummary,
			&item.LastAssistantMessage,
			&item.Status,
			&item.StartedAt,
			&item.UpdatedAt,
			&completedAt,
		); err != nil {
			return nil, err
		}
		if completedAt.Valid {
			item.CompletedAt = &completedAt.Time
		}
		if item.CompletedAt == nil && isDashboardStale(now, item.UpdatedAt) {
			item.Status = string(collectorapi.StatusIdle)
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *PostgresStore) activeBusinessCall(ctx context.Context, collectorID string, agentID string) (*dashboard.BusinessCall, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT metadata
FROM office_agent_activities
WHERE collector_id = $1
  AND agent_id = $2
  AND completed_at IS NULL
  AND activity_type = $3
ORDER BY started_at DESC
LIMIT 1
`, collectorID, agentID, collectorapi.ActivityCallingBusinessSystem)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var metadataBytes []byte
	if err := rows.Scan(&metadataBytes); err != nil {
		return nil, err
	}
	metadata := map[string]string{}
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		return nil, err
	}
	call, ok := dashboard.BusinessCallFromMetadata(metadata)
	if !ok {
		return nil, nil
	}
	return &call, rows.Err()
}

func (s *PostgresStore) agentActivities(ctx context.Context, collectorID string, agentID string, limit int, now time.Time) ([]dashboard.ActivityItem, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT collector_id, activity_id, agent_id, COALESCE(sub_agent_id, ''), session_id, turn_id, tool_call_id, activity_type, status, title, summary, started_at, completed_at, metadata
FROM office_agent_activities
WHERE collector_id = $1 AND agent_id = $2
ORDER BY started_at DESC
LIMIT $3
`, collectorID, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []dashboard.ActivityItem{}
	for rows.Next() {
		var item dashboard.ActivityItem
		var metadataBytes []byte
		if err := rows.Scan(
			&item.CollectorID,
			&item.ActivityID,
			&item.AgentID,
			&item.SubAgentID,
			&item.SessionID,
			&item.TurnID,
			&item.ToolCallID,
			&item.ActivityType,
			&item.Status,
			&item.Title,
			&item.Summary,
			&item.StartedAt,
			&item.CompletedAt,
			&metadataBytes,
		); err != nil {
			return nil, err
		}
		item.DurationMS = dashboard.DurationMillis(item.StartedAt, item.CompletedAt, now)
		metadata := map[string]string{}
		if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
			return nil, err
		}
		if call, ok := dashboard.BusinessCallFromMetadata(metadata); ok {
			item.BusinessCall = &call
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *PostgresStore) agentToolCalls(ctx context.Context, collectorID string, agentID string, limit int, now time.Time) ([]dashboard.ToolCallItem, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT collector_id, agent_id, tool_call_id, external_tool_call_id, session_id, turn_id, sub_agent_id,
       tool_name, tool_type, status, input, response, response_text, started_at, completed_at, duration_ms
FROM office_agent_tool_calls
WHERE collector_id = $1 AND agent_id = $2
ORDER BY started_at DESC
LIMIT $3
`, collectorID, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []dashboard.ToolCallItem{}
	for rows.Next() {
		var item dashboard.ToolCallItem
		if err := rows.Scan(
			&item.CollectorID,
			&item.AgentID,
			&item.ToolCallID,
			&item.ExternalToolCallID,
			&item.SessionID,
			&item.TurnID,
			&item.SubAgentID,
			&item.ToolName,
			&item.ToolType,
			&item.Status,
			&item.Input,
			&item.Response,
			&item.ResponseText,
			&item.StartedAt,
			&item.CompletedAt,
			&item.DurationMS,
		); err != nil {
			return nil, err
		}
		if item.DurationMS == 0 {
			item.DurationMS = dashboard.DurationMillis(item.StartedAt, item.CompletedAt, now)
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

type agentStatsMetrics struct {
	ActiveSessions      int
	ActiveWorkMS        int64
	ToolTypeVariety     int
	ToolCallCount       int
	RecentActivityCount int
}

func (s *PostgresStore) agentStatsMetrics(ctx context.Context, collectorID string, agentID string, now time.Time) (agentStatsMetrics, error) {
	var metrics agentStatsMetrics
	err := s.db.QueryRowContext(ctx, `
SELECT
	(SELECT COUNT(*) FROM office_agent_sessions WHERE collector_id = $1 AND agent_id = $2 AND ended_at IS NULL AND updated_at >= $4) AS active_sessions,
	(SELECT COALESCE(SUM(CASE
		WHEN duration_ms > 0 THEN duration_ms
		WHEN completed_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::bigint
		ELSE GREATEST(0, EXTRACT(EPOCH FROM ($3 - started_at)) * 1000)::bigint
	END), 0) FROM office_agent_tool_calls WHERE collector_id = $1 AND agent_id = $2) AS active_work_ms,
	(SELECT COUNT(DISTINCT NULLIF(tool_type, '')) FROM office_agent_tool_calls WHERE collector_id = $1 AND agent_id = $2) AS tool_type_variety,
	(SELECT COUNT(*) FROM office_agent_tool_calls WHERE collector_id = $1 AND agent_id = $2) AS tool_call_count,
	(SELECT LEAST(COUNT(*), 100) FROM office_agent_activities WHERE collector_id = $1 AND agent_id = $2) AS recent_activity_count
`, collectorID, agentID, now, now.Add(-dashboardStaleAfter)).Scan(
		&metrics.ActiveSessions,
		&metrics.ActiveWorkMS,
		&metrics.ToolTypeVariety,
		&metrics.ToolCallCount,
		&metrics.RecentActivityCount,
	)
	return metrics, err
}

type officeSummaryMetrics struct {
	ActiveSessions      int
	ActiveTurns         int
	RecentToolCallCount int
}

func (s *PostgresStore) officeSummaryMetrics(ctx context.Context, now time.Time) (officeSummaryMetrics, error) {
	var metrics officeSummaryMetrics
	err := s.db.QueryRowContext(ctx, `
SELECT
	(SELECT COUNT(*) FROM office_agent_sessions WHERE ended_at IS NULL AND updated_at >= $3) AS active_sessions,
	(SELECT COUNT(*) FROM office_agent_turns WHERE completed_at IS NULL AND updated_at >= $3) AS active_turns,
	(SELECT COUNT(*) FROM office_agent_tool_calls WHERE started_at >= $1 AND started_at <= $2) AS recent_tool_call_count
`, now.Add(-5*time.Minute), now, now.Add(-dashboardStaleAfter)).Scan(
		&metrics.ActiveSessions,
		&metrics.ActiveTurns,
		&metrics.RecentToolCallCount,
	)
	return metrics, err
}

func (s *PostgresStore) officeSummaryMetricsForUser(ctx context.Context, userID string, now time.Time) (officeSummaryMetrics, error) {
	var metrics officeSummaryMetrics
	err := s.db.QueryRowContext(ctx, `
SELECT
	(SELECT COUNT(*) FROM office_agent_sessions s JOIN office_collector_tokens o ON o.collector_id = s.collector_id WHERE o.user_id = $1 AND s.ended_at IS NULL AND s.updated_at >= $4) AS active_sessions,
	(SELECT COUNT(*) FROM office_agent_turns t JOIN office_collector_tokens o ON o.collector_id = t.collector_id WHERE o.user_id = $1 AND t.completed_at IS NULL AND t.updated_at >= $4) AS active_turns,
	(SELECT COUNT(*) FROM office_agent_tool_calls tc JOIN office_collector_tokens o ON o.collector_id = tc.collector_id WHERE o.user_id = $1 AND tc.started_at >= $2 AND tc.started_at <= $3) AS recent_tool_call_count
`, userID, now.Add(-5*time.Minute), now, now.Add(-dashboardStaleAfter)).Scan(
		&metrics.ActiveSessions,
		&metrics.ActiveTurns,
		&metrics.RecentToolCallCount,
	)
	return metrics, err
}

func (s *PostgresStore) userOwnsCollector(ctx context.Context, userID, collectorID string) (bool, error) {
	var owned bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM office_collector_tokens WHERE user_id = $1 AND collector_id = $2)`, userID, collectorID).Scan(&owned)
	return owned, err
}

type agentBatchKey struct {
	CollectorID string
	AgentID     string
}

func (s *PostgresStore) fillAgentThroughput(ctx context.Context, agents []dashboard.AgentListItem, now time.Time) error {
	if len(agents) == 0 {
		return nil
	}
	keyIndex := map[agentBatchKey]int{}
	for i := range agents {
		keyIndex[agentBatchKey{CollectorID: agents[i].CollectorID, AgentID: agents[i].AgentID}] = i
		agents[i].Sessions = []dashboard.AgentSessionBrief{}
	}
	if err := s.fillAgentSessionBriefs(ctx, agents, keyIndex, now); err != nil {
		return err
	}
	return s.fillAgentToolMetrics(ctx, agents, keyIndex, now)
}

func (s *PostgresStore) fillAgentSessionBriefs(ctx context.Context, agents []dashboard.AgentListItem, keyIndex map[agentBatchKey]int, now time.Time) error {
	selectedAgents, args := selectedAgentValuesSQL(agents, 1)
	rows, err := s.db.QueryContext(ctx, `
WITH selected_agents(collector_id, agent_id) AS (`+selectedAgents+`),
ranked_sessions AS (
	SELECT
		s.collector_id,
		s.agent_id,
		s.session_id,
		s.status,
		s.ended_at IS NULL AS active,
		s.updated_at,
		ROW_NUMBER() OVER (
			PARTITION BY s.collector_id, s.agent_id
			ORDER BY s.ended_at IS NULL DESC, s.started_at DESC, s.session_id
		) AS rn
	FROM office_agent_sessions s
	JOIN selected_agents a
	  ON a.collector_id = s.collector_id
	 AND a.agent_id = s.agent_id
),
session_turns AS (
	SELECT DISTINCT ON (t.collector_id, t.agent_id, t.session_id)
		t.collector_id,
		t.agent_id,
		t.session_id,
		t.title
	FROM office_agent_turns t
	JOIN ranked_sessions s
	  ON s.collector_id = t.collector_id
	 AND s.agent_id = t.agent_id
	 AND s.session_id = t.session_id
	WHERE s.rn <= 10
	ORDER BY t.collector_id, t.agent_id, t.session_id, t.completed_at IS NULL DESC, t.started_at DESC, t.turn_id
),
session_actions AS (
	SELECT collector_id, agent_id, session_id, tool_name, tool_type, status, started_at, action_rank
	FROM (
		SELECT
			tc.collector_id,
			tc.agent_id,
			tc.session_id,
			tc.tool_name,
			tc.tool_type,
			tc.status,
			tc.started_at,
			ROW_NUMBER() OVER (
				PARTITION BY tc.collector_id, tc.agent_id, tc.session_id
				ORDER BY tc.started_at DESC, tc.tool_call_id
			) AS action_rank
		FROM office_agent_tool_calls tc
		JOIN ranked_sessions s
		  ON s.collector_id = tc.collector_id
		 AND s.agent_id = tc.agent_id
		 AND s.session_id = tc.session_id
		WHERE s.rn <= 10
	) ranked_actions
	WHERE action_rank <= 2
)
SELECT
	s.collector_id,
	s.agent_id,
	s.session_id,
	s.status,
	COALESCE(t.title, '') AS current_turn_title,
	s.active,
	s.updated_at,
	a.tool_name,
	a.tool_type,
	a.status,
	a.started_at,
	a.action_rank
FROM ranked_sessions s
LEFT JOIN session_turns t
  ON t.collector_id = s.collector_id
 AND t.agent_id = s.agent_id
 AND t.session_id = s.session_id
LEFT JOIN session_actions a
  ON a.collector_id = s.collector_id
 AND a.agent_id = s.agent_id
 AND a.session_id = s.session_id
WHERE s.rn <= 10
ORDER BY s.collector_id, s.agent_id, s.rn, a.action_rank
`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	sessionIndexes := map[agentBatchKey]map[string]int{}
	for rows.Next() {
		var collectorID, agentID string
		var brief dashboard.AgentSessionBrief
		var toolName, toolType, status sql.NullString
		var startedAt, sessionUpdatedAt sql.NullTime
		var actionRank sql.NullInt64
		if err := rows.Scan(
			&collectorID,
			&agentID,
			&brief.SessionID,
			&brief.Status,
			&brief.CurrentTurnTitle,
			&brief.Active,
			&sessionUpdatedAt,
			&toolName,
			&toolType,
			&status,
			&startedAt,
			&actionRank,
		); err != nil {
			return err
		}
		if brief.Active && sessionUpdatedAt.Valid && isDashboardStale(now, sessionUpdatedAt.Time) {
			brief.Active = false
			brief.Status = string(collectorapi.StatusIdle)
		}
		brief.RecentActions = []dashboard.AgentLastAction{}
		if startedAt.Valid {
			action := dashboard.AgentLastAction{
				ToolName:  toolName.String,
				ToolType:  toolType.String,
				Status:    status.String,
				StartedAt: startedAt.Time,
			}
			brief.LastAction = &action
			brief.RecentActions = append(brief.RecentActions, action)
		}
		if i, ok := keyIndex[agentBatchKey{CollectorID: collectorID, AgentID: agentID}]; ok {
			key := agentBatchKey{CollectorID: collectorID, AgentID: agentID}
			if sessionIndexes[key] == nil {
				sessionIndexes[key] = map[string]int{}
			}
			if existingIndex, exists := sessionIndexes[key][brief.SessionID]; exists {
				if len(brief.RecentActions) > 0 {
					agents[i].Sessions[existingIndex].RecentActions = append(agents[i].Sessions[existingIndex].RecentActions, brief.RecentActions[0])
					if agents[i].Sessions[existingIndex].LastAction == nil || actionRank.Int64 == 1 {
						action := brief.RecentActions[0]
						agents[i].Sessions[existingIndex].LastAction = &action
					}
				}
				continue
			}
			sessionIndexes[key][brief.SessionID] = len(agents[i].Sessions)
			agents[i].Sessions = append(agents[i].Sessions, brief)
		}
	}
	return rows.Err()
}

func (s *PostgresStore) fillAgentToolMetrics(ctx context.Context, agents []dashboard.AgentListItem, keyIndex map[agentBatchKey]int, now time.Time) error {
	selectedAgents, args := selectedAgentValuesSQL(agents, 3)
	args = append([]any{now.Add(-5 * time.Minute), now}, args...)
	rows, err := s.db.QueryContext(ctx, `
WITH selected_agents(collector_id, agent_id) AS (`+selectedAgents+`),
latest_actions AS (
	SELECT DISTINCT ON (tc.collector_id, tc.agent_id)
		tc.collector_id,
		tc.agent_id,
		tc.tool_name,
		tc.tool_type,
		tc.status,
		tc.started_at
	FROM office_agent_tool_calls tc
	JOIN selected_agents a
	  ON a.collector_id = tc.collector_id
	 AND a.agent_id = tc.agent_id
	ORDER BY tc.collector_id, tc.agent_id, tc.started_at DESC, tc.tool_call_id
),
recent_counts AS (
	SELECT tc.collector_id, tc.agent_id, COUNT(*) AS recent_tool_calls
	FROM office_agent_tool_calls tc
	JOIN selected_agents a
	  ON a.collector_id = tc.collector_id
	 AND a.agent_id = tc.agent_id
	WHERE tc.started_at >= $1 AND tc.started_at <= $2
	GROUP BY tc.collector_id, tc.agent_id
)
SELECT
	a.collector_id,
	a.agent_id,
	la.tool_name,
	la.tool_type,
	la.status,
	la.started_at,
	COALESCE(rc.recent_tool_calls, 0) AS recent_tool_calls
FROM selected_agents a
LEFT JOIN latest_actions la
  ON la.collector_id = a.collector_id
 AND la.agent_id = a.agent_id
LEFT JOIN recent_counts rc
  ON rc.collector_id = a.collector_id
 AND rc.agent_id = a.agent_id
`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var collectorID, agentID string
		var toolName, toolType, status sql.NullString
		var startedAt sql.NullTime
		var recentToolCalls int
		if err := rows.Scan(&collectorID, &agentID, &toolName, &toolType, &status, &startedAt, &recentToolCalls); err != nil {
			return err
		}
		i, ok := keyIndex[agentBatchKey{CollectorID: collectorID, AgentID: agentID}]
		if !ok {
			continue
		}
		agents[i].RecentToolCalls = recentToolCalls
		if startedAt.Valid {
			agents[i].LastAction = &dashboard.AgentLastAction{
				ToolName:  toolName.String,
				ToolType:  toolType.String,
				Status:    status.String,
				StartedAt: startedAt.Time,
			}
		}
	}
	return rows.Err()
}

func buildOfficeFilters(agents []dashboard.AgentListItem) dashboard.OfficeFilters {
	workspaces := map[string]int{}
	statusCounts := map[string]int{}
	businessSystems := map[string]dashboard.BusinessSystemCount{}
	for _, agent := range agents {
		if strings.TrimSpace(agent.WorkspaceName) != "" {
			workspaces[agent.WorkspaceName]++
		}
		statusCounts[agent.Status]++
		if agent.ActiveBusinessCall != nil {
			key := agent.ActiveBusinessCall.SystemType + "\x00" + agent.ActiveBusinessCall.SystemName
			count := businessSystems[key]
			count.SystemType = agent.ActiveBusinessCall.SystemType
			count.SystemName = agent.ActiveBusinessCall.SystemName
			count.ActiveCount++
			businessSystems[key] = count
		}
	}
	workspaceCounts := make([]dashboard.WorkspaceCount, 0, len(workspaces))
	for workspace, count := range workspaces {
		workspaceCounts = append(workspaceCounts, dashboard.WorkspaceCount{WorkspaceName: workspace, AgentCount: count})
	}
	sort.Slice(workspaceCounts, func(i, j int) bool {
		return workspaceCounts[i].WorkspaceName < workspaceCounts[j].WorkspaceName
	})
	systemCounts := make([]dashboard.BusinessSystemCount, 0, len(businessSystems))
	for _, count := range businessSystems {
		systemCounts = append(systemCounts, count)
	}
	sort.Slice(systemCounts, func(i, j int) bool {
		return systemCounts[i].SystemName < systemCounts[j].SystemName
	})
	return dashboard.OfficeFilters{
		Workspaces:      workspaceCounts,
		StatusCounts:    statusCounts,
		BusinessSystems: systemCounts,
	}
}

func buildOfficeSummary(agents []dashboard.AgentListItem, metrics officeSummaryMetrics) dashboard.OfficeSummary {
	var summary dashboard.OfficeSummary
	summary.TotalAgents = len(agents)
	summary.ActiveSessions = metrics.ActiveSessions
	summary.ActiveTurns = metrics.ActiveTurns
	summary.RecentToolCallCount = metrics.RecentToolCallCount
	for _, agent := range agents {
		if agent.Status != string(collectorapi.StatusOffline) {
			summary.OnlineAgents++
		}
		if isWorkingStatus(agent.Status) {
			summary.WorkingAgents++
		}
		if agent.Status == string(collectorapi.StatusBlocked) {
			summary.BlockedAgents++
		}
		if agent.Status == string(collectorapi.StatusError) {
			summary.ErrorAgents++
		}
		summary.ActiveSubAgents += agent.SubAgents.ActiveCount
	}
	return summary
}

func selectedAgentValuesSQL(agents []dashboard.AgentListItem, firstPlaceholder int) (string, []any) {
	values := make([]string, 0, len(agents))
	args := make([]any, 0, len(agents)*2)
	placeholder := firstPlaceholder
	for _, agent := range agents {
		values = append(values, fmt.Sprintf("($%d, $%d)", placeholder, placeholder+1))
		args = append(args, agent.CollectorID, agent.AgentID)
		placeholder += 2
	}
	return "VALUES " + strings.Join(values, ", "), args
}

func isWorkingStatus(status string) bool {
	switch collectorapi.Status(status) {
	case collectorapi.StatusThinking,
		collectorapi.StatusSearching,
		collectorapi.StatusCoding,
		collectorapi.StatusReadingFiles,
		collectorapi.StatusRunningCommands,
		collectorapi.StatusOrganizingData,
		collectorapi.StatusSummarizing,
		collectorapi.StatusCallingBusinessSystem:
		return true
	default:
		return false
	}
}

func isDashboardStale(now time.Time, updatedAt time.Time) bool {
	return !updatedAt.IsZero() && now.Sub(updatedAt) > dashboardStaleAfter
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
