package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
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
		if strings.TrimSpace(account.Name) == "" {
			modelConfigurationError(c, http.StatusBadRequest, "user_name_required", "请先设置用户名")
			return
		}
		model, err := validatePlatformModelRoute(c, opts, account.UserID)
		if err != nil {
			abortAuthorizationError(c, http.StatusServiceUnavailable, "model_configuration_unavailable", "模型配置服务暂不可用")
			return
		}
		if opts.ProxyGateway == nil {
			abortAuthorizationError(c, http.StatusServiceUnavailable, "model_configuration_unavailable", "模型配置服务暂不可用")
			return
		}
		if err := opts.ProxyGateway.EnsureAccountToken(c.Request.Context(), account.UserID); err != nil {
			writeModelConfigurationError(c, err)
			return
		}
		issued, err := opts.ProxyGateway.CopyActiveAccountToken(c.Request.Context(), account.UserID)
		if err != nil {
			writeModelConfigurationError(c, err)
			return
		}
		c.JSON(http.StatusOK, platformManagedModelConfiguration{
			Mode: ModelAccessPlatformManaged, BaseURL: modelGatewayBaseURL(c, opts),
			Model: model, APIKey: issued.Plaintext,
			CredentialVersion: 1,
		})
	})
}

func validatePlatformModelRoute(c *gin.Context, opts Options, userID string) (string, error) {
	return validatePlatformModelRouteContext(c.Request.Context(), opts, userID)
}

func validatePlatformModelRouteContext(ctx context.Context, opts Options, userID string) (string, error) {
	if opts.ModelCredentialCipher == nil || opts.ModelGroupStore == nil || opts.ModelUpstreamStore == nil {
		return "", errors.New("platform model routing is not configured")
	}
	if _, err := opts.ModelGroupStore.EnsureUserModelGroup(ctx, userID, time.Now().UTC()); err != nil {
		return "", err
	}
	_, model, _, err := resolveModelRouteTargets(ctx, opts, userID, "")
	return model, err
}

func modelConfigurationError(c *gin.Context, status int, code, message string) {
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}

func writeModelConfigurationError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, mcpgateway.ErrModelGroupNotConfigured):
		modelConfigurationError(c, http.StatusServiceUnavailable, "model_group_unavailable", "模型组尚未配置")
	default:
		modelConfigurationError(c, http.StatusInternalServerError, "model_configuration_unavailable", "模型配置服务暂不可用")
	}
}

func modelGatewayBaseURL(c *gin.Context, opts Options) string {
	base := strings.TrimRight(strings.TrimSpace(opts.ModelGatewayBaseURL), "/")
	if base == "" {
		scheme := "http"
		if c.Request.TLS != nil || strings.EqualFold(strings.TrimSpace(c.GetHeader("X-Forwarded-Proto")), "https") {
			scheme = "https"
		}
		base = scheme + "://" + c.Request.Host
	}
	return base + "/v1"
}
