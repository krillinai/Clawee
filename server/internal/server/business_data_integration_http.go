package server

import (
	"bytes"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

const maxBilibiliWebhookBodyBytes = 1 << 20

const maxBilibiliSourcePatchBodyBytes = 1024

type bilibiliWebhookPayload struct {
	Event   string `json:"event"`
	Content struct {
		Data     json.RawMessage `json:"data"`
		OpenID   string          `json:"openid"`
		ClientID string          `json:"client_id"`
	} `json:"content"`
}

type bilibiliSourcePatchRequest struct {
	SyncEnabled *bool `json:"sync_enabled"`
}

func mountBilibiliAppRoutes(app *gin.RouterGroup, opts Options) {
	app.GET("/business-data-sources/bilibili", func(c *gin.Context) {
		if c.Request.URL.RawQuery != "" {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩账号列表请求无效")
			return
		}
		if _, ok := requireBilibiliAction(c, opts, dataaccess.ActionRead); !ok {
			return
		}
		if opts.BilibiliSourceManager == nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		items, err := opts.BilibiliSourceManager.List(c.Request.Context())
		if err != nil {
			businessDataError(c, http.StatusServiceUnavailable, "bilibili_source_operation_failed", "无法读取哔哩哔哩账号状态")
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": itemsResponse(items)})
	})
	app.POST("/business-data-sources/bilibili/authorize", func(c *gin.Context) {
		if c.Request.URL.RawQuery != "" {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩授权请求无效")
			return
		}
		if opts.BilibiliIntegration == nil {
			businessDataError(c, http.StatusServiceUnavailable, "bilibili_not_configured", "哔哩哔哩接入未配置，请在服务端启用 bilibili 并配置 client_id、client_secret 和 redirect_url")
			return
		}
		account, ok := requireBilibiliConnect(c, opts)
		if !ok {
			return
		}
		authorizationURL, err := opts.BilibiliIntegration.AuthorizationURL(c.Request.Context(), account.UserID)
		if err != nil {
			if opts.Logger != nil {
				opts.Logger.Error("create bilibili authorization failed",
					zap.String("request_id", requestIDFromContext(c.Request.Context())),
					zap.String("user_id", account.UserID),
					zap.Error(err))
			}
			if errors.Is(err, businessdata.ErrBilibiliOAuthStateUnavailable) {
				businessDataError(c, http.StatusServiceUnavailable, "bilibili_oauth_state_unavailable", "无法保存哔哩哔哩授权会话，请检查数据库连接并确认迁移 00044 已执行")
				return
			}
			businessDataError(c, http.StatusInternalServerError, "bilibili_authorize_failed", "无法生成哔哩哔哩授权参数，请根据请求 ID 检查服务端日志")
			return
		}
		logBilibiliOperation(c, opts, account.UserID, "", "account_authorize_started", "success")
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"authorization_url": authorizationURL}})
	})
	app.POST("/business-data-sources/bilibili/sync", func(c *gin.Context) {
		if c.Request.URL.RawQuery != "" {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩同步请求无效")
			return
		}
		if opts.BilibiliIntegration == nil || opts.BilibiliSyncRequester == nil {
			businessDataError(c, http.StatusNotFound, "bilibili_disabled", "哔哩哔哩接入未启用")
			return
		}
		account, ok := requireBilibiliConnect(c, opts)
		if !ok {
			return
		}
		result, err := opts.BilibiliSyncRequester.RequestSync(c.Request.Context(), businessdata.ProviderBilibili)
		if err != nil {
			logBilibiliOperation(c, opts, account.UserID, "", "sync_requested", "failed")
			businessDataError(c, http.StatusServiceUnavailable, "bilibili_sync_failed", "无法提交哔哩哔哩同步任务")
			return
		}
		if result.SourceCount == 0 {
			businessDataError(c, http.StatusConflict, "bilibili_not_connected", "哔哩哔哩账号尚未连接")
			return
		}
		status := "already_queued"
		if result.QueuedCount > 0 {
			status = "queued"
		}
		logBilibiliOperation(c, opts, account.UserID, "", "sync_requested", status)
		c.JSON(http.StatusAccepted, gin.H{"data": gin.H{"status": status}})
	})
	app.POST("/business-data-sources/bilibili/:source_id/sync", func(c *gin.Context) {
		if invalidBilibiliNoInputRequest(c) {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩账号同步请求无效")
			return
		}
		account, ok := requireBilibiliAction(c, opts, dataaccess.ActionConnect)
		if !ok {
			return
		}
		if opts.BilibiliIntegration == nil {
			businessDataError(c, http.StatusNotFound, "bilibili_disabled", "哔哩哔哩接入未启用")
			return
		}
		if opts.BilibiliSourceManager == nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		sourceID := strings.TrimSpace(c.Param("source_id"))
		result, err := opts.BilibiliSourceManager.RequestSync(c.Request.Context(), sourceID)
		if err != nil {
			logBilibiliOperation(c, opts, account.UserID, sourceID, "account_sync_requested", "failed")
			handleBilibiliSourceError(c, err)
			return
		}
		status := "already_queued"
		if result.QueuedCount > 0 {
			status = "queued"
		}
		logBilibiliOperation(c, opts, account.UserID, sourceID, "account_sync_requested", status)
		c.JSON(http.StatusAccepted, gin.H{"data": gin.H{"status": status}})
	})
	app.PATCH("/business-data-sources/bilibili/:source_id", func(c *gin.Context) {
		if c.Request.URL.RawQuery != "" {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩账号管理请求无效")
			return
		}
		account, ok := requireBilibiliAction(c, opts, dataaccess.ActionManage)
		if !ok {
			return
		}
		var request bilibiliSourcePatchRequest
		decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, maxBilibiliSourcePatchBodyBytes))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil || request.SyncEnabled == nil {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩账号管理请求无效")
			return
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩账号管理请求无效")
			return
		}
		if opts.BilibiliSourceManager == nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		if *request.SyncEnabled && opts.BilibiliIntegration == nil {
			businessDataError(c, http.StatusNotFound, "bilibili_disabled", "哔哩哔哩接入未启用")
			return
		}
		sourceID := strings.TrimSpace(c.Param("source_id"))
		change, err := opts.BilibiliSourceManager.SetSyncEnabled(c.Request.Context(), sourceID, *request.SyncEnabled)
		action := "account_sync_disabled"
		if *request.SyncEnabled {
			action = "account_sync_enabled"
		}
		if err != nil {
			logBilibiliOperation(c, opts, account.UserID, sourceID, action, "failed")
			handleBilibiliSourceError(c, err)
			return
		}
		var syncRequestStatus any
		if change.QueuedCount > 0 {
			syncRequestStatus = "queued"
		}
		logBilibiliOperation(c, opts, account.UserID, sourceID, action, "success")
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"source": change.Source, "sync_request_status": syncRequestStatus}})
	})
	app.DELETE("/business-data-sources/bilibili/:source_id", func(c *gin.Context) {
		if invalidBilibiliNoInputRequest(c) {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩账号删除请求无效")
			return
		}
		account, ok := requireBilibiliAction(c, opts, dataaccess.ActionManage)
		if !ok {
			return
		}
		if opts.BilibiliSourceManager == nil {
			businessDataError(c, http.StatusServiceUnavailable, "business_data_unavailable", "业务数据暂不可用")
			return
		}
		sourceID := strings.TrimSpace(c.Param("source_id"))
		if err := opts.BilibiliSourceManager.Delete(c.Request.Context(), sourceID); err != nil {
			logBilibiliOperation(c, opts, account.UserID, sourceID, "account_deleted", "failed")
			handleBilibiliSourceError(c, err)
			return
		}
		logBilibiliOperation(c, opts, account.UserID, sourceID, "account_deleted", "success")
		c.Status(http.StatusNoContent)
	})
}

