package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type ModelGroupStore struct {
	pool *pgxpool.Pool
}

func NewModelGroupStore(pool *pgxpool.Pool) *ModelGroupStore {
	return &ModelGroupStore{pool: pool}
}

func (s *ModelGroupStore) GetUserModelGroup(ctx context.Context, userID string) (mcpgateway.ModelGroup, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.ModelGroup{}, mcpgateway.ErrModelGroupNotFound
	}
	return scanModelGroup(s.pool.QueryRow(ctx, `
SELECT g.group_id, g.name, g.route_strategy, g.default_model, g.status, g.created_at, g.updated_at
FROM model_user_group_assignments a
JOIN model_upstream_groups g ON g.group_id = a.group_id
WHERE a.user_id = $1`, userID))
}

func (s *ModelGroupStore) EnsureUserModelGroup(ctx context.Context, userID string, now time.Time) (mcpgateway.ModelGroup, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.ModelGroup{}, mcpgateway.ErrModelGroupNotConfigured
	}
	if userID == "" {
		return mcpgateway.ModelGroup{}, errors.New("user id is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return mcpgateway.ModelGroup{}, err
	}
	defer tx.Rollback(ctx)

	group, err := scanModelGroup(tx.QueryRow(ctx, `
SELECT g.group_id, g.name, g.route_strategy, g.default_model, g.status, g.created_at, g.updated_at
FROM model_user_group_assignments a
JOIN model_upstream_groups g ON g.group_id = a.group_id
WHERE a.user_id = $1`, userID))
	if err == nil {
		return group, tx.Commit(ctx)
	}
	if !errors.Is(err, mcpgateway.ErrModelGroupNotFound) {
		return mcpgateway.ModelGroup{}, err
	}

	group, err = scanModelGroup(tx.QueryRow(ctx, `
SELECT group_id, name, route_strategy, default_model, status, created_at, updated_at
FROM model_upstream_groups
WHERE status = $1
ORDER BY random()
LIMIT 1`, mcpgateway.ModelGroupStatusActive))
	if errors.Is(err, mcpgateway.ErrModelGroupNotFound) {
		return mcpgateway.ModelGroup{}, mcpgateway.ErrModelGroupNotConfigured
	}
	if err != nil {
		return mcpgateway.ModelGroup{}, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO model_user_group_assignments (user_id, group_id, assigned_at, updated_at)
VALUES ($1, $2, $3, $3)
ON CONFLICT (user_id) DO NOTHING`, userID, group.ID, now); err != nil {
		return mcpgateway.ModelGroup{}, err
	}
	group, err = scanModelGroup(tx.QueryRow(ctx, `
SELECT g.group_id, g.name, g.route_strategy, g.default_model, g.status, g.created_at, g.updated_at
FROM model_user_group_assignments a
JOIN model_upstream_groups g ON g.group_id = a.group_id
WHERE a.user_id = $1`, userID))
	if err != nil {
		return mcpgateway.ModelGroup{}, err
	}
	return group, tx.Commit(ctx)
}

func (s *ModelGroupStore) ListModelUpstreamAccounts(ctx context.Context) ([]mcpgateway.ModelUpstreamAccount, error) {
	if s == nil || s.pool == nil {
		return nil, mcpgateway.ErrModelGroupNotConfigured
	}
	rows, err := s.pool.Query(ctx, `
SELECT upstream_account_id, name, base_url, api_key_ciphertext, models, synced_models, manual_models, model_sync_at, model_sync_error, status, health_status, created_at, updated_at
FROM model_upstream_accounts
ORDER BY name, upstream_account_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]mcpgateway.ModelUpstreamAccount, 0)
	for rows.Next() {
		item, err := scanModelUpstreamAccount(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *ModelGroupStore) GetModelUpstreamAccount(ctx context.Context, id string) (mcpgateway.ModelUpstreamAccount, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.ModelUpstreamAccount{}, mcpgateway.ErrModelGroupNotConfigured
	}
	return scanModelUpstreamAccount(s.pool.QueryRow(ctx, `
SELECT upstream_account_id, name, base_url, api_key_ciphertext, models, synced_models, manual_models, model_sync_at, model_sync_error, status, health_status, created_at, updated_at
FROM model_upstream_accounts
WHERE upstream_account_id = $1`, id))
}

