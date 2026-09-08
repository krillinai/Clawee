package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/auth"
	"github.com/krillinai/Clawee/server/internal/office/claweeactivity"
	"github.com/krillinai/Clawee/server/internal/tokenutil"
)

func (s *PostgresStore) GetOrCreateClaweeDirectSource(ctx context.Context, userID, agentID string, now time.Time) (string, error) {
	if _, ok := s.db.(*sql.Tx); ok {
		return "", errors.New("GetOrCreateClaweeDirectSource must run on root database connection")
	}
	if s.root == nil {
		return "", errors.New("GetOrCreateClaweeDirectSource missing root database connection")
	}
	tx, err := s.root.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	var ownerID string
	err = tx.QueryRowContext(ctx, `
SELECT aa.user_id
FROM account_agents aa
JOIN accounts a ON a.user_id = aa.user_id
WHERE aa.agent_id = $1 AND a.status = 'active'
FOR UPDATE OF aa
`, agentID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && ownerID != userID) {
		return "", claweeactivity.ErrAgentForbidden
	}
	if err != nil {
		return "", err
	}

	var collectorID, sourceType string
	var sourceUserID sql.NullString
	err = tx.QueryRowContext(ctx, `
SELECT collector_id, user_id, source_type
FROM office_collector_tokens
WHERE agent_id = $1
FOR UPDATE
`, agentID).Scan(&collectorID, &sourceUserID, &sourceType)
	if err == nil {
		if sourceType != claweeactivity.DirectSourceType {
			return "", claweeactivity.ErrCollectorSource
		}
		if !sourceUserID.Valid || sourceUserID.String != userID {
			if _, err := tx.ExecContext(ctx, `UPDATE office_collector_tokens SET user_id = $2 WHERE collector_id = $1`, collectorID, userID); err != nil {
				return "", err
			}
		}
		if err := tx.Commit(); err != nil {
			return "", err
		}
		return collectorID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}

	collectorID, err = auth.GenerateToken("collector_", 16)
	if err != nil {
		return "", err
	}
	discardedToken, err := tokenutil.Generate32("col_")
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO office_collector_tokens
	(collector_id, token_hash, device_label, user_id, agent_id, source_type, revoked_at)
VALUES ($1, $2, 'Clawee Direct', $3, $4, $5, $6)
`, collectorID, auth.HashToken(discardedToken), userID, agentID, claweeactivity.DirectSourceType, now); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return collectorID, nil
}
