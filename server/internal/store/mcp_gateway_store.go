package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type MCPGatewayStore struct {
	pool *pgxpool.Pool
}

var _ mcpgateway.Store = (*MCPGatewayStore)(nil)

func NewMCPGatewayStore(pool *pgxpool.Pool) *MCPGatewayStore {
	return &MCPGatewayStore{pool: pool}
}

func (s *MCPGatewayStore) SaveAgent(ctx context.Context, agent mcpgateway.AgentRegistration) error {
	if s == nil || s.pool == nil {
		return nil
	}
	now := time.Now().UTC()
	if agent.CreatedAt.IsZero() {
		agent.CreatedAt = now
	}
	if agent.CreationSource == "" {
		agent.CreationSource = mcpgateway.AgentCreationSourceLegacy
	}
	agent.UpdatedAt = now
	_, err := s.pool.Exec(ctx, `
INSERT INTO mcp_agents (agent_id, client_id, name, tenant_id, actor_id, status, creation_source, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (agent_id) DO UPDATE SET
	client_id = EXCLUDED.client_id,
	name = EXCLUDED.name,
	tenant_id = EXCLUDED.tenant_id,
	actor_id = EXCLUDED.actor_id,
	status = EXCLUDED.status,
	creation_source = EXCLUDED.creation_source,
	updated_at = EXCLUDED.updated_at`,
		agent.AgentID, agent.ClientID, agent.Name, agent.TenantID, agent.ActorID,
		agent.Status, agent.CreationSource, agent.CreatedAt, agent.UpdatedAt,
	)
	return err
}

func (s *MCPGatewayStore) UpdateAgentName(ctx context.Context, agentID, name string) (mcpgateway.AgentRegistration, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.AgentRegistration{}, mcpgateway.ErrAgentNotFound
	}
	row := s.pool.QueryRow(ctx, `
UPDATE mcp_agents
SET name = $2, updated_at = $3
WHERE agent_id = $1
RETURNING agent_id, client_id, name, tenant_id, actor_id, status, creation_source, created_at, updated_at`,
		agentID, name, time.Now().UTC())
	agent, err := scanAgent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.AgentRegistration{}, mcpgateway.ErrAgentNotFound
	}
	return agent, err
}

func (s *MCPGatewayStore) CreateOwnedAgent(ctx context.Context, userID string, agent mcpgateway.AgentRegistration) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrAgentOwnerUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var accountStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM accounts WHERE user_id = $1 FOR UPDATE`, userID).Scan(&accountStatus); errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.ErrAgentOwnerUnavailable
	} else if err != nil {
		return err
	}
	if accountStatus != mcpgateway.StatusActive {
		return mcpgateway.ErrAgentOwnerUnavailable
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mcp_agents WHERE agent_id = $1)`, agent.AgentID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return mcpgateway.ErrAgentAlreadyExists
	}
	now := time.Now().UTC()
	if agent.CreatedAt.IsZero() {
		agent.CreatedAt = now
	}
	if agent.CreationSource == "" {
		agent.CreationSource = mcpgateway.AgentCreationSourceLegacy
	}
	agent.UpdatedAt = now
	if _, err := tx.Exec(ctx, `
INSERT INTO mcp_agents (agent_id, client_id, name, tenant_id, actor_id, status, creation_source, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, agent.AgentID, agent.ClientID, agent.Name, agent.TenantID, agent.ActorID, agent.Status, agent.CreationSource, agent.CreatedAt, agent.UpdatedAt); err != nil {
		return normalizeAgentInsertError(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO account_agents (user_id, agent_id, created_at) VALUES ($1, $2, $3)`, userID, agent.AgentID, agent.CreatedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func normalizeAgentInsertError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return mcpgateway.ErrAgentAlreadyExists
	}
	return err
}

func (s *MCPGatewayStore) GetAgent(ctx context.Context, agentID string) (mcpgateway.AgentRegistration, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.AgentRegistration{}, mcpgateway.ErrAgentNotFound
	}
	row := s.pool.QueryRow(ctx, `
SELECT agent_id, client_id, name, tenant_id, actor_id, status, creation_source, created_at, updated_at
FROM mcp_agents WHERE agent_id = $1`, agentID)
	agent, err := scanAgent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.AgentRegistration{}, mcpgateway.ErrAgentNotFound
	}
	return agent, err
}

func (s *MCPGatewayStore) ListAgents(ctx context.Context, filter mcpgateway.AgentFilter) ([]mcpgateway.AgentRegistration, error) {
	if s == nil || s.pool == nil {
		return []mcpgateway.AgentRegistration{}, nil
	}
	rows, err := s.pool.Query(ctx, `
SELECT agent_id, client_id, name, tenant_id, actor_id, status, creation_source, created_at, updated_at
FROM mcp_agents
WHERE ($1 = '' OR agent_id = $1)
  AND ($2 = '' OR status = $2)
ORDER BY agent_id ASC`, filter.AgentID, filter.Status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mcpgateway.AgentRegistration
	for rows.Next() {
		agent, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, agent)
	}
	return out, rows.Err()
}

func (s *MCPGatewayStore) DeleteAgent(ctx context.Context, agentID string) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrAgentNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	tag, err := tx.Exec(ctx, `DELETE FROM mcp_agents WHERE agent_id = $1`, agentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return mcpgateway.ErrAgentNotFound
	}
	return tx.Commit(ctx)
}

