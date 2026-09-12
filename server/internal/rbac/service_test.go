package rbac

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
)

func TestServiceRejectsUnknownPermissionCode(t *testing.T) {
	service, _, _ := newTestService(t)

	_, err := service.CreateRole(context.Background(), "usr_admin", CreateRoleInput{
		Code:        "auditor",
		Name:        "审计员",
		Permissions: []string{"console:unknown:read"},
	})
	if !errors.Is(err, ErrInvalidPermission) {
		t.Fatalf("CreateRole error = %v, want ErrInvalidPermission", err)
	}
}

func TestServiceCombinesRolesAndExpandsManagePermission(t *testing.T) {
	service, _, accountService := newTestService(t)
	ctx := context.Background()
	account := createAccount(t, accountService, "operator@example.com")

	agentRole, err := service.CreateRole(ctx, "usr_admin", CreateRoleInput{
		Code:        "agent_operator",
		Name:        "Agent 运营员",
		Permissions: []string{PermissionAgentManage},
	})
	if err != nil {
		t.Fatal(err)
	}
	auditRole, err := service.CreateRole(ctx, "usr_admin", CreateRoleInput{
		Code:        "security_auditor",
		Name:        "安全审计员",
		Permissions: []string{PermissionMCPAuditRead, PermissionActivityRead},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.AssignAccountRole(ctx, "usr_admin", account.UserID, agentRole.RoleID); err != nil {
		t.Fatal(err)
	}
	if err := service.AssignAccountRole(ctx, "usr_admin", account.UserID, auditRole.RoleID); err != nil {
		t.Fatal(err)
	}

	permissions, err := service.ListEffectivePermissions(ctx, account.UserID)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{PermissionActivityRead, PermissionMCPAuditRead}
	for _, permission := range PermissionCatalog() {
		if permission.Module == "agent" {
			want = append(want, permission.Code)
		}
	}
	sort.Strings(want)
	assertStringsEqual(t, permissions, want)

	allowed, err := service.HasPermission(ctx, account.UserID, PermissionAgentRead)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("manage permission did not include read permission")
	}
	allowed, err = service.HasPermission(ctx, account.UserID, PermissionAgentTokenRotate)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("manage permission did not include action permission")
	}
}

