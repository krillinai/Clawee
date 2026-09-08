package server

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/clawadmin"
)

type ModelAccessMode string

const (
	ModelAccessPlatformManaged   ModelAccessMode = "platform_managed"
	ModelAccessEnterpriseManaged ModelAccessMode = "enterprise_managed"
)

type platformManagedModelConfiguration struct {
	Mode              ModelAccessMode `json:"mode"`
	BaseURL           string          `json:"base_url"`
	Model             string          `json:"model"`
	APIKey            string          `json:"api_key"`
	CredentialVersion int             `json:"credential_version"`
}

type enterpriseManagedModelConfiguration struct {
	Mode ModelAccessMode `json:"mode"`
}

func modelAccessMode(opts Options) ModelAccessMode {
	if opts.ModelAccessMode == "" {
		return ModelAccessPlatformManaged
	}
	return opts.ModelAccessMode
}

func mountModelConfigurationRoutes(app *gin.RouterGroup, opts Options) {
	app.POST("/model-configuration", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		principal, principalOK := currentPrincipal(c)
		account, accountOK := currentAccount(c)
		_, agentOK := currentClaweeAgent(c)
		if !principalOK || !accountOK || account.UserID != principal.UserID || principal.ClientID != accounts.ClientClaweeAgent || principal.AgentID == "" || !agentOK {
			abortAuthorizationError(c, http.StatusForbidden, "agent_context_required", "仅 Clawee Agent 可以获取模型配置")
			return
		}
		if modelAccessMode(opts) == ModelAccessEnterpriseManaged {
			c.JSON(http.StatusOK, enterpriseManagedModelConfiguration{Mode: ModelAccessEnterpriseManaged})
			return
		}
		if opts.ModelConfigurationProvider == nil {
			abortAuthorizationError(c, http.StatusServiceUnavailable, "model_configuration_unavailable", "模型配置服务暂不可用")
			return
		}
		configuration, err := opts.ModelConfigurationProvider.EnsureModelConfiguration(c.Request.Context(), clawadmin.AccountReference{
			ID: account.UserID, Name: account.DisplayName(), Email: account.Email,
		})
		if err != nil {
			abortAuthorizationError(c, http.StatusServiceUnavailable, "model_configuration_unavailable", "模型配置服务暂不可用")
			return
		}
		c.JSON(http.StatusOK, platformManagedModelConfiguration{
			Mode: ModelAccessPlatformManaged, BaseURL: configuration.BaseURL,
			Model: configuration.Model, APIKey: configuration.APIKey,
			CredentialVersion: configuration.CredentialVersion,
		})
	})
}