func requireBilibiliConnect(c *gin.Context, opts Options) (accountResponseValue accounts.Account, allowed bool) {
	return requireBilibiliAction(c, opts, dataaccess.ActionConnect)
}

func requireBilibiliAction(c *gin.Context, opts Options, action string) (accountResponseValue accounts.Account, allowed bool) {
	if opts.DataAccessService == nil {
		businessDataError(c, http.StatusServiceUnavailable, "data_authorization_unavailable", "数据授权服务不可用")
		return accountResponseValue, false
	}
	account, ok := currentAccount(c)
	if !ok {
		businessDataError(c, http.StatusUnauthorized, "unauthorized", "未认证")
		return accountResponseValue, false
	}
	allowed, err := opts.DataAccessService.HasAction(c.Request.Context(), account.UserID, dataaccess.ResourceDataView, dataaccess.ViewBilibiliOperation, action)
	if err != nil {
		businessDataError(c, http.StatusServiceUnavailable, "data_authorization_unavailable", "数据授权服务不可用")
		return accountResponseValue, false
	}
	if !allowed {
		code, message := "business_data_view_forbidden", "无权查看哔哩哔哩账号"
		if action == dataaccess.ActionConnect {
			code, message = "business_data_connect_forbidden", "无权连接或同步哔哩哔哩账号"
		} else if action == dataaccess.ActionManage {
			code, message = "business_data_manage_forbidden", "无权管理哔哩哔哩账号"
		}
		businessDataError(c, http.StatusForbidden, code, message)
		return accountResponseValue, false
	}
	return account, true
}

func logBilibiliOperation(c *gin.Context, opts Options, userID, sourceID, action, result string) {
	if opts.Logger == nil {
		return
	}
	opts.Logger.Info("bilibili business data operation",
		zap.String("request_id", requestIDFromContext(c.Request.Context())), zap.String("user_id", userID),
		zap.String("source_id", sourceID), zap.String("action", action), zap.String("result", result))
}