func TestServiceActionPermissionDoesNotGrantSiblingActions(t *testing.T) {
	service, _, accountService := newTestService(t)
	ctx := context.Background()
	account := createAccount(t, accountService, "token-operator@example.com")
	role, err := service.CreateRole(ctx, "usr_admin", CreateRoleInput{
		Code:        "token_rotator",
		Name:        "Token 轮换员",
		Permissions: []string{PermissionAgentTokenRotate},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.AssignAccountRole(ctx, "usr_admin", account.UserID, role.RoleID); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		permission string
		want       bool
	}{
		{PermissionAgentTokenRotate, true},
		{PermissionAgentTokenReveal, false},
		{PermissionAgentTokenRevoke, false},
		{PermissionAgentRead, false},
	} {
		allowed, err := service.HasPermission(ctx, account.UserID, test.permission)
		if err != nil {
			t.Fatal(err)
		}
		if allowed != test.want {
			t.Fatalf("HasPermission(%q) = %v, want %v", test.permission, allowed, test.want)
		}
	}
}

func TestSharedFilesManageDoesNotGrantStorageGovernance(t *testing.T) {
	service, _, accountService := newTestService(t)
	ctx := context.Background()
	account := createAccount(t, accountService, "shared-files-manager@example.com")
	role, err := service.CreateRole(ctx, "usr_admin", CreateRoleInput{
		Code: "shared_files_manager", Name: "网盘管理员", Permissions: []string{PermissionSharedFilesManage},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.AssignAccountRole(ctx, "usr_admin", account.UserID, role.RoleID); err != nil {
		t.Fatal(err)
	}
	for _, permission := range []string{PermissionSharedFilesStorageRead, PermissionSharedFilesStorageManage, PermissionSharedFilesStorageMigrate} {
		allowed, err := service.HasPermission(ctx, account.UserID, permission)
		if err != nil {
			t.Fatal(err)
		}
		if allowed {
			t.Fatalf("旧网盘管理权限不应自动授予 %q", permission)
		}
	}
}

func TestAdminRoleAlwaysExpandsToCurrentCatalog(t *testing.T) {
	service, _, accountService := newTestService(t)
	ctx := context.Background()
	admin := createAccount(t, accountService, "admin@example.com")
	if err := service.BootstrapAdmin(ctx, admin.UserID); err != nil {
		t.Fatal(err)
	}

	permissions, err := service.ListEffectivePermissions(ctx, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(permissions) != len(PermissionCatalog()) {
		t.Fatalf("permission count = %d, want %d", len(permissions), len(PermissionCatalog()))
	}
	for _, permission := range PermissionCatalog() {
		allowed, err := service.HasPermission(ctx, admin.UserID, permission.Code)
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Fatalf("admin missing permission %q", permission.Code)
		}
	}
}

func TestRollbackBootstrapAdminIsIdempotentAndBypassesLastAdminProtection(t *testing.T) {
	service, _, accountService := newTestService(t)
	ctx := context.Background()
	admin := createAccount(t, accountService, "rollback-admin@example.com")
	if err := service.BootstrapAdmin(ctx, admin.UserID); err != nil {
		t.Fatal(err)
	}

	if err := service.RollbackBootstrapAdmin(ctx, admin.UserID); err != nil {
		t.Fatalf("RollbackBootstrapAdmin() error = %v", err)
	}
	roles, err := service.ListEffectiveRoles(ctx, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(roles) != 0 {
		t.Fatalf("roles after rollback = %#v, want none", roles)
	}
	if err := service.RollbackBootstrapAdmin(ctx, admin.UserID); err != nil {
		t.Fatalf("repeated RollbackBootstrapAdmin() error = %v", err)
	}
}

func TestSystemRoleCannotBeChangedAndRejectedAttemptIsAudited(t *testing.T) {
	service, store, _ := newTestService(t)
	ctx := context.Background()
	adminRole, err := service.RoleByCode(ctx, AdminRoleCode)
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.UpdateRole(ctx, "usr_admin", UpdateRoleInput{
		RoleID:      adminRole.RoleID,
		Name:        "另一个名称",
		Permissions: []string{PermissionAccountRead},
	})
	if !errors.Is(err, ErrSystemRoleImmutable) {
		t.Fatalf("UpdateRole error = %v, want ErrSystemRoleImmutable", err)
	}
	audits := store.Audits()
	if len(audits) != 1 || audits[0].Action != AuditRoleUpdateRejected {
		t.Fatalf("audits = %#v, want one rejected update audit", audits)
	}
}

func TestPermissionCatalogDoesNotContainStandaloneOverviewPermission(t *testing.T) {
	for _, permission := range PermissionCatalog() {
		if permission.Code == "console:overview:read" {
			t.Fatalf("permission catalog still contains %q", permission.Code)
		}
	}
}

func TestBoundCustomRoleCannotBeDeleted(t *testing.T) {
	service, _, accountService := newTestService(t)
	ctx := context.Background()
	account := createAccount(t, accountService, "user@example.com")
	role, err := service.CreateRole(ctx, "usr_admin", CreateRoleInput{
		Code:        "reader",
		Name:        "只读角色",
		Permissions: []string{PermissionAccountRead},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.AssignAccountRole(ctx, "usr_admin", account.UserID, role.RoleID); err != nil {
		t.Fatal(err)
	}

	err = service.DeleteRole(ctx, "usr_admin", role.RoleID)
	if !errors.Is(err, ErrRoleInUse) {
		t.Fatalf("DeleteRole error = %v, want ErrRoleInUse", err)
	}
}

func TestLastActiveAdminCannotBeRemovedOrDisabled(t *testing.T) {
	service, store, accountService := newTestService(t)
	ctx := context.Background()
	admin := createAccount(t, accountService, "admin@example.com")
	if err := service.BootstrapAdmin(ctx, admin.UserID); err != nil {
		t.Fatal(err)
	}
	adminRole, err := service.RoleByCode(ctx, AdminRoleCode)
	if err != nil {
		t.Fatal(err)
	}

	err = service.RemoveAccountRole(ctx, admin.UserID, admin.UserID, adminRole.RoleID)
	if !errors.Is(err, ErrLastActiveAdmin) {
		t.Fatalf("RemoveAccountRole error = %v, want ErrLastActiveAdmin", err)
	}
	_, err = accountService.UpdateAccountStatusWithValidation(ctx, admin.UserID, accounts.StatusDisabled, func(lockedCtx context.Context) error {
		return service.ValidateAccountDeactivation(lockedCtx, admin.UserID, admin.UserID)
	})
	if !errors.Is(err, ErrLastActiveAdmin) {
		t.Fatalf("UpdateAccountStatusWithValidation error = %v, want ErrLastActiveAdmin", err)
	}

	audits := store.Audits()
	if len(audits) < 2 {
		t.Fatalf("audit count = %d, want rejected removal and deactivation audits", len(audits))
	}
	if audits[len(audits)-2].Action != AuditAccountRoleRemoveRejected {
		t.Fatalf("remove audit action = %q", audits[len(audits)-2].Action)
	}
	if audits[len(audits)-1].Action != AuditLastAdminProtection {
		t.Fatalf("deactivate audit action = %q", audits[len(audits)-1].Action)
	}
}

func TestRoleLifecycleQueriesAndNonAdminRemoval(t *testing.T) {
	service, _, accountService := newTestService(t)
	ctx := context.Background()
	account := createAccount(t, accountService, "reader@example.com")
	role, err := service.CreateRole(ctx, "usr_admin", CreateRoleInput{
		Code: "reader", Name: "只读角色", Permissions: []string{PermissionAccountRead},
	})
	if err != nil {
		t.Fatal(err)
	}

	roles, err := service.ListRoles(ctx)
	if err != nil || len(roles) != 2 || roles[0].Code != AdminRoleCode {
		t.Fatalf("ListRoles = %#v, %v", roles, err)
	}
	got, err := service.GetRole(ctx, role.RoleID)
	if err != nil || got.Code != role.Code {
		t.Fatalf("GetRole = %#v, %v", got, err)
	}
	updated, err := service.UpdateRole(ctx, "usr_admin", UpdateRoleInput{
		RoleID: role.RoleID, Name: "账号查看员", Permissions: []string{PermissionAccountManage},
	})
	if err != nil || updated.Name != "账号查看员" {
		t.Fatalf("UpdateRole = %#v, %v", updated, err)
	}
	if err := service.AssignAccountRole(ctx, "usr_admin", account.UserID, role.RoleID); err != nil {
		t.Fatal(err)
	}
	if allowed, err := service.HasAnyPermission(ctx, account.UserID); err != nil || !allowed {
		t.Fatalf("HasAnyPermission = %v, %v", allowed, err)
	}
	effectiveRoles, err := service.ListEffectiveRoles(ctx, account.UserID)
	if err != nil || len(effectiveRoles) != 1 || effectiveRoles[0] != "reader" {
		t.Fatalf("ListEffectiveRoles = %#v, %v", effectiveRoles, err)
	}
	if err := service.RemoveAccountRole(ctx, "usr_admin", account.UserID, role.RoleID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteRole(ctx, "usr_admin", role.RoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetRole(ctx, role.RoleID); !errors.Is(err, ErrRoleNotFound) {
		t.Fatalf("GetRole after delete error = %v", err)
	}
}

func TestServiceValidatesRequestsAndAllowsRemovingOneOfMultipleAdmins(t *testing.T) {
	service, _, accountService := newTestService(t)
	ctx := context.Background()
	adminOne := createAccount(t, accountService, "admin1@example.com")
	adminTwo := createAccount(t, accountService, "admin2@example.com")
	if err := service.BootstrapAdmin(ctx, adminOne.UserID); err != nil {
		t.Fatal(err)
	}
	if err := service.BootstrapAdmin(ctx, adminOne.UserID); err != nil {
		t.Fatalf("duplicate BootstrapAdmin = %v", err)
	}
	if err := service.BootstrapAdmin(ctx, adminTwo.UserID); err != nil {
		t.Fatal(err)
	}
	adminRole, err := service.RoleByCode(ctx, AdminRoleCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RemoveAccountRole(ctx, adminOne.UserID, adminOne.UserID, adminRole.RoleID); err != nil {
		t.Fatalf("remove one of multiple admins = %v", err)
	}

	if _, err := service.CreateRole(ctx, "usr_admin", CreateRoleInput{Code: "A", Name: "无效"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid CreateRole error = %v", err)
	}
	if _, err := service.UpdateRole(ctx, "usr_admin", UpdateRoleInput{RoleID: adminRole.RoleID, Name: "admin"}); !errors.Is(err, ErrSystemRoleImmutable) {
		t.Fatalf("system UpdateRole error = %v", err)
	}
	if err := service.AssignAccountRole(ctx, "usr_admin", "", adminRole.RoleID); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("empty AssignAccountRole error = %v", err)
	}
	if _, err := service.HasPermission(ctx, adminTwo.UserID, "console:unknown:read"); !errors.Is(err, ErrInvalidPermission) {
		t.Fatalf("invalid HasPermission error = %v", err)
	}
}

func TestPermissionCatalogExcludesRemovedIndustryPermission(t *testing.T) {
	for _, permission := range PermissionCatalog() {
		if permission.Code == "console:industry:read" {
			t.Fatalf("permission catalog still contains removed permission %q", permission.Code)
		}
	}
}

func newTestService(t *testing.T) (*Service, *MemoryStore, *accounts.Service) {
	t.Helper()
	accountService := accounts.NewService(accounts.Config{
		Store: accounts.NewMemoryStore(),
		Clock: func() time.Time { return time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC) },
	})
	store := NewMemoryStore()
	service := NewService(Config{Store: store, Accounts: accountService, Clock: func() time.Time {
		return time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	}})
	if err := service.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	return service, store, accountService
}

func createAccount(t *testing.T, service *accounts.Service, email string) accounts.Account {
	t.Helper()
	account, err := service.CreateAccount(context.Background(), accounts.CreateAccountRequest{
		Email: email, Name: email, Password: "passw0rd!", Status: accounts.StatusActive,
	})
	if err != nil {
		t.Fatal(err)
	}
	return account
}

func assertStringsEqual(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %#v, want %#v", got, want)
		}
	}
}