func (s *MCPGatewayStore) RotateAccountToken(ctx context.Context, userID string, token mcpgateway.AccountToken) error {
	if s == nil || s.pool == nil {
		return accounts.ErrAccountNotFound
	}
	if strings.TrimSpace(userID) == "" || token.UserID != userID {
		return mcpgateway.ErrAgentOwnerUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM accounts WHERE user_id = $1 FOR UPDATE`, userID).Scan(&status); errors.Is(err, pgx.ErrNoRows) {
		return accounts.ErrAccountNotFound
	} else if err != nil {
		return err
	}
	if status != mcpgateway.StatusActive {
		return accounts.ErrAccountNotActive
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `UPDATE mcp_account_tokens SET status = $2, updated_at = $3 WHERE user_id = $1 AND status = $4`, userID, mcpgateway.StatusRevoked, now, mcpgateway.StatusActive); err != nil {
		return err
	}
	if err := insertAccountToken(ctx, tx, token); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *MCPGatewayStore) RevokeAccountTokens(ctx context.Context, userID string, revokedAt time.Time) (int64, error) {
	if s == nil || s.pool == nil {
		return 0, mcpgateway.ErrAccountTokenNotFound
	}
	tag, err := s.pool.Exec(ctx, `UPDATE mcp_account_tokens SET status = $2, updated_at = $3 WHERE user_id = $1 AND status = $4`, userID, mcpgateway.StatusRevoked, revokedAt, mcpgateway.StatusActive)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, mcpgateway.ErrAccountTokenNotFound
	}
	return tag.RowsAffected(), nil
}

func (s *MCPGatewayStore) TouchAccountToken(ctx context.Context, tokenID string, usedAt time.Time) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrAccountTokenNotFound
	}
	tag, err := s.pool.Exec(ctx, `UPDATE mcp_account_tokens SET last_used_at = $2, updated_at = $2 WHERE token_id = $1`, tokenID, usedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return mcpgateway.ErrAccountTokenNotFound
	}
	return nil
}

func insertAccountToken(ctx context.Context, tx pgx.Tx, token mcpgateway.AccountToken) error {
	scopes, err := marshalStringSlice(token.Scopes)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO mcp_account_tokens (
	token_id, user_id, token_hash, token_ciphertext, fingerprint, status, expires_at, last_used_at,
	issuer, scopes, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		token.ID, token.UserID, token.TokenHash, token.TokenCiphertext, token.Fingerprint, token.Status,
		token.ExpiresAt, token.LastUsedAt, token.Issuer, scopes, token.CreatedAt, token.UpdatedAt)
	return err
}

func (s *MCPGatewayStore) GetAccountTokenByHash(ctx context.Context, tokenHash string) (mcpgateway.AccountToken, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.AccountToken{}, mcpgateway.ErrAccountTokenNotFound
	}
	row := s.pool.QueryRow(ctx, `
SELECT token_id, user_id, token_hash, token_ciphertext, fingerprint, status, expires_at, last_used_at,
	issuer, scopes, created_at, updated_at
FROM mcp_account_tokens
WHERE token_hash = $1`, tokenHash)
	token, err := scanAccountToken(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.AccountToken{}, mcpgateway.ErrAccountTokenNotFound
	}
	return token, err
}

func (s *MCPGatewayStore) GetActiveAccountToken(ctx context.Context, userID string) (mcpgateway.AccountToken, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.AccountToken{}, mcpgateway.ErrAccountTokenNotFound
	}
	row := s.pool.QueryRow(ctx, `
SELECT token_id, user_id, token_hash, token_ciphertext, fingerprint, status, expires_at, last_used_at,
	issuer, scopes, created_at, updated_at
FROM mcp_account_tokens
WHERE user_id = $1 AND status = $2
ORDER BY created_at DESC
LIMIT 1`, userID, mcpgateway.StatusActive)
	token, err := scanAccountToken(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.AccountToken{}, mcpgateway.ErrAccountTokenNotFound
	}
	return token, err
}

func (s *MCPGatewayStore) GetLatestAccountToken(ctx context.Context, userID string) (mcpgateway.AccountToken, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.AccountToken{}, mcpgateway.ErrAccountTokenNotFound
	}
	row := s.pool.QueryRow(ctx, `
SELECT token_id, user_id, token_hash, token_ciphertext, fingerprint, status, expires_at, last_used_at,
	issuer, scopes, created_at, updated_at
FROM mcp_account_tokens
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 1`, userID)
	token, err := scanAccountToken(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.AccountToken{}, mcpgateway.ErrAccountTokenNotFound
	}
	return token, err
}

func (s *MCPGatewayStore) SaveUpstreamServer(ctx context.Context, server mcpgateway.UpstreamServer) error {
	if s == nil || s.pool == nil {
		return nil
	}
	stdioConfig, err := marshalStdioConfig(server.Stdio)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if server.CreatedAt.IsZero() {
		server.CreatedAt = now
	}
	server.UpdatedAt = now
	_, err = s.pool.Exec(ctx, `
INSERT INTO mcp_upstream_servers (
	server_id, name, domain, transport, endpoint, stdio_config, auth_type, credential_ref, token_ciphertext,
		owner_team, namespace, routing_description, collector_id, status, created_at, updated_at, deleted_at
	) VALUES (
		$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
) ON CONFLICT (server_id) DO UPDATE SET
	name = EXCLUDED.name,
	domain = EXCLUDED.domain,
	transport = EXCLUDED.transport,
	endpoint = EXCLUDED.endpoint,
	stdio_config = EXCLUDED.stdio_config,
	auth_type = EXCLUDED.auth_type,
	credential_ref = EXCLUDED.credential_ref,
	token_ciphertext = EXCLUDED.token_ciphertext,
	owner_team = EXCLUDED.owner_team,
	namespace = EXCLUDED.namespace,
	routing_description = EXCLUDED.routing_description,
	collector_id = EXCLUDED.collector_id,
	status = EXCLUDED.status,
	updated_at = EXCLUDED.updated_at,
	deleted_at = EXCLUDED.deleted_at`,
		server.ID, server.Name, server.Domain, server.Transport, server.Endpoint, stdioConfig,
		server.AuthType, server.CredentialRef, server.TokenCiphertext, server.OwnerTeam,
		server.Namespace, server.RoutingDescription, server.CollectorID, server.Status, server.CreatedAt, server.UpdatedAt, server.DeletedAt,
	)
	return err
}

func (s *MCPGatewayStore) GetUpstreamServer(ctx context.Context, id string) (mcpgateway.UpstreamServer, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.UpstreamServer{}, mcpgateway.ErrUpstreamServerNotFound
	}
	row := s.pool.QueryRow(ctx, `
SELECT server_id, name, domain, transport, endpoint, stdio_config, auth_type, credential_ref, token_ciphertext,
	owner_team, namespace, routing_description, collector_id, status, created_at, updated_at, deleted_at
FROM mcp_upstream_servers WHERE server_id = $1 AND deleted_at IS NULL`, id)
	server, err := scanUpstreamServer(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.UpstreamServer{}, mcpgateway.ErrUpstreamServerNotFound
	}
	return server, err
}

func (s *MCPGatewayStore) ListUpstreamServers(ctx context.Context) ([]mcpgateway.UpstreamServer, error) {
	if s == nil || s.pool == nil {
		return []mcpgateway.UpstreamServer{}, nil
	}
	rows, err := s.pool.Query(ctx, `
SELECT server_id, name, domain, transport, endpoint, stdio_config, auth_type, credential_ref, token_ciphertext,
	owner_team, namespace, routing_description, collector_id, status, created_at, updated_at, deleted_at
FROM mcp_upstream_servers WHERE deleted_at IS NULL ORDER BY server_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mcpgateway.UpstreamServer
	for rows.Next() {
		server, err := scanUpstreamServer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, server)
	}
	return out, rows.Err()
}

