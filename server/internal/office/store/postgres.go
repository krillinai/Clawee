package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/krillinai/Clawee/server/internal/office/auth"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/office/registration"
	"github.com/krillinai/Clawee/server/internal/office/state"
	"github.com/krillinai/Clawee/server/internal/tokenutil"
)

type PostgresStore struct {
	root *sql.DB
	db   sqlExecutor
}

const collectorDeviceIDRandomBytes = 8

type sqlExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func NewPostgresStore(db *sql.DB) *PostgresStore {
	return &PostgresStore{root: db, db: db}
}

func generateCollectorDeviceID() (string, error) {
	return auth.GenerateToken("device_", collectorDeviceIDRandomBytes)
}

func (s *PostgresStore) SeedCollectorToken(ctx context.Context, collectorID, tokenHash, deviceLabel string) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO office_collector_tokens (collector_id, token_hash, device_label)
VALUES ($1, $2, $3)
ON CONFLICT (collector_id) DO UPDATE SET
token_hash = EXCLUDED.token_hash,
device_label = EXCLUDED.device_label,
revoked_at = NULL
`, collectorID, tokenHash, deviceLabel)
	return err
}

func (s *PostgresStore) CreateOwnedRegistrationCode(ctx context.Context, code, userID, createdBy string, createdAt time.Time, expiresAt *time.Time) error {
	result, err := s.db.ExecContext(ctx, `
INSERT INTO office_collector_registration_codes
	(registration_code_hash, registration_code, user_id, created_by, created_at, expires_at, used_count)
SELECT $1, $6, a.user_id, $3, $4, $5, 0
FROM accounts a
WHERE a.user_id = $2 AND a.status = 'active'
`, auth.HashToken(code), userID, createdBy, createdAt, expiresAt, code)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return registration.ErrRegistrationOwnerInvalid
	}
	return nil
}

func (s *PostgresStore) RegisterCollector(ctx context.Context, req collectorapi.RegistrationRequest, registeredAt time.Time) (collectorapi.RegistrationResponse, error) {
	if _, ok := s.db.(*sql.Tx); ok {
		return collectorapi.RegistrationResponse{}, errors.New("RegisterCollector must run on root database connection")
	}
	if s.root == nil {
		return collectorapi.RegistrationResponse{}, errors.New("RegisterCollector missing root database connection")
	}

	codeHash := auth.HashToken(req.RegistrationCode)
	tx, err := s.root.BeginTx(ctx, nil)
	if err != nil {
		return collectorapi.RegistrationResponse{}, err
	}

	var expiresAt sql.NullTime
	var revokedAt sql.NullTime
	var userID sql.NullString
	var accountStatus sql.NullString
	err = tx.QueryRowContext(ctx, `
SELECT c.expires_at, c.revoked_at, c.user_id, a.status
FROM office_collector_registration_codes c
LEFT JOIN accounts a ON a.user_id = c.user_id
WHERE c.registration_code_hash = $1
FOR UPDATE OF c
`, codeHash).Scan(&expiresAt, &revokedAt, &userID, &accountStatus)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, registration.ErrInvalidRegistrationCode
	}
	if err != nil {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, err
	}
	if expiresAt.Valid && !expiresAt.Time.After(registeredAt) {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, registration.ErrRegistrationCodeExpired
	}
	if revokedAt.Valid {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, registration.ErrRegistrationCodeRevoked
	}
	if !userID.Valid || userID.String == "" || !accountStatus.Valid || accountStatus.String != "active" {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, registration.ErrRegistrationOwnerInvalid
	}

	var collectorID string
	var collectorUserID sql.NullString
	err = tx.QueryRowContext(ctx, `
SELECT collector_id, user_id
FROM office_collector_tokens
WHERE agent_id = $1
FOR UPDATE
`, req.AgentID).Scan(&collectorID, &collectorUserID)
	if errors.Is(err, sql.ErrNoRows) {
		var agentUserID string
		err = tx.QueryRowContext(ctx, `
