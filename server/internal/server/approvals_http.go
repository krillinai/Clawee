package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/skillhub"
	"github.com/krillinai/Clawee/server/internal/workflow"
)

type approvalItem struct {
	Kind           string     `json:"kind"`
	ID             string     `json:"id"`
	Type           string     `json:"type"`
	Title          string     `json:"title"`
	BusinessStatus string     `json:"business_status"`
	MyStatus       string     `json:"my_status"`
	CreatedAt      time.Time  `json:"created_at"`
	CanProcess     bool       `json:"can_process"`
	ActedAt        *time.Time `json:"acted_at,omitempty"`
	InitiatedBy    string     `json:"initiated_by,omitempty"`
	SkillID        string     `json:"skill_id,omitempty"`
	VersionID      string     `json:"version_id,omitempty"`
	Version        string     `json:"version,omitempty"`
	RequestID      string     `json:"request_id,omitempty"`
	InstanceID     string     `json:"instance_id,omitempty"`
	TaskID         string     `json:"task_id,omitempty"`
}

type approvalCursor struct {
	User   string    `json:"user"`
	View   string    `json:"view"`
	Type   string    `json:"type"`
	Status string    `json:"status"`
	Time   time.Time `json:"time"`
	Kind   string    `json:"kind"`
	ID     string    `json:"id"`
}

func skillApprovalItem(item skillhub.PersonalApproval) approvalItem {
	return approvalItem{Kind: "skill", ID: item.RequestID, Type: "skill", Title: item.Title, BusinessStatus: item.Status, MyStatus: item.MyStatus, CreatedAt: item.CreatedAt, CanProcess: item.CanProcess, ActedAt: item.ActedAt, InitiatedBy: item.InitiatedBy, SkillID: item.SkillID, VersionID: item.VersionID, Version: item.Version, RequestID: item.RequestID}
}

func workflowApprovalItem(item workflow.ApprovalRecord) approvalItem {
	return approvalItem{Kind: item.Kind, ID: item.ID, Type: "workflow", Title: item.Title, BusinessStatus: item.Status, MyStatus: item.MyStatus, CreatedAt: item.CreatedAt, CanProcess: item.CanProcess, ActedAt: item.ActedAt, InitiatedBy: item.StartedBy, InstanceID: item.InstanceID, TaskID: item.TaskID}
}

func approvalPage(c *gin.Context) (approvalCursor, int, bool) {
	filter := approvalCursor{User: currentUserID(c), View: c.DefaultQuery("view", "todo"), Type: c.DefaultQuery("type", "all"), Status: c.DefaultQuery("status", "all")}
	limit, raw, valid := workflowPage(c)
	if !valid {
		return filter, 0, false
	}
	if (filter.View != "todo" && filter.View != "done" && filter.View != "initiated") || (filter.Type != "all" && filter.Type != "skill" && filter.Type != "workflow") {
		workflowError(c, workflow.ErrInvalid)
		return filter, 0, false
	}
	switch filter.Status {
	case "all", "pending", "approved", "rejected", "invalidated", "running", "succeeded", "terminated":
	default:
		workflowError(c, workflow.ErrInvalid)
		return filter, 0, false
	}
	if raw == "" {
		return filter, limit, true
	}
	if len(raw) > 4096 {
		workflowError(c, workflow.ErrInvalid)
		return filter, 0, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		workflowError(c, workflow.ErrInvalid)
		return filter, 0, false
	}
	var cursor approvalCursor
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&cursor)
	validKind := cursor.Kind == "skill" || cursor.Kind == "workflow" || cursor.Kind == "workflow_instance"
	matchesType := filter.Type == "all" || (filter.Type == "skill" && cursor.Kind == "skill") || (filter.Type == "workflow" && cursor.Kind != "skill")
	matchesView := cursor.Kind == "skill" || (filter.View == "initiated" && cursor.Kind == "workflow_instance") || (filter.View != "initiated" && cursor.Kind == "workflow")
	if decodeErr != nil || decoder.Decode(new(any)) != io.EOF || cursor.User != filter.User || cursor.View != filter.View || cursor.Type != filter.Type || cursor.Status != filter.Status || cursor.Time.IsZero() || cursor.ID == "" || !validKind || !matchesType || !matchesView {
		workflowError(c, workflow.ErrInvalid)
		return filter, 0, false
	}
	return cursor, limit, true
}