func (s *MCPGatewayStore) DeleteUpstreamServer(ctx context.Context, id string) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrUpstreamServerNotFound
	}
	now := time.Now().UTC()
	tag, err := s.pool.Exec(ctx, `
UPDATE mcp_upstream_servers
SET status = $2, deleted_at = $3, updated_at = $3
WHERE server_id = $1 AND deleted_at IS NULL`,
		id, mcpgateway.StatusDisabled, now,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return mcpgateway.ErrUpstreamServerNotFound
	}
	return nil
}

func (s *MCPGatewayStore) SaveUpstreamSyncLog(ctx context.Context, log mcpgateway.UpstreamSyncLog) error {
	if s == nil || s.pool == nil {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
INSERT INTO mcp_upstream_sync_logs (
	sync_id, upstream_server_id, status, message, started_at, completed_at
) VALUES (
	$1, $2, $3, $4, $5, $6
)`,
		log.ID, log.UpstreamServerID, log.Status, log.Message, log.StartedAt, log.CompletedAt,
	)
	return err
}

func (s *MCPGatewayStore) GetLatestUpstreamSyncLog(ctx context.Context, serverID string) (mcpgateway.UpstreamSyncLog, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.UpstreamSyncLog{}, mcpgateway.ErrUpstreamServerNotFound
	}
	row := s.pool.QueryRow(ctx, `
SELECT sync_id, upstream_server_id, status, message, started_at, completed_at
FROM mcp_upstream_sync_logs
WHERE upstream_server_id = $1
ORDER BY completed_at DESC
LIMIT 1`, serverID)
	log, err := scanUpstreamSyncLog(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.UpstreamSyncLog{}, mcpgateway.ErrUpstreamServerNotFound
	}
	return log, err
}

func (s *MCPGatewayStore) SaveCapability(ctx context.Context, capability mcpgateway.Capability) error {
	if s == nil || s.pool == nil {
		return nil
	}
	inputSchema, err := marshalJSONMap(capability.InputSchema)
	if err != nil {
		return err
	}
	outputSchema, err := marshalJSONMap(capability.OutputSchema)
	if err != nil {
		return err
	}
	annotations, err := marshalJSONMap(capability.Annotations)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if capability.CreatedAt.IsZero() {
		capability.CreatedAt = now
	}
	capability.UpdatedAt = now
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())

	_, err = tx.Exec(ctx, `
DELETE FROM mcp_capabilities
WHERE exposed_name = $1 AND capability_id <> $2`,
		capability.ExposedName, capability.ID,
	)
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `
INSERT INTO mcp_capabilities (
	capability_id, upstream_server_id, capability_type, upstream_name, exposed_name,
	title, description, input_schema, output_schema, annotations, risk_level,
	read_only, destructive, idempotent, approval_required, confirm_required, confirm_template, status, schema_hash,
	version, last_synced_at, created_at, updated_at
) VALUES (
	$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
	$17, $18, $19, $20, $21, $22, $23
) ON CONFLICT (capability_id) DO UPDATE SET
	upstream_server_id = EXCLUDED.upstream_server_id,
	capability_type = EXCLUDED.capability_type,
	upstream_name = EXCLUDED.upstream_name,
	exposed_name = EXCLUDED.exposed_name,
	title = EXCLUDED.title,
	description = EXCLUDED.description,
	input_schema = EXCLUDED.input_schema,
	output_schema = EXCLUDED.output_schema,
	annotations = EXCLUDED.annotations,
	risk_level = EXCLUDED.risk_level,
	read_only = EXCLUDED.read_only,
	destructive = EXCLUDED.destructive,
	idempotent = EXCLUDED.idempotent,
	approval_required = EXCLUDED.approval_required,
	confirm_required = EXCLUDED.confirm_required,
	confirm_template = EXCLUDED.confirm_template,
	status = EXCLUDED.status,
	schema_hash = EXCLUDED.schema_hash,
	version = EXCLUDED.version,
	last_synced_at = EXCLUDED.last_synced_at,
	updated_at = EXCLUDED.updated_at`,
		capability.ID, capability.UpstreamServerID, capability.Type, capability.UpstreamName,
		capability.ExposedName, capability.Title, capability.Description, inputSchema, outputSchema,
		annotations, capability.RiskLevel, capability.ReadOnly, capability.Destructive,
		capability.Idempotent, capability.ApprovalRequired, capability.ConfirmRequired,
		capability.ConfirmTemplate, capability.Status, capability.SchemaHash, capability.Version,
		nullableTime(capability.LastSyncedAt), capability.CreatedAt, capability.UpdatedAt,
	)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *MCPGatewayStore) GetCapabilityByExposedName(ctx context.Context, exposedName string) (mcpgateway.Capability, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.Capability{}, mcpgateway.ErrCapabilityNotFound
	}
	row := s.pool.QueryRow(ctx, capabilitySelectSQL()+` WHERE exposed_name = $1`, exposedName)
	capability, err := scanCapability(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.Capability{}, mcpgateway.ErrCapabilityNotFound
	}
	return capability, err
}

func (s *MCPGatewayStore) ListCapabilities(ctx context.Context, filter mcpgateway.CapabilityFilter) ([]mcpgateway.Capability, error) {
	if s == nil || s.pool == nil {
		return []mcpgateway.Capability{}, nil
	}
	query := capabilitySelectSQL() + `
LEFT JOIN mcp_upstream_servers ON mcp_capabilities.upstream_server_id = mcp_upstream_servers.server_id
WHERE ($1 = '' OR capability_type = $1)
	AND ($2 = '' OR mcp_capabilities.status = $2)
	AND ($3 = '' OR upstream_server_id = $3)
	AND ($4 = '' OR mcp_upstream_servers.domain = $4)
	AND ($5 = '' OR risk_level = $5)
	AND ($6 = '' OR capability_id = $6)
	AND mcp_upstream_servers.deleted_at IS NULL
ORDER BY exposed_name ASC`
	rows, err := s.pool.Query(ctx, query, filter.Type, filter.Status, filter.UpstreamServerID, filter.Domain, filter.RiskLevel, filter.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mcpgateway.Capability
	for rows.Next() {
		capability, err := scanCapability(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, capability)
	}
	return out, rows.Err()
}

func (s *MCPGatewayStore) DeleteCapability(ctx context.Context, capabilityID string) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrCapabilityNotFound
	}
	tag, err := s.pool.Exec(ctx, `
DELETE FROM mcp_capabilities
WHERE capability_id = $1`, capabilityID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return mcpgateway.ErrCapabilityNotFound
	}
	return nil
}

func (s *MCPGatewayStore) SaveGrant(ctx context.Context, grant mcpgateway.AccountGrant) error {
	if s == nil || s.pool == nil {
		return nil
	}
	scope, err := marshalJSONMap(grant.DataScope)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if grant.CreatedAt.IsZero() {
		grant.CreatedAt = now
	}
	grant.UpdatedAt = now
	_, err = s.pool.Exec(ctx, `
INSERT INTO mcp_account_grants (
	grant_id, user_id, capability_id, grant_type, data_scope, expires_at,
	created_by, created_at, updated_at
) VALUES (
	$1, $2, $3, $4, $5, $6, $7, $8, $9
) ON CONFLICT (grant_id) DO UPDATE SET
	user_id = EXCLUDED.user_id,
	capability_id = EXCLUDED.capability_id,
	grant_type = EXCLUDED.grant_type,
	data_scope = EXCLUDED.data_scope,
	expires_at = EXCLUDED.expires_at,
	created_by = EXCLUDED.created_by,
	updated_at = EXCLUDED.updated_at`,
		grant.ID, grant.UserID, grant.CapabilityID, grant.GrantType, scope,
		grant.ExpiresAt, grant.CreatedBy, grant.CreatedAt, grant.UpdatedAt,
	)
	return normalizeGrantInsertError(err)
}

func normalizeGrantInsertError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return mcpgateway.ErrGrantAlreadyExists
	}
	return err
}

func (s *MCPGatewayStore) DeleteGrant(ctx context.Context, grantID string) error {
	if s == nil || s.pool == nil {
		return nil
	}
	tag, err := s.pool.Exec(ctx, `
DELETE FROM mcp_account_grants
WHERE grant_id = $1`, grantID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return mcpgateway.ErrGrantNotFound
	}
	return nil
}

func (s *MCPGatewayStore) ListGrants(ctx context.Context, filter mcpgateway.GrantFilter) ([]mcpgateway.AccountGrant, error) {
	if s == nil || s.pool == nil {
		return []mcpgateway.AccountGrant{}, nil
	}
	rows, err := s.pool.Query(ctx, `
SELECT grant_id, user_id, capability_id, grant_type, data_scope, expires_at, created_by, created_at, updated_at
FROM mcp_account_grants
WHERE ($1 = '' OR user_id = $1)
  AND ($2 = '' OR capability_id = $2)
  AND ($3 = '' OR grant_type = $3)
ORDER BY grant_id ASC`, filter.UserID, filter.CapabilityID, filter.GrantType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mcpgateway.AccountGrant
	for rows.Next() {
		grant, err := scanGrant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, grant)
	}
	return out, rows.Err()
}

func (s *MCPGatewayStore) SaveListAuditRecord(ctx context.Context, record mcpgateway.ListAuditRecord) error {
	if s == nil || s.pool == nil {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
	INSERT INTO mcp_list_audit_records (
		audit_id, trace_id, agent_id, user_id, actor_id, tenant_id, endpoint_type,
		endpoint_upstream_server_id, capability_type, decision, decision_reason,
		returned_count, filtered_count, created_at
	) VALUES (
		$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
	)`,
		record.ID, record.TraceID, record.AgentID, record.UserID, record.ActorID, record.TenantID,
		record.EndpointType, record.EndpointUpstreamServerID, record.CapabilityType, record.Decision, record.DecisionReason,
		record.ReturnedCount, record.FilteredCount, record.CreatedAt,
	)
	return err
}

