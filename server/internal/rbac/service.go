package rbac

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
)

var roleCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}$`)

type AccountReader interface {
	Account(context.Context, string) (accounts.Account, error)
	ListAccounts(context.Context) ([]accounts.Account, error)
}

type Config struct {
	Store    Store
	Accounts AccountReader
	Clock    func() time.Time
}

type Service struct {
	store      Store
	accounts   AccountReader
	clock      func() time.Time
	adminGuard sync.Mutex
}

type protectedAccountRoleRemover interface {
	RemoveAccountRoleProtected(context.Context, string, string, OperationAudit, OperationAudit) (bool, error)
}

func NewService(cfg Config) *Service {
	store := cfg.Store
	if store == nil {
		store = NewMemoryStore()
	}
	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Service{store: store, accounts: cfg.Accounts, clock: clock}
}

func (s *Service) Initialize(ctx context.Context) error {
	now := s.clock().UTC()
	return s.store.EnsureSystemRole(ctx, Role{
		RoleID: AdminRoleID, Code: AdminRoleCode, Name: AdminRoleName, System: true,
		CreatedAt: now, UpdatedAt: now,
	})
}

func (s *Service) ListRoles(ctx context.Context) ([]Role, error) {
	roles, err := s.store.ListRoles(ctx)
	if err != nil {
		return nil, err
	}
	for i := range roles {
		if roles[i].System && roles[i].Code == AdminRoleCode {
			roles[i].Permissions = permissionCodes()
		}
	}
	return roles, nil
}

func (s *Service) GetRole(ctx context.Context, roleID string) (Role, error) {
	role, err := s.store.GetRole(ctx, strings.TrimSpace(roleID))
	if err != nil {
		return Role{}, err
	}
	if role.System && role.Code == AdminRoleCode {
		role.Permissions = permissionCodes()
	}
	return role, nil
}

func (s *Service) RoleByCode(ctx context.Context, code string) (Role, error) {
	role, err := s.store.GetRoleByCode(ctx, strings.TrimSpace(code))
	if err != nil {
		return Role{}, err
	}
	if role.System && role.Code == AdminRoleCode {
		role.Permissions = permissionCodes()
	}
	return role, nil
}

func (s *Service) CreateRole(ctx context.Context, operatorID string, input CreateRoleInput) (Role, error) {
	code := strings.TrimSpace(input.Code)
	name := strings.TrimSpace(input.Name)
	permissions, err := normalizePermissions(input.Permissions)
	if err != nil {
		return Role{}, err
	}
	if !roleCodePattern.MatchString(code) || code == AdminRoleCode || name == "" || len(name) > 100 {
		return Role{}, ErrInvalidRequest
	}
	now := s.clock().UTC()
	role := Role{RoleID: generateID("role"), Code: code, Name: name, Permissions: permissions, CreatedAt: now, UpdatedAt: now}
	if err := s.store.CreateRole(ctx, role, s.audit(operatorID, AuditRoleCreate, "role", role.RoleID, nil, role)); err != nil {
		return Role{}, err
	}
	return role, nil
}

func (s *Service) UpdateRole(ctx context.Context, operatorID string, input UpdateRoleInput) (Role, error) {
	role, err := s.store.GetRole(ctx, strings.TrimSpace(input.RoleID))
	if err != nil {
		return Role{}, err
	}
	if role.System {
		if err := s.store.RecordAudit(ctx, s.audit(operatorID, AuditRoleUpdateRejected, "role", role.RoleID, role, role)); err != nil {
			return Role{}, err
		}
		return Role{}, ErrSystemRoleImmutable
	}
	name := strings.TrimSpace(input.Name)
	permissions, err := normalizePermissions(input.Permissions)
	if err != nil {
		return Role{}, err
	}
	if name == "" || len(name) > 100 {
		return Role{}, ErrInvalidRequest
	}
	before := role
	role.Name = name
	role.Permissions = permissions
	role.UpdatedAt = s.clock().UTC()
	if err := s.store.UpdateRole(ctx, role, s.audit(operatorID, AuditRoleUpdate, "role", role.RoleID, before, role)); err != nil {
		return Role{}, err
	}
	return role, nil
}

func (s *Service) DeleteRole(ctx context.Context, operatorID, roleID string) error {
	role, err := s.store.GetRole(ctx, strings.TrimSpace(roleID))
	if err != nil {
		return err
	}
	if role.System {
		if err := s.store.RecordAudit(ctx, s.audit(operatorID, AuditRoleDeleteRejected, "role", role.RoleID, role, nil)); err != nil {
			return err
		}
		return ErrSystemRoleImmutable
	}
	count, err := s.store.CountRoleAccounts(ctx, role.RoleID)
	if err != nil {
		return err
	}
	if count > 0 {
		if err := s.store.RecordAudit(ctx, s.audit(operatorID, AuditRoleDeleteRejected, "role", role.RoleID, role, nil)); err != nil {
			return err
		}
		return ErrRoleInUse
	}
	return s.store.DeleteRole(ctx, role.RoleID, s.audit(operatorID, AuditRoleDelete, "role", role.RoleID, role, nil))
}

func (s *Service) ListAccountRoles(ctx context.Context, userID string) ([]AccountRole, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, ErrInvalidRequest
	}
	if s.accounts != nil {
		if _, err := s.accounts.Account(ctx, userID); err != nil {
			return nil, err
		}
	}
	return s.store.ListAccountRoles(ctx, userID)
}

func (s *Service) AssignAccountRole(ctx context.Context, operatorID, userID, roleID string) error {
	userID = strings.TrimSpace(userID)
	roleID = strings.TrimSpace(roleID)
	if userID == "" || roleID == "" {
		return ErrInvalidRequest
	}
	if s.accounts != nil {
		if _, err := s.accounts.Account(ctx, userID); err != nil {
			return err
		}
	}
	role, err := s.store.GetRole(ctx, roleID)
	if err != nil {
		return err
	}
	now := s.clock().UTC()
	binding := AccountRole{UserID: userID, RoleID: role.RoleID, RoleCode: role.Code, RoleName: role.Name, System: role.System, CreatedAt: now}
	return s.store.AssignAccountRole(ctx, binding, s.audit(operatorID, AuditAccountRoleAssign, "account_role", userID+":"+roleID, nil, binding))
}

func (s *Service) BootstrapAdmin(ctx context.Context, userID string) error {
	err := s.AssignAccountRole(ctx, userID, userID, AdminRoleID)
	if errors.Is(err, ErrAccountRoleExists) {
		return nil
	}
	return err
}

func (s *Service) RollbackBootstrapAdmin(ctx context.Context, userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ErrInvalidRequest
	}
	binding := AccountRole{
		UserID:   userID,
		RoleID:   AdminRoleID,
		RoleCode: AdminRoleCode,
		RoleName: AdminRoleName,
		System:   true,
	}
	err := s.store.RemoveAccountRole(ctx, userID, AdminRoleID, s.audit(
		userID,
		AuditAccountRoleRemove,
		"account_role",
		userID+":"+AdminRoleID,
		binding,
		nil,
	))
	if errors.Is(err, ErrAccountRoleNotFound) {
		return nil
	}
	return err
}

func (s *Service) RemoveAccountRole(ctx context.Context, operatorID, userID, roleID string) error {
	userID = strings.TrimSpace(userID)
	roleID = strings.TrimSpace(roleID)
	role, err := s.store.GetRole(ctx, roleID)
	if err != nil {
		return err
	}
	binding := AccountRole{UserID: userID, RoleID: roleID, RoleCode: role.Code, RoleName: role.Name, System: role.System}
	removeAudit := s.audit(operatorID, AuditAccountRoleRemove, "account_role", userID+":"+roleID, binding, nil)
	rejectedAudit := s.audit(operatorID, AuditAccountRoleRemoveRejected, "account_role", userID+":"+roleID, binding, nil)
	if role.Code == AdminRoleCode {
		if store, ok := s.store.(protectedAccountRoleRemover); ok {
			removed, err := store.RemoveAccountRoleProtected(ctx, userID, roleID, removeAudit, rejectedAudit)
			if err != nil {
				return err
			}
			if !removed {
				return ErrLastActiveAdmin
			}
			return nil
		}
	}

	s.adminGuard.Lock()
	defer s.adminGuard.Unlock()
	if role.Code == AdminRoleCode {
		last, err := s.isLastActiveAdmin(ctx, userID)
		if err != nil {
			return err
		}
		if last {
			if err := s.store.RecordAudit(ctx, rejectedAudit); err != nil {
				return err
			}
			return ErrLastActiveAdmin
		}
	}
	return s.store.RemoveAccountRole(ctx, userID, roleID, removeAudit)
}

func (s *Service) HasAnyPermission(ctx context.Context, userID string) (bool, error) {
	permissions, err := s.ListEffectivePermissions(ctx, userID)
	return len(permissions) > 0, err
}

func (s *Service) HasActiveAdmin(ctx context.Context) (bool, error) {
	hasBinding, err := s.store.HasActiveAdmin(ctx)
	if err != nil || !hasBinding || s.accounts == nil {
		return hasBinding, err
	}
	accountsList, err := s.accounts.ListAccounts(ctx)
	if err != nil {
		return false, err
	}
	for _, account := range accountsList {
		if account.Status != accounts.StatusActive {
			continue
		}
		roles, err := s.store.ListAccountRoles(ctx, account.UserID)
		if err != nil {
			return false, err
		}
		for _, role := range roles {
			if role.RoleCode == AdminRoleCode {
				return true, nil
			}
		}
	}
	return false, nil
}

func (s *Service) HasPermission(ctx context.Context, userID, permissionCode string) (bool, error) {
	permissionCode = strings.TrimSpace(permissionCode)
	if !validPermission(permissionCode) {
		return false, ErrInvalidPermission
	}
	permissions, err := s.ListEffectivePermissions(ctx, userID)
	if err != nil {
		return false, err
	}
	for _, permission := range permissions {
		if permission == permissionCode {
			return true, nil
		}
	}
	return false, nil
}

func (s *Service) ListEffectivePermissions(ctx context.Context, userID string) ([]string, error) {
	bindings, err := s.ListAccountRoles(ctx, userID)
	if err != nil {
		return nil, err
	}
	permissions := map[string]struct{}{}
	for _, binding := range bindings {
		role, err := s.store.GetRole(ctx, binding.RoleID)
		if err != nil {
			return nil, err
		}
		if role.System && role.Code == AdminRoleCode {
			for _, code := range permissionCodes() {
				permissions[code] = struct{}{}
			}
			continue
		}
		for _, code := range role.Permissions {
			expandPermission(code, permissions)
		}
	}
	out := make([]string, 0, len(permissions))
	for code := range permissions {
		out = append(out, code)
	}
	sort.Strings(out)
	return out, nil
}

func (s *Service) ListEffectiveRoles(ctx context.Context, userID string) ([]string, error) {
	bindings, err := s.ListAccountRoles(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(bindings))
	for _, binding := range bindings {
		out = append(out, binding.RoleCode)
	}
	sort.Strings(out)
	return out, nil
}

func (s *Service) ValidateAccountDeactivation(ctx context.Context, operatorID, userID string) error {
	last, err := s.isLastActiveAdmin(ctx, strings.TrimSpace(userID))
	if err != nil {
		return err
	}
	if last {
		if err := s.store.RecordAudit(ctx, s.audit(operatorID, AuditLastAdminProtection, "account", userID, map[string]string{"status": accounts.StatusActive}, map[string]string{"status": accounts.StatusDisabled})); err != nil {
			return err
		}
		return ErrLastActiveAdmin
	}
	return nil
}

func (s *Service) isLastActiveAdmin(ctx context.Context, targetUserID string) (bool, error) {
	if s.accounts == nil {
		return false, nil
	}
	target, err := s.accounts.Account(ctx, targetUserID)
	if err != nil {
		return false, err
	}
	if target.Status != accounts.StatusActive {
		return false, nil
	}
	targetRoles, err := s.store.ListAccountRoles(ctx, targetUserID)
	if err != nil {
		return false, err
	}
	if !hasRoleCode(targetRoles, AdminRoleCode) {
		return false, nil
	}
	items, err := s.accounts.ListAccounts(ctx)
	if err != nil {
		return false, err
	}
	activeAdmins := 0
	for _, account := range items {
		if account.Status != accounts.StatusActive {
			continue
		}
		roles, err := s.store.ListAccountRoles(ctx, account.UserID)
		if err != nil {
			return false, err
		}
		if hasRoleCode(roles, AdminRoleCode) {
			activeAdmins++
		}
	}
	return activeAdmins <= 1, nil
}

func hasRoleCode(roles []AccountRole, code string) bool {
	for _, role := range roles {
		if role.RoleCode == code {
			return true
		}
	}
	return false
}

func normalizePermissions(input []string) ([]string, error) {
	seen := map[string]struct{}{}
	for _, code := range input {
		code = strings.TrimSpace(code)
		if !validPermission(code) {
			return nil, ErrInvalidPermission
		}
		seen[code] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for code := range seen {
		out = append(out, code)
	}
	sort.Strings(out)
	return out, nil
}

func (s *Service) audit(operatorID, action, targetType, targetID string, before, after any) OperationAudit {
	return OperationAudit{
		AuditID: generateID("audit"), OperatorID: strings.TrimSpace(operatorID), Action: action,
		TargetType: targetType, TargetID: targetID, Before: marshalSnapshot(before), After: marshalSnapshot(after), CreatedAt: s.clock().UTC(),
	}
}

func marshalSnapshot(value any) []byte {
	if value == nil {
		return []byte("null")
	}
	data, _ := json.Marshal(value)
	return data
}

func generateID(prefix string) string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(value[:])
}
