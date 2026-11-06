package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/agentprompt"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type agentPromptPolicyRequest struct {
	ServerAgentPrompt string `json:"server_agent_prompt"`
	ClaweeAgentPrompt string `json:"clawee_agent_prompt"`
}

func mountAgentPromptPolicyRoutes(app, admin *gin.RouterGroup, opts Options) {
	if opts.AgentPromptPolicyService == nil || opts.OfficeManagementAPI == nil {
		return
	}

	app.GET("/agent-prompt-policy", func(c *gin.Context) {
		policy, err := opts.AgentPromptPolicyService.Get(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"code": "agent_prompt_policy_unavailable", "message": "Agent 提示词配置暂时不可用", "details": []any{}}})
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"data": agentPromptPolicyResponse(policy)})
	})

	protected := admin.Group("/agent-prompt-policy")
	protected.Use(requirePermission(opts.RBACService, rbac.PermissionAgentManage))
	protected.GET("", func(c *gin.Context) {
		policy, err := opts.AgentPromptPolicyService.Get(c.Request.Context())
		if err != nil {
			agentPromptPolicyUnavailable(c)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"data": agentPromptPolicyResponse(policy)})
	})
	protected.PUT("", func(c *gin.Context) {
		var request agentPromptPolicyRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			agentPromptPolicyInvalid(c, "请求体必须是有效 JSON")
			return
		}
		request.ServerAgentPrompt = strings.TrimSpace(request.ServerAgentPrompt)
		request.ClaweeAgentPrompt = strings.TrimSpace(request.ClaweeAgentPrompt)
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		before, err := opts.AgentPromptPolicyService.Get(c.Request.Context())
		if err != nil {
			agentPromptPolicyUnavailable(c)
			return
		}
		policy, err := opts.AgentPromptPolicyService.Update(c.Request.Context(), agentprompt.UpdateInput{
			ServerPrompt: request.ServerAgentPrompt,
			ClaweePrompt: request.ClaweeAgentPrompt,
			UpdatedBy:    account.UserID,
		})
		if err != nil {
			switch {
			case errors.Is(err, agentprompt.ErrPromptTooLong):
				agentPromptPolicyInvalid(c, "单段提示词不能超过 32768 个字符")
			case errors.Is(err, agentprompt.ErrPromptContainsSecret):
				agentPromptPolicyInvalid(c, "提示词不能包含凭据、Token 或其他秘密")
			default:
				agentPromptPolicyUnavailable(c)
			}
			return
		}
		if opts.RBACService == nil {
			agentPromptPolicyUnavailable(c)
			return
		}
		if err := opts.RBACService.RecordAudit(
			c.Request.Context(), account.UserID, rbac.AuditAgentPromptPolicyUpdate,
			"agent_prompt_policy", agentprompt.DefaultID, before, policy,
		); err != nil {
			agentPromptPolicyUnavailable(c)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": agentPromptPolicyResponse(policy)})
	})
}

func agentPromptPolicyResponse(policy agentprompt.Policy) gin.H {
	return gin.H{
		"version":             policy.Version,
		"server_agent_prompt": policy.ServerPrompt,
		"clawee_agent_prompt": policy.ClaweePrompt,
		"updated_at":          policy.UpdatedAt,
	}
}

func agentPromptPolicyInvalid(c *gin.Context, message string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "validation_failed", "message": message, "details": []any{}}})
}

func agentPromptPolicyUnavailable(c *gin.Context) {
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"code": "agent_prompt_policy_unavailable", "message": "Agent 提示词配置暂时不可用", "details": []any{}}})
}
