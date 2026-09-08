package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/auth"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/registration"
)

func (s *PostgresStore) CreateManagementRegistrationCode(ctx context.Context, userID, createdBy string, createdAt time.Time) (management.CreateRegistrationCodeResponse, error) {
	code, err := auth.GenerateToken("reg_", 16)
	if err != nil {
		return management.CreateRegistrationCodeResponse{}, err
	}
	if s.root == nil {
		return management.CreateRegistrationCodeResponse{}, errors.New("CreateManagementRegistrationCode missing root database connection")
	}
	tx, err := s.root.BeginTx(ctx, nil)
	if err != nil {
		return management.CreateRegistrationCodeResponse{}, err
	}
	defer tx.Rollback()
	if err := lockActiveRegistrationAccount(ctx, tx, userID); err != nil {
		return management.CreateRegistrationCodeResponse{}, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE office_collector_registration_codes
SET revoked_at = $2
WHERE user_id = $1 AND revoked_at IS NULL
`, userID, createdAt); err != nil {
		return management.CreateRegistrationCodeResponse{}, err
	}
	txStore := &PostgresStore{root: s.root, db: tx}
	if err := txStore.CreateOwnedRegistrationCode(ctx, code, userID, createdBy, createdAt, nil); err != nil {
		return management.CreateRegistrationCodeResponse{}, err
	}
	if err := tx.Commit(); err != nil {
		return management.CreateRegistrationCodeResponse{}, err
	}
	return management.CreateRegistrationCodeResponse{
		RegistrationCode: code,
		CreatedAt:        createdAt,
	}, nil
}

func (s *PostgresStore) EnsureManagementRegistrationCode(ctx context.Context, userID, createdBy string, createdAt time.Time) (management.RegistrationCodeSummary, error) {
	if s.root == nil {
		return management.RegistrationCodeSummary{}, errors.New("EnsureManagementRegistrationCode missing root database connection")
	}
	tx, err := s.root.BeginTx(ctx, nil)
	if err != nil {
		return management.RegistrationCodeSummary{}, err
	}
	defer tx.Rollback()
	if err := lockActiveRegistrationAccount(ctx, tx, userID); err != nil {
		return management.RegistrationCodeSummary{}, err
	}

	txStore := &PostgresStore{root: s.root, db: tx}
	summary, err := txStore.currentRegistrationCode(ctx, userID, createdAt)
	if err != nil {
		return management.RegistrationCodeSummary{}, err
	}
	if summary.Exists {
		if err := tx.Commit(); err != nil {
			return management.RegistrationCodeSummary{}, err
		}
		return summary, nil
	}

	code, err := auth.GenerateToken("reg_", 16)
	if err != nil {
		return management.RegistrationCodeSummary{}, err
	}
	if err := txStore.CreateOwnedRegistrationCode(ctx, code, userID, createdBy, createdAt, nil); err != nil {
		return management.RegistrationCodeSummary{}, err
	}
	if err := tx.Commit(); err != nil {
		return management.RegistrationCodeSummary{}, err
	}
	return management.RegistrationCodeSummary{
		Exists:    true,
		Code:      code,
		CreatedBy: createdBy,
		CreatedAt: &createdAt,
	}, nil
}

func lockActiveRegistrationAccount(ctx context.Context, tx *sql.Tx, userID string) error {
	var status string
	err := tx.QueryRowContext(ctx, `
SELECT status
FROM accounts
WHERE user_id = $1
FOR UPDATE
`, userID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && status != "active") {
		return registration.ErrRegistrationOwnerInvalid
	}
	return err
}

func (s *PostgresStore) CollectorsOverview(ctx context.Context, now time.Time, onlineThreshold time.Duration) (management.CollectorsOverview, error) {
	registrationCode, err := s.currentRegistrationCode(ctx, "", now)
	if err != nil {
		return management.CollectorsOverview{}, err
	}
	collectors, err := s.collectorItems(ctx, "", now, onlineThreshold)
	if err != nil {
		return management.CollectorsOverview{}, err
	}
	return management.CollectorsOverview{
		SchemaVersion:          management.SchemaVersion,
		ServerTime:             now,
		OnlineThresholdSeconds: int(onlineThreshold.Seconds()),
		RegistrationCode:       registrationCode,
		Summary:                collectorSummary(collectors),
		Collectors:             collectors,
	}, nil
}

func (s *PostgresStore) UserCollectorsOverview(ctx context.Context, userID string, now time.Time, onlineThreshold time.Duration) (management.CollectorsOverview, error) {
	registrationCode, err := s.currentRegistrationCode(ctx, userID, now)
	if err != nil {
		return management.CollectorsOverview{}, err
	}
	collectors, err := s.collectorItems(ctx, userID, now, onlineThreshold)
	if err != nil {
		return management.CollectorsOverview{}, err
	}
	return management.CollectorsOverview{
		SchemaVersion:          management.SchemaVersion,
		ServerTime:             now,
		OnlineThresholdSeconds: int(onlineThreshold.Seconds()),
		RegistrationCode:       registrationCode,
		Summary:                collectorSummary(collectors),
		Collectors:             collectors,
	}, nil
}

func (s *PostgresStore) DeleteCollector(ctx context.Context, collectorID string, now time.Time, onlineThreshold time.Duration) error {
	return s.deleteCollector(ctx, "", collectorID, now, onlineThreshold)
}

func (s *PostgresStore) DeleteUserCollector(ctx context.Context, userID, collectorID string, now time.Time, onlineThreshold time.Duration) error {
	return s.deleteCollector(ctx, userID, collectorID, now, onlineThreshold)
}

func (s *PostgresStore) deleteCollector(ctx context.Context, userID, collectorID string, now time.Time, onlineThreshold time.Duration) error {
	if _, ok := s.db.(*sql.Tx); ok {
		return errors.New("DeleteCollector must run on root database connection")
	}
	if s.root == nil {
		return errors.New("DeleteCollector missing root database connection")
	}

	tx, err := s.root.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var lastSeenAt sql.NullTime
	var revokedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `
SELECT d.last_seen_at, t.revoked_at
FROM office_collector_tokens t
LEFT JOIN LATERAL (
	SELECT last_seen_at
	FROM office_collector_devices d
	WHERE d.collector_id = t.collector_id
	ORDER BY d.last_seen_at DESC
	LIMIT 1
) d ON true
WHERE t.collector_id = $1 AND t.source_type = 'collector' AND ($2 = '' OR t.user_id = $2)
FOR UPDATE OF t
`, collectorID, userID).Scan(&lastSeenAt, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return management.ErrCollectorNotFound
	}
	if err != nil {
		return err
	}

	var lastSeenAtPtr *time.Time
	if lastSeenAt.Valid {
		lastSeenAtPtr = &lastSeenAt.Time
	}
	if collectorStatus(now, onlineThreshold, lastSeenAtPtr, revokedAt.Valid) == management.CollectorStatusOnline {
		return management.ErrCollectorOnline
	}
	if !revokedAt.Valid {
		return management.ErrCollectorNotDisabled
	}

	for _, stmt := range []string{
		`DELETE FROM office_agent_tool_calls WHERE collector_id = $1`,
		`DELETE FROM office_agent_activities WHERE collector_id = $1`,
		`DELETE FROM office_agent_sub_agents WHERE collector_id = $1`,
		`DELETE FROM office_agent_turns WHERE collector_id = $1`,
		`DELETE FROM office_agent_sessions WHERE collector_id = $1`,
		`DELETE FROM office_agents WHERE collector_id = $1`,
		`DELETE FROM office_agent_source_events WHERE collector_id = $1`,
		`DELETE FROM office_collector_devices WHERE collector_id = $1`,
		`DELETE FROM office_collector_registrations WHERE collector_id = $1`,
		`DELETE FROM office_collector_tokens WHERE collector_id = $1`,
	} {
		if _, err := tx.ExecContext(ctx, stmt, collectorID); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *PostgresStore) RevokeCollectorToken(ctx context.Context, collectorID string, revokedAt time.Time) error {
	result, err := s.db.ExecContext(ctx, `
UPDATE office_collector_tokens
SET revoked_at = $2
WHERE collector_id = $1 AND source_type = 'collector' AND revoked_at IS NULL
`, collectorID, revokedAt)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 1 {
		return nil
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM office_collector_tokens WHERE collector_id = $1 AND source_type = 'collector')`, collectorID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return management.ErrCollectorNotFound
	}
	return management.ErrCollectorTokenRevoked
}

