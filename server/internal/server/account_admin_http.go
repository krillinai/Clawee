package server

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type createAccountRequest struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Password string `json:"password"`
	Status   string `json:"status"`
}

type updateAccountRequest struct {
	UserID string  `json:"user_id"`
	Name   *string `json:"name"`
	Status *string `json:"status"`
}

type resetAccountPasswordRequest struct {
	UserID   string `json:"user_id"`
	Password string `json:"password"`
}

func handleAccountDetail(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, err := accountSvc.Account(c.Request.Context(), strings.TrimSpace(c.Query("user_id")))
		if err != nil {
			accountError(c, err)
			return
		}
		resp, err := accountManagementResponse(c.Request.Context(), accountSvc, proxyGateway, account)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

func handleListAccounts(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := accountSvc.ListAccounts(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		out := make([]gin.H, 0, len(items))
		for _, account := range items {
			item, err := accountManagementResponse(c.Request.Context(), accountSvc, proxyGateway, account)
			if err != nil {
				agentAPIError(c, err)
				return
			}
			out = append(out, item)
		}
		c.JSON(http.StatusOK, itemsResponse(out))
	}
}

func handleCreateAccount(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req createAccountRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		account, err := accountSvc.CreateAccount(c.Request.Context(), accounts.CreateAccountRequest{
			Email:    req.Email,
			Name:     req.Name,
			Password: req.Password,
			Status:   req.Status,
		})
		if err != nil {
			accountError(c, err)
			return
		}
		resp, err := accountManagementResponse(c.Request.Context(), accountSvc, proxyGateway, account)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusCreated, resp)
	}
}

func handleUpdateAccount(accountSvc *accounts.Service, rbacSvc *rbac.Service, proxyGateway *mcpgateway.Service, lifecycle interface {
	DisableModelCredential(context.Context, string) error
}, logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req updateAccountRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		userID := strings.TrimSpace(req.UserID)
		if userID == "" {
			accountError(c, accounts.ErrAccountUserIDRequired)
			return
		}
		if (req.Name == nil) == (req.Status == nil) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "必须且只能修改账户昵称或状态"})
			return
		}
		if req.Name != nil {
			account, err := accountSvc.UpdateAccountName(c.Request.Context(), userID, *req.Name)
			if err != nil {
				accountError(c, err)
				return
			}
			auditAccountAction(c, logger, "update_name", account)
			resp, err := accountManagementResponse(c.Request.Context(), accountSvc, proxyGateway, account)
			if err != nil {
				agentAPIError(c, err)
				return
			}
			c.JSON(http.StatusOK, resp)
			return
		}
		if *req.Status != accounts.StatusActive && *req.Status != accounts.StatusDisabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "账户状态必须为 active 或 disabled"})
			return
		}
		items, err := accountSvc.ListAccounts(c.Request.Context())
		if err != nil {
			accountError(c, err)
			return
		}
		previousStatus := ""
		for _, item := range items {
			if item.UserID == userID {
				previousStatus = item.Status
				break
			}
		}
		if previousStatus == "" {
			accountError(c, accounts.ErrAccountNotFound)
			return
		}

		var account accounts.Account
		if previousStatus == accounts.StatusActive && *req.Status != accounts.StatusActive {
			if rbacSvc == nil || lifecycle == nil {
				accountError(c, errRBACServiceUnavailable)
				return
			}
			account, err = accountSvc.UpdateAccountStatusWithValidation(c.Request.Context(), userID, *req.Status, func(ctx context.Context) error {
				if err := rbacSvc.ValidateAccountDeactivation(ctx, currentUserID(c), userID); err != nil {
					return err
				}
				return lifecycle.DisableModelCredential(ctx, userID)
			})
		} else {
			account, err = accountSvc.UpdateAccountStatus(c.Request.Context(), userID, *req.Status)
		}
		if err != nil {
			accountError(c, err)
			return
		}
		auditAccountAction(c, logger, "update_status", account)
		resp, err := accountManagementResponse(c.Request.Context(), accountSvc, proxyGateway, account)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