func (s *MCPGatewayStore) SaveProxyAuditRecord(ctx context.Context, record mcpgateway.ProxyAuditRecord) error {
	if s == nil || s.pool == nil {
		return nil
	}
	requestHeaders, err := marshalJSONMap(record.RequestHeaders)
	if err != nil {
		return err
	}
	requestBody, err := marshalJSONMap(record.RequestBody)
	if err != nil {
		return err
	}
	responseHeaders, err := marshalJSONMap(record.ResponseHeaders)
	if err != nil {
		return err
	}
	responseBody, err := marshalJSONMap(record.ResponseBody)
	if err != nil {
		return err
	}
	resolvedDataScope, err := marshalJSONMap(record.ResolvedDataScope)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
	INSERT INTO mcp_proxy_audit_records (
		audit_id, trace_id, request_id, inbound_session_id, upstream_session_id,
		agent_id, user_id, actor_id, tenant_id, token_id, token_hash, endpoint_type,
		endpoint_upstream_server_id, upstream_server_id,
		capability_id, capability_type, exposed_name, upstream_name, request_headers,
		request_body, response_headers, response_body, resolved_data_scope, decision, decision_reason,
		error, duration_ms, created_at, completed_at
	) VALUES (
		$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
		$16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29
	)`,
		record.ID, record.TraceID, record.RequestID, record.InboundSessionID,
		record.UpstreamSessionID, record.AgentID, record.UserID, record.ActorID, record.TenantID,
		record.TokenID, record.TokenHash, record.EndpointType, record.EndpointUpstreamServerID,
		record.UpstreamServerID, record.CapabilityID,
		record.CapabilityType, record.ExposedName, record.UpstreamName, requestHeaders,
		requestBody, responseHeaders, responseBody, resolvedDataScope, record.Decision, record.DecisionReason,
		record.Error, record.DurationMS, record.CreatedAt, record.CompletedAt,
	)
	return err
}

func (s *MCPGatewayStore) ListProxyAuditRecords(ctx context.Context, filter mcpgateway.ProxyAuditFilter) ([]mcpgateway.ProxyAuditRecord, error) {
	if s == nil || s.pool == nil {
		return []mcpgateway.ProxyAuditRecord{}, nil
	}
	where := []string{
		"($2 = '' OR audit_id = $2)",
		"($3 = '' OR decision = $3)",
		"($4 = '' OR agent_id = $4)",
		"($5 = '' OR upstream_server_id = $5)",
		"($6 = '' OR exposed_name = $6 OR upstream_name = $6 OR capability_id = $6)",
		"($7::timestamptz IS NULL OR created_at >= $7)",
		"($8::timestamptz IS NULL OR created_at <= $8)",
		"($9 = FALSE OR error <> '')",
	}
	rows, err := s.pool.Query(ctx, `
	SELECT audit_id, trace_id, request_id, inbound_session_id, upstream_session_id,
		agent_id, user_id, actor_id, tenant_id, token_id, token_hash, endpoint_type,
		endpoint_upstream_server_id, upstream_server_id,
		capability_id, capability_type, exposed_name, upstream_name, request_headers,
	request_body, response_headers, response_body, resolved_data_scope, decision, decision_reason,
	error, duration_ms, created_at, completed_at
FROM mcp_proxy_audit_records
WHERE `+strings.Join(where, " AND ")+`
ORDER BY created_at DESC
LIMIT $1`, normalizeLimit(filter.Limit), filter.ID, filter.Decision, filter.AgentID, filter.UpstreamServerID,
		filter.Tool, nullableTime(filter.CreatedFrom), nullableTime(filter.CreatedTo), filter.ErrorOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mcpgateway.ProxyAuditRecord
	for rows.Next() {
		record, err := scanProxyAuditRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, rows.Err()
}

func (s *MCPGatewayStore) SaveGateRequest(ctx context.Context, gate mcpgateway.GateRequest) error {
	if s == nil || s.pool == nil {
		return nil
	}
	requestHeaders, err := marshalJSONMap(gate.RequestHeaders)
	if err != nil {
		return err
	}
	requestBody, err := marshalJSONMap(gate.RequestBody)
	if err != nil {
		return err
	}
	gateSummary, err := marshalGateSummary(gate.GateSummary)
	if err != nil {
		return err
	}
	responseHeaders, err := marshalJSONMap(gate.ResponseHeaders)
	if err != nil {
		return err
	}
	responseBody, err := marshalJSONMap(gate.ResponseBody)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if gate.CreatedAt.IsZero() {
		gate.CreatedAt = now
	}
	if gate.UpdatedAt.IsZero() {
		gate.UpdatedAt = now
	}
	_, err = s.pool.Exec(ctx, `
INSERT INTO mcp_gate_requests (
	gate_id, gate_type, gate_provider, trace_id, request_audit_id, execution_audit_id,
	tenant_id, agent_id, actor_id, token_id, token_hash, endpoint_type,
	endpoint_upstream_server_id, capability_id, capability_type,
		upstream_server_id, inbound_session_id, upstream_session_id, exposed_name, upstream_name,
		request_headers, request_body, arguments_hash, schema_hash, gate_summary, status,
		confirm_url, decided_by, decision_reason, decided_at, expires_at, response_headers,
		response_body, error, created_at, updated_at, completed_at, user_id
	) VALUES (
		$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
		$19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
		$37, $38
) ON CONFLICT (gate_id) DO UPDATE SET
	gate_type = EXCLUDED.gate_type,
	gate_provider = EXCLUDED.gate_provider,
	trace_id = EXCLUDED.trace_id,
	request_audit_id = EXCLUDED.request_audit_id,
	execution_audit_id = EXCLUDED.execution_audit_id,
	tenant_id = EXCLUDED.tenant_id,
	agent_id = EXCLUDED.agent_id,
	actor_id = EXCLUDED.actor_id,
	token_id = EXCLUDED.token_id,
	token_hash = EXCLUDED.token_hash,
	endpoint_type = EXCLUDED.endpoint_type,
	endpoint_upstream_server_id = EXCLUDED.endpoint_upstream_server_id,
	capability_id = EXCLUDED.capability_id,
	capability_type = EXCLUDED.capability_type,
	upstream_server_id = EXCLUDED.upstream_server_id,
	inbound_session_id = EXCLUDED.inbound_session_id,
	upstream_session_id = EXCLUDED.upstream_session_id,
	exposed_name = EXCLUDED.exposed_name,
	upstream_name = EXCLUDED.upstream_name,
	request_headers = EXCLUDED.request_headers,
	request_body = EXCLUDED.request_body,
	arguments_hash = EXCLUDED.arguments_hash,
	schema_hash = EXCLUDED.schema_hash,
	gate_summary = EXCLUDED.gate_summary,
	status = EXCLUDED.status,
	confirm_url = EXCLUDED.confirm_url,
	decided_by = EXCLUDED.decided_by,
	decision_reason = EXCLUDED.decision_reason,
	decided_at = EXCLUDED.decided_at,
		expires_at = EXCLUDED.expires_at,
		response_headers = EXCLUDED.response_headers,
		response_body = EXCLUDED.response_body,
		error = EXCLUDED.error,
		updated_at = EXCLUDED.updated_at,
		completed_at = EXCLUDED.completed_at,
		user_id = EXCLUDED.user_id`,
		gate.ID, gate.Type, gate.Provider, gate.TraceID, gate.RequestAuditID, gate.ExecutionAuditID,
		gate.TenantID, gate.AgentID, gate.ActorID, gate.TokenID, gate.TokenHash,
		gate.EndpointType, gate.EndpointUpstreamServerID, gate.CapabilityID,
		gate.CapabilityType, gate.UpstreamServerID, gate.InboundSessionID, gate.UpstreamSessionID,
		gate.ExposedName, gate.UpstreamName, requestHeaders, requestBody, gate.ArgumentsHash,
		gate.SchemaHash, gateSummary, gate.Status, gate.ConfirmURL, gate.DecidedBy,
		gate.DecisionReason, gate.DecidedAt, gate.ExpiresAt, responseHeaders, responseBody,
		gate.Error, gate.CreatedAt, gate.UpdatedAt, gate.CompletedAt, gate.UserID,
	)
	return err
}

func (s *MCPGatewayStore) GetGateRequest(ctx context.Context, id string) (mcpgateway.GateRequest, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.GateRequest{}, mcpgateway.ErrGateNotFound
	}
	row := s.pool.QueryRow(ctx, gateSelectSQL()+` WHERE gate_id = $1`, id)
	gate, err := scanGateRequest(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.GateRequest{}, mcpgateway.ErrGateNotFound
	}
	return gate, err
}

func (s *MCPGatewayStore) ListGateRequests(ctx context.Context, filter mcpgateway.GateFilter) ([]mcpgateway.GateRequest, error) {
	if s == nil || s.pool == nil {
		return []mcpgateway.GateRequest{}, nil
	}
	where := []string{
		"($2 = '' OR gate_type = $2)",
		"($3 = '' OR status = $3)",
		"($4 = '' OR agent_id = $4)",
		"($5 = '' OR actor_id = $5)",
		"($6 = '' OR tenant_id = $6)",
		"($7 = '' OR capability_id = $7)",
		"($8::timestamptz IS NULL OR created_at >= $8)",
		"($9::timestamptz IS NULL OR created_at <= $9)",
	}
	rows, err := s.pool.Query(ctx, gateSelectSQL()+`
WHERE `+strings.Join(where, " AND ")+`
ORDER BY created_at DESC
LIMIT $1`, normalizeLimit(filter.Limit), filter.Type, filter.Status, filter.AgentID,
		filter.ActorID, filter.TenantID, filter.CapabilityID, nullableTime(filter.CreatedFrom),
		nullableTime(filter.CreatedTo))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mcpgateway.GateRequest
	for rows.Next() {
		gate, err := scanGateRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, gate)
	}
	return out, rows.Err()
}

func (s *MCPGatewayStore) UpdateGateDecision(ctx context.Context, update mcpgateway.GateDecisionUpdate) (mcpgateway.GateRequest, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.GateRequest{}, mcpgateway.ErrGateNotFound
	}
	if update.UpdatedAt.IsZero() {
		update.UpdatedAt = time.Now().UTC()
	}
	if update.DecidedAt.IsZero() {
		update.DecidedAt = update.UpdatedAt
	}
	row := s.pool.QueryRow(ctx, `
UPDATE mcp_gate_requests
SET status = $3,
    decided_by = $4,
    decision_reason = $5,
    decided_at = $6,
    error = $7,
    updated_at = $8
WHERE gate_id = $1 AND status = $2
RETURNING gate_id, gate_type, gate_provider, trace_id, request_audit_id, execution_audit_id,
    tenant_id, agent_id, actor_id, token_id, token_hash, capability_id, capability_type,
	    upstream_server_id, inbound_session_id, upstream_session_id, exposed_name, upstream_name,
	    request_headers, request_body, arguments_hash, schema_hash, gate_summary, status,
	    confirm_url, decided_by, decision_reason, decided_at, expires_at, response_headers,
	    response_body, error, created_at, updated_at, completed_at, user_id`,
		update.ID, update.From, update.To, update.DecidedBy, update.Reason,
		update.DecidedAt, update.Error, update.UpdatedAt)
	gate, err := scanGateRequest(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.GateRequest{}, s.gateUpdateMissError(ctx, update.ID)
	}
	return gate, err
}

func (s *MCPGatewayStore) UpdateGateExecution(ctx context.Context, update mcpgateway.GateExecutionUpdate) (mcpgateway.GateRequest, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.GateRequest{}, mcpgateway.ErrGateNotFound
	}
	responseHeaders, err := marshalJSONMap(update.ResponseHeaders)
	if err != nil {
		return mcpgateway.GateRequest{}, err
	}
	responseBody, err := marshalJSONMap(update.ResponseBody)
	if err != nil {
		return mcpgateway.GateRequest{}, err
	}
	if update.UpdatedAt.IsZero() {
		update.UpdatedAt = time.Now().UTC()
	}
	var completedAt *time.Time
	if update.To == mcpgateway.GateCompleted || update.To == mcpgateway.GateFailed {
		if update.CompletedAt.IsZero() {
			update.CompletedAt = update.UpdatedAt
		}
		completedAt = &update.CompletedAt
	}
	row := s.pool.QueryRow(ctx, `
UPDATE mcp_gate_requests
SET status = $3,
	execution_audit_id = $4,
	response_headers = $5,
	response_body = $6,
	error = $7,
	updated_at = $8,
	completed_at = $9
WHERE gate_id = $1 AND status = $2
RETURNING gate_id, gate_type, gate_provider, trace_id, request_audit_id, execution_audit_id,
	tenant_id, agent_id, actor_id, token_id, token_hash, capability_id, capability_type,
		upstream_server_id, inbound_session_id, upstream_session_id, exposed_name, upstream_name,
		request_headers, request_body, arguments_hash, schema_hash, gate_summary, status,
		confirm_url, decided_by, decision_reason, decided_at, expires_at, response_headers,
		response_body, error, created_at, updated_at, completed_at, user_id`,
		update.ID, update.From, update.To, update.ExecutionAuditID, responseHeaders,
		responseBody, update.Error, update.UpdatedAt, completedAt)
	gate, err := scanGateRequest(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.GateRequest{}, s.gateUpdateMissError(ctx, update.ID)
	}
	return gate, err
}

func (s *MCPGatewayStore) gateUpdateMissError(ctx context.Context, id string) error {
	var exists bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mcp_gate_requests WHERE gate_id = $1)`, id).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return mcpgateway.ErrGateNotFound
	}
	return mcpgateway.ErrGateConflict
}

