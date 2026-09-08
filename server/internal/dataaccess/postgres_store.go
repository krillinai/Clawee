package dataaccess

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func (s *PostgresStore) CreateGrants(ctx context.Context, grants []Grant, audit Audit) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT action FROM data_resource_grants
WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3
ORDER BY action FOR UPDATE`, audit.TargetUserID, audit.ResourceType, audit.ResourceID)
	if err != nil {
		return err
	}
	audit.BeforeActions = audit.BeforeActions[:0]
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			rows.Close()
			return err
		}
		audit.BeforeActions = append(audit.BeforeActions, action)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	audit.AfterActions = append(audit.BeforeActions[:len(audit.BeforeActions):len(audit.BeforeActions)], audit.AfterActions...)
	sort.Strings(audit.AfterActions)
	for _, grant := range grants {
		if _, err := tx.Exec(ctx, `INSERT INTO data_resource_grants
(grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, grant.GrantID, grant.UserID, grant.ResourceType, grant.ResourceID, grant.Action, grant.CreatedBy, grant.CreatedAt, grant.UpdatedAt); err != nil {
			return mapStoreError(err)
		}
	}
	if err := insertAudit(ctx, tx, audit); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) ReplaceGrants(ctx context.Context, userID, resourceType, resourceID string, grants []Grant, audit Audit) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT action FROM data_resource_grants
WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3
	ORDER BY action FOR UPDATE`, userID, resourceType, resourceID)
	if err != nil {
		return err
	}
	audit.BeforeActions = audit.BeforeActions[:0]
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			rows.Close()
			return err
		}
		audit.BeforeActions = append(audit.BeforeActions, action)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(audit.BeforeActions) == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx, `DELETE FROM data_resource_grants WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3`, userID, resourceType, resourceID); err != nil {
		return err
	}
	for _, grant := range grants {
		if _, err := tx.Exec(ctx, `INSERT INTO data_resource_grants
(grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, grant.GrantID, grant.UserID, grant.ResourceType, grant.ResourceID, grant.Action, grant.CreatedBy, grant.CreatedAt, grant.UpdatedAt); err != nil {
			return mapStoreError(err)
		}
	}
	if err := insertAudit(ctx, tx, audit); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) DeleteGrants(ctx context.Context, userID, resourceType, resourceID string, audit Audit) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT action FROM data_resource_grants WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3 ORDER BY action FOR UPDATE`, userID, resourceType, resourceID)
	if err != nil {
		return err
	}
	audit.BeforeActions = audit.BeforeActions[:0]
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			rows.Close()
			return err
		}
		audit.BeforeActions = append(audit.BeforeActions, action)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(audit.BeforeActions) == 0 {
		return ErrNotFound
	}
	tag, err := tx.Exec(ctx, `DELETE FROM data_resource_grants WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3`, userID, resourceType, resourceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := insertAudit(ctx, tx, audit); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) RecordAudit(ctx context.Context, audit Audit) error {
	return insertAudit(ctx, s.pool, audit)
}

func (s *PostgresStore) ListGrants(ctx context.Context, filter Filter) ([]Grant, error) {
	rows, err := s.pool.Query(ctx, `SELECT grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at
FROM data_resource_grants
WHERE ($1='' OR user_id=$1)
  AND ($2='' OR resource_type=$2)
  AND ($3='' OR resource_id=$3)
  AND ($4='' OR action=$4)
ORDER BY user_id,resource_id,action`, filter.UserID, filter.ResourceType, filter.ResourceID, filter.Action)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Grant{}
	for rows.Next() {
		var grant Grant
		if err := rows.Scan(&grant.GrantID, &grant.UserID, &grant.ResourceType, &grant.ResourceID, &grant.Action, &grant.CreatedBy, &grant.CreatedAt, &grant.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, grant)
	}
	return out, rows.Err()
}

type auditExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func insertAudit(ctx context.Context, executor auditExecutor, audit Audit) error {
	_, err := executor.Exec(ctx, `INSERT INTO data_resource_grant_audits
(audit_id,operator_user_id,target_user_id,resource_type,resource_id,before_actions,after_actions,result,request_id,created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, audit.AuditID, audit.OperatorID, audit.TargetUserID, audit.ResourceType,
		audit.ResourceID, audit.BeforeActions, audit.AfterActions, audit.Result, audit.RequestID, audit.CreatedAt)
	return err
}

func mapStoreError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23505":
			return ErrConflict
		case "23503":
			return ErrNotFound
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