SELECT user_id
FROM account_agents
WHERE agent_id = $1
`, req.AgentID).Scan(&agentUserID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			_ = tx.Rollback()
			return collectorapi.RegistrationResponse{}, err
		}
		if err == nil && agentUserID != userID.String {
			_ = tx.Rollback()
			return collectorapi.RegistrationResponse{}, registration.ErrAgentIDConflict
		}
		collectorID, err = auth.GenerateToken("collector_", 16)
		if err != nil {
			_ = tx.Rollback()
			return collectorapi.RegistrationResponse{}, err
		}
	} else if err != nil {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, err
	} else if !collectorUserID.Valid || collectorUserID.String != userID.String {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, registration.ErrAgentIDConflict
	}
	collectorExists := collectorUserID.Valid

	collectorToken, err := tokenutil.Generate32("col_")
	if err != nil {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, err
	}
	deviceID, err := generateCollectorDeviceID()
	if err != nil {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, err
	}
	registrationID, err := auth.GenerateToken("registration_", 16)
	if err != nil {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, err
	}

	agentIDs := make([]string, 0, len(req.Agents))
	for _, agent := range req.Agents {
		if agent.AgentID != "" {
			agentIDs = append(agentIDs, agent.AgentID)
		}
	}
	registeredAgentIDs, err := json.Marshal(agentIDs)
	if err != nil {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, err
	}

	if collectorExists {
		if _, err := tx.ExecContext(ctx, `
UPDATE office_collector_tokens
SET token_hash = $2,
    device_label = $3,
    last_used_at = NULL,
    revoked_at = NULL,
    source_type = 'collector'
WHERE collector_id = $1
`, collectorID, auth.HashToken(collectorToken), req.DeviceName); err != nil {
			_ = tx.Rollback()
			return collectorapi.RegistrationResponse{}, err
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO office_collector_tokens (collector_id, token_hash, device_label, user_id, agent_id)
VALUES ($1, $2, $3, $4, $5)
`, collectorID, auth.HashToken(collectorToken), req.DeviceName, userID.String, req.AgentID); err != nil {
			_ = tx.Rollback()
			if isCollectorAgentUniqueViolation(err) {
				return collectorapi.RegistrationResponse{}, registration.ErrAgentIDConflict
			}
			return collectorapi.RegistrationResponse{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO office_collector_registrations (registration_id, registration_code_hash, collector_id, device_id, device_name, hostname, os, arch, collector_version, registered_agent_ids, registered_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`, registrationID, codeHash, collectorID, deviceID, req.DeviceName, req.Hostname, req.OS, req.Arch, req.CollectorVersion, registeredAgentIDs, registeredAt); err != nil {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE office_collector_registration_codes
SET used_count = used_count + 1,
last_used_at = $2
WHERE registration_code_hash = $1
`, codeHash, registeredAt); err != nil {
		_ = tx.Rollback()
		return collectorapi.RegistrationResponse{}, err
	}
	if err := tx.Commit(); err != nil {
		return collectorapi.RegistrationResponse{}, err
	}

	return collectorapi.RegistrationResponse{
		CollectorID:    collectorID,
		CollectorToken: collectorToken,
		DeviceID:       deviceID,
		PrivacyMode:    "summary_only",
	}, nil
}

func isCollectorAgentUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "uq_office_collector_tokens_agent"
}

func (s *PostgresStore) Authenticate(ctx context.Context, token string) (httpapi.CollectorIdentity, bool, error) {
	var collectorID string
	var userID sql.NullString
	var revokedAt sql.NullTime
	var accountStatus sql.NullString
	err := s.db.QueryRowContext(ctx, `
SELECT t.collector_id, t.user_id, t.revoked_at, a.status
FROM office_collector_tokens t
LEFT JOIN accounts a ON a.user_id = t.user_id
WHERE t.token_hash = $1
`, auth.HashToken(token)).Scan(&collectorID, &userID, &revokedAt, &accountStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return httpapi.CollectorIdentity{}, false, nil
	}
	if err != nil {
		return httpapi.CollectorIdentity{}, false, err
	}
	if revokedAt.Valid || !userID.Valid || userID.String == "" || !accountStatus.Valid || accountStatus.String != "active" {
		return httpapi.CollectorIdentity{}, false, nil
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE office_collector_tokens SET last_used_at = now() WHERE collector_id = $1`, collectorID); err != nil {
		return httpapi.CollectorIdentity{}, false, err
	}
	return httpapi.CollectorIdentity{CollectorID: collectorID, UserID: userID.String}, true, nil
}

func (s *PostgresStore) UpsertDevice(ctx context.Context, input state.DeviceHeartbeat) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO office_collector_devices (collector_id, device_id, collector_version, last_seen_at, updated_at)
VALUES ($1, $2, $3, $4, $4)
ON CONFLICT (collector_id, device_id) DO UPDATE SET
collector_version = EXCLUDED.collector_version,
last_seen_at = EXCLUDED.last_seen_at,
updated_at = EXCLUDED.updated_at
`, input.CollectorID, input.DeviceID, input.CollectorVersion, input.LastSeenAt)
	return err
}