type rowScanner interface {
	Scan(dest ...any) error
}

func gateSelectSQL() string {
	return `SELECT gate_id, gate_type, gate_provider, trace_id, request_audit_id, execution_audit_id,
	tenant_id, agent_id, actor_id, token_id, token_hash, endpoint_type,
		endpoint_upstream_server_id, capability_id, capability_type,
		upstream_server_id, inbound_session_id, upstream_session_id, exposed_name, upstream_name,
		request_headers, request_body, arguments_hash, schema_hash, gate_summary, status,
		confirm_url, decided_by, decision_reason, decided_at, expires_at, response_headers,
		response_body, error, created_at, updated_at, completed_at, user_id FROM mcp_gate_requests`
}

func scanAgent(row rowScanner) (mcpgateway.AgentRegistration, error) {
	var agent mcpgateway.AgentRegistration
	err := row.Scan(&agent.AgentID, &agent.ClientID, &agent.Name, &agent.TenantID,
		&agent.ActorID, &agent.Status, &agent.CreationSource, &agent.CreatedAt, &agent.UpdatedAt)
	return agent, err
}

func scanAccountToken(row rowScanner) (mcpgateway.AccountToken, error) {
	var token mcpgateway.AccountToken
	var scopes []byte
	err := row.Scan(&token.ID, &token.UserID, &token.TokenHash, &token.TokenCiphertext, &token.Fingerprint,
		&token.Status, &token.ExpiresAt, &token.LastUsedAt, &token.Issuer, &scopes,
		&token.CreatedAt, &token.UpdatedAt)
	if err != nil {
		return mcpgateway.AccountToken{}, err
	}
	token.Scopes, err = unmarshalStringSlice(scopes)
	if err != nil {
		return mcpgateway.AccountToken{}, fmt.Errorf("decode token scopes: %w", err)
	}
	return token, nil
}

