package rbac

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrPostgresStoreUnavailable = errors.New("postgres rbac store is unavailable")

type PostgresStore struct {
	pool postgresPool
}

type postgresPool interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Begin(context.Context) (pgx.Tx, error)
}

func NewPostgresStore(pool postgresPool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

func (s *PostgresStore) EnsureSystemRole(ctx context.Context, role Role) error {
	if s == nil || s.pool == nil {
		return ErrPostgresStoreUnavailable
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO rbac_roles (role_id, code, name, is_system, created_at, updated_at)
		VALUES ($1, $2, $3, TRUE, $4, $5)
		ON CONFLICT (role_id) DO UPDATE SET
			code = EXCLUDED.code,
			name = EXCLUDED.name,
			is_system = TRUE,
			updated_at = EXCLUDED.updated_at
	`, role.RoleID, role.Code, role.Name, role.CreatedAt, role.UpdatedAt)
	return err
}

func (s *PostgresStore) HasActiveAdmin(ctx context.Context) (bool, error) {
	if s == nil || s.pool == nil {
		return false, ErrPostgresStoreUnavailable
	}
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM accounts a
			JOIN account_roles ar ON ar.user_id = a.user_id
			JOIN rbac_roles r ON r.role_id = ar.role_id
			WHERE a.status = 'active' AND r.code = 'admin'
		)
	`).Scan(&exists)
	return exists, err
}

func (s *PostgresStore) ListRoles(ctx context.Context) ([]Role, error) {
	if s == nil || s.pool == nil {
		return nil, ErrPostgresStoreUnavailable
	}
	rows, err := s.pool.Query(ctx, roleSelectSQL+roleGroupSQL+` ORDER BY r.is_system DESC, r.code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		role, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

func (s *PostgresStore) GetRole(ctx context.Context, roleID string) (Role, error) {
	return s.getRole(ctx, `WHERE r.role_id = $1`, roleID)
}

func (s *PostgresStore) GetRoleByCode(ctx context.Context, code string) (Role, error) {
	return s.getRole(ctx, `WHERE r.code = $1`, code)
}

func (s *PostgresStore) getRole(ctx context.Context, where string, value string) (Role, error) {
	if s == nil || s.pool == nil {
		return Role{}, ErrPostgresStoreUnavailable
	}
	role, err := scanRole(s.pool.QueryRow(ctx, roleSelectSQL+" "+where+roleGroupSQL, value))
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, ErrRoleNotFound
	}
	return role, err
}

func (s *PostgresStore) CreateRole(ctx context.Context, role Role, audit OperationAudit) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO rbac_roles (role_id, code, name, is_system, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, role.RoleID, role.Code, role.Name, role.System, role.CreatedAt, role.UpdatedAt)
		if isUniqueViolation(err, "rbac_roles_code_key") {
			return ErrRoleCodeExists
		}
		if err != nil {
			return err
		}
		if err := replacePermissions(ctx, tx, role.RoleID, role.Permissions, role.CreatedAt); err != nil {
			return err
		}
		return insertAudit(ctx, tx, audit)
	})
}

func (s *PostgresStore) UpdateRole(ctx context.Context, role Role, audit OperationAudit) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE rbac_roles SET name = $2, updated_at = $3 WHERE role_id = $1`, role.RoleID, role.Name, role.UpdatedAt)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrRoleNotFound
		}
		if err := replacePermissions(ctx, tx, role.RoleID, role.Permissions, role.UpdatedAt); err != nil {
			return err
		}
		return insertAudit(ctx, tx, audit)
	})
}

func (s *PostgresStore) DeleteRole(ctx context.Context, roleID string, audit OperationAudit) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM rbac_roles WHERE role_id = $1`, roleID)
		if isForeignKeyViolation(err) {
			return ErrRoleInUse
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrRoleNotFound
		}
		return insertAudit(ctx, tx, audit)
	})
}

func (s *PostgresStore) ListAccountRoles(ctx context.Context, userID string) ([]AccountRole, error) {
	if s == nil || s.pool == nil {
		return nil, ErrPostgresStoreUnavailable
	}
	rows, err := s.pool.Query(ctx, `
		SELECT ar.user_id, ar.role_id, r.code, r.name, r.is_system, ar.created_at
		FROM account_roles ar
		JOIN rbac_roles r ON r.role_id = ar.role_id
		WHERE ar.user_id = $1
		ORDER BY r.code
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []AccountRole
	for rows.Next() {
		var role AccountRole
		if err := rows.Scan(&role.UserID, &role.RoleID, &role.RoleCode, &role.RoleName, &role.System, &role.CreatedAt); err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

func (s *PostgresStore) AssignAccountRole(ctx context.Context, binding AccountRole, audit OperationAudit) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO account_roles (user_id, role_id, created_at)
			VALUES ($1, $2, $3)
		`, binding.UserID, binding.RoleID, binding.CreatedAt)
		if isUniqueViolation(err, "account_roles_pkey") {
			return ErrAccountRoleExists
		}
		if err != nil {
			return err
		}
		return insertAudit(ctx, tx, audit)
	})
}

func (s *PostgresStore) RemoveAccountRole(ctx context.Context, userID, roleID string, audit OperationAudit) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM account_roles WHERE user_id = $1 AND role_id = $2`, userID, roleID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrAccountRoleNotFound
		}
		return insertAudit(ctx, tx, audit)
	})
}

