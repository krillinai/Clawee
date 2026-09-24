package server

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dingtalk"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func mountSkillApprovalCallback(api *gin.RouterGroup, opts Options) {
	if !opts.DingTalkAuth.OAEnabled || opts.SkillHubService == nil {
		return
	}
	api.POST("/integrations/dingtalk/skill-approval/callback", func(c *gin.Context) {
		var request struct {
			Encrypt string `json:"encrypt"`
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		if c.ShouldBindJSON(&request) != nil {
			c.Status(http.StatusBadRequest)
			return
		}
		query := c.Request.URL.Query()
		timestamp, nonce := query.Get("timestamp"), query.Get("nonce")
		codec := dingtalk.ApprovalCallback{Token: opts.DingTalkAuth.OAEventToken, EncodingAESKey: opts.DingTalkAuth.OAEncodingAESKey}
		signature := query.Get("signature")
		if signature == "" {
			signature = query.Get("msg_signature")
		}
		event, receiver, err := codec.Decode(signature, timestamp, nonce, request.Encrypt)
		if err != nil {
			c.Status(http.StatusForbidden)
			return
		}
		if event.EventType == "bpms_instance_change" && (event.Type == "finish" || event.Type == "terminate") {
			if err = opts.SkillHubService.ApplyApprovalResult(c.Request.Context(), event.ProcessInstanceID, event.ProcessCode, event.Type, event.Result); err != nil {
				c.Status(http.StatusInternalServerError)
				return
			}
		}
		encrypted, signature, err := codec.Success(timestamp, nonce, receiver)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.JSON(http.StatusOK, gin.H{"msg_signature": signature, "timeStamp": timestamp, "nonce": nonce, "encrypt": encrypted})
	})
}

func handleSkillSpaceApproval(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			SpaceID  string `json:"space_id"`
			Provider string `json:"approval_provider"`
			Template string `json:"external_approval_template_id"`
		}
		if decodeSkillJSON(c, &req) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if !checkAdminSpaceRead(c, opts.SkillHubService, req.SpaceID) {
			return
		}
		if req.Provider == "dingtalk" && (!opts.DingTalkAuth.OAEnabled || opts.DingTalkAuth.OAClient == nil) {
			c.JSON(http.StatusConflict, gin.H{"code": "oa_not_configured", "error": "钉钉 OA 尚未配置完整"})
			return
		}
		account, _ := currentAccount(c)
		c.Set(skillSpaceIDKey, req.SpaceID)
		if err := opts.SkillHubService.SetSpaceApproval(c.Request.Context(), req.SpaceID, req.Provider, req.Template, account.UserID); err != nil {
			skillError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func handleAppSkillApprovalDetail(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		detail, err := service.GetApprovalDetailForUser(c.Request.Context(), account.UserID, skillID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, detail)
	}
}

