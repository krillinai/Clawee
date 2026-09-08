package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/management"
)

func (s *PostgresStore) BindMCPAgent(ctx context.Context, collectorID, officeAgentID, mcpAgentID string, updatedAt time.Time) error {
	if s == nil || s.root == nil {
		return management.ErrOfficeAgentNotFound
	}
	tx, err := s.root.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var officeOwnerID, currentMCPAgentID sql.NullString
	err = tx.QueryRowContext(ctx, `
SELECT t.user_id, a.mcp_agent_id
FROM office_agents a
JOIN office_collector_tokens t ON t.collector_id = a.collector_id
WHERE a.collector_id = $1 AND a.agent_id = $2
FOR UPDATE OF a
`, collectorID, officeAgentID).Scan(&officeOwnerID, &currentMCPAgentID)
	if errors.Is(err, sql.ErrNoRows) {
		return management.ErrOfficeAgentNotFound
	}
	if err != nil {
		return err
	}
	if currentMCPAgentID.Valid && currentMCPAgentID.String != mcpAgentID {
		return management.ErrOfficeAgentAlreadyBound
	}

	var mcpOwnerID sql.NullString
	err = tx.QueryRowContext(ctx, `
SELECT aa.user_id
FROM mcp_agents a
LEFT JOIN account_agents aa ON aa.agent_id = a.agent_id
WHERE a.agent_id = $1
FOR UPDATE OF a
`, mcpAgentID).Scan(&mcpOwnerID)
	if errors.Is(err, sql.ErrNoRows) {
		return management.ErrMCPAgentNotFound
	}
	if err != nil {
		return err
	}
	if !officeOwnerID.Valid || !mcpOwnerID.Valid || officeOwnerID.String != mcpOwnerID.String {
		return management.ErrAgentOwnerMismatch
	}

	var alreadyBound bool
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS (
	SELECT 1 FROM office_agents
	WHERE mcp_agent_id = $1 AND (collector_id <> $2 OR agent_id <> $3)
)
`, mcpAgentID, collectorID, officeAgentID).Scan(&alreadyBound); err != nil {
		return err
	}
	if alreadyBound {
		return management.ErrMCPAgentAlreadyBound
	}

	if _, err := tx.ExecContext(ctx, `
UPDATE office_agents
SET mcp_agent_id = $3, updated_at = $4
WHERE collector_id = $1 AND agent_id = $2
`, collectorID, officeAgentID, mcpAgentID, updatedAt); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresStore) UnbindMCPAgent(ctx context.Context, collectorID, officeAgentID string, updatedAt time.Time) error {
	result, err := s.db.ExecContext(ctx, `
UPDATE office_agents
SET mcp_agent_id = NULL, updated_at = $3
WHERE collector_id = $1 AND agent_id = $2
`, collectorID, officeAgentID, updatedAt)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return management.ErrOfficeAgentNotFound
	}
	return nil
}

func (s *PostgresStore) DeleteOfficeAgent(ctx context.Context, collectorID, officeAgentID string) error {
	if s == nil || s.root == nil {
		return management.ErrOfficeAgentNotFound
	}
	tx, err := s.root.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var mcpAgentID sql.NullString
	err = tx.QueryRowContext(ctx, `
SELECT mcp_agent_id
FROM office_agents
WHERE collector_id = $1 AND agent_id = $2
FOR UPDATE
`, collectorID, officeAgentID).Scan(&mcpAgentID)
	if errors.Is(err, sql.ErrNoRows) {
		return management.ErrOfficeAgentNotFound
	}
	if err != nil {
		return err
	}
	if mcpAgentID.Valid {
		return management.ErrOfficeAgentBound
	}

	for _, stmt := range []string{
		`DELETE FROM office_agent_tool_calls WHERE collector_id = $1 AND agent_id = $2`,
		`DELETE FROM office_agent_activities WHERE collector_id = $1 AND agent_id = $2`,
		`DELETE FROM office_agent_sub_agents WHERE collector_id = $1 AND parent_agent_id = $2`,
		`DELETE FROM office_agent_turns WHERE collector_id = $1 AND agent_id = $2`,
		`DELETE FROM office_agent_sessions WHERE collector_id = $1 AND agent_id = $2`,
		`DELETE FROM office_agent_source_events WHERE collector_id = $1 AND agent_id = $2`,
		`DELETE FROM office_agents WHERE collector_id = $1 AND agent_id = $2`,
	} {
		if _, err := tx.ExecContext(ctx, stmt, collectorID, officeAgentID); err != nil {
			return err
		}
	}

	return tx.Commit()
}