func (s *PostgresStore) RevokeUserCollectorToken(ctx context.Context, userID, collectorID string, revokedAt time.Time) error {
	result, err := s.db.ExecContext(ctx, `
UPDATE office_collector_tokens
SET revoked_at = $3
WHERE collector_id = $1 AND user_id = $2 AND source_type = 'collector' AND revoked_at IS NULL
`, collectorID, userID, revokedAt)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 1 {
		return nil
	}
	var revoked bool
	err = s.db.QueryRowContext(ctx, `SELECT revoked_at IS NOT NULL FROM office_collector_tokens WHERE collector_id = $1 AND user_id = $2 AND source_type = 'collector'`, collectorID, userID).Scan(&revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return management.ErrCollectorNotFound
	}
	if err != nil {
		return err
	}
	if revoked {
		return management.ErrCollectorTokenRevoked
	}
	return management.ErrCollectorNotFound
}

func (s *PostgresStore) currentRegistrationCode(ctx context.Context, userID string, now time.Time) (management.RegistrationCodeSummary, error) {
	var code string
	var createdBy string
	var createdAt time.Time
	var expiresAt sql.NullTime
	var usedCount int
	var lastUsedAt sql.NullTime
	var revokedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
SELECT registration_code, created_by, created_at, expires_at, used_count, last_used_at, revoked_at
FROM office_collector_registration_codes
WHERE (expires_at IS NULL OR expires_at > $1)
  AND revoked_at IS NULL
  AND ($2 = '' OR user_id = $2)
ORDER BY created_at DESC
LIMIT 1
`, now, userID).Scan(&code, &createdBy, &createdAt, &expiresAt, &usedCount, &lastUsedAt, &revokedAt)
	if err == sql.ErrNoRows {
		return management.RegistrationCodeSummary{Exists: false}, nil
	}
	if err != nil {
		return management.RegistrationCodeSummary{}, err
	}

	summary := management.RegistrationCodeSummary{
		Exists:    true,
		Code:      code,
		CreatedBy: createdBy,
		CreatedAt: &createdAt,
		UsedCount: usedCount,
		Revoked:   revokedAt.Valid,
	}
	if expiresAt.Valid {
		summary.ExpiresAt = &expiresAt.Time
	}
	if lastUsedAt.Valid {
		summary.LastUsedAt = &lastUsedAt.Time
	}
	return summary, nil
}

func (s *PostgresStore) collectorItems(ctx context.Context, userID string, now time.Time, onlineThreshold time.Duration) ([]management.CollectorItem, error) {
	where := "WHERE t.source_type = 'collector'"
	args := []any{}
	if userID != "" {
		where += " AND t.user_id = $1"
		args = append(args, userID)
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT
	t.collector_id,
	COALESCE(r.device_id, '') AS device_id,
	COALESCE(r.device_name, '') AS device_name,
	COALESCE(r.hostname, '') AS hostname,
	COALESCE(r.os, '') AS os,
	COALESCE(r.arch, '') AS arch,
	COALESCE(d.collector_version, r.collector_version, '') AS collector_version,
	COALESCE((
		SELECT COUNT(*)
		FROM office_agents oa
		WHERE oa.collector_id = t.collector_id
	), 0) AS registered_agent_count,
	r.registered_at,
	t.created_at,
	t.last_used_at,
	d.last_seen_at,
	t.revoked_at
	,COALESCE(t.user_id, '')
	,COALESCE(a.name, '')
	,COALESCE(a.email, '')
FROM office_collector_tokens t
LEFT JOIN accounts a ON a.user_id = t.user_id
LEFT JOIN LATERAL (
	SELECT *
	FROM office_collector_registrations r
	WHERE r.collector_id = t.collector_id
	ORDER BY r.registered_at DESC
	LIMIT 1
) r ON true
LEFT JOIN LATERAL (
	SELECT *
	FROM office_collector_devices d
	WHERE d.collector_id = t.collector_id
	ORDER BY d.last_seen_at DESC
	LIMIT 1
) d ON true
`+where+`
ORDER BY r.registered_at DESC NULLS LAST, t.created_at DESC
`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var collectors []management.CollectorItem
	for rows.Next() {
		var item management.CollectorItem
		var registeredAt sql.NullTime
		var tokenLastUsedAt sql.NullTime
		var lastSeenAt sql.NullTime
		var revokedAt sql.NullTime
		if err := rows.Scan(
			&item.CollectorID,
			&item.DeviceID,
			&item.DeviceName,
			&item.Hostname,
			&item.OS,
			&item.Arch,
			&item.CollectorVersion,
			&item.RegisteredAgentCount,
			&registeredAt,
			&item.TokenCreatedAt,
			&tokenLastUsedAt,
			&lastSeenAt,
			&revokedAt,
			&item.UserID,
			&item.UserName,
			&item.UserEmail,
		); err != nil {
			return nil, err
		}

		if registeredAt.Valid {
			item.RegisteredAt = &registeredAt.Time
		}
		if tokenLastUsedAt.Valid {
			item.TokenLastUsedAt = &tokenLastUsedAt.Time
		}
		if lastSeenAt.Valid {
			item.LastSeenAt = &lastSeenAt.Time
		}
		item.Status = collectorStatus(now, onlineThreshold, item.LastSeenAt, revokedAt.Valid)
		if revokedAt.Valid {
			item.TokenStatus = "revoked"
		} else {
			item.TokenStatus = "active"
		}
		collectors = append(collectors, item)
	}
	return collectors, rows.Err()
}

