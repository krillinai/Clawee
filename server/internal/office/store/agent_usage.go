package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/krillinai/Clawee/server/internal/activity"
)

func (s *PostgresStore) AgentUsage(ctx context.Context, userID, collectorID, agentID string, r activity.DateRange) (activity.AgentUsage, error) {
	result := activity.AgentUsage{Points: []activity.AgentUsagePoint{}, MCPDistribution: []activity.MCPUsage{}, MCPStatus: "unlinked"}
	var mcpAgentID, ownerID string
	err := s.db.QueryRowContext(ctx, `
SELECT COALESCE(a.mcp_agent_id, ''), COALESCE(ct.user_id, '')
FROM office_agents a
LEFT JOIN office_collector_tokens ct ON ct.collector_id = a.collector_id
WHERE a.collector_id = $1 AND a.agent_id = $2 AND ct.user_id = $3`, collectorID, agentID, userID).Scan(&mcpAgentID, &ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return result, activity.ErrAgentNotFound
	}
	if err != nil {
		return result, err
	}
	rows, err := s.db.QueryContext(ctx, `
WITH events AS (
 SELECT started_at AS occurred_at, 'session' AS kind FROM office_agent_sessions WHERE collector_id = $3 AND agent_id = $4
 UNION ALL SELECT started_at, 'turn' FROM office_agent_turns WHERE collector_id = $3 AND agent_id = $4
 UNION ALL SELECT completed_at, 'completed' FROM office_agent_turns WHERE collector_id = $3 AND agent_id = $4 AND completed_at IS NOT NULL
 UNION ALL SELECT started_at, 'tool' FROM office_agent_tool_calls WHERE collector_id = $3 AND agent_id = $4
)
SELECT date_trunc($5, occurred_at AT TIME ZONE $6) AT TIME ZONE $6,
 COUNT(*) FILTER (WHERE kind = 'session'), COUNT(*) FILTER (WHERE kind = 'turn'),
 COUNT(*) FILTER (WHERE kind = 'completed'), COUNT(*) FILTER (WHERE kind = 'tool')
FROM events WHERE occurred_at >= $1 AND occurred_at < $2
GROUP BY 1 ORDER BY 1`, r.Start, r.End, collectorID, agentID, r.Granularity, r.Timezone)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var point activity.AgentUsagePoint
		if err := rows.Scan(&point.BucketStart, &point.SessionCount, &point.TurnCount, &point.CompletedTurns, &point.ToolCallCount); err != nil {
			return result, err
		}
		result.Points = append(result.Points, point)
		result.SessionCount += point.SessionCount
		result.TurnCount += point.TurnCount
		result.CompletedTurns += point.CompletedTurns
		result.ToolCallCount += point.ToolCallCount
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	rows.Close()
	result.SkillUsage, result.SkillUsageTotals, err = s.skillUsage(ctx, r.Start, r.End, collectorID, agentID)
	if err != nil {
		return result, err
	}
	// The database enforces a unique MCP identity per office Agent.
	if mcpAgentID == "" || ownerID == "" {
		return result, nil
	}
	result.MCPStatus = "available"
	mcpRows, err := s.db.QueryContext(ctx, `
SELECT a.upstream_server_id, COALESCE(NULLIF(s.name, ''), a.upstream_server_id), COUNT(*)
FROM mcp_proxy_audit_records a
LEFT JOIN mcp_upstream_servers s ON s.server_id = a.upstream_server_id
WHERE a.agent_id = $1 AND a.user_id = $2 AND a.created_at >= $3 AND a.created_at < $4
 AND a.capability_type = 'tool' AND a.decision IN ('allowed', 'confirmation_completed') AND a.upstream_server_id <> ''
GROUP BY a.upstream_server_id, s.name ORDER BY COUNT(*) DESC, a.upstream_server_id`, mcpAgentID, ownerID, r.Start, r.End)
	if err != nil {
		return result, err
	}
	defer mcpRows.Close()
	var total int64
	for mcpRows.Next() {
		var item activity.MCPUsage
		if err := mcpRows.Scan(&item.ID, &item.Label, &item.InvocationCount); err != nil {
			return result, err
		}
		result.MCPDistribution = append(result.MCPDistribution, item)
		total += item.InvocationCount
	}
	if err := mcpRows.Err(); err != nil {
		return result, err
	}
	if total > 0 {
		for i := range result.MCPDistribution {
			result.MCPDistribution[i].Share = float64(result.MCPDistribution[i].InvocationCount) / float64(total)
		}
	}
	return result, nil
}
