package rbac

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	pgxmock "github.com/pashagolub/pgxmock/v4"
)

func TestPostgresStoreReadsRolesBindingsAndAudits(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	mock := newRBACPGXMock(t)
	store := NewPostgresStore(mock)

	mock.ExpectExec(`INSERT INTO rbac_roles`).
		WithArgs(AdminRoleID, AdminRoleCode, AdminRoleName, now, now).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	if err := store.EnsureSystemRole(ctx, Role{RoleID: AdminRoleID, Code: AdminRoleCode, Name: AdminRoleName, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}

	listRows := roleRows(now).AddRow("role_reader", "reader", "只读", false, now, now, []string{PermissionAccountRead})
	mock.ExpectQuery(`(?s)SELECT r.role_id.*ORDER BY r.is_system DESC, r.code`).WillReturnRows(listRows)
	roles, err := store.ListRoles(ctx)
	if err != nil || len(roles) != 1 || roles[0].Code != "reader" {
		t.Fatalf("ListRoles = %#v, %v", roles, err)
	}

	mock.ExpectQuery(`(?s)SELECT r.role_id.*WHERE r.role_id = \$1.*GROUP BY`).
		WithArgs("role_reader").WillReturnRows(roleRows(now).AddRow("role_reader", "reader", "只读", false, now, now, []string{PermissionAccountRead}))
	if _, err := store.GetRole(ctx, "role_reader"); err != nil {
		t.Fatal(err)
	}
	mock.ExpectQuery(`(?s)SELECT r.role_id.*WHERE r.code = \$1.*GROUP BY`).
		WithArgs("reader").WillReturnRows(roleRows(now).AddRow("role_reader", "reader", "只读", false, now, now, []string{PermissionAccountRead}))
	if _, err := store.GetRoleByCode(ctx, "reader"); err != nil {
		t.Fatal(err)
	}

	mock.ExpectQuery(`SELECT ar.user_id, ar.role_id`).WithArgs("usr_1").WillReturnRows(
		pgxmock.NewRows([]string{"user_id", "role_id", "code", "name", "is_system", "created_at"}).
			AddRow("usr_1", "role_reader", "reader", "只读", false, now),
	)
	bindings, err := store.ListAccountRoles(ctx, "usr_1")
	if err != nil || len(bindings) != 1 || bindings[0].RoleCode != "reader" {
		t.Fatalf("ListAccountRoles = %#v, %v", bindings, err)
	}

	mock.ExpectQuery(`SELECT count\(\*\) FROM account_roles`).WithArgs("role_reader").WillReturnRows(
		pgxmock.NewRows([]string{"count"}).AddRow(2),
	)
	if count, err := store.CountRoleAccounts(ctx, "role_reader"); err != nil || count != 2 {
		t.Fatalf("CountRoleAccounts = %d, %v", count, err)
	}

	audit := testAudit(now)
	expectAudit(mock, audit)
	if err := store.RecordAudit(ctx, audit); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresStoreWritesRolesTransactionally(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	role := Role{RoleID: "role_operator", Code: "operator", Name: "运营员", Permissions: []string{PermissionAgentManage, PermissionCollectorManage}, CreatedAt: now, UpdatedAt: now}
	audit := testAudit(now)

	t.Run("create", func(t *testing.T) {
		mock := newRBACPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		mock.ExpectExec(`INSERT INTO rbac_roles`).WithArgs(role.RoleID, role.Code, role.Name, false, now, now).WillReturnResult(pgxmock.NewResult("INSERT", 1))
		expectPermissions(mock, role.RoleID, role.Permissions, now)
		expectAudit(mock, audit)
		mock.ExpectCommit()
		if err := store.CreateRole(ctx, role, audit); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("update", func(t *testing.T) {
		mock := newRBACPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		mock.ExpectExec(`UPDATE rbac_roles SET name`).WithArgs(role.RoleID, role.Name, now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
		expectPermissions(mock, role.RoleID, role.Permissions, now)
		expectAudit(mock, audit)
		mock.ExpectCommit()
		if err := store.UpdateRole(ctx, role, audit); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("delete", func(t *testing.T) {
		mock := newRBACPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		mock.ExpectExec(`DELETE FROM rbac_roles`).WithArgs(role.RoleID).WillReturnResult(pgxmock.NewResult("DELETE", 1))
		expectAudit(mock, audit)
		mock.ExpectCommit()
		if err := store.DeleteRole(ctx, role.RoleID, audit); err != nil {
			t.Fatal(err)
		}
	})
}

func TestPostgresStoreWritesAccountRoleBindingsTransactionally(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	binding := AccountRole{UserID: "usr_1", RoleID: "role_reader", CreatedAt: now}
	audit := testAudit(now)

	mock := newRBACPGXMock(t)
	store := NewPostgresStore(mock)
	mock.ExpectBegin()
	mock.ExpectExec(`INSERT INTO account_roles`).WithArgs(binding.UserID, binding.RoleID, now).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	expectAudit(mock, audit)
	mock.ExpectCommit()
	if err := store.AssignAccountRole(ctx, binding, audit); err != nil {
		t.Fatal(err)
	}

	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM account_roles`).WithArgs(binding.UserID, binding.RoleID).WillReturnResult(pgxmock.NewResult("DELETE", 1))
	expectAudit(mock, audit)
	mock.ExpectCommit()
	if err := store.RemoveAccountRole(ctx, binding.UserID, binding.RoleID, audit); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresStoreProtectsLastActiveAdminInRemovalTransaction(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	audit := testAudit(now)
	rejectedAudit := testAudit(now)
	rejectedAudit.AuditID = "audit_rejected"
	rejectedAudit.Action = AuditAccountRoleRemoveRejected

	t.Run("remove when another active admin exists", func(t *testing.T) {
		mock := newRBACPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		expectAdminGuardLock(mock)
		mock.ExpectQuery(`(?s)SELECT.*EXISTS.*count`).WithArgs("usr_1", AdminRoleID).WillReturnRows(
			pgxmock.NewRows([]string{"target_active", "active_admins"}).AddRow(true, 2),
		)
		mock.ExpectExec(`DELETE FROM account_roles`).WithArgs("usr_1", AdminRoleID).WillReturnResult(pgxmock.NewResult("DELETE", 1))
		expectAudit(mock, audit)
		mock.ExpectCommit()

		removed, err := store.RemoveAccountRoleProtected(ctx, "usr_1", AdminRoleID, audit, rejectedAudit)
		if err != nil || !removed {
			t.Fatalf("RemoveAccountRoleProtected = %v, %v; want true, nil", removed, err)
		}
	})

	t.Run("record rejection when target is last active admin", func(t *testing.T) {
		mock := newRBACPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		expectAdminGuardLock(mock)
		mock.ExpectQuery(`(?s)SELECT.*EXISTS.*count`).WithArgs("usr_1", AdminRoleID).WillReturnRows(
			pgxmock.NewRows([]string{"target_active", "active_admins"}).AddRow(true, 1),
		)
		expectAudit(mock, rejectedAudit)
		mock.ExpectCommit()

		removed, err := store.RemoveAccountRoleProtected(ctx, "usr_1", AdminRoleID, audit, rejectedAudit)
		if err != nil || removed {
			t.Fatalf("RemoveAccountRoleProtected = %v, %v; want false, nil", removed, err)
		}
	})
}

func TestPostgresStoreMapsConstraintErrors(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	role := Role{RoleID: "role_reader", Code: "reader", Name: "只读", CreatedAt: now, UpdatedAt: now}
	audit := testAudit(now)

	mock := newRBACPGXMock(t)
	store := NewPostgresStore(mock)
	mock.ExpectBegin()
	mock.ExpectExec(`INSERT INTO rbac_roles`).WithArgs(
		pgxmock.AnyArg(), pgxmock.AnyArg(), pgxmock.AnyArg(), pgxmock.AnyArg(), pgxmock.AnyArg(), pgxmock.AnyArg(),
	).WillReturnError(&pgconn.PgError{Code: "23505", ConstraintName: "rbac_roles_code_key"})
	mock.ExpectRollback()
	if err := store.CreateRole(ctx, role, audit); err != ErrRoleCodeExists {
		t.Fatalf("CreateRole error = %v", err)
	}

	mock.ExpectBegin()
	mock.ExpectExec(`DELETE FROM rbac_roles`).WithArgs(role.RoleID).WillReturnError(&pgconn.PgError{Code: "23503"})
	mock.ExpectRollback()
	if err := store.DeleteRole(ctx, role.RoleID, audit); err != ErrRoleInUse {
		t.Fatalf("DeleteRole error = %v", err)
	}
}

func newRBACPGXMock(t *testing.T) pgxmock.PgxPoolIface {
	t.Helper()
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Error(err)
		}
		mock.Close()
	})
	return mock
}

func roleRows(now time.Time) *pgxmock.Rows {
	return pgxmock.NewRows([]string{"role_id", "code", "name", "is_system", "created_at", "updated_at", "permissions"})
}

func testAudit(now time.Time) OperationAudit {
	return OperationAudit{
		AuditID: "audit_1", OperatorID: "usr_admin", Action: AuditRoleCreate,
		TargetType: "role", TargetID: "role_reader", Before: []byte("null"), After: []byte(`{"code":"reader"}`), CreatedAt: now,
	}
}

func expectPermissions(mock pgxmock.PgxPoolIface, roleID string, permissions []string, now time.Time) {
	mock.ExpectExec(`DELETE FROM role_permissions`).WithArgs(roleID).WillReturnResult(pgxmock.NewResult("DELETE", 1))
	for _, permission := range permissions {
		mock.ExpectExec(`INSERT INTO role_permissions`).WithArgs(roleID, permission, now).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	}
}

func expectAudit(mock pgxmock.PgxPoolIface, audit OperationAudit) {
	mock.ExpectExec(`INSERT INTO rbac_operation_audits`).WithArgs(
		audit.AuditID, audit.OperatorID, audit.Action, audit.TargetType, audit.TargetID,
		string(audit.Before), string(audit.After), audit.CreatedAt,
	).WillReturnResult(pgxmock.NewResult("INSERT", 1))
}

func expectAdminGuardLock(mock pgxmock.PgxPoolIface) {
	mock.ExpectExec(`INSERT INTO account_bootstrap_locks`).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectExec(`SELECT lock_id FROM account_bootstrap_locks`).WillReturnResult(pgxmock.NewResult("SELECT", 1))
}