func handleAppSkillApprovalFiles(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		items, err := service.ListApprovalVersionFilesForUser(c.Request.Context(), account.UserID, skillID(c), skillVersionID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleAppSkillApprovalFile(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		item, err := service.ReadApprovalVersionFileForUser(c.Request.Context(), account.UserID, skillID(c), skillVersionID(c), c.Query("path"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleAppSkillApprovalPackage(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		download, err := service.OpenApprovalVersionPackageForUser(c.Request.Context(), account.UserID, skillID(c), skillVersionID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		defer download.Reader.Close()
		c.Header("Content-Type", "application/zip")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", download.Filename))
		c.Header("Content-Length", fmt.Sprintf("%d", download.Size))
		c.Status(http.StatusOK)
		_, _ = io.Copy(c.Writer, download.Reader)
	}
}

func handleSubmitSkillApproval(opts Options, app bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req setCurrentVersionRequest
		if decodeSkillJSON(c, &req) != nil || !opts.DingTalkAuth.OAEnabled || opts.DingTalkAuth.OAClient == nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if !app && !checkAdminSkillRead(c, opts.SkillHubService, req.SkillID) {
			return
		}
		account, _ := currentAccount(c)
		identity, err := opts.AccountService.AccountIdentityForUser(c.Request.Context(), account.UserID, "dingtalk", opts.DingTalkAuth.ProviderKey)
		if errors.Is(err, accounts.ErrAccountIdentityNotFound) {
			c.JSON(http.StatusConflict, gin.H{"code": "dingtalk_not_bound", "error": "请先绑定钉钉账户"})
			return
		}
		if err != nil {
			skillError(c, err)
			return
		}
		item, version, skill, err := opts.SkillHubService.BeginApproval(c.Request.Context(), strings.TrimSpace(req.SkillID), strings.TrimSpace(req.VersionID), account.UserID, identity.ExternalUserID, app)
		if err != nil {
			skillError(c, err)
			return
		}
		c.Set(skillIDKey, skill.SkillID)
		c.Set(skillVersionKey, version.VersionID)
		c.Set(skillSpaceIDKey, skill.SpaceID)
		link := strings.TrimRight(opts.DingTalkAuth.PublicBaseURL, "/") + "/app/skills/detail?approval=1&skill_id=" + url.QueryEscape(skill.SkillID) + "&version_id=" + url.QueryEscape(version.VersionID)
		fields := []dingtalk.ApprovalField{{Name: "Skill 名称", Value: skill.Name}, {Name: "版本", Value: version.Version}, {Name: "变更说明", Value: version.Changelog}, {Name: "包 SHA-256", Value: version.PackageSHA256}, {Name: "Clawee 详情", Value: link}}
		instanceID, err := opts.DingTalkAuth.OAClient.CreateApproval(c.Request.Context(), identity.ExternalUserID, item.TemplateID, fields)
		if err != nil {
			status := "uncertain"
			var apiErr *dingtalk.APIError
			if errors.As(err, &apiErr) && (apiErr.Step == "app_token" || apiErr.Step == "create_approval" && apiErr.HTTPStatus >= 400 && apiErr.HTTPStatus < 500 && apiErr.HTTPStatus != http.StatusRequestTimeout && apiErr.HTTPStatus != http.StatusTooManyRequests) {
				status = "failed"
			}
			_, _ = opts.SkillHubService.FinishSubmission(c.Request.Context(), item.ID, "", status)
			c.JSON(http.StatusBadGateway, gin.H{"code": "oa_submission_failed", "error": "钉钉审批发起失败；状态不确定时请管理员核对审批实例"})
			return
		}
		item, err = opts.SkillHubService.FinishSubmission(c.Request.Context(), item.ID, instanceID, "running")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": "oa_submission_uncertain", "error": "审批实例已创建但保存失败，请管理员核对"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func syncSkillApproval(c *gin.Context, opts Options, item skillhub.ApprovalInstance) error {
	if item.ProviderInstanceID == "" {
		return skillhub.ErrExternalApprovalConflict
	}
	detail, err := opts.DingTalkAuth.OAClient.GetApproval(c.Request.Context(), item.ProviderInstanceID)
	if err != nil {
		return err
	}
	if detail.ProcessInstanceID != item.ProviderInstanceID || detail.ProcessCode != item.TemplateID {
		return skillhub.ErrExternalApprovalConflict
	}
	return applySkillApprovalDetail(c, opts, item, detail)
}

func applySkillApprovalDetail(c *gin.Context, opts Options, item skillhub.ApprovalInstance, detail dingtalk.ApprovalDetail) error {
	status := strings.ToLower(detail.Status)
	result := strings.ToLower(detail.Result)
	if status == "completed" {
		return opts.SkillHubService.ApplyApprovalResult(c.Request.Context(), item.ProviderInstanceID, item.TemplateID, "finish", result)
	}
	if status == "terminated" {
		return opts.SkillHubService.ApplyApprovalResult(c.Request.Context(), item.ProviderInstanceID, item.TemplateID, "terminate", "")
	}
	return nil
}

func handleSyncSkillApproval(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req setCurrentVersionRequest
		if decodeSkillJSON(c, &req) != nil || !opts.DingTalkAuth.OAEnabled || opts.DingTalkAuth.OAClient == nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if !checkAdminSkillRead(c, opts.SkillHubService, req.SkillID) {
			return
		}
		c.Set(skillIDKey, req.SkillID)
		c.Set(skillVersionKey, req.VersionID)
		item, err := opts.SkillHubService.GetApproval(c.Request.Context(), req.SkillID, req.VersionID)
		if err == nil {
			err = syncSkillApproval(c, opts, item)
		}
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"status": "synced"}})
	}
}

func handleResolveSkillApproval(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			ID         string `json:"application_id"`
			Resolution string `json:"resolution"`
			ProviderID string `json:"provider_instance_id"`
		}
		if decodeSkillJSON(c, &req) != nil || !opts.DingTalkAuth.OAEnabled || opts.DingTalkAuth.OAClient == nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		current, err := opts.SkillHubService.GetApprovalByID(c.Request.Context(), req.ID)
		if err != nil {
			skillError(c, err)
			return
		}
		if !checkAdminSpaceRead(c, opts.SkillHubService, current.SpaceID) {
			return
		}
		var detail dingtalk.ApprovalDetail
		if req.Resolution == "bind_instance" {
			if current.Status != "submitting" && current.Status != "uncertain" {
				skillError(c, skillhub.ErrExternalApprovalConflict)
				return
			}
			detail, err = opts.DingTalkAuth.OAClient.GetApproval(c.Request.Context(), req.ProviderID)
			if err != nil {
				skillError(c, err)
				return
			}
			if detail.ProcessInstanceID != req.ProviderID || detail.ProcessCode != current.TemplateID {
				skillError(c, skillhub.ErrExternalApprovalConflict)
				return
			}
			if detail.OriginatorUserID != current.InitiatorExternalUserID || !approvalFieldMatches(detail.FormComponentValues, "包 SHA-256", current.PackageSHA256) {
				skillError(c, skillhub.ErrExternalApprovalConflict)
				return
			}
		}
		item, err := opts.SkillHubService.ResolveApproval(c.Request.Context(), req.ID, req.Resolution, req.ProviderID)
		if err == nil && req.Resolution == "bind_instance" {
			err = applySkillApprovalDetail(c, opts, item, detail)
		}
		if err != nil {
			skillError(c, err)
			return
		}
		c.Set(skillResultKey, fmt.Sprintf("%s:%s", req.ID, req.Resolution))
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func approvalFieldMatches(fields []dingtalk.ApprovalField, name, value string) bool {
	for _, field := range fields {
		if field.Name == name && field.Value == value {
			return true
		}
	}
	return false
}