func scanUpstreamServer(row rowScanner) (mcpgateway.UpstreamServer, error) {
	var server mcpgateway.UpstreamServer
	var stdioConfig []byte
	err := row.Scan(&server.ID, &server.Name, &server.Domain, &server.Transport, &server.Endpoint, &stdioConfig,
		&server.AuthType, &server.CredentialRef, &server.TokenCiphertext, &server.OwnerTeam,
		&server.Namespace, &server.RoutingDescription, &server.CollectorID, &server.Status, &server.CreatedAt, &server.UpdatedAt, &server.DeletedAt)
	if err != nil {
		return mcpgateway.UpstreamServer{}, err
	}
	server.Stdio, err = unmarshalStdioConfig(stdioConfig)
	return server, err
}

func scanUpstreamSyncLog(row rowScanner) (mcpgateway.UpstreamSyncLog, error) {
	var log mcpgateway.UpstreamSyncLog
	err := row.Scan(&log.ID, &log.UpstreamServerID, &log.Status, &log.Message, &log.StartedAt, &log.CompletedAt)
	return log, err
}

func capabilitySelectSQL() string {
	return `SELECT mcp_capabilities.capability_id, mcp_capabilities.upstream_server_id, mcp_capabilities.capability_type,
	mcp_capabilities.upstream_name, mcp_capabilities.exposed_name, mcp_capabilities.title, mcp_capabilities.description,
	mcp_capabilities.input_schema, mcp_capabilities.output_schema, mcp_capabilities.annotations, mcp_capabilities.risk_level,
	mcp_capabilities.read_only, mcp_capabilities.destructive, mcp_capabilities.idempotent, mcp_capabilities.approval_required,
	mcp_capabilities.confirm_required, mcp_capabilities.confirm_template, mcp_capabilities.status, mcp_capabilities.schema_hash,
	mcp_capabilities.version, mcp_capabilities.last_synced_at,
	mcp_capabilities.created_at, mcp_capabilities.updated_at FROM mcp_capabilities`
}

