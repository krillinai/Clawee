package server

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type createRoleRequest struct {
	Code            string   `json:"code"`
	Name            string   `json:"name"`
	PermissionCodes []string `json:"permission_codes"`
}

type updateRoleRequest struct {
	RoleID          string   `json:"role_id"`
	Name            string   `json:"name"`
	PermissionCodes []string `json:"permission_codes"`
}

type roleIDRequest struct {
	RoleID string `json:"role_id"`
}

type accountRoleRequest struct {
	UserID string `json:"user_id"`
	RoleID string `json:"role_id"`
}

func mountRBACRoutes(group *gin.RouterGroup, opts Options) {
	if opts.RBACService == nil {
		return
	}
	service := opts.RBACService
	read := requirePermission(service, rbac.PermissionRBACRead)
	roleCreate := requirePermission(service, rbac.PermissionRBACRoleCreate)
	roleUpdate := requirePermission(service, rbac.PermissionRBACRoleUpdate)
	roleDelete := requirePermission(service, rbac.PermissionRBACRoleDelete)
	accountRoleUpdate := requirePermission(service, rbac.PermissionRBACAccountRoleUpdate)

	group.GET("/permissions", read, func(c *gin.Context) {
		catalog := rbac.PermissionCatalog()
		items := make([]gin.H, 0, len(catalog))
		for _, permission := range catalog {
			items = append(items, permissionResponse(permission))
		}
		c.JSON(http.StatusOK, gin.H{"data": items, "meta": gin.H{"next_cursor": "", "has_next": false}})
	})
	group.GET("/roles", read, func(c *gin.Context) {
		roles, err := service.ListRoles(c.Request.Context())
		if err != nil {
			rbacError(c, err)
			return
		}
		items := make([]gin.H, 0, len(roles))
		for _, role := range roles {
			items = append(items, roleResponse(role))
		}
		c.JSON(http.StatusOK, gin.H{"data": items, "meta": gin.H{"next_cursor": "", "has_next": false}})
	})
	group.GET("/roles/detail", read, func(c *gin.Context) {
		role, err := service.GetRole(c.Request.Context(), c.Query("role_id"))
		if err != nil {
			rbacError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": roleResponse(role)})
	})
	group.POST("/roles", roleCreate, func(c *gin.Context) {
		var request createRoleRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			rbacError(c, rbac.ErrInvalidRequest)
			return
		}
		role, err := service.CreateRole(c.Request.Context(), currentUserID(c), rbac.CreateRoleInput{
			Code: request.Code, Name: request.Name, Permissions: request.PermissionCodes,
		})
		if err != nil {
			rbacError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"data": roleResponse(role)})
	})
	group.PATCH("/roles", roleUpdate, func(c *gin.Context) {
		var request updateRoleRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			rbacError(c, rbac.ErrInvalidRequest)
			return
		}
		role, err := service.UpdateRole(c.Request.Context(), currentUserID(c), rbac.UpdateRoleInput{
			RoleID: request.RoleID, Name: request.Name, Permissions: request.PermissionCodes,
		})
		if err != nil {
			rbacError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": roleResponse(role)})
	})
	group.POST("/roles/remove", roleDelete, func(c *gin.Context) {
		var request roleIDRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			rbacError(c, rbac.ErrInvalidRequest)
			return
		}
		if err := service.DeleteRole(c.Request.Context(), currentUserID(c), request.RoleID); err != nil {
			rbacError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
	group.GET("/account-roles", read, func(c *gin.Context) {
		roles, err := service.ListAccountRoles(c.Request.Context(), c.Query("user_id"))
		if err != nil {
			rbacError(c, err)
			return
		}
		items := make([]gin.H, 0, len(roles))
		for _, role := range roles {
			items = append(items, accountRoleResponse(role))
		}
		c.JSON(http.StatusOK, gin.H{"data": items, "meta": gin.H{"next_cursor": "", "has_next": false}})
	})
	group.POST("/account-roles", accountRoleUpdate, func(c *gin.Context) {
		var request accountRoleRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			rbacError(c, rbac.ErrInvalidRequest)
			return
		}
		if err := service.AssignAccountRole(c.Request.Context(), currentUserID(c), request.UserID, request.RoleID); err != nil {
			rbacError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"data": gin.H{"user_id": request.UserID, "role_id": request.RoleID}})
	})
	group.POST("/account-roles/remove", accountRoleUpdate, func(c *gin.Context) {
		var request accountRoleRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			rbacError(c, rbac.ErrInvalidRequest)
			return
		}
		if err := service.RemoveAccountRole(c.Request.Context(), currentUserID(c), request.UserID, request.RoleID); err != nil {
			rbacError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
}

func permissionResponse(permission rbac.Permission) gin.H {
	return gin.H{
		"code": permission.Code, "module": permission.Module, "action": permission.Action,
		"name": permission.Name, "description": permission.Description,
	}
}

func roleResponse(role rbac.Role) gin.H {
	return gin.H{
		"role_id": role.RoleID, "code": role.Code, "name": role.Name, "is_system": role.System,
		"permission_codes": role.Permissions, "created_at": role.CreatedAt, "updated_at": role.UpdatedAt,
	}
}

func accountRoleResponse(role rbac.AccountRole) gin.H {
	return gin.H{
		"user_id": role.UserID, "role_id": role.RoleID, "role_code": role.RoleCode,
		"role_name": role.RoleName, "is_system": role.System, "created_at": role.CreatedAt,
	}
}

func currentUserID(c *gin.Context) string {
	account, _ := currentAccount(c)
	return account.UserID
}

func rbacError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "internal_error", "RBAC 操作失败"
	switch {
	case errors.Is(err, rbac.ErrInvalidRequest), errors.Is(err, rbac.ErrInvalidPermission):
		status, code, message = http.StatusBadRequest, "invalid_request", err.Error()
	case errors.Is(err, rbac.ErrRoleNotFound), errors.Is(err, rbac.ErrAccountRoleNotFound), errors.Is(err, accounts.ErrAccountNotFound):
		status, code, message = http.StatusNotFound, "not_found", "资源不存在"
	case errors.Is(err, rbac.ErrRoleCodeExists), errors.Is(err, rbac.ErrAccountRoleExists), errors.Is(err, rbac.ErrRoleInUse), errors.Is(err, rbac.ErrSystemRoleImmutable), errors.Is(err, rbac.ErrLastActiveAdmin):
		status, code, message = http.StatusConflict, "conflict", err.Error()
	}
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}
