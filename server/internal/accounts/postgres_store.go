package accounts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrPostgresStoreUnavailable = errors.New("postgres account store is unavailable")

type postgresTxKey struct{}

type postgresRunner interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type PostgresStore struct {
	pool *pgxpool.Pool
}

type postgresTxStore struct {
	tx pgx.Tx
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

func (s *PostgresStore) WithBootstrapLock(ctx context.Context, fn func(context.Context) error) error {
	if s == nil || s.pool == nil {
		return ErrPostgresStoreUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO account_bootstrap_locks (lock_id) VALUES ('first_admin') ON CONFLICT DO NOTHING`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT lock_id FROM account_bootstrap_locks WHERE lock_id = 'first_admin' FOR UPDATE`); err != nil {
		return err
	}
	txStore := &postgresTxStore{tx: tx}
	if err := fn(context.WithValue(ctx, postgresTxKey{}, txStore)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) WithExternalIdentityLock(ctx context.Context, providerType, providerKey, providerSubject string, fn func(context.Context) error) error {
	if s == nil || s.pool == nil {
		return ErrPostgresStoreUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	lockKey := externalIdentityLockKey(providerType, providerKey, providerSubject)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return err
	}
	if err := fn(context.WithValue(ctx, postgresTxKey{}, &postgresTxStore{tx: tx})); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func externalIdentityLockKey(providerType, providerKey, providerSubject string) string {
	digest := sha256.Sum256([]byte(providerType + "\x00" + providerKey + "\x00" + providerSubject))
	return hex.EncodeToString(digest[:])
}

func (s *PostgresStore) SaveAccount(ctx context.Context, account Account) error {
	return saveAccount(ctx, s.runner(ctx), account)
}

func (s *PostgresStore) DeleteAccount(ctx context.Context, userID string) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	tag, err := runner.Exec(ctx, `DELETE FROM accounts WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAccountNotFound
	}
	return nil
}

func (s *PostgresStore) GetAccount(ctx context.Context, userID string) (Account, error) {
	return getAccount(ctx, s.runner(ctx), `WHERE user_id = $1`, userID)
}

func (s *PostgresStore) GetAccountByEmail(ctx context.Context, email string) (Account, error) {
	return getAccount(ctx, s.runner(ctx), `WHERE email = $1`, email)
}

func (s *PostgresStore) ListAccounts(ctx context.Context) ([]Account, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return nil, ErrPostgresStoreUnavailable
	}
	rows, err := runner.Query(ctx, `
		SELECT user_id, email, name, password_hash, status, created_at, updated_at
		FROM accounts
		ORDER BY created_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []Account
	for rows.Next() {
		account, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return accounts, nil
}

func (s *PostgresStore) CountAccounts(ctx context.Context) (int, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return 0, ErrPostgresStoreUnavailable
	}
	var count int
	if err := runner.QueryRow(ctx, `SELECT count(*) FROM accounts`).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func (s *PostgresStore) SaveSession(ctx context.Context, session Session) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `
		INSERT INTO account_sessions (session_id, user_id, agent_id, token_hash, expires_at, created_at, last_seen_at)
		VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7)
		ON CONFLICT (session_id) DO UPDATE SET
			user_id = EXCLUDED.user_id,
			agent_id = EXCLUDED.agent_id,
			token_hash = EXCLUDED.token_hash,
			expires_at = EXCLUDED.expires_at,
			created_at = EXCLUDED.created_at,
			last_seen_at = EXCLUDED.last_seen_at
	`, session.SessionID, session.UserID, session.AgentID, session.TokenHash, session.ExpiresAt, session.CreatedAt, session.LastSeenAt)
	return err
}

func (s *PostgresStore) GetSessionByHash(ctx context.Context, tokenHash string) (Session, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return Session{}, ErrPostgresStoreUnavailable
	}
	var session Session
	err := runner.QueryRow(ctx, `
		SELECT session_id, user_id, COALESCE(agent_id, ''), token_hash, expires_at, created_at, last_seen_at
		FROM account_sessions
		WHERE token_hash = $1
	`, tokenHash).Scan(
		&session.SessionID,
		&session.UserID,
		&session.AgentID,
		&session.TokenHash,
		&session.ExpiresAt,
		&session.CreatedAt,
		&session.LastSeenAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionNotFound
	}
	if err != nil {
		return Session{}, err
	}
	return session, nil
}

func (s *PostgresStore) DeleteSession(ctx context.Context, sessionID string) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `DELETE FROM account_sessions WHERE session_id = $1`, sessionID)
	return err
}

func (s *PostgresStore) DeleteSessionsForUser(ctx context.Context, userID string) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `DELETE FROM account_sessions WHERE user_id = $1`, userID)
	return err
}