func scanCapability(row rowScanner) (mcpgateway.Capability, error) {
	var capability mcpgateway.Capability
	var inputSchema, outputSchema, annotations []byte
	var lastSyncedAt *time.Time
	err := row.Scan(&capability.ID, &capability.UpstreamServerID, &capability.Type,
		&capability.UpstreamName, &capability.ExposedName, &capability.Title,
		&capability.Description, &inputSchema, &outputSchema, &annotations,
		&capability.RiskLevel, &capability.ReadOnly, &capability.Destructive,
		&capability.Idempotent, &capability.ApprovalRequired, &capability.ConfirmRequired,
		&capability.ConfirmTemplate, &capability.Status, &capability.SchemaHash, &capability.Version, &lastSyncedAt,
		&capability.CreatedAt, &capability.UpdatedAt)
	if err != nil {
		return mcpgateway.Capability{}, err
	}
	capability.InputSchema, err = unmarshalJSONMap(inputSchema)
	if err != nil {
		return mcpgateway.Capability{}, fmt.Errorf("decode input schema: %w", err)
	}
	capability.OutputSchema, err = unmarshalJSONMap(outputSchema)
	if err != nil {
		return mcpgateway.Capability{}, fmt.Errorf("decode output schema: %w", err)
	}
	capability.Annotations, err = unmarshalJSONMap(annotations)
	if err != nil {
		return mcpgateway.Capability{}, fmt.Errorf("decode annotations: %w", err)
	}
	if lastSyncedAt != nil {
		capability.LastSyncedAt = *lastSyncedAt
	}
	return capability, nil
}

func scanGrant(row rowScanner) (mcpgateway.AccountGrant, error) {
	var grant mcpgateway.AccountGrant
	var dataScope []byte
	err := row.Scan(&grant.ID, &grant.UserID, &grant.CapabilityID, &grant.GrantType,
		&dataScope, &grant.ExpiresAt, &grant.CreatedBy, &grant.CreatedAt, &grant.UpdatedAt)
	if err != nil {
		return mcpgateway.AccountGrant{}, err
	}
	grant.DataScope, err = unmarshalJSONMap(dataScope)
	if err != nil {
		return mcpgateway.AccountGrant{}, fmt.Errorf("decode data scope: %w", err)
	}
	return grant, nil
}

