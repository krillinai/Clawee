package accountgovernance

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	pool  *pgxpool.Pool
	clock func() time.Time
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool, clock: func() time.Time { return time.Now().UTC() }}
}

func (s *PostgresStore) TransferAgent(ctx context.Context, input TransferAgentInput) (result Result, err error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	statuses, err := lockAccounts(ctx, tx, input.SourceUserID, input.TargetUserID)
	if err != nil {
		return Result{}, err
	}
	if statuses[input.TargetUserID] != "active" {
		return Result{}, ErrTargetAccountNotActive
	}

	var ownerUserID, actorID string
	err = tx.QueryRow(ctx, `
		SELECT aa.user_id, ma.actor_id
		FROM account_agents aa
		JOIN mcp_agents ma ON ma.agent_id = aa.agent_id
		WHERE aa.agent_id = $1
		FOR UPDATE OF aa, ma`, input.AgentID).Scan(&ownerUserID, &actorID)
	if err == pgx.ErrNoRows {
		return Result{}, ErrAgentNotFound
	}
	if err != nil {
		return Result{}, err
	}
	if ownerUserID != input.SourceUserID {
		return Result{}, ErrAgentOwnerConflict
	}
	if actorID != input.SourceUserID {
		return Result{}, ErrAgentOwnerInconsistent
	}
	if err := rejectPendingGates(ctx, tx, []string{input.AgentID}); err != nil {
		return Result{}, err
	}

	now := s.clock()
	if _, err := tx.Exec(ctx, `DELETE FROM account_sessions WHERE user_id = $1 AND agent_id = $2`, input.SourceUserID, input.AgentID); err != nil {
		return Result{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE account_agents SET user_id = $1, created_at = $2 WHERE user_id = $3 AND agent_id = $4`, input.TargetUserID, now, input.SourceUserID, input.AgentID); err != nil {
		return Result{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE office_collector_tokens SET user_id = $1 WHERE agent_id = $2`, input.TargetUserID, input.AgentID); err != nil {
		return Result{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE mcp_agents SET actor_id = $1, updated_at = $2 WHERE agent_id = $3`, input.TargetUserID, now, input.AgentID); err != nil {
		return Result{}, err
	}

	result = Result{Action: ActionAgentTransfer, AgentIDs: []string{input.AgentID}, SourceUserID: input.SourceUserID, TargetUserID: input.TargetUserID, TokensPreserved: true, GrantsPreserved: true, TokenCount: 0, GrantCount: 0, CompletedAt: now}
	before := map[string]any{"agent_id": input.AgentID, "owner_user_id": input.SourceUserID, "actor_id": actorID, "token_count": 0, "grant_count": 0}
	after := map[string]any{"agent_id": input.AgentID, "owner_user_id": input.TargetUserID, "actor_id": input.TargetUserID, "token_count": 0, "grant_count": 0}
	if err := insertAudit(ctx, tx, input.RequestID, input.OperatorUserID, ActionAgentTransfer, input.AgentID, input.SourceUserID, input.TargetUserID, input.Reason, result.TokensPreserved, result.GrantsPreserved, before, after, now); err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}

func (s *PostgresStore) MergeAccounts(ctx context.Context, input MergeAccountsInput) (result Result, err error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	statuses, err := lockAccounts(ctx, tx, input.SourceUserID, input.TargetUserID)
	if err != nil {
		return Result{}, err
	}
	if statuses[input.SourceUserID] != "disabled" {
		return Result{}, ErrSourceAccountNotDisabled
	}
	if statuses[input.TargetUserID] != "active" {
		return Result{}, ErrTargetAccountNotActive
	}

	var identityConflict bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM account_identities source
			JOIN account_identities target
			  ON target.provider_type = source.provider_type
			 AND target.provider_key = source.provider_key
			WHERE source.user_id = $1 AND target.user_id = $2
		)`, input.SourceUserID, input.TargetUserID).Scan(&identityConflict); err != nil {
		return Result{}, err
	}
	if identityConflict {
		return Result{}, ErrIdentityConflict
	}

	agentIDs, err := lockedAccountAgentIDs(ctx, tx, input.SourceUserID)
	if err != nil {
		return Result{}, err
	}
	if err := rejectPendingGates(ctx, tx, agentIDs); err != nil {
		return Result{}, err
	}
	tokenCount, grantCount, err := accountAccessCounts(ctx, tx, input.SourceUserID)
	if err != nil {
		return Result{}, err
	}
	var grantConflict bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM mcp_account_grants source
			JOIN mcp_account_grants target
			  ON target.user_id = $2
			 AND target.capability_id = source.capability_id
			 AND target.grant_type = source.grant_type
			WHERE source.user_id = $1
			  AND (source.data_scope IS DISTINCT FROM target.data_scope OR source.expires_at IS DISTINCT FROM target.expires_at)
		)`, input.SourceUserID, input.TargetUserID).Scan(&grantConflict); err != nil {
		return Result{}, err
	}
	if grantConflict {
		return Result{}, ErrAccountGrantConflict
	}
	now := s.clock()
	before := map[string]any{"source_status": statuses[input.SourceUserID], "target_status": statuses[input.TargetUserID], "agent_ids": agentIDs, "token_count": tokenCount, "grant_count": grantCount}

	statements := []struct {
		query string
		args  []any
	}{
		{`DELETE FROM account_sessions WHERE user_id = $1`, []any{input.SourceUserID}},
		{`DELETE FROM oauth_login_states WHERE bind_user_id = $1`, []any{input.SourceUserID}},
		{`DELETE FROM oauth_authorization_codes WHERE user_id = $1`, []any{input.SourceUserID}},
		{`DELETE FROM mcp_account_grants source USING mcp_account_grants target WHERE source.user_id = $1 AND target.user_id = $2 AND source.capability_id = target.capability_id AND source.grant_type = target.grant_type`, []any{input.SourceUserID, input.TargetUserID}},
		{`UPDATE mcp_account_grants SET user_id = $1, updated_at = $2 WHERE user_id = $3`, []any{input.TargetUserID, now, input.SourceUserID}},
		{`UPDATE mcp_agents SET actor_id = $1, updated_at = $2 WHERE agent_id = ANY($3)`, []any{input.TargetUserID, now, agentIDs}},
		{`UPDATE account_agents SET user_id = $1, created_at = $2 WHERE user_id = $3`, []any{input.TargetUserID, now, input.SourceUserID}},
		{`INSERT INTO account_roles (user_id, role_id, created_at) SELECT $1, role_id, $2 FROM account_roles WHERE user_id = $3 ON CONFLICT (user_id, role_id) DO NOTHING`, []any{input.TargetUserID, now, input.SourceUserID}},
		{`DELETE FROM data_resource_grants source USING data_resource_grants target WHERE source.user_id = $1 AND target.user_id = $2 AND source.resource_type = target.resource_type AND source.resource_id = target.resource_id AND source.action = target.action`, []any{input.SourceUserID, input.TargetUserID}},
		{`UPDATE data_resource_grants SET user_id = $1, updated_at = $2 WHERE user_id = $3`, []any{input.TargetUserID, now, input.SourceUserID}},
		{`UPDATE account_identities SET user_id = $1, updated_at = $2 WHERE user_id = $3`, []any{input.TargetUserID, now, input.SourceUserID}},
		{`UPDATE office_collector_tokens SET user_id = $1 WHERE user_id = $2`, []any{input.TargetUserID, input.SourceUserID}},
		{`UPDATE office_collector_registration_codes SET user_id = $1 WHERE user_id = $2`, []any{input.TargetUserID, input.SourceUserID}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			return Result{}, err
		}
	}

	result = Result{Action: ActionAccountMerge, AgentIDs: agentIDs, SourceUserID: input.SourceUserID, TargetUserID: input.TargetUserID, TokensPreserved: false, GrantsPreserved: true, TokenCount: tokenCount, GrantCount: grantCount, CompletedAt: now}
	after := map[string]any{"source_deleted": true, "target_status": statuses[input.TargetUserID], "agent_ids": agentIDs, "token_count": tokenCount, "grant_count": grantCount}
	if err := insertAudit(ctx, tx, input.RequestID, input.OperatorUserID, ActionAccountMerge, "", input.SourceUserID, input.TargetUserID, input.Reason, result.TokensPreserved, result.GrantsPreserved, before, after, now); err != nil {
		return Result{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM accounts WHERE user_id = $1`, input.SourceUserID); err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}