func (s *PostgresStore) FindAgentCollector(ctx context.Context, mcpAgentID string, now time.Time, onlineThreshold time.Duration) (management.AgentCollectorInfo, bool, error) {
	var item management.AgentCollectorInfo
	var lastSeenAt, revokedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
SELECT
	a.collector_id,
	a.agent_id,
	a.device_id,
	COALESCE(r.device_name, ''),
	COALESCE(r.hostname, ''),
	COALESCE(r.os, ''),
	COALESCE(r.arch, ''),
	COALESCE(d.collector_version, r.collector_version, ''),
	collector_state.last_seen_at,
	t.revoked_at
FROM office_agents a
LEFT JOIN office_collector_tokens t ON t.collector_id = a.collector_id
LEFT JOIN LATERAL (
	SELECT *
	FROM office_collector_registrations r
	WHERE r.collector_id = a.collector_id
	  AND r.device_id = a.device_id
	ORDER BY r.registered_at DESC
	LIMIT 1
) r ON true
LEFT JOIN LATERAL (
	SELECT *
	FROM office_collector_devices d
	WHERE d.collector_id = a.collector_id
	  AND d.device_id = a.device_id
	ORDER BY d.last_seen_at DESC
	LIMIT 1
) d ON true
LEFT JOIN LATERAL (
	SELECT last_seen_at
	FROM office_collector_devices d
	WHERE d.collector_id = a.collector_id
	ORDER BY d.last_seen_at DESC
	LIMIT 1
) collector_state ON true
WHERE a.mcp_agent_id = $1 AND t.source_type = 'collector'
LIMIT 1
`, mcpAgentID).Scan(
		&item.CollectorID,
		&item.OfficeAgentID,
		&item.DeviceID,
		&item.DeviceName,
		&item.Hostname,
		&item.OS,
		&item.Arch,
		&item.CollectorVersion,
		&lastSeenAt,
		&revokedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return management.AgentCollectorInfo{}, false, nil
	}
	if err != nil {
		return management.AgentCollectorInfo{}, false, err
	}
	if lastSeenAt.Valid {
		item.LastSeenAt = &lastSeenAt.Time
	}
	item.Status = collectorStatus(now, onlineThreshold, item.LastSeenAt, revokedAt.Valid)
	return item, true, nil
}

func collectorStatus(now time.Time, onlineThreshold time.Duration, lastSeenAt *time.Time, revoked bool) string {
	if revoked {
		return management.CollectorStatusRevoked
	}
	if lastSeenAt == nil {
		return management.CollectorStatusNever
	}
	if now.Sub(*lastSeenAt) <= onlineThreshold {
		return management.CollectorStatusOnline
	}
	return management.CollectorStatusOffline
}

func collectorSummary(collectors []management.CollectorItem) management.CollectorSummary {
	summary := management.CollectorSummary{
		TotalCollectors: len(collectors),
	}
	for _, collector := range collectors {
		switch collector.Status {
		case management.CollectorStatusOnline:
			summary.OnlineCollectors++
		case management.CollectorStatusOffline:
			summary.OfflineCollectors++
		case management.CollectorStatusNever:
			summary.NeverSeenCollectors++
		}
	}
	return summary
}