func (s *PostgresStore) RemoveAccountRoleProtected(ctx context.Context, userID, roleID string, audit, rejectedAudit OperationAudit) (bool, error) {
	removed := false
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO account_bootstrap_locks (lock_id) VALUES ('first_admin') ON CONFLICT DO NOTHING`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT lock_id FROM account_bootstrap_locks WHERE lock_id = 'first_admin' FOR UPDATE`); err != nil {
			return err
		}
		var targetActive bool
		var activeAdmins int
		if err := tx.QueryRow(ctx, `
			SELECT
				EXISTS (
					SELECT 1 FROM accounts a
					JOIN account_roles ar ON ar.user_id = a.user_id
					WHERE a.user_id = $1 AND a.status = 'active' AND ar.role_id = $2
				),
				(
					SELECT count(*) FROM accounts a
					JOIN account_roles ar ON ar.user_id = a.user_id
					WHERE a.status = 'active' AND ar.role_id = $2
				)
		`, userID, roleID).Scan(&targetActive, &activeAdmins); err != nil {
			return err
		}
		if targetActive && activeAdmins <= 1 {
			return insertAudit(ctx, tx, rejectedAudit)
		}
		tag, err := tx.Exec(ctx, `DELETE FROM account_roles WHERE user_id = $1 AND role_id = $2`, userID, roleID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrAccountRoleNotFound
		}
		if err := insertAudit(ctx, tx, audit); err != nil {
			return err
		}
		removed = true
		return nil
	})
	return removed, err
}

func (s *PostgresStore) CountRoleAccounts(ctx context.Context, roleID string) (int, error) {
	if s == nil || s.pool == nil {
		return 0, ErrPostgresStoreUnavailable
	}
	var count int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM account_roles WHERE role_id = $1`, roleID).Scan(&count)
	return count, err
}

func (s *PostgresStore) RecordAudit(ctx context.Context, audit OperationAudit) error {
	if s == nil || s.pool == nil {
		return ErrPostgresStoreUnavailable
	}
	return insertAudit(ctx, s.pool, audit)
}

func (s *PostgresStore) withTx(ctx context.Context, fn func(pgx.Tx) error) error {
	if s == nil || s.pool == nil {
		return ErrPostgresStoreUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const roleSelectSQL = `
	SELECT r.role_id, r.code, r.name, r.is_system, r.created_at, r.updated_at,
		COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code)
			FILTER (WHERE rp.permission_code IS NOT NULL), ARRAY[]::TEXT[])
	FROM rbac_roles r
	LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
`

const roleGroupSQL = `
	GROUP BY r.role_id, r.code, r.name, r.is_system, r.created_at, r.updated_at
`

type rowScanner interface {
	Scan(...any) error
}

func scanRole(row rowScanner) (Role, error) {
	var role Role
	err := row.Scan(&role.RoleID, &role.Code, &role.Name, &role.System, &role.CreatedAt, &role.UpdatedAt, &role.Permissions)
	return role, err
}

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func replacePermissions(ctx context.Context, tx pgx.Tx, roleID string, permissions []string, createdAt time.Time) error {
	if _, err := tx.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, roleID); err != nil {
		return err
	}
	for _, permission := range permissions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO role_permissions (role_id, permission_code, created_at)
			VALUES ($1, $2, $3)
		`, roleID, permission, createdAt); err != nil {
			return err
		}
	}
	return nil
}

func insertAudit(ctx context.Context, runner execer, audit OperationAudit) error {
	_, err := runner.Exec(ctx, `
		INSERT INTO rbac_operation_audits (
			audit_id, operator_user_id, action, target_type, target_id,
			before_snapshot, after_snapshot, created_at
		) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
	`, audit.AuditID, audit.OperatorID, audit.Action, audit.TargetType, audit.TargetID, string(audit.Before), string(audit.After), audit.CreatedAt)
	return err
}

func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}