func (s *PostgresStore) UpsertAgent(ctx context.Context, input state.AgentState) error {
	metadata, err := marshalMetadata(input.Metadata)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO office_agents (collector_id, agent_id, device_id, agent_type, display_name, version, status, workspace_name, current_session_id, current_turn_id, last_seen_at, metadata, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11)
ON CONFLICT (collector_id, agent_id) DO UPDATE SET
device_id = EXCLUDED.device_id,
agent_type = EXCLUDED.agent_type,
display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), office_agents.display_name),
version = COALESCE(NULLIF(EXCLUDED.version, ''), office_agents.version),
status = EXCLUDED.status,
workspace_name = COALESCE(NULLIF(EXCLUDED.workspace_name, ''), office_agents.workspace_name),
current_session_id = COALESCE(NULLIF(EXCLUDED.current_session_id, ''), office_agents.current_session_id),
current_turn_id = COALESCE(NULLIF(EXCLUDED.current_turn_id, ''), office_agents.current_turn_id),
last_seen_at = EXCLUDED.last_seen_at,
metadata = office_agents.metadata || EXCLUDED.metadata,
updated_at = EXCLUDED.updated_at
`, input.CollectorID, input.AgentID, input.DeviceID, input.AgentType, input.DisplayName, input.Version, input.Status, input.WorkspaceName, input.CurrentSessionID, input.CurrentTurnID, input.LastSeenAt, metadata)
	return err
}

func (s *PostgresStore) ApplySourceEvent(ctx context.Context, input state.SourceEventState, reduce func(context.Context, state.Store) error) (bool, error) {
	if _, ok := s.db.(*sql.Tx); ok {
		return false, errors.New("ApplySourceEvent must run on root database connection")
	}
	if s.root == nil {
		return false, errors.New("ApplySourceEvent missing root database connection")
	}

	tx, err := s.root.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	txStore := &PostgresStore{root: s.root, db: tx}

	inserted, err := txStore.insertSourceEvent(ctx, input)
	if err != nil {
		_ = tx.Rollback()
		return false, err
	}
	if !inserted {
		if err := tx.Rollback(); err != nil {
			return false, err
		}
		return false, nil
	}

	if err := reduce(ctx, txStore); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *PostgresStore) insertSourceEvent(ctx context.Context, input state.SourceEventState) (bool, error) {
	rawPayload := input.RawPayload
	if len(rawPayload) == 0 {
		rawPayload = []byte(`{}`)
	}
	standardPayload := input.StandardPayload
	if len(standardPayload) == 0 {
		standardPayload = []byte(`{}`)
	}
	parseStatus := input.ParseStatus
	if parseStatus == "" {
		parseStatus = "parsed"
	}

	var inserted bool
	err := s.db.QueryRowContext(ctx, `
INSERT INTO office_agent_source_events (
	collector_id, source_event_id, source_type, source_event_type, standard_event_type,
	agent_id, session_id, turn_id, sub_agent_id, tool_call_id,
	occurred_at, received_at, raw_payload, standard_payload, parse_status, parse_error
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (collector_id, source_event_id) DO NOTHING
RETURNING true
`, input.CollectorID, input.SourceEventID, input.SourceType, input.SourceEventType, input.StandardEventType,
		input.AgentID, input.SessionID, input.TurnID, input.SubAgentID, input.ToolCallID,
		input.OccurredAt, input.ReceivedAt, rawPayload, standardPayload, parseStatus, input.ParseError).Scan(&inserted)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return inserted, err
}

func (s *PostgresStore) UpsertSession(ctx context.Context, input state.SessionState) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO office_agent_sessions (collector_id, agent_id, session_id, status, summary, started_at, ended_at, workspace_name, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10)
ON CONFLICT (collector_id, agent_id, session_id) DO UPDATE SET
status = EXCLUDED.status,
summary = COALESCE(NULLIF(EXCLUDED.summary, ''), office_agent_sessions.summary),
started_at = CASE WHEN $9 THEN EXCLUDED.started_at ELSE office_agent_sessions.started_at END,
ended_at = COALESCE(EXCLUDED.ended_at, office_agent_sessions.ended_at),
workspace_name = COALESCE(NULLIF(EXCLUDED.workspace_name, ''), office_agent_sessions.workspace_name),
updated_at = EXCLUDED.updated_at
`, input.CollectorID, input.AgentID, input.SessionID, input.Status, input.Summary, input.StartedAt, input.EndedAt, input.WorkspaceName, input.UpdateStartedAt, input.UpdatedAt)
	return err
}