func (s *PostgresStore) SaveAccountAgent(ctx context.Context, item AccountAgent) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `
		INSERT INTO account_agents (user_id, agent_id, created_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, agent_id) DO NOTHING
	`, item.UserID, item.AgentID, item.CreatedAt)
	return err
}

func (s *PostgresStore) ListAccountAgents(ctx context.Context, userID string) ([]AccountAgent, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return nil, ErrPostgresStoreUnavailable
	}
	rows, err := runner.Query(ctx, `
		SELECT user_id, agent_id, created_at
		FROM account_agents
		WHERE user_id = $1
		ORDER BY created_at, agent_id
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []AccountAgent
	for rows.Next() {
		var item AccountAgent
		if err := rows.Scan(&item.UserID, &item.AgentID, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *PostgresStore) GetAccountForAgent(ctx context.Context, agentID string) (Account, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return Account{}, ErrPostgresStoreUnavailable
	}
	row := runner.QueryRow(ctx, `
		SELECT a.user_id, a.email, a.name, a.password_hash, a.status, a.created_at, a.updated_at
		FROM account_agents aa
		JOIN accounts a ON a.user_id = aa.user_id
		WHERE aa.agent_id = $1
	`, agentID)
	account, err := scanAccount(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, ErrAccountAgentNotFound
	}
	return account, err
}

func (s *PostgresStore) GetAccountIdentity(ctx context.Context, providerType, providerKey, providerSubject string) (AccountIdentity, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return AccountIdentity{}, ErrPostgresStoreUnavailable
	}
	return scanAccountIdentity(runner.QueryRow(ctx, `
		SELECT provider_type, provider_key, provider_subject, user_id, external_user_id, verified_at, created_at, updated_at
		FROM account_identities
		WHERE provider_type = $1 AND provider_key = $2 AND provider_subject = $3
	`, providerType, providerKey, providerSubject))
}

func (s *PostgresStore) GetAccountIdentityForUser(ctx context.Context, userID, providerType, providerKey string) (AccountIdentity, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return AccountIdentity{}, ErrPostgresStoreUnavailable
	}
	return scanAccountIdentity(runner.QueryRow(ctx, `
		SELECT provider_type, provider_key, provider_subject, user_id, external_user_id, verified_at, created_at, updated_at
		FROM account_identities
		WHERE user_id = $1 AND provider_type = $2 AND provider_key = $3
	`, userID, providerType, providerKey))
}

func (s *PostgresStore) InsertAccountIdentity(ctx context.Context, identity AccountIdentity) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `
		INSERT INTO account_identities (
			provider_type, provider_key, provider_subject, user_id, external_user_id, verified_at, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject, identity.UserID, identity.ExternalUserID,
		identity.VerifiedAt, identity.CreatedAt, identity.UpdatedAt)
	if isUniqueViolation(err, "account_identities_pkey") {
		return ErrAccountIdentityExists
	}
	if isUniqueViolation(err, "account_identities_user_id_provider_type_provider_key_key") {
		return ErrAccountIdentityUserConflict
	}
	return err
}

func (s *PostgresStore) UpdateAccountIdentityVerification(ctx context.Context, identity AccountIdentity) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	tag, err := runner.Exec(ctx, `
		UPDATE account_identities
		SET external_user_id = $4, verified_at = $5, updated_at = $6
		WHERE provider_type = $1 AND provider_key = $2 AND provider_subject = $3
	`, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject, identity.ExternalUserID, identity.VerifiedAt, identity.UpdatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAccountIdentityNotFound
	}
	return nil
}

func (s *PostgresStore) DeleteAccountIdentity(ctx context.Context, userID, providerType, providerKey string) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	tag, err := runner.Exec(ctx, `
		DELETE FROM account_identities
		WHERE user_id = $1 AND provider_type = $2 AND provider_key = $3
	`, userID, providerType, providerKey)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAccountIdentityNotFound
	}
	return nil
}

func (s *PostgresStore) SaveOAuthLoginState(ctx context.Context, state OAuthLoginState) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `
		INSERT INTO oauth_login_states (
			state_hash, provider_type, provider_key, intent, redirect_to, bind_user_id, agent_id, pkce_challenge, created_at, expires_at
		) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)
	`, state.StateHash, state.ProviderType, state.ProviderKey, state.Intent, state.RedirectTo, state.BindUserID,
		state.AgentID, state.PKCEChallenge, state.CreatedAt, state.ExpiresAt)
	return err
}