func (s *ModelGroupStore) SaveModelUpstreamAccount(ctx context.Context, account mcpgateway.ModelUpstreamAccount) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrModelGroupNotConfigured
	}
	mcpgateway.NormalizeModelUpstreamAccount(&account)
	models, err := json.Marshal(account.Models)
	if err != nil {
		return err
	}
	syncedModels, err := json.Marshal(account.SyncedModels)
	if err != nil {
		return err
	}
	manualModels, err := json.Marshal(account.ManualModels)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
INSERT INTO model_upstream_accounts (
    upstream_account_id, name, base_url, api_key_ciphertext, models, synced_models, manual_models, model_sync_at, model_sync_error, status, health_status, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13)
ON CONFLICT (upstream_account_id) DO UPDATE SET
    name = EXCLUDED.name,
    base_url = EXCLUDED.base_url,
    api_key_ciphertext = EXCLUDED.api_key_ciphertext,
    models = EXCLUDED.models,
    synced_models = EXCLUDED.synced_models,
    manual_models = EXCLUDED.manual_models,
    model_sync_at = EXCLUDED.model_sync_at,
    model_sync_error = EXCLUDED.model_sync_error,
    status = EXCLUDED.status,
    health_status = EXCLUDED.health_status,
    updated_at = EXCLUDED.updated_at`,
		account.ID, account.Name, account.BaseURL, account.APIKeyCiphertext, models, syncedModels, manualModels,
		account.ModelSyncAt, account.ModelSyncError, account.Status, account.HealthStatus, account.CreatedAt, account.UpdatedAt)
	return err
}

func (s *ModelGroupStore) DeleteModelUpstreamAccount(ctx context.Context, id string) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrModelGroupNotConfigured
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM model_upstream_accounts WHERE upstream_account_id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return mcpgateway.ErrModelUpstreamAccountNotFound
	}
	return nil
}

func (s *ModelGroupStore) ListModelGroups(ctx context.Context) ([]mcpgateway.ModelGroupConfig, error) {
	if s == nil || s.pool == nil {
		return nil, mcpgateway.ErrModelGroupNotConfigured
	}
	rows, err := s.pool.Query(ctx, `SELECT group_id FROM model_upstream_groups ORDER BY name, group_id`)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	items := make([]mcpgateway.ModelGroupConfig, 0, len(ids))
	for _, id := range ids {
		item, err := s.GetModelGroup(ctx, id)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *ModelGroupStore) GetModelGroup(ctx context.Context, id string) (mcpgateway.ModelGroupConfig, error) {
	if s == nil || s.pool == nil {
		return mcpgateway.ModelGroupConfig{}, mcpgateway.ErrModelGroupNotConfigured
	}
	group, err := scanModelGroup(s.pool.QueryRow(ctx, `
SELECT group_id, name, route_strategy, default_model, status, created_at, updated_at
FROM model_upstream_groups
WHERE group_id = $1`, id))
	if err != nil {
		return mcpgateway.ModelGroupConfig{}, err
	}
	rows, err := s.pool.Query(ctx, `