func (s *PostgresStore) CloseOpenActivities(ctx context.Context, scope state.ActivityScope, completedAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE office_agent_activities SET completed_at = $6, updated_at = $6
WHERE collector_id = $1
AND agent_id = $2
AND COALESCE(sub_agent_id, '') = $3
AND session_id = $4
AND turn_id = $5
AND completed_at IS NULL
`, scope.CollectorID, scope.AgentID, scope.SubAgentID, scope.SessionID, scope.TurnID, completedAt)
	return err
}

func (s *PostgresStore) UpsertActivity(ctx context.Context, input state.ActivityState) error {
	metadata, err := marshalMetadata(input.Metadata)
	if err != nil {
		return err
	}
	updatedAt := input.StartedAt
	if input.CompletedAt != nil {
		updatedAt = *input.CompletedAt
	}

	_, err = s.db.ExecContext(ctx, `
INSERT INTO office_agent_activities (collector_id, activity_id, agent_id, sub_agent_id, session_id, turn_id, tool_call_id, activity_type, status, title, summary, started_at, completed_at, metadata, updated_at)
VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
ON CONFLICT (collector_id, agent_id, activity_id) DO UPDATE SET
sub_agent_id = EXCLUDED.sub_agent_id,
session_id = EXCLUDED.session_id,
turn_id = EXCLUDED.turn_id,
tool_call_id = COALESCE(NULLIF(EXCLUDED.tool_call_id, ''), office_agent_activities.tool_call_id),
activity_type = EXCLUDED.activity_type,
status = EXCLUDED.status,
title = COALESCE(NULLIF(EXCLUDED.title, ''), office_agent_activities.title),
summary = COALESCE(NULLIF(EXCLUDED.summary, ''), office_agent_activities.summary),
completed_at = COALESCE(EXCLUDED.completed_at, office_agent_activities.completed_at),
metadata = office_agent_activities.metadata || EXCLUDED.metadata,
updated_at = EXCLUDED.updated_at
`, input.CollectorID, input.ActivityID, input.AgentID, input.SubAgentID, input.SessionID, input.TurnID, input.ToolCallID, input.ActivityType, input.Status, input.Title, input.Summary, input.StartedAt, input.CompletedAt, metadata, updatedAt)
	return err
}

func (s *PostgresStore) CompleteActivity(ctx context.Context, input state.ActivityCompletion) error {
	if input.ActivityID != "" {
		_, err := s.db.ExecContext(ctx, `
UPDATE office_agent_activities SET completed_at = $4, updated_at = $4
WHERE collector_id = $1 AND agent_id = $2 AND activity_id = $3 AND completed_at IS NULL
`, input.Scope.CollectorID, input.Scope.AgentID, input.ActivityID, input.CompletedAt)
		return err
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE office_agent_activities SET completed_at = $7, updated_at = $7
WHERE collector_id = $1
AND agent_id = $2
AND COALESCE(sub_agent_id, '') = $3
AND session_id = $4
AND turn_id = $5
AND activity_type = $6
AND completed_at IS NULL
`, input.Scope.CollectorID, input.Scope.AgentID, input.Scope.SubAgentID, input.Scope.SessionID, input.Scope.TurnID, input.ActivityType, input.CompletedAt)
	return err
}

