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
	location := start.Location()
	requiredDays := calendarDayCount(start, end)
	timezone := location.String()
	if timezone == "" {
		timezone = "UTC"
	}
	var activeUsers, totalUsers int64
	err = s.db.QueryRowContext(ctx, `
WITH daily_sessions AS (
  SELECT ct.user_id, (t.started_at AT TIME ZONE $3)::date AS activity_date
  FROM office_agent_turns t
  JOIN office_collector_tokens ct ON ct.collector_id = t.collector_id
  JOIN accounts a ON a.user_id = ct.user_id AND a.status = 'active'
  WHERE ct.user_id IS NOT NULL
    AND t.session_id <> ''
    AND t.status <> 'error'
    AND t.started_at >= $1
    AND t.started_at < $2
  GROUP BY ct.user_id, (t.started_at AT TIME ZONE $3)::date
), user_activity AS (
  SELECT user_id, COUNT(*) AS active_days
  FROM daily_sessions
  GROUP BY user_id
)
SELECT
  COUNT(*) FILTER (WHERE active_days = $4),
  (SELECT COUNT(*) FROM accounts WHERE status = 'active')
FROM user_activity
`, start, end, timezone, requiredDays).Scan(&activeUsers, &totalUsers)
	if err != nil {
		return activity.ActivitySnapshot{}, err
	}
	result.PlatformActivity = activity.PlatformActivity{
		ActiveUsers: activeUsers,
		TotalUsers:  totalUsers,
		Rate:        platformActivityRate(activeUsers, totalUsers),
	}
	agentRows, err := s.db.QueryContext(ctx, `
SELECT a.collector_id, a.agent_id, COALESCE(NULLIF(ma.name, ''), NULLIF(a.display_name, ''), a.agent_id), a.status,
	   COALESCE(ct.user_id, ''), COALESCE(owner.name, ''),
       COUNT(DISTINCT se.session_id), COUNT(DISTINCT t.turn_id), MAX(COALESCE(t.completed_at, t.started_at))
FROM office_agents a
LEFT JOIN mcp_agents ma ON ma.agent_id = a.mcp_agent_id
LEFT JOIN office_collector_tokens ct ON ct.collector_id = a.collector_id
LEFT JOIN accounts owner ON owner.user_id = ct.user_id
	LEFT JOIN office_agent_sessions se ON se.collector_id = a.collector_id AND se.agent_id = a.agent_id AND se.started_at >= $1 AND se.started_at < $2
	LEFT JOIN office_agent_turns t ON t.collector_id = a.collector_id AND t.agent_id = a.agent_id AND t.started_at >= $1 AND t.started_at < $2
	GROUP BY a.collector_id, a.agent_id, ma.name, a.display_name, a.status, ct.user_id, owner.name
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
		if err := agentRows.Scan(&item.CollectorID, &item.AgentID, &item.Name, &item.Status, &item.EmployeeID, &item.EmployeeName, &item.SessionCount, &item.TurnCount, &lastActivity); err != nil {
			return activity.ActivitySnapshot{}, err
		}
		if lastActivity.Valid {
			value := lastActivity.Time
			item.LastActivityAt = &value
		}
		result.Agents = append(result.Agents, item)
	}
	if err := agentRows.Err(); err != nil {
		return activity.ActivitySnapshot{}, err
	}
	err = s.db.QueryRowContext(ctx, `
SELECT COUNT(DISTINCT source_event_key) FILTER (WHERE event_type = 'skill.created'),
       COUNT(DISTINCT source_event_key) FILTER (WHERE event_type = 'skill.version_uploaded')
FROM employee_ai_activity_facts
WHERE occurred_at >= $1 AND occurred_at < $2 AND actor_kind = 'user'
  AND origin IN ('app_upload', 'admin_upload')`, start, end).Scan(
		&result.SkillContributions.CreatedCount, &result.SkillContributions.UpdatedCount)
	if err != nil {
		return activity.ActivitySnapshot{}, err
	}
	result.SkillUsage, result.SkillUsageTotals, err = s.skillUsage(ctx, start, end, "", "")
	if err != nil {
		return result, err
	}
	result.EmployeeSkillUsage, err = s.employeeSkillUsage(ctx, start, end)
	return result, err
}

func calendarDayCount(start, end time.Time) int64 {
	if !end.After(start) {
		return 1
	}
	count := int64(0)
	location := start.Location()
	for current := start.In(location); current.Before(end.In(location)); current = current.AddDate(0, 0, 1) {
		count++
	}
	return count
}

func platformActivityRate(activeUsers, totalUsers int64) float64 {
	if totalUsers <= 0 {
		return 0
	}
	return float64(activeUsers) / float64(totalUsers)
}

func (s *PostgresStore) employeeSkillUsage(ctx context.Context, start, end time.Time) ([]activity.EmployeeSkillUsage, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT ct.user_id, COALESCE(NULLIF(owner.name, ''), ct.user_id),
  COUNT(DISTINCT (e.source, e.skill_key)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run')),
  COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence = 'explicit_request'),
  COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run')),
  COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run') AND e.invocation = 'explicit'),
  COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run') AND e.invocation = 'implicit'),
  MAX(e.occurred_at) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run'))
FROM office_agent_skill_evidence e
JOIN office_collector_tokens ct ON ct.collector_id = e.collector_id
LEFT JOIN accounts owner ON owner.user_id = ct.user_id
WHERE ct.user_id IS NOT NULL AND e.occurred_at >= $1 AND e.occurred_at < $2
GROUP BY ct.user_id, owner.name
ORDER BY COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run')) DESC,
  COALESCE(NULLIF(owner.name, ''), ct.user_id), ct.user_id`, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []activity.EmployeeSkillUsage{}
	for rows.Next() {
		var item activity.EmployeeSkillUsage
		var lastObserved sql.NullTime
		if err := rows.Scan(&item.EmployeeID, &item.EmployeeName, &item.ObservedSkillCount,
			&item.RequestedSkillRuns, &item.ObservedSkillRuns, &item.ExplicitSkillRuns,
			&item.ImplicitSkillRuns, &lastObserved); err != nil {
			return nil, err
		}
		if lastObserved.Valid {
			value := lastObserved.Time
			item.LastObservedAt = &value
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *PostgresStore) skillUsage(ctx context.Context, start, end time.Time, collectorID, agentID string) ([]activity.SkillUsage, activity.SkillUsageTotals, error) {
	var result activity.ActivitySnapshot
	err := s.db.QueryRowContext(ctx, `
SELECT COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence = 'explicit_request'),
       COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run')),
       COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run') AND e.invocation = 'explicit'),
       COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id, e.skill_key)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run') AND e.invocation = 'implicit')
FROM office_agent_skill_evidence e
JOIN office_collector_tokens ct ON ct.collector_id = e.collector_id
WHERE ct.user_id IS NOT NULL AND e.occurred_at >= $1 AND e.occurred_at < $2
  AND ($3 = '' OR e.collector_id = $3) AND ($4 = '' OR e.agent_id = $4)`, start, end, collectorID, agentID).Scan(
		&result.SkillUsageTotals.RequestedSkillRuns, &result.SkillUsageTotals.ObservedSkillRuns,
		&result.SkillUsageTotals.ExplicitSkillRuns, &result.SkillUsageTotals.ImplicitSkillRuns)
	if err != nil {
		return nil, activity.SkillUsageTotals{}, err
	}
	skillRows, err := s.db.QueryContext(ctx, `
SELECT MAX(e.skill_id), MAX(e.skill_name), e.skill_key, e.source,
  COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id)) FILTER (WHERE e.evidence = 'explicit_request'),
  COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run')),
  COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run') AND e.invocation = 'implicit')
FROM office_agent_skill_evidence e
JOIN office_collector_tokens ct ON ct.collector_id = e.collector_id
WHERE ct.user_id IS NOT NULL AND e.occurred_at >= $1 AND e.occurred_at < $2
  AND ($3 = '' OR e.collector_id = $3) AND ($4 = '' OR e.agent_id = $4)
GROUP BY e.skill_key, e.source
ORDER BY COUNT(DISTINCT (e.collector_id, e.agent_id, e.run_id)) FILTER (WHERE e.evidence IN ('skill_file_read', 'skill_resource_run')) DESC,
  MAX(e.skill_name), e.skill_key
LIMIT 100
`, start, end, collectorID, agentID)
	if err != nil {
		return nil, activity.SkillUsageTotals{}, err
	}
	defer skillRows.Close()
	result.SkillUsage = []activity.SkillUsage{}
	for skillRows.Next() {
		var item activity.SkillUsage
		if err := skillRows.Scan(&item.SkillID, &item.SkillName, &item.SkillKey, &item.Source,
			&item.RequestedRuns, &item.ObservedRuns, &item.ImplicitRuns); err != nil {
			return nil, activity.SkillUsageTotals{}, err
		}
		result.SkillUsage = append(result.SkillUsage, item)
	}
	return result.SkillUsage, result.SkillUsageTotals, skillRows.Err()
}
