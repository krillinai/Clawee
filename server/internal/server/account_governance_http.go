package server

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accountgovernance"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type transferAgentRequest struct {
	AgentID      string `json:"agent_id"`
	SourceUserID string `json:"source_user_id"`
	TargetUserID string `json:"target_user_id"`
	Reason       string `json:"reason"`
}

type mergeAccountsRequest struct {
	SourceUserID string `json:"source_user_id"`
	TargetUserID string `json:"target_user_id"`
	Reason       string `json:"reason"`
}

func mountAccountGovernanceRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.AccountGovernanceService == nil {
		return
	}
	service := opts.AccountGovernanceService
	admin.POST("/mcp/agents/transfer", requirePermission(opts.RBACService, rbac.PermissionAgentTransfer), func(c *gin.Context) {
		var request transferAgentRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			accountGovernanceError(c, accountgovernance.ErrInvalidRequest)
			return
		}
		result, err := service.TransferAgent(c.Request.Context(), accountgovernance.TransferAgentInput{
			AgentID: request.AgentID, SourceUserID: request.SourceUserID, TargetUserID: request.TargetUserID,
			Reason: request.Reason, OperatorUserID: currentUserID(c), RequestID: requestIDFromContext(c.Request.Context()),
		})
		if err != nil {
			accountGovernanceError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	})
	admin.POST("/accounts/merge", requirePermission(opts.RBACService, rbac.PermissionAccountMerge), func(c *gin.Context) {
		var request mergeAccountsRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			accountGovernanceError(c, accountgovernance.ErrInvalidRequest)
			return
		}
		result, err := service.MergeAccounts(c.Request.Context(), accountgovernance.MergeAccountsInput{
			SourceUserID: request.SourceUserID, TargetUserID: request.TargetUserID, Reason: request.Reason,
			OperatorUserID: currentUserID(c), RequestID: requestIDFromContext(c.Request.Context()),
		})
		if err != nil {
			accountGovernanceError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	})
}

func accountGovernanceError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "account_governance_failed", "账号治理操作失败"
	switch {
	case errors.Is(err, accountgovernance.ErrInvalidRequest), errors.Is(err, accountgovernance.ErrSameAccount):
		status, code, message = http.StatusBadRequest, "invalid_request", err.Error()
	case errors.Is(err, accountgovernance.ErrAccountNotFound), errors.Is(err, accountgovernance.ErrAgentNotFound):
		status, code, message = http.StatusNotFound, "not_found", err.Error()
	case errors.Is(err, accountgovernance.ErrSourceAccountNotDisabled),
		errors.Is(err, accountgovernance.ErrTargetAccountNotActive),
		errors.Is(err, accountgovernance.ErrAgentOwnerConflict),
		errors.Is(err, accountgovernance.ErrAgentOwnerInconsistent),
		errors.Is(err, accountgovernance.ErrIdentityConflict),
		errors.Is(err, accountgovernance.ErrAccountGrantConflict),
		errors.Is(err, accountgovernance.ErrPendingGate):
		status, code, message = http.StatusConflict, "state_conflict", err.Error()
	}
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}
