package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/cloudskills"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/settings"
)

func mountCloudSkillRoutes(app, admin *gin.RouterGroup, opts Options) {
	if opts.CloudSkillService == nil {
		return
	}
	app.GET("/cloud-skills", handleCloudSkillList(opts.CloudSkillService))
	admin.GET("/skills/cloud-settings", skillRequirePermission(opts.RBACService, rbac.PermissionSkillRead), handleCloudSkillSettings(opts.CloudSkillService))
	admin.PUT("/skills/cloud-settings", skillRequirePermission(opts.RBACService, rbac.PermissionSkillManage), handleCloudSkillSettingsUpdate(opts.CloudSkillService))
}

func handleCloudSkillList(service *cloudskills.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		response, err := service.List(c.Request.Context())
		if err != nil {
			cloudSkillError(c, err)
			return
		}
		c.JSON(http.StatusOK, response)
	}
}

func handleCloudSkillSettings(service *cloudskills.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		configuration, err := service.Get(c.Request.Context())
		if err != nil {
			cloudSkillError(c, err)
			return
		}
		c.JSON(http.StatusOK, configuration)
	}
}

func handleCloudSkillSettingsUpdate(service *cloudskills.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		var request struct {
			AgentEmail     string `json:"agent_email"`
			PromptTemplate string `json:"prompt_template"`
			Version        int64  `json:"version"`
		}
		if decodeSkillJSON(c, &request) != nil || request.Version < 0 {
			cloudSkillError(c, cloudskills.ErrInvalidRequest)
			return
		}
		configuration, err := service.Update(c.Request.Context(), cloudskills.Config{
			AgentEmail: request.AgentEmail, PromptTemplate: request.PromptTemplate,
		}, strings.TrimSpace(account.UserID), request.Version)
		if err != nil {
			cloudSkillError(c, err)
			return
		}
		c.JSON(http.StatusOK, configuration)
	}
}

func cloudSkillError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "cloud_skill_unavailable", "云 Skill 暂时不可用"
	switch {
	case errors.Is(err, cloudskills.ErrInvalidRequest):
		status, code, message = http.StatusBadRequest, "invalid_request", "请求参数不合法"
	case errors.Is(err, settings.ErrVersionConflict):
		status, code, message = http.StatusConflict, "version_conflict", "配置已被其他管理员修改，请刷新后重试"
	case errors.Is(err, accounts.ErrAccountNotFound), errors.Is(err, cloudskills.ErrUnavailable):
		status, code, message = http.StatusServiceUnavailable, "cloud_skill_unavailable", "云 Skill 账户暂不可用"
	}
	if status >= http.StatusInternalServerError {
		_ = c.Error(err)
	}
	c.JSON(status, gin.H{"code": code, "error": message})
}
