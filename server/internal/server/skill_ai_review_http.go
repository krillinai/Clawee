package server

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func mountSkillAIReviewRoutes(app, admin *gin.RouterGroup, opts Options) {
	service := opts.SkillHubService
	if service == nil || opts.AccountService == nil {
		return
	}
	service.SetAIReviewIdentityLookup(func(ctx context.Context, user, agent string) error {
		if user != "" {
			account, err := opts.AccountService.Account(ctx, user)
			if err != nil || account.Status != accounts.StatusActive {
				return skillhub.ErrReviewForbidden
			}
		}
		if agent == "" {
			return nil
		}
		owner, err := opts.AccountService.AccountForAgent(ctx, agent)
		if err != nil || owner.Status != accounts.StatusActive || user != "" && owner.UserID != user || opts.ProxyGateway == nil {
			return skillhub.ErrReviewForbidden
		}
		registered, err := opts.ProxyGateway.Store().GetAgent(ctx, agent)
		if err != nil || registered.Status != mcpgateway.StatusActive {
			return skillhub.ErrReviewForbidden
		}
		return nil
	})
	manage := skillRequirePermission(opts.RBACService, rbac.PermissionSkillSpaceUpdate)
	admin.GET("/skill-spaces/:id/ai-review", manage, func(c *gin.Context) {
		if !checkAdminSpaceRead(c, service, c.Param("id")) {
			return
		}
		config, err := service.GetAIReviewConfig(c.Request.Context(), c.Param("id"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": config})
	})
	admin.PUT("/skill-spaces/:id/ai-review", manage, skillOperationLog(opts.Logger, "skill_space_ai_review_update"), func(c *gin.Context) {
		var body skillhub.AIReviewConfig
		if decodeSkillJSON(c, &body) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if !checkAdminSpaceRead(c, service, c.Param("id")) {
			return
		}
		config, err := service.SetAIReviewConfig(c.Request.Context(), c.Param("id"), body, currentUserID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": config})
	})
	read := skillRequirePermission(opts.RBACService, rbac.PermissionSkillRead)
	agentID := func(c *gin.Context) string {
		principal, ok := currentPrincipal(c)
		if !ok || principal.ClientID != accounts.ClientClaweeAgent {
			return ""
		}
		agent, ok := currentClaweeAgent(c)
		if !ok || agent.AgentID != principal.AgentID {
			return ""
		}
		return principal.AgentID
	}
	app.GET("/skill-ai-review-tasks", read, func(c *gin.Context) {
		tasks, err := service.ListAIReviewTasks(c.Request.Context(), currentUserID(c), agentID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"tasks": tasks}})
	})
	app.POST("/skill-ai-review-tasks/:requestID/claim", read, func(c *gin.Context) {
		var body struct {
			AttemptID string `json:"attempt_id"`
		}
		if decodeSkillJSON(c, &body) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if agentID(c) == "" {
			skillError(c, skillhub.ErrReviewForbidden)
			return
		}
		task, err := service.ClaimAIReview(c.Request.Context(), c.Param("requestID"), body.AttemptID, currentUserID(c), agentID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": task})
	})
	app.POST("/skill-ai-review-tasks/:requestID/result", read, func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256*1024)
		var body skillhub.AIReviewResultInput
		if decodeSkillJSON(c, &body) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if agentID(c) == "" {
			skillError(c, skillhub.ErrReviewForbidden)
			return
		}
		review, err := service.SubmitAIReviewResult(c.Request.Context(), c.Param("requestID"), currentUserID(c), agentID(c), body)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": review})
	})
	for _, action := range []string{"retry", "manual"} {
		manual := action == "manual"
		app.POST("/approvals/skill/:id/ai-review/"+action, read, func(c *gin.Context) {
			var attempt, comment string
			if manual {
				var body struct {
					AttemptID string `json:"attempt_id"`
					Comment   string `json:"comment"`
				}
				if decodeSkillJSON(c, &body) != nil {
					skillError(c, skillhub.ErrInvalidRequest)
					return
				}
				attempt, comment = body.AttemptID, body.Comment
			} else {
				var body struct {
					AttemptID string `json:"attempt_id"`
				}
				if decodeSkillJSON(c, &body) != nil {
					skillError(c, skillhub.ErrInvalidRequest)
					return
				}
				attempt = body.AttemptID
			}
			review, err := service.ManageAIReview(c.Request.Context(), c.Param("id"), attempt, currentUserID(c), comment, manual)
			if err != nil {
				skillError(c, err)
				return
			}
			c.JSON(http.StatusOK, gin.H{"data": review})
		})
	}
}