func mountApprovalRoutes(app *gin.RouterGroup, opts Options) {
	if opts.AccountService == nil {
		return
	}
	app.GET("/approvals", func(c *gin.Context) {
		filter, limit, valid := approvalPage(c)
		if !valid {
			return
		}
		items := []approvalItem{}
		if opts.SkillHubService != nil && opts.RBACService != nil && filter.Type != "workflow" {
			allowed, err := opts.RBACService.HasPermission(c.Request.Context(), filter.User, rbac.PermissionSkillRead)
			if err != nil {
				skillError(c, err)
				return
			}
			if allowed {
				records, err := opts.SkillHubService.ListPersonalApprovals(c.Request.Context(), filter.User, skillhub.PersonalApprovalQuery{View: filter.View, Status: filter.Status, BeforeTime: filter.Time, BeforeKind: filter.Kind, BeforeID: filter.ID, Limit: limit + 1})
				if err != nil {
					skillError(c, err)
					return
				}
				for _, record := range records {
					items = append(items, skillApprovalItem(record))
				}
			}
		}
		if opts.WorkflowService != nil && opts.WorkflowService.DB != nil && filter.Type != "skill" {
			records, err := opts.WorkflowService.Approvals(c.Request.Context(), filter.User, workflow.ApprovalQuery{View: filter.View, Status: filter.Status, BeforeTime: filter.Time, BeforeKind: filter.Kind, BeforeID: filter.ID, Limit: limit + 1})
			if err != nil {
				workflowError(c, err)
				return
			}
			for _, record := range records {
				items = append(items, workflowApprovalItem(record))
			}
		}
		sort.Slice(items, func(left, right int) bool {
			if !items[left].CreatedAt.Equal(items[right].CreatedAt) {
				return items[left].CreatedAt.After(items[right].CreatedAt)
			}
			if items[left].Kind != items[right].Kind {
				return items[left].Kind > items[right].Kind
			}
			return items[left].ID > items[right].ID
		})
		next := ""
		if len(items) > limit {
			items = items[:limit]
			last := items[limit-1]
			filter.Time, filter.Kind, filter.ID = last.CreatedAt, last.Kind, last.ID
			encoded, _ := json.Marshal(filter)
			next = base64.RawURLEncoding.EncodeToString(encoded)
		}
		workflowList(c, items, next)
	})
	detailHandler := func(c *gin.Context) {
		if c.Param("kind") == "skill" || c.FullPath() == "/api/v1/app/approvals/skill/:id" {
			if opts.SkillHubService == nil {
				skillError(c, skillhub.ErrNotFound)
				return
			}
			if !authorizePermission(c, opts.RBACService, rbac.PermissionSkillRead) {
				return
			}
			item, detail, err := opts.SkillHubService.GetPersonalApproval(c.Request.Context(), currentUserID(c), c.Param("id"))
			if err != nil {
				skillError(c, err)
				return
			}
			c.JSON(http.StatusOK, gin.H{"data": gin.H{"item": skillApprovalItem(item), "skill": detail}})
			return
		}
		if c.Param("kind") != "workflow" && c.Param("kind") != "workflow_instance" {
			workflowError(c, workflow.ErrInvalid)
			return
		}
		if opts.WorkflowService == nil || opts.WorkflowService.DB == nil {
			workflowError(c, workflow.ErrMissing)
			return
		}
		item, instance, task, err := opts.WorkflowService.Approval(c.Request.Context(), currentUserID(c), c.Param("kind"), c.Param("id"))
		if err != nil {
			workflowError(c, err)
			return
		}
		instances := []workflow.Instance{instance}
		if !workflowInstanceNames(c, opts.WorkflowService, instances) {
			return
		}
		detail := gin.H{"item": workflowApprovalItem(item), "workflow": instances[0]}
		if task != nil {
			detail["task"] = task
		}
		c.JSON(http.StatusOK, gin.H{"data": detail})
	}
	app.GET("/approvals/:kind/:id", detailHandler)
	if opts.SkillHubService == nil {
		return
	}
	app.GET("/approvals/skill/:id", detailHandler)
	read := requirePermission(opts.RBACService, rbac.PermissionSkillRead)
	app.POST("/approvals/skill/:id/decision", skillOperationLog(opts.Logger, "skill_review"), read, func(c *gin.Context) {
		var body struct {
			Decision string                 `json:"decision"`
			Comment  string                 `json:"comment"`
			Scores   *skillhub.ReviewScores `json:"scores"`
		}
		if decodeSkillJSON(c, &body) != nil || (body.Decision != "approved" && body.Decision != "rejected") {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		item, detail, err := opts.SkillHubService.GetPersonalApproval(c.Request.Context(), currentUserID(c), c.Param("id"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.Set(skillIDKey, item.SkillID)
		c.Set(skillVersionKey, item.VersionID)
		c.Set(skillSpaceIDKey, detail.Skill.SpaceID)
		c.Set(skillReviewDecisionKey, body.Decision)
		version, err := opts.SkillHubService.ReviewVersion(c.Request.Context(), item.SkillID, item.VersionID, currentUserID(c), body.Decision == "approved", body.Comment, skillhub.ReviewInput{RequestID: item.RequestID, Scores: body.Scores})
		if err != nil {
			skillError(c, err)
			return
		}
		c.Set(skillSHAKey, version.PackageSHA256)
		c.JSON(http.StatusOK, gin.H{"data": version})
	})
	app.GET("/approvals/skill/:id/files", read, func(c *gin.Context) {
		items, err := opts.SkillHubService.ListApprovalRequestFiles(c.Request.Context(), currentUserID(c), c.Param("id"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	})
	app.GET("/approvals/skill/:id/file", read, func(c *gin.Context) {
		item, err := opts.SkillHubService.ReadApprovalRequestFile(c.Request.Context(), currentUserID(c), c.Param("id"), c.Query("path"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	})
	app.GET("/approvals/skill/:id/package", skillOperationLog(opts.Logger, skillActionDownload), read, func(c *gin.Context) {
		item, err := opts.SkillHubService.OpenApprovalRequestPackage(c.Request.Context(), currentUserID(c), c.Param("id"))
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
