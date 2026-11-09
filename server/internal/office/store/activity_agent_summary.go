package store

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
)

func (s *PostgresStore) AgentSummary(ctx context.Context, agentID string, start, end time.Time, options activity.AgentDetailOptions) (activity.AgentSummary, error) {
	if options.Limit == 0 {
		options.Limit = 10
	}
	if options.Limit < 1 || options.Limit > 20 || options.Offset < 0 {
		return activity.AgentSummary{}, activity.ErrInvalidAgentList
	}
	var result activity.AgentSummary
	var lastSeen time.Time
	owners, err := s.db.QueryContext(ctx, `
SELECT DISTINCT ON (COALESCE(ct.user_id, ''))
       a.agent_id, COALESCE(NULLIF(ma.name, ''), NULLIF(a.display_name, ''), a.agent_id), a.status, a.last_seen_at,
       COALESCE(ct.user_id, ''), COALESCE(owner.name, '')
FROM office_agents a
LEFT JOIN mcp_agents ma ON ma.agent_id = a.mcp_agent_id
LEFT JOIN office_collector_tokens ct ON ct.collector_id = a.collector_id
LEFT JOIN accounts owner ON owner.user_id = ct.user_id
WHERE a.agent_id = $1 AND ($2 = '' OR ct.user_id = $2)
ORDER BY COALESCE(ct.user_id, ''), a.last_seen_at DESC, a.collector_id
LIMIT 2`, agentID, options.EmployeeID)
	if err != nil {
		return activity.AgentSummary{}, err
	}
	defer owners.Close()
	if !owners.Next() {
		if err := owners.Err(); err != nil {
			return activity.AgentSummary{}, err
		}
		return activity.AgentSummary{}, activity.ErrAgentNotFound
	}
	if err := owners.Scan(&result.AgentID, &result.Name, &result.Status, &lastSeen, &result.EmployeeID, &result.EmployeeName); err != nil {
		return activity.AgentSummary{}, err
	}
	if owners.Next() {
		return activity.AgentSummary{}, activity.ErrAmbiguousAgent
	}
	if err := owners.Err(); err != nil {
		return activity.AgentSummary{}, err
	}
	owners.Close()

	var lastActivity sql.NullTime
	err = s.db.QueryRowContext(ctx, `
WITH scoped AS (
  SELECT a.collector_id, a.agent_id, COALESCE(a.mcp_agent_id, a.agent_id) AS mcp_agent_id
  FROM office_agents a
  LEFT JOIN office_collector_tokens ct ON ct.collector_id = a.collector_id
  WHERE a.agent_id = $1 AND COALESCE(ct.user_id, '') = $2
)
SELECT
  (SELECT COUNT(DISTINCT (se.collector_id, se.session_id)) FROM office_agent_sessions se JOIN scoped s USING (collector_id, agent_id) WHERE se.started_at >= $3 AND se.started_at < $4),
  (SELECT COUNT(DISTINCT (t.collector_id, t.turn_id)) FROM office_agent_turns t JOIN scoped s USING (collector_id, agent_id) WHERE t.started_at >= $3 AND t.started_at < $4),
  (SELECT COUNT(DISTINCT (t.collector_id, t.turn_id)) FROM office_agent_turns t JOIN scoped s USING (collector_id, agent_id) WHERE t.completed_at >= $3 AND t.completed_at < $4),
  (SELECT COUNT(DISTINCT (tc.collector_id, tc.tool_call_id)) FROM office_agent_tool_calls tc JOIN scoped s USING (collector_id, agent_id) WHERE tc.started_at >= $3 AND tc.started_at < $4),
  (SELECT COUNT(*) FROM mcp_proxy_audit_records a WHERE a.agent_id IN (SELECT mcp_agent_id FROM scoped) AND a.user_id = $2 AND a.created_at >= $3 AND a.created_at < $4 AND a.capability_type = 'tool' AND a.decision IN ('allowed', 'confirmation_completed')),
  (SELECT MAX(occurred_at) FROM (
    SELECT COALESCE(t.completed_at, t.started_at) AS occurred_at FROM office_agent_turns t JOIN scoped s USING (collector_id, agent_id) WHERE t.started_at >= $3 AND t.started_at < $4
    UNION ALL
    SELECT a.started_at FROM office_agent_activities a JOIN scoped s USING (collector_id, agent_id) WHERE a.started_at >= $3 AND a.started_at < $4
  ) recent)
`, agentID, result.EmployeeID, start, end).Scan(
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
LEFT JOIN office_collector_tokens ct ON ct.collector_id = agent.collector_id
WHERE agent.agent_id = $1 AND COALESCE(ct.user_id, '') = $2 AND a.started_at >= $3 AND a.started_at < $4
ORDER BY a.started_at DESC, a.collector_id, a.activity_id
LIMIT 20`, agentID, result.EmployeeID, start, end)
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
	if err := rows.Err(); err != nil {
		return activity.AgentSummary{}, err
	}
	rows.Close()
	if options.IncludeContent {
		result.Content, err = s.agentConversationContent(ctx, agentID, result.EmployeeID, start, end, options)
		if err != nil {
			return activity.AgentSummary{}, err
		}
	}
	return result, nil
}

func (s *PostgresStore) agentConversationContent(ctx context.Context, agentID, employeeID string, start, end time.Time, options activity.AgentDetailOptions) (*activity.ConversationContent, error) {
	content := &activity.ConversationContent{
		Scope: "reported_turns_with_last_assistant_message",
		Note:  "仅包含查询周期内开始且已上报的主会话轮次，每轮助手内容为最后一条已采集消息，不代表完整聊天过程或实际业务成果。未上报的本地历史不在范围内；历史采集完整性无法保证。按轮次分页，会话可能跨页；每段最多返回 8000 字符，已识别的采集截断及本次查询截断均会标记。",
		Limit: options.Limit, Offset: options.Offset, Sessions: []activity.ConversationSession{},
	}
	const scope = `
FROM office_agent_turns t
JOIN office_agents a USING (collector_id, agent_id)
LEFT JOIN office_collector_tokens ct ON ct.collector_id = t.collector_id
LEFT JOIN office_agent_sessions se ON se.collector_id = t.collector_id AND se.agent_id = t.agent_id AND se.session_id = t.session_id
WHERE t.agent_id = $1 AND COALESCE(ct.user_id, '') = $2
  AND t.started_at >= $3 AND t.started_at < $4
  AND t.sub_agent_id = '' AND ($5 = '' OR t.session_id = $5)`
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) `+scope, agentID, employeeID, start, end, options.SessionID).Scan(&content.TotalTurns); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT t.collector_id, t.session_id, COALESCE(NULLIF(se.workspace_name, ''), a.workspace_name), t.turn_id, t.status, t.started_at, t.completed_at,
       LEFT(t.user_prompt, $8), LEFT(t.last_assistant_message, $8),
       RIGHT(t.user_prompt, 15) = E'\n...[TRUNCATED]', RIGHT(t.last_assistant_message, 15) = E'\n...[TRUNCATED]'
`+scope+`
ORDER BY t.started_at, t.collector_id, t.session_id, t.turn_id
LIMIT $6 OFFSET $7`, agentID, employeeID, start, end, options.SessionID, options.Limit, options.Offset, activity.MaxConversationTextChars+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type sessionKey struct{ collectorID, sessionID string }
	sessions := map[sessionKey]int{}
	for rows.Next() {
		var collectorID, sessionID, workspace string
		var turn activity.ConversationTurn
		if err := rows.Scan(&collectorID, &sessionID, &workspace, &turn.TurnID, &turn.Status, &turn.StartedAt, &turn.CompletedAt,
			&turn.UserPrompt, &turn.LastAssistantMessage, &turn.UserPromptTruncated, &turn.LastAssistantMessageTruncated); err != nil {
			return nil, err
		}
		turn.UserPrompt, turn.UserPromptTruncated = conversationText(turn.UserPrompt, turn.UserPromptTruncated)
		turn.LastAssistantMessage, turn.LastAssistantMessageTruncated = conversationText(turn.LastAssistantMessage, turn.LastAssistantMessageTruncated)
		turn.UserPromptMissing = strings.TrimSpace(turn.UserPrompt) == ""
		turn.LastAssistantMessageMissing = strings.TrimSpace(turn.LastAssistantMessage) == ""
		key := sessionKey{collectorID, sessionID}
		index, exists := sessions[key]
		if !exists {
			index = len(content.Sessions)
			sessions[key] = index
			content.Sessions = append(content.Sessions, activity.ConversationSession{CollectorID: collectorID, SessionID: sessionID, WorkspaceName: workspace, Turns: []activity.ConversationTurn{}})
		}
		content.Sessions[index].Turns = append(content.Sessions[index].Turns, turn)
		content.ReturnedTurns++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	content.HasMore = content.Offset < content.TotalTurns && content.ReturnedTurns < content.TotalTurns-content.Offset
	if content.HasMore {
		next := content.Offset + content.ReturnedTurns
		content.NextOffset = &next
	}
	return content, nil
}

func conversationText(value string, truncated bool) (string, bool) {
	runes := []rune(value)
	if len(runes) > activity.MaxConversationTextChars {
		return string(runes[:activity.MaxConversationTextChars]), true
	}
	return value, truncated
}