func invalidBilibiliNoInputRequest(c *gin.Context) bool {
	if c.Request.URL.RawQuery != "" {
		return true
	}
	if c.Request.Body == nil {
		return false
	}
	var one [1]byte
	n, err := c.Request.Body.Read(one[:])
	return n > 0 || err != nil && !errors.Is(err, io.EOF)
}

func handleBilibiliSourceError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, businessdata.ErrInvalidRequest):
		businessDataError(c, http.StatusBadRequest, "invalid_request", "哔哩哔哩账号请求无效")
	case errors.Is(err, businessdata.ErrNotFound):
		businessDataError(c, http.StatusNotFound, "business_data_source_not_found", "哔哩哔哩账号不存在")
	case errors.Is(err, businessdata.ErrBilibiliSourceDisabled):
		businessDataError(c, http.StatusConflict, businessdata.BilibiliSyncDisabledCode, "哔哩哔哩账号同步已停止")
	case errors.Is(err, businessdata.ErrBilibiliSourceAuthorizationRequired):
		businessDataError(c, http.StatusConflict, "bilibili_reauth_required", "哔哩哔哩账号需要重新授权")
	default:
		businessDataError(c, http.StatusServiceUnavailable, "bilibili_source_operation_failed", "哔哩哔哩账号操作失败")
	}
}

func mountBilibiliCallbackRoute(api *gin.RouterGroup, opts Options) {
	api.GET("/integrations/bilibili/oauth/callback", func(c *gin.Context) {
		if opts.BilibiliIntegration == nil {
			businessDataError(c, http.StatusNotFound, "bilibili_disabled", "哔哩哔哩接入未启用")
			return
		}
		code, state := strings.TrimSpace(c.Query("code")), strings.TrimSpace(c.Query("state"))
		if code == "" || state == "" {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "授权回调参数无效")
			return
		}
		if _, err := opts.BilibiliIntegration.HandleCallback(c.Request.Context(), code, state); err != nil {
			c.Redirect(http.StatusFound, "/app/business-data/bilibili-operation?authorization=failed")
			return
		}
		c.Redirect(http.StatusFound, "/app/business-data/bilibili-operation?authorization=success")
	})

	api.POST("/integrations/bilibili/webhooks", func(c *gin.Context) {
		if opts.BilibiliIntegration == nil || strings.TrimSpace(opts.BilibiliWebhookClientID) == "" || strings.TrimSpace(opts.BilibiliWebhookSecret) == "" {
			businessDataError(c, http.StatusNotFound, "bilibili_disabled", "哔哩哔哩接入未启用")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxBilibiliWebhookBodyBytes))
		if err != nil {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "Webhook 请求无效")
			return
		}
		if !validBilibiliWebhookSignature(opts.BilibiliWebhookSecret, body, c.GetHeader("x-bilibili-signature")) {
			businessDataError(c, http.StatusUnauthorized, "invalid_signature", "Webhook 签名无效")
			return
		}

		var payload bilibiliWebhookPayload
		if err := json.Unmarshal(body, &payload); err != nil || strings.TrimSpace(payload.Event) == "" {
			businessDataError(c, http.StatusBadRequest, "invalid_request", "Webhook 请求无效")
			return
		}
		switch payload.Event {
		case "verify_webhooks":
			if len(payload.Content.Data) == 0 || bytes.Equal(bytes.TrimSpace(payload.Content.Data), []byte("null")) {
				businessDataError(c, http.StatusBadRequest, "invalid_request", "Webhook 校验数据无效")
				return
			}
			c.JSON(http.StatusOK, gin.H{"data": payload.Content.Data})
		case "deauthorize":
			openID, clientID := strings.TrimSpace(payload.Content.OpenID), strings.TrimSpace(payload.Content.ClientID)
			if openID == "" || clientID != strings.TrimSpace(opts.BilibiliWebhookClientID) {
				businessDataError(c, http.StatusBadRequest, "invalid_request", "Webhook 解除授权参数无效")
				return
			}
			if err := opts.BilibiliIntegration.HandleDeauthorize(c.Request.Context(), openID); err != nil {
				businessDataError(c, http.StatusInternalServerError, "bilibili_deauthorize_failed", "无法处理哔哩哔哩解除授权")
				return
			}
			c.Status(http.StatusNoContent)
		default:
			c.Status(http.StatusNoContent)
		}
	})
}

func validBilibiliWebhookSignature(secret string, body []byte, signature string) bool {
	provided, err := hex.DecodeString(strings.TrimSpace(signature))
	if err != nil || len(provided) != sha1.Size {
		return false
	}
	expected := sha1.Sum(append([]byte(secret), body...))
	return subtle.ConstantTimeCompare(expected[:], provided) == 1
}