func lockAccounts(ctx context.Context, tx pgx.Tx, sourceUserID, targetUserID string) (map[string]string, error) {
	rows, err := tx.Query(ctx, `SELECT user_id, status FROM accounts WHERE user_id = ANY($1) ORDER BY user_id FOR UPDATE`, []string{sourceUserID, targetUserID})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	statuses := make(map[string]string, 2)
	for rows.Next() {
		var userID, status string
		if err := rows.Scan(&userID, &status); err != nil {
			return nil, err
		}
		statuses[userID] = status
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(statuses) != 2 {
		return nil, ErrAccountNotFound
	}
	return statuses, nil
}

func lockedAccountAgentIDs(ctx context.Context, tx pgx.Tx, userID string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT aa.agent_id
		FROM account_agents aa
		JOIN mcp_agents ma ON ma.agent_id = aa.agent_id
		WHERE aa.user_id = $1
		ORDER BY aa.agent_id
		FOR UPDATE OF aa, ma`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func rejectPendingGates(ctx context.Context, tx pgx.Tx, agentIDs []string) error {
	if len(agentIDs) == 0 {
		return nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mcp_gate_requests WHERE agent_id = ANY($1) AND status IN ('pending', 'executing'))`, agentIDs).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrPendingGate
	}
	return nil
}

func accountAccessCounts(ctx context.Context, tx pgx.Tx, userID string) (int, int, error) {
	var tokens, grants int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mcp_account_tokens WHERE user_id = $1`, userID).Scan(&tokens); err != nil {
		return 0, 0, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mcp_account_grants WHERE user_id = $1`, userID).Scan(&grants); err != nil {
		return 0, 0, err
	}
	return tokens, grants, nil
}

func insertAudit(ctx context.Context, tx pgx.Tx, requestID, operatorUserID, action, agentID, sourceUserID, targetUserID, reason string, tokensPreserved, grantsPreserved bool, before, after map[string]any, createdAt time.Time) error {
	beforeJSON, err := json.Marshal(before)
	if err != nil {
		return err
	}
	afterJSON, err := json.Marshal(after)
	if err != nil {
		return err
	}
	auditID, err := randomID("agov_")
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO account_governance_audits (
			audit_id, request_id, operator_user_id, action, agent_id, source_user_id, target_user_id,
			reason, tokens_preserved, grants_preserved, before_snapshot, after_snapshot, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		auditID, requestID, operatorUserID, action, agentID, sourceUserID, targetUserID, reason, tokensPreserved, grantsPreserved, beforeJSON, afterJSON, createdAt)
	return err
}

func randomID(prefix string) (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate audit id: %w", err)
	}
	return prefix + hex.EncodeToString(raw), nil
}
