package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
)

func (s *PostgresStore) AgentSummary(ctx context.Context, agentID string, start, end time.Time) (activity.AgentSummary, error) {
	var result activity.AgentSummary
	var lastSeen time.Time
	err := s.db.QueryRowContext(ctx, `
SELECT a.agent_id, COALESCE(NULLIF(ma.name, ''), NULLIF(a.display_name, ''), a.agent_id), a.status, a.last_seen_at
FROM office_agents a
LEFT JOIN mcp_agents ma ON ma.agent_id = a.mcp_agent_id
WHERE a.agent_id = $1
ORDER BY a.last_seen_at DESC, a.collector_id
LIMIT 1`, agentID).Scan(&result.AgentID, &result.Name, &result.Status, &lastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return activity.AgentSummary{}, activity.ErrAgentNotFound
	}
	if err != nil {
		return activity.AgentSummary{}, err
	}

	var lastActivity sql.NullTime
	err = s.db.QueryRowContext(ctx, `
WITH scoped AS (
  SELECT collector_id, agent_id, COALESCE(mcp_agent_id, agent_id) AS mcp_agent_id
  FROM office_agents WHERE agent_id = $1
)
SELECT
  (SELECT COUNT(DISTINCT (se.collector_id, se.session_id)) FROM office_agent_sessions se JOIN scoped s USING (collector_id, agent_id) WHERE se.started_at >= $2 AND se.started_at < $3),
  (SELECT COUNT(DISTINCT (t.collector_id, t.turn_id)) FROM office_agent_turns t JOIN scoped s USING (collector_id, agent_id) WHERE t.started_at >= $2 AND t.started_at < $3),
  (SELECT COUNT(DISTINCT (t.collector_id, t.turn_id)) FROM office_agent_turns t JOIN scoped s USING (collector_id, agent_id) WHERE t.completed_at >= $2 AND t.completed_at < $3),
  (SELECT COUNT(DISTINCT (tc.collector_id, tc.tool_call_id)) FROM office_agent_tool_calls tc JOIN scoped s USING (collector_id, agent_id) WHERE tc.started_at >= $2 AND tc.started_at < $3),
  (SELECT COUNT(*) FROM mcp_proxy_audit_records a WHERE a.agent_id IN (SELECT mcp_agent_id FROM scoped) AND a.created_at >= $2 AND a.created_at < $3 AND a.capability_type = 'tool' AND a.decision IN ('allowed', 'confirmation_completed')),
  (SELECT MAX(occurred_at) FROM (
    SELECT COALESCE(t.completed_at, t.started_at) AS occurred_at FROM office_agent_turns t JOIN scoped s USING (collector_id, agent_id) WHERE t.started_at >= $2 AND t.started_at < $3
    UNION ALL
    SELECT a.started_at FROM office_agent_activities a JOIN scoped s USING (collector_id, agent_id) WHERE a.started_at >= $2 AND a.started_at < $3
  ) recent)
`, agentID, start, end).Scan(
		&result.SessionCount, &result.TurnCount, &result.CompletedTurnCount, &result.ToolCallCount, &result.MCPCallCount, &lastActivity,
	)
	if err != nil {
		return activity.AgentSummary{}, err
	}
	if lastActivity.Valid {
		value := lastActivity.Time
		result.LastActivityAt = &value
	} else {
		result.LastActivityAt = &lastSeen
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT a.started_at, a.activity_type, a.status
FROM office_agent_activities a
JOIN office_agents agent USING (collector_id, agent_id)
WHERE agent.agent_id = $1 AND a.started_at >= $2 AND a.started_at < $3
ORDER BY a.started_at DESC, a.activity_id
LIMIT 20`, agentID, start, end)
	if err != nil {
		return activity.AgentSummary{}, err
	}
	defer rows.Close()
	result.RecentActivities = []activity.AgentRecentActivity{}
	for rows.Next() {
		var item activity.AgentRecentActivity
		if err := rows.Scan(&item.OccurredAt, &item.Type, &item.Status); err != nil {
			return activity.AgentSummary{}, err
		}
		result.RecentActivities = append(result.RecentActivities, item)
	}
	return result, rows.Err()
}