func (s *PostgresStore) UpsertSubAgent(ctx context.Context, input state.SubAgentState) error {
	metadata, err := marshalMetadata(input.Metadata)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO office_agent_sub_agents (collector_id, parent_agent_id, sub_agent_id, session_id, parent_turn_id, spawn_tool_call_id, name, nickname, role, status, current_activity, started_at, updated_at, completed_at, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
ON CONFLICT (collector_id, parent_agent_id, sub_agent_id) DO UPDATE SET
session_id = EXCLUDED.session_id,
parent_turn_id = COALESCE(NULLIF(EXCLUDED.parent_turn_id, ''), office_agent_sub_agents.parent_turn_id),
spawn_tool_call_id = COALESCE(NULLIF(EXCLUDED.spawn_tool_call_id, ''), office_agent_sub_agents.spawn_tool_call_id),
name = COALESCE(NULLIF(EXCLUDED.name, ''), office_agent_sub_agents.name),
nickname = COALESCE(NULLIF(EXCLUDED.nickname, ''), office_agent_sub_agents.nickname),
role = COALESCE(NULLIF(EXCLUDED.role, ''), office_agent_sub_agents.role),
status = EXCLUDED.status,
current_activity = COALESCE(NULLIF(EXCLUDED.current_activity, ''), office_agent_sub_agents.current_activity),
updated_at = EXCLUDED.updated_at,
completed_at = COALESCE(EXCLUDED.completed_at, office_agent_sub_agents.completed_at),
metadata = office_agent_sub_agents.metadata || EXCLUDED.metadata
`, input.CollectorID, input.ParentAgentID, input.SubAgentID, input.SessionID, input.ParentTurnID, input.SpawnToolCallID, input.Name, input.Nickname, input.Role, input.Status, input.CurrentActivity, input.StartedAt, input.UpdatedAt, input.CompletedAt, metadata)
	return err
}

func (s *PostgresStore) CompleteSubAgent(ctx context.Context, input state.SubAgentCompletion) error {
	status := input.Status
	if status == "" {
		status = collectorapi.StatusIdle
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE office_agent_sub_agents SET completed_at = $4, updated_at = $4, status = $5
WHERE collector_id = $1 AND parent_agent_id = $2 AND sub_agent_id = $3
`, input.CollectorID, input.ParentAgentID, input.SubAgentID, input.CompletedAt, status)
	return err
}

func (s *PostgresStore) UpsertTurn(ctx context.Context, input state.TurnState) error {
	metadata, err := marshalMetadata(input.Metadata)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO office_agent_turns (
	collector_id, agent_id, turn_id, session_id, sub_agent_id, parent_agent_id, parent_turn_id,
	spawn_tool_call_id, title, user_prompt, assistant_summary, last_assistant_message,
	summary, status, started_at, updated_at, completed_at, metadata
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $13, $14, $15, $16, $17)
ON CONFLICT (collector_id, agent_id, turn_id) DO UPDATE SET
session_id = EXCLUDED.session_id,
sub_agent_id = COALESCE(NULLIF(EXCLUDED.sub_agent_id, ''), office_agent_turns.sub_agent_id),
parent_agent_id = COALESCE(NULLIF(EXCLUDED.parent_agent_id, ''), office_agent_turns.parent_agent_id),
parent_turn_id = COALESCE(NULLIF(EXCLUDED.parent_turn_id, ''), office_agent_turns.parent_turn_id),
spawn_tool_call_id = COALESCE(NULLIF(EXCLUDED.spawn_tool_call_id, ''), office_agent_turns.spawn_tool_call_id),
title = COALESCE(NULLIF(EXCLUDED.title, ''), office_agent_turns.title),
user_prompt = COALESCE(NULLIF(EXCLUDED.user_prompt, ''), office_agent_turns.user_prompt),
assistant_summary = COALESCE(NULLIF(EXCLUDED.assistant_summary, ''), office_agent_turns.assistant_summary),
last_assistant_message = COALESCE(NULLIF(EXCLUDED.last_assistant_message, ''), office_agent_turns.last_assistant_message),
summary = COALESCE(NULLIF(EXCLUDED.summary, ''), office_agent_turns.summary),
status = EXCLUDED.status,
updated_at = EXCLUDED.updated_at,
completed_at = COALESCE(EXCLUDED.completed_at, office_agent_turns.completed_at),
metadata = office_agent_turns.metadata || EXCLUDED.metadata
`, input.CollectorID, input.AgentID, input.TurnID, input.SessionID, input.SubAgentID, input.ParentAgentID, input.ParentTurnID,
		input.SpawnToolCallID, input.Title, input.UserPrompt, input.AssistantSummary, input.LastAssistantMessage,
		input.Status, input.StartedAt, input.UpdatedAt, input.CompletedAt, metadata)
	return err
}

func (s *PostgresStore) CompleteTurn(ctx context.Context, input state.TurnCompletion) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE office_agent_turns SET completed_at = $4, updated_at = $4, status = $5
WHERE collector_id = $1 AND agent_id = $2 AND turn_id = $3
`, input.CollectorID, input.AgentID, input.TurnID, input.CompletedAt, collectorapi.StatusIdle)
	return err
}