func handleResetAccountPassword(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service, logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req resetAccountPasswordRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		userID := strings.TrimSpace(req.UserID)
		if userID == "" {
			accountError(c, accounts.ErrInvalidAccountRequest)
			return
		}
		account, err := accountSvc.ResetAccountPassword(c.Request.Context(), userID, req.Password)
		if err != nil {
			accountError(c, err)
			return
		}
		auditAccountAction(c, logger, "reset_password", account)
		resp, err := accountManagementResponse(c.Request.Context(), accountSvc, proxyGateway, account)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

func auditAccountAction(c *gin.Context, logger *zap.Logger, action string, target accounts.Account) {
	if logger == nil {
		return
	}
	operator, _ := currentAccount(c)
	logger.Info("admin account action",
		zap.String("action", action),
		zap.String("operator_user_id", operator.UserID),
		zap.String("operator_email", operator.Email),
		zap.String("target_user_id", target.UserID),
		zap.String("target_email", target.Email),
	)
}

func accountError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, accounts.ErrAccountUserIDRequired):
		c.JSON(http.StatusBadRequest, gin.H{"error": "账户 ID 不能为空"})
	case errors.Is(err, accounts.ErrAccountNameRequired):
		c.JSON(http.StatusBadRequest, gin.H{"error": "账户昵称不能为空"})
	case errors.Is(err, accounts.ErrInvalidAccountRequest), errors.Is(err, accounts.ErrPasswordTooShort), errors.Is(err, accounts.ErrEmailExists), errors.Is(err, rbac.ErrLastActiveAdmin), errors.Is(err, rbac.ErrAccountRoleExists), errors.Is(err, rbac.ErrAccountRoleNotFound):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	case errors.Is(err, accounts.ErrAccountNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}

func accountManagementResponse(ctx context.Context, accountSvc *accounts.Service, proxyGateway *mcpgateway.Service, account accounts.Account) (gin.H, error) {
	out := accountResponse(account, false)
	out["agent"] = nil

	if proxyGateway == nil {
		return out, nil
	}
	agentID, err := accountSvc.PrimaryAgentID(ctx, account.UserID)
	if errors.Is(err, accounts.ErrAccountAgentNotFound) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	agent, err := proxyGateway.Store().GetAgent(ctx, agentID)
	if err != nil {
		return nil, err
	}
	out["agent"] = accountAgentSummaryResponse(agent)
	return out, nil
}

func accountAgentSummaryResponse(agent mcpgateway.AgentRegistration) gin.H {
	return gin.H{
		"agentId":   agent.AgentID,
		"clientId":  agent.ClientID,
		"name":      agent.Name,
		"status":    agent.Status,
		"actorId":   agent.ActorID,
		"updatedAt": agent.UpdatedAt,
	}
}

func mountAccountAdminRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.AccountService == nil {
		return
	}
	admin.GET("/accounts", requirePermission(opts.RBACService, rbac.PermissionAccountRead), handleListAccounts(opts.AccountService, opts.ProxyGateway))
	admin.GET("/accounts/detail", requirePermission(opts.RBACService, rbac.PermissionAccountRead), handleAccountDetail(opts.AccountService, opts.ProxyGateway))
	admin.POST("/accounts", requirePermission(opts.RBACService, rbac.PermissionAccountManage), handleCreateAccount(opts.AccountService, opts.ProxyGateway))
	admin.PATCH("/accounts", requirePermission(opts.RBACService, rbac.PermissionAccountManage), handleUpdateAccount(opts.AccountService, opts.RBACService, opts.ProxyGateway, opts.ModelCredentialLifecycle, opts.Logger))
	admin.POST("/accounts/password/reset", requirePermission(opts.RBACService, rbac.PermissionAccountManage), handleResetAccountPassword(opts.AccountService, opts.ProxyGateway, opts.Logger))
}