func scanProxyAuditRecord(row rowScanner) (mcpgateway.ProxyAuditRecord, error) {
	var record mcpgateway.ProxyAuditRecord
	var requestHeaders, requestBody, responseHeaders, responseBody, resolvedDataScope []byte
	err := row.Scan(&record.ID, &record.TraceID, &record.RequestID, &record.InboundSessionID,
		&record.UpstreamSessionID, &record.AgentID, &record.UserID, &record.ActorID, &record.TenantID,
		&record.TokenID, &record.TokenHash, &record.EndpointType, &record.EndpointUpstreamServerID,
		&record.UpstreamServerID, &record.CapabilityID,
		&record.CapabilityType, &record.ExposedName, &record.UpstreamName, &requestHeaders,
		&requestBody, &responseHeaders, &responseBody, &resolvedDataScope, &record.Decision, &record.DecisionReason,
		&record.Error, &record.DurationMS, &record.CreatedAt, &record.CompletedAt)
	if err != nil {
		return mcpgateway.ProxyAuditRecord{}, err
	}
	record.RequestHeaders, err = unmarshalJSONMap(requestHeaders)
	if err != nil {
		return mcpgateway.ProxyAuditRecord{}, fmt.Errorf("decode request headers: %w", err)
	}
	record.RequestBody, err = unmarshalJSONMap(requestBody)
	if err != nil {
		return mcpgateway.ProxyAuditRecord{}, fmt.Errorf("decode request body: %w", err)
	}
	record.ResponseHeaders, err = unmarshalJSONMap(responseHeaders)
	if err != nil {
		return mcpgateway.ProxyAuditRecord{}, fmt.Errorf("decode response headers: %w", err)
	}
	record.ResponseBody, err = unmarshalJSONMap(responseBody)
	if err != nil {
		return mcpgateway.ProxyAuditRecord{}, fmt.Errorf("decode response body: %w", err)
	}
	record.ResolvedDataScope, err = unmarshalJSONMap(resolvedDataScope)
	if err != nil {
		return mcpgateway.ProxyAuditRecord{}, fmt.Errorf("decode resolved data scope: %w", err)
	}
	return record, nil
}

func scanGateRequest(row rowScanner) (mcpgateway.GateRequest, error) {
	var gate mcpgateway.GateRequest
	var requestHeaders, requestBody, gateSummary, responseHeaders, responseBody []byte
	err := row.Scan(&gate.ID, &gate.Type, &gate.Provider, &gate.TraceID, &gate.RequestAuditID,
		&gate.ExecutionAuditID, &gate.TenantID, &gate.AgentID, &gate.ActorID, &gate.TokenID,
		&gate.TokenHash, &gate.EndpointType, &gate.EndpointUpstreamServerID,
		&gate.CapabilityID, &gate.CapabilityType, &gate.UpstreamServerID,
		&gate.InboundSessionID, &gate.UpstreamSessionID, &gate.ExposedName, &gate.UpstreamName,
		&requestHeaders, &requestBody, &gate.ArgumentsHash, &gate.SchemaHash, &gateSummary,
		&gate.Status, &gate.ConfirmURL, &gate.DecidedBy, &gate.DecisionReason, &gate.DecidedAt,
		&gate.ExpiresAt, &responseHeaders, &responseBody, &gate.Error, &gate.CreatedAt,
		&gate.UpdatedAt, &gate.CompletedAt, &gate.UserID)
	if err != nil {
		return mcpgateway.GateRequest{}, err
	}
	gate.RequestHeaders, err = unmarshalJSONMap(requestHeaders)
	if err != nil {
		return mcpgateway.GateRequest{}, fmt.Errorf("decode gate request headers: %w", err)
	}
	gate.RequestBody, err = unmarshalJSONMap(requestBody)
	if err != nil {
		return mcpgateway.GateRequest{}, fmt.Errorf("decode gate request body: %w", err)
	}
	gate.GateSummary, err = unmarshalGateSummary(gateSummary)
	if err != nil {
		return mcpgateway.GateRequest{}, fmt.Errorf("decode gate summary: %w", err)
	}
	gate.ResponseHeaders, err = unmarshalJSONMap(responseHeaders)
	if err != nil {
		return mcpgateway.GateRequest{}, fmt.Errorf("decode gate response headers: %w", err)
	}
	gate.ResponseBody, err = unmarshalJSONMap(responseBody)
	if err != nil {
		return mcpgateway.GateRequest{}, fmt.Errorf("decode gate response body: %w", err)
	}
	return gate, nil
}

func marshalJSONMap(value mcpgateway.JSONMap) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode json map: %w", err)
	}
	return raw, nil
}

func marshalGateSummary(value mcpgateway.GateSummary) ([]byte, error) {
	if value.System == "" && value.Action == "" && value.Object == "" && value.Tool == "" &&
		value.RiskLevel == "" && !value.Destructive && !value.ReadOnly &&
		len(value.Parameters) == 0 && len(value.Risks) == 0 {
		return nil, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode gate summary: %w", err)
	}
	return raw, nil
}

func marshalStringSlice(value []string) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode string slice: %w", err)
	}
	return raw, nil
}

func marshalStdioConfig(value mcpgateway.StdioConfig) ([]byte, error) {
	if value.Command == "" && len(value.Args) == 0 && value.CWD == "" && len(value.Env) == 0 {
		return nil, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode stdio config: %w", err)
	}
	return raw, nil
}

func unmarshalStringSlice(raw []byte) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode string slice: %w", err)
	}
	return out, nil
}

func unmarshalGateSummary(raw []byte) (mcpgateway.GateSummary, error) {
	if len(raw) == 0 {
		return mcpgateway.GateSummary{}, nil
	}
	var out mcpgateway.GateSummary
	if err := json.Unmarshal(raw, &out); err != nil {
		return mcpgateway.GateSummary{}, fmt.Errorf("decode gate summary: %w", err)
	}
	return out, nil
}

func unmarshalStdioConfig(raw []byte) (mcpgateway.StdioConfig, error) {
	if len(raw) == 0 {
		return mcpgateway.StdioConfig{}, nil
	}
	var out mcpgateway.StdioConfig
	if err := json.Unmarshal(raw, &out); err != nil {
		return mcpgateway.StdioConfig{}, fmt.Errorf("decode stdio config: %w", err)
	}
	return out, nil
}

func unmarshalJSONMap(raw []byte) (mcpgateway.JSONMap, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var out mcpgateway.JSONMap
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode json map: %w", err)
	}
	if out == nil {
		return nil, fmt.Errorf("decode json map: expected object")
	}
	return out, nil
}

func nullableTime(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	return &value
}

func normalizeLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}
