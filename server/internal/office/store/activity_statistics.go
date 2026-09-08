package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
)

func (s *PostgresStore) Statistics(ctx context.Context, start, end time.Time) (activity.ActivitySnapshot, error) {
	var result activity.ActivitySnapshot
	err := s.db.QueryRowContext(ctx, `
SELECT
  COUNT(DISTINCT ct.user_id) FILTER (WHERE t.started_at >= $1 AND t.started_at < $2),
  COUNT(DISTINCT (t.collector_id, t.agent_id)) FILTER (WHERE t.started_at >= $1 AND t.started_at < $2),
  COUNT(DISTINCT (t.collector_id, t.agent_id, t.turn_id)) FILTER (WHERE t.completed_at >= $1 AND t.completed_at < $2)
FROM office_agent_turns t
JOIN office_collector_tokens ct ON ct.collector_id = t.collector_id
WHERE ct.user_id IS NOT NULL
`, start, end).Scan(&result.ActiveEmployees, &result.ActiveAgents, &result.CompletedTurns)
	if err != nil {
		return activity.ActivitySnapshot{}, err
	}
	agentRows, err := s.db.QueryContext(ctx, `
SELECT a.collector_id, a.agent_id, COALESCE(NULLIF(ma.name, ''), NULLIF(a.display_name, ''), a.agent_id), a.status,
       COUNT(DISTINCT se.session_id), COUNT(DISTINCT t.turn_id), MAX(COALESCE(t.completed_at, t.started_at))
FROM office_agents a
LEFT JOIN mcp_agents ma ON ma.agent_id = a.mcp_agent_id
	LEFT JOIN office_agent_sessions se ON se.collector_id = a.collector_id AND se.agent_id = a.agent_id AND se.started_at >= $1 AND se.started_at < $2
	LEFT JOIN office_agent_turns t ON t.collector_id = a.collector_id AND t.agent_id = a.agent_id AND t.started_at >= $1 AND t.started_at < $2
	GROUP BY a.collector_id, a.agent_id, ma.name, a.display_name, a.status
	ORDER BY MAX(COALESCE(t.completed_at, t.started_at)) DESC NULLS LAST, a.collector_id, a.agent_id
	`, start, end)
	if err != nil {
		return activity.ActivitySnapshot{}, err
	}
	defer agentRows.Close()
	result.Agents = []activity.Agent{}
	for agentRows.Next() {
		var item activity.Agent
		var lastActivity sql.NullTime
		if err := agentRows.Scan(&item.CollectorID, &item.AgentID, &item.Name, &item.Status, &item.SessionCount, &item.TurnCount, &lastActivity); err != nil {
			return activity.ActivitySnapshot{}, err
		}
		if lastActivity.Valid {
			value := lastActivity.Time
			item.LastActivityAt = &value
		}
		result.Agents = append(result.Agents, item)
	}
	return result, agentRows.Err()
}
