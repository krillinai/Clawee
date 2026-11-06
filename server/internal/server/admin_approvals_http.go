package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/approvals"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/skillhub"
	"github.com/krillinai/Clawee/server/internal/workflow"
)

type adminApprovalCursor struct {
	User   string
	Type   string
	Filter approvals.Filter
}

func adminApprovalPage(c *gin.Context) (adminApprovalCursor, int, bool) {
	query := adminApprovalCursor{User: currentUserID(c), Type: c.DefaultQuery("type", "all"), Filter: approvals.Filter{
		View: c.DefaultQuery("view", "all"), Status: c.DefaultQuery("status", "all"), Channel: c.DefaultQuery("channel", "all"),
		InitiatedBy: strings.TrimSpace(c.Query("initiated_by")), SpaceID: strings.TrimSpace(c.Query("space_id")), TemplateID: strings.TrimSpace(c.Query("template_id")), Search: strings.TrimSpace(c.Query("q")),
	}}
	limit, raw, ok := workflowPage(c)
	if !ok {
		return query, 0, false
	}
	valid := func(value string, allowed ...string) bool {
		for _, option := range allowed {
			if value == option {
				return true
			}
		}
		return false
	}
	if !valid(query.Type, "all", "skill", "workflow") || !valid(query.Filter.View, "all", "active", "closed", "error") || !valid(query.Filter.Status, "all", "pending", "running", "approved", "rejected", "invalidated", "succeeded", "terminated", "error") || !valid(query.Filter.Channel, "all", "local", "dingtalk", "workflow") || len([]rune(query.Filter.Search)) > 200 || len(query.Filter.InitiatedBy) > 256 || len(query.Filter.SpaceID) > 256 || len(query.Filter.TemplateID) > 256 {
		workflowError(c, workflow.ErrInvalid)
		return query, 0, false
	}
	for key, target := range map[string]**time.Time{"from": &query.Filter.From, "until": &query.Filter.Until} {
		if value := c.Query(key); value != "" {
			at, err := time.Parse(time.RFC3339, value)
			if err != nil {
				workflowError(c, workflow.ErrInvalid)
				return query, 0, false
			}
			utc := at.UTC()
			*target = &utc
		}
	}
	if query.Filter.From != nil && query.Filter.Until != nil && !query.Filter.From.Before(*query.Filter.Until) {
		workflowError(c, workflow.ErrInvalid)
		return query, 0, false
	}
	if raw == "" {
		return query, limit, true
	}
	if len(raw) > 4096 {
		workflowError(c, workflow.ErrInvalid)
		return query, 0, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	var cursor adminApprovalCursor
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.DisallowUnknownFields()
	if err != nil || decoder.Decode(&cursor) != nil || decoder.Decode(new(any)) != io.EOF || cursor.Filter.BeforeTime.IsZero() || cursor.Filter.BeforeID == "" || !valid(cursor.Filter.BeforeKind, "skill", "skill_external", "workflow_instance") || query.Type == "skill" && cursor.Filter.BeforeKind == "workflow_instance" || query.Type == "workflow" && cursor.Filter.BeforeKind != "workflow_instance" {
		workflowError(c, workflow.ErrInvalid)
		return query, 0, false
	}
	normalized := cursor
	normalized.Filter.BeforeTime, normalized.Filter.BeforeKind, normalized.Filter.BeforeID = time.Time{}, "", ""
	expected, _ := json.Marshal(query)
	actual, _ := json.Marshal(normalized)
	if !bytes.Equal(expected, actual) {
		workflowError(c, workflow.ErrInvalid)
		return query, 0, false
	}
	return cursor, limit, true
}

func adminApprovalDomains(c *gin.Context, opts Options, kind string) (bool, bool, bool) {
	skills, flows := false, false
	for permission, target := range map[string]*bool{rbac.PermissionSkillRead: &skills, rbac.PermissionWorkflowInstanceRead: &flows} {
		allowed, err := opts.RBACService.HasPermission(c.Request.Context(), currentUserID(c), permission)
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "permission_check_failed", "权限检查失败")
			return false, false, false
		}
		*target = allowed
	}
	return skills && kind != "workflow" && opts.SkillHubService != nil, flows && kind != "skill" && opts.WorkflowService != nil && opts.WorkflowService.DB != nil, true
}

func mountAdminApprovalRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.AccountService == nil {
		return
	}
	read := requireAnyPermission(opts.RBACService, rbac.PermissionSkillRead, rbac.PermissionWorkflowInstanceRead)
	admin.GET("/approvals", read, func(c *gin.Context) {
		query, limit, ok := adminApprovalPage(c)
		if !ok {
			return
		}
		skills, flows, ok := adminApprovalDomains(c, opts, query.Type)
		if !ok {
			return
		}
		items := []approvals.Record{}
		if skills {
			administrator, err := opts.RBACService.HasPermission(c.Request.Context(), query.User, rbac.PermissionSkillSpaceUpdate)
			if err != nil {
				skillError(c, err)
				return
			}
			records, err := opts.SkillHubService.ListAdminApprovals(c.Request.Context(), query.User, query.Filter, limit+1, administrator)
			if err != nil {
				skillError(c, err)
				return
			}
			items = append(items, records...)
		}
		if flows {
			records, err := opts.WorkflowService.AdminApprovals(c.Request.Context(), query.User, query.Filter, limit+1)
			if err != nil {
				workflowError(c, err)
				return
			}
			items = append(items, records...)
		}
		approvals.Sort(items)
		next := ""
		if len(items) > limit {
			items = items[:limit]
			last := items[len(items)-1]
			query.Filter.BeforeTime, query.Filter.BeforeKind, query.Filter.BeforeID = last.CreatedAt, last.Kind, last.ID
			encoded, _ := json.Marshal(query)
			next = base64.RawURLEncoding.EncodeToString(encoded)
		}
		workflowList(c, items, next)
	})
	admin.GET("/approvals/summary", read, func(c *gin.Context) {
		query, _, ok := adminApprovalPage(c)
		if !ok {
			return
		}
		skills, flows, ok := adminApprovalDomains(c, opts, query.Type)
		if !ok {
			return
		}
		var summary approvals.Summary
		if skills {
			part, err := opts.SkillHubService.AdminApprovalSummary(c.Request.Context(), query.User, query.Filter)
			if err != nil {
				skillError(c, err)
				return
			}
			summary.Add(part)
		}
		if flows {
			part, err := opts.WorkflowService.AdminApprovalSummary(c.Request.Context(), query.User, query.Filter)
			if err != nil {
				workflowError(c, err)
				return
			}
			summary.Add(part)
		}
		c.JSON(http.StatusOK, gin.H{"data": summary})
	})
	admin.GET("/approvals/:kind/:id", read, func(c *gin.Context) {
		kind, id := c.Param("kind"), c.Param("id")
		if kind == "workflow_instance" {
			if !authorizePermission(c, opts.RBACService, rbac.PermissionWorkflowInstanceRead) {
				return
			}
			if opts.WorkflowService == nil || opts.WorkflowService.DB == nil {
				workflowError(c, workflow.ErrMissing)
				return
			}
			fileAdmin, err := workflowFileAdmin(c, opts)
			if err != nil {
				workflowError(c, err)
				return
			}
			item, instance, err := opts.WorkflowService.AdminApproval(c.Request.Context(), currentUserID(c), id, fileAdmin)
			if err != nil {
				workflowError(c, err)
				return
			}
			instances := []workflow.Instance{instance}
			if !workflowInstanceNames(c, opts.WorkflowService, instances) {
				return
			}
			events, err := opts.WorkflowService.AdminApprovalEvents(c.Request.Context(), id)
			if err != nil {
				workflowError(c, err)
				return
			}
			allowed, err := opts.RBACService.HasPermission(c.Request.Context(), currentUserID(c), rbac.PermissionWorkflowInstanceTerminate)
			if err != nil {
				workflowError(c, err)
				return
			}
			c.JSON(http.StatusOK, gin.H{"data": gin.H{"item": item, "workflow": instances[0], "events": events, "actions": gin.H{"terminate": allowed && instance.Status == "running"}}})
			return
		}
		if kind != "skill" && kind != "skill_external" {
			workflowError(c, workflow.ErrInvalid)
			return
		}
		if !authorizePermission(c, opts.RBACService, rbac.PermissionSkillRead) {
			return
		}
		if opts.SkillHubService == nil {
			skillError(c, skillhub.ErrNotFound)
			return
		}
		item, detail, err := opts.SkillHubService.GetAdminApproval(c.Request.Context(), currentUserID(c), kind, id)
		if err != nil {
			skillError(c, err)
			return
		}
		if len(detail.Versions) > 0 {
			version := &detail.Versions[0]
			progress := version.LocalApproval
			if progress != nil {
				item.WorkflowStage = progress.WorkflowStage
				admin, err := opts.RBACService.HasPermission(c.Request.Context(), currentUserID(c), rbac.PermissionSkillSpaceUpdate)
				if err != nil {
					skillError(c, err)
					return
				}
				item.CanRetryAI = progress.Status == "pending" && version.ApprovalStatus == "pending" && (currentUserID(c) == version.UploadedByUserID || admin) && progress.AIReview != nil && progress.AIReview.Status == "failed" && progress.AIReview.ErrorCode != "materials_unsupported" && item.MaterialsAvailable
				progress.CanRetryAI, progress.CanSubmitReview = item.CanRetryAI, item.CanProcess
			}
		}

		sync, resolve := false, false
		if kind == "skill_external" && item.MaterialsAvailable && opts.DingTalkAuth.OAEnabled && opts.DingTalkAuth.OAClient != nil {
			allowed, err := opts.RBACService.HasPermission(c.Request.Context(), currentUserID(c), rbac.PermissionSkillPublish)
			if err != nil {
				skillError(c, err)
				return
			}
			latest, err := opts.SkillHubService.GetApproval(c.Request.Context(), item.SkillID, item.VersionID)
			if err != nil {
				skillError(c, err)
				return
			}
			if allowed && latest.ID == item.ID {
				sync = latest.ProviderInstanceID != "" && latest.Status == "running"
				resolve = latest.Status == "submitting" || latest.Status == "uncertain"
			}
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"item": item, "skill": detail, "actions": gin.H{"sync": sync, "resolve": resolve}}})
	})
	if opts.SkillHubService == nil {
		return
	}
	skillRead := requirePermission(opts.RBACService, rbac.PermissionSkillRead)
	admin.GET("/approvals/:kind/:id/files", skillRead, func(c *gin.Context) {
		items, err := opts.SkillHubService.ListAdminApprovalFiles(c.Request.Context(), currentUserID(c), c.Param("kind"), c.Param("id"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	})
	admin.GET("/approvals/:kind/:id/file", skillRead, func(c *gin.Context) {
		item, err := opts.SkillHubService.ReadAdminApprovalFile(c.Request.Context(), currentUserID(c), c.Param("kind"), c.Param("id"), c.Query("path"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	})
	admin.GET("/approvals/:kind/:id/package", skillOperationLog(opts.Logger, skillActionDownload), skillRead, func(c *gin.Context) {
		item, err := opts.SkillHubService.OpenAdminApprovalPackage(c.Request.Context(), currentUserID(c), c.Param("kind"), c.Param("id"))
		if err != nil {
			skillError(c, err)
			return
		}
		defer item.Reader.Close()
		c.Set(skillIDKey, item.Detail.SkillID)
		c.Set(skillVersionKey, item.Detail.VersionID)
		c.Set(skillSHAKey, item.Detail.PackageSHA256)
		c.Header("Content-Type", "application/zip")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", item.Filename))
		c.Header("Content-Length", fmt.Sprintf("%d", item.Size))
		c.Status(http.StatusOK)
		_, _ = io.Copy(c.Writer, item.Reader)
	})
}
