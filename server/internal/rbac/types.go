package rbac

import (
	"errors"
	"time"
)

const (
	AdminRoleID   = "role_admin"
	AdminRoleCode = "admin"
	AdminRoleName = "系统管理员"

	AuditRoleCreate                = "role_create"
	AuditRoleUpdate                = "role_update"
	AuditRoleDelete                = "role_delete"
	AuditRoleUpdateRejected        = "role_update_rejected"
	AuditRoleDeleteRejected        = "role_delete_rejected"
	AuditAccountRoleAssign         = "account_role_assign"
	AuditAccountRoleRemove         = "account_role_remove"
	AuditAccountRoleRemoveRejected = "account_role_remove_rejected"
	AuditLastAdminProtection       = "last_admin_protection"
)

var (
	ErrInvalidRequest      = errors.New("invalid rbac request")
	ErrInvalidPermission   = errors.New("invalid permission code")
	ErrRoleNotFound        = errors.New("rbac role not found")
	ErrRoleCodeExists      = errors.New("rbac role code already exists")
	ErrSystemRoleImmutable = errors.New("system role cannot be changed")
	ErrRoleInUse           = errors.New("rbac role is assigned to accounts")
	ErrAccountRoleExists   = errors.New("account role binding already exists")
	ErrAccountRoleNotFound = errors.New("account role binding not found")
	ErrLastActiveAdmin     = errors.New("cannot remove the last active admin")
)

type Role struct {
	RoleID      string
	Code        string
	Name        string
	System      bool
	Permissions []string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type AccountRole struct {
	UserID    string
	RoleID    string
	RoleCode  string
	RoleName  string
	System    bool
	CreatedAt time.Time
}

type OperationAudit struct {
	AuditID    string
	OperatorID string
	Action     string
	TargetType string
	TargetID   string
	Before     []byte
	After      []byte
	CreatedAt  time.Time
}

type CreateRoleInput struct {
	Code        string
	Name        string
	Permissions []string
}

type UpdateRoleInput struct {
	RoleID      string
	Name        string
	Permissions []string
}