SELECT a.upstream_account_id, a.name, a.base_url, a.models, a.status, a.health_status, g.priority, g.weight
FROM model_upstream_group_accounts g
JOIN model_upstream_accounts a ON a.upstream_account_id = g.upstream_account_id
WHERE g.group_id = $1
ORDER BY g.priority, a.name, a.upstream_account_id`, id)
	if err != nil {
		return mcpgateway.ModelGroupConfig{}, err
	}
	defer rows.Close()
	accounts := make([]mcpgateway.ModelGroupAccount, 0)
	for rows.Next() {
		var item mcpgateway.ModelGroupAccount
		var models []byte
		if err := rows.Scan(&item.UpstreamAccountID, &item.Name, &item.BaseURL, &models, &item.Status, &item.HealthStatus, &item.Priority, &item.Weight); err != nil {
			return mcpgateway.ModelGroupConfig{}, err
		}
		if len(models) != 0 {
			if err := json.Unmarshal(models, &item.Models); err != nil {
				return mcpgateway.ModelGroupConfig{}, err
			}
		}
		accounts = append(accounts, item)
	}
	if err := rows.Err(); err != nil {
		return mcpgateway.ModelGroupConfig{}, err
	}
	return mcpgateway.ModelGroupConfig{ModelGroup: group, Accounts: accounts}, nil
}

func (s *ModelGroupStore) SaveModelGroup(ctx context.Context, config mcpgateway.ModelGroupConfig) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrModelGroupNotConfigured
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `
INSERT INTO model_upstream_groups (group_id, name, route_strategy, default_model, status, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (group_id) DO UPDATE SET
    name = EXCLUDED.name,
    route_strategy = EXCLUDED.route_strategy,
    default_model = EXCLUDED.default_model,
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at`,
		config.ID, config.Name, config.RouteStrategy, config.DefaultModel, config.Status, config.CreatedAt, config.UpdatedAt)
	if err != nil {
		return err
	}
	if err := setModelGroupAccountsTx(ctx, tx, config.ID, config.Accounts); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *ModelGroupStore) DeleteModelGroup(ctx context.Context, id string) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrModelGroupNotConfigured
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM model_upstream_groups WHERE group_id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return mcpgateway.ErrModelGroupNotFound
	}
	return nil
}

func (s *ModelGroupStore) SetModelGroupAccounts(ctx context.Context, groupID string, accounts []mcpgateway.ModelGroupAccount) error {
	if s == nil || s.pool == nil {
		return mcpgateway.ErrModelGroupNotConfigured
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := setModelGroupAccountsTx(ctx, tx, groupID, accounts); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func setModelGroupAccountsTx(ctx context.Context, tx pgx.Tx, groupID string, accounts []mcpgateway.ModelGroupAccount) error {
	var existingID string
	if err := tx.QueryRow(ctx, `SELECT group_id FROM model_upstream_groups WHERE group_id = $1`, groupID).Scan(&existingID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return mcpgateway.ErrModelGroupNotFound
		}
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM model_upstream_group_accounts WHERE group_id = $1`, groupID); err != nil {
		return err
	}
	for _, account := range accounts {
		if _, err := tx.Exec(ctx, `
INSERT INTO model_upstream_group_accounts (group_id, upstream_account_id, priority, weight, created_at)
VALUES ($1, $2, $3, $4, $5)`, groupID, account.UpstreamAccountID, account.Priority, account.Weight, time.Now().UTC()); err != nil {
			return err
		}
	}
	return nil
}

type modelGroupRow interface {
	Scan(...any) error
}

func scanModelGroup(row modelGroupRow) (mcpgateway.ModelGroup, error) {
	var group mcpgateway.ModelGroup
	err := row.Scan(&group.ID, &group.Name, &group.RouteStrategy, &group.DefaultModel, &group.Status, &group.CreatedAt, &group.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.ModelGroup{}, mcpgateway.ErrModelGroupNotFound
	}
	return group, err
}

func scanModelUpstreamAccount(row modelGroupRow) (mcpgateway.ModelUpstreamAccount, error) {
	var account mcpgateway.ModelUpstreamAccount
	var models, syncedModels, manualModels []byte
	err := row.Scan(&account.ID, &account.Name, &account.BaseURL, &account.APIKeyCiphertext, &models, &syncedModels, &manualModels, &account.ModelSyncAt, &account.ModelSyncError, &account.Status, &account.HealthStatus, &account.CreatedAt, &account.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpgateway.ModelUpstreamAccount{}, mcpgateway.ErrModelUpstreamAccountNotFound
	}
	if err != nil {
		return mcpgateway.ModelUpstreamAccount{}, err
	}
	if len(models) != 0 {
		if err := json.Unmarshal(models, &account.Models); err != nil {
			return mcpgateway.ModelUpstreamAccount{}, err
		}
	}
	if len(syncedModels) != 0 {
		if err := json.Unmarshal(syncedModels, &account.SyncedModels); err != nil {
			return mcpgateway.ModelUpstreamAccount{}, err
		}
	}
	if len(manualModels) != 0 {
		if err := json.Unmarshal(manualModels, &account.ManualModels); err != nil {
			return mcpgateway.ModelUpstreamAccount{}, err
		}
	}
	mcpgateway.NormalizeModelUpstreamAccount(&account)
	return account, nil
}