func (s *PostgresStore) UpsertToolCall(ctx context.Context, input state.ToolCallState) error {
	metadata, err := marshalMetadata(input.Metadata)
	if err != nil {
		return err
	}
	toolInput := input.Input
	if len(toolInput) == 0 {
		toolInput = []byte(`{}`)
	}
	response := input.Response
	if len(response) == 0 {
		response = []byte(`{}`)
	}
	updatedAt := input.StartedAt
	if input.CompletedAt != nil {
		updatedAt = *input.CompletedAt
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO office_agent_tool_calls (
	collector_id, agent_id, tool_call_id, external_tool_call_id, session_id, turn_id, sub_agent_id,
	tool_name, tool_type, status, input, response, response_text, started_at, completed_at,
	duration_ms, source_event_start_id, source_event_end_id, metadata, updated_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
ON CONFLICT (collector_id, agent_id, tool_call_id) DO UPDATE SET
external_tool_call_id = COALESCE(NULLIF(EXCLUDED.external_tool_call_id, ''), office_agent_tool_calls.external_tool_call_id),
session_id = COALESCE(NULLIF(EXCLUDED.session_id, ''), office_agent_tool_calls.session_id),
turn_id = COALESCE(NULLIF(EXCLUDED.turn_id, ''), office_agent_tool_calls.turn_id),
sub_agent_id = COALESCE(NULLIF(EXCLUDED.sub_agent_id, ''), office_agent_tool_calls.sub_agent_id),
tool_name = COALESCE(NULLIF(EXCLUDED.tool_name, ''), office_agent_tool_calls.tool_name),
tool_type = COALESCE(NULLIF(EXCLUDED.tool_type, ''), office_agent_tool_calls.tool_type),
status = EXCLUDED.status,
input = COALESCE(NULLIF(EXCLUDED.input, '{}'::jsonb), office_agent_tool_calls.input),
response = COALESCE(NULLIF(EXCLUDED.response, '{}'::jsonb), office_agent_tool_calls.response),
response_text = COALESCE(NULLIF(EXCLUDED.response_text, ''), office_agent_tool_calls.response_text),
completed_at = COALESCE(EXCLUDED.completed_at, office_agent_tool_calls.completed_at),
duration_ms = GREATEST(EXCLUDED.duration_ms, office_agent_tool_calls.duration_ms),
source_event_start_id = COALESCE(NULLIF(EXCLUDED.source_event_start_id, ''), office_agent_tool_calls.source_event_start_id),
source_event_end_id = COALESCE(NULLIF(EXCLUDED.source_event_end_id, ''), office_agent_tool_calls.source_event_end_id),
metadata = office_agent_tool_calls.metadata || EXCLUDED.metadata,
updated_at = EXCLUDED.updated_at
`, input.CollectorID, input.AgentID, input.ToolCallID, input.ExternalToolCallID, input.SessionID, input.TurnID, input.SubAgentID,
		input.ToolName, input.ToolType, input.Status, toolInput, response, input.ResponseText, input.StartedAt, input.CompletedAt,
		input.DurationMS, input.SourceEventStartID, input.SourceEventEndID, metadata, updatedAt)
	return err
}

func (s *PostgresStore) CompleteToolCall(ctx context.Context, input state.ToolCallCompletion) error {
	metadata, err := marshalMetadata(input.Metadata)
	if err != nil {
		return err
	}
	response := input.Response
	if len(response) == 0 {
		response = []byte(`{}`)
	}
	_, err = s.db.ExecContext(ctx, `
UPDATE office_agent_tool_calls
SET status = $4,
	response = CASE WHEN $5::jsonb = '{}'::jsonb THEN response ELSE $5::jsonb END,
	response_text = COALESCE(NULLIF($6, ''), response_text),
	completed_at = $7,
	duration_ms = GREATEST(duration_ms, $10, EXTRACT(EPOCH FROM ($7 - started_at)) * 1000)::bigint,
	source_event_end_id = COALESCE(NULLIF($8, ''), source_event_end_id),
	metadata = metadata || $9,
	updated_at = $7
WHERE collector_id = $1 AND agent_id = $2 AND tool_call_id = $3
`, input.CollectorID, input.AgentID, input.ToolCallID, input.Status, response, input.ResponseText, input.CompletedAt, input.SourceEventEndID, metadata, input.DurationMS)
	return err
}

func (s *PostgresStore) MarkOffline(ctx context.Context, now time.Time, threshold time.Duration) error {
	cutoff := now.Add(-threshold)
	_, err := s.db.ExecContext(ctx, `
UPDATE office_agents SET status = $1, updated_at = $2
WHERE last_seen_at < $3 AND status <> $1
`, collectorapi.StatusOffline, now, cutoff)
	return err
}

func marshalMetadata(input map[string]string) ([]byte, error) {
	if input == nil {
		input = map[string]string{}
	}
	return json.Marshal(input)
}