func (s *PostgresStore) ConsumeOAuthLoginState(ctx context.Context, stateHash string, now time.Time) (OAuthLoginState, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return OAuthLoginState{}, ErrPostgresStoreUnavailable
	}
	var state OAuthLoginState
	err := runner.QueryRow(ctx, `
		DELETE FROM oauth_login_states
		WHERE state_hash = $1 AND expires_at > $2
		RETURNING state_hash, provider_type, provider_key, intent, redirect_to, COALESCE(bind_user_id, ''),
			COALESCE(agent_id, ''), COALESCE(pkce_challenge, ''), created_at, expires_at
	`, stateHash, now).Scan(&state.StateHash, &state.ProviderType, &state.ProviderKey, &state.Intent, &state.RedirectTo,
		&state.BindUserID, &state.AgentID, &state.PKCEChallenge, &state.CreatedAt, &state.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return OAuthLoginState{}, ErrOAuthLoginStateNotFound
	}
	return state, err
}

func (s *PostgresStore) DeleteExpiredOAuthLoginStates(ctx context.Context, now time.Time) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `DELETE FROM oauth_login_states WHERE expires_at <= $1`, now)
	return err
}

func (s *PostgresStore) SaveOAuthAuthorizationCode(ctx context.Context, code OAuthAuthorizationCode) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `
		INSERT INTO oauth_authorization_codes (
			code_hash, user_id, agent_id, redirect_uri, pkce_challenge, created_at, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, code.CodeHash, code.UserID, code.AgentID, code.RedirectURI, code.PKCEChallenge, code.CreatedAt, code.ExpiresAt)
	return err
}

func (s *PostgresStore) ConsumeOAuthAuthorizationCode(ctx context.Context, req OAuthAuthorizationCodeConsumeRequest) (OAuthAuthorizationCode, error) {
	runner := s.runner(ctx)
	if runner == nil {
		return OAuthAuthorizationCode{}, ErrPostgresStoreUnavailable
	}
	var code OAuthAuthorizationCode
	err := runner.QueryRow(ctx, `
		DELETE FROM oauth_authorization_codes
		WHERE code_hash = $1
		  AND agent_id = $2
		  AND redirect_uri = $3
		  AND pkce_challenge = $4
		  AND expires_at > $5
		RETURNING code_hash, user_id, agent_id, redirect_uri, pkce_challenge, created_at, expires_at
	`, req.CodeHash, req.AgentID, req.RedirectURI, req.PKCEChallenge, req.Now).Scan(
		&code.CodeHash, &code.UserID, &code.AgentID, &code.RedirectURI, &code.PKCEChallenge, &code.CreatedAt, &code.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return OAuthAuthorizationCode{}, ErrOAuthAuthorizationCodeNotFound
	}
	return code, err
}

func (s *PostgresStore) DeleteExpiredOAuthAuthorizationCodes(ctx context.Context, now time.Time) error {
	runner := s.runner(ctx)
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `DELETE FROM oauth_authorization_codes WHERE expires_at <= $1`, now)
	return err
}

func (s *PostgresStore) runner(ctx context.Context) postgresRunner {
	if txStore, ok := ctx.Value(postgresTxKey{}).(*postgresTxStore); ok {
		return txStore.tx
	}
	if s == nil || s.pool == nil {
		return nil
	}
	return s.pool
}

func saveAccount(ctx context.Context, runner postgresRunner, account Account) error {
	if runner == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := runner.Exec(ctx, `
		INSERT INTO accounts (user_id, email, name, password_hash, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (user_id) DO UPDATE SET
			email = EXCLUDED.email,
			name = EXCLUDED.name,
			password_hash = EXCLUDED.password_hash,
			status = EXCLUDED.status,
			updated_at = EXCLUDED.updated_at
	`, account.UserID, account.Email, account.Name, account.PasswordHash, account.Status, account.CreatedAt, account.UpdatedAt)
	if isUniqueViolation(err, "accounts_email_key") {
		return ErrEmailExists
	}
	return err
}

func getAccount(ctx context.Context, runner postgresRunner, where string, arg string) (Account, error) {
	if runner == nil {
		return Account{}, ErrPostgresStoreUnavailable
	}
	row := runner.QueryRow(ctx, `
		SELECT user_id, email, name, password_hash, status, created_at, updated_at
		FROM accounts
		`+where, arg)
	account, err := scanAccount(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, ErrAccountNotFound
	}
	if err != nil {
		return Account{}, err
	}
	return account, nil
}

func scanAccount(row pgx.Row) (Account, error) {
	var account Account
	err := row.Scan(
		&account.UserID,
		&account.Email,
		&account.Name,
		&account.PasswordHash,
		&account.Status,
		&account.CreatedAt,
		&account.UpdatedAt,
	)
	return account, err
}

func scanAccountIdentity(row pgx.Row) (AccountIdentity, error) {
	var identity AccountIdentity
	err := row.Scan(&identity.ProviderType, &identity.ProviderKey, &identity.ProviderSubject, &identity.UserID,
		&identity.ExternalUserID, &identity.VerifiedAt, &identity.CreatedAt, &identity.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountIdentity{}, ErrAccountIdentityNotFound
	}
	return identity, err
}

func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}
