package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

type skillReviewCursor struct {
	User   string    `json:"user"`
	Stage  string    `json:"stage"`
	Status string    `json:"status,omitempty"`
	Time   time.Time `json:"time"`
	ID     string    `json:"id"`
}

func mountSkillReviewWorkflowRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.SkillHubService == nil {
		return
	}
	admin.GET("/skill-review-workflow", requirePermission(opts.RBACService, rbac.PermissionWorkflowTemplateManage), func(c *gin.Context) {
		c.JSON(200, gin.H{"data": gin.H{"id": "builtin:skill-review", "name": "Skill 审批工作流", "read_only": true, "trigger": "upload", "review_skill": "skill-review", "steps": []gin.H{
			{"name": "上传", "rule": "配置本地人工审核名单或角色的空间中，人工上传触发新版本与新轮次；Git 同步、钉钉和无名单空间沿用原流程。"},
			{"name": "基础校验", "rule": "校验 ZIP、路径、大小、特殊文件及 SKILL.md 必填项；不合格直接拒绝上传。"},
			{"name": "AI 评估", "rule": "唯一服务端 Agent 使用可信 skill-review 静态分析。只有有效通过报告才能进入人工；需修改时上传新版本，技术异常可重试。"},
			{"name": "人工评分", "rule": "本轮名单全员评审，任一驳回即不通过。每人按场景价值、结果有效性、使用便利性、复用价值分别评 1–5 分。"},
			{"name": "分值汇总", "rule": "全员通过后各维度取平均再相加，满分 20；AI 建议分不参与。仍需按现有入口手动发布。"},
		}}})
	})
	admin.GET("/skill-review-workflow/runs", requirePermission(opts.RBACService, rbac.PermissionWorkflowInstanceRead), requirePermission(opts.RBACService, rbac.PermissionSkillRead), func(c *gin.Context) {
		limit, raw, ok := workflowPage(c)
		if !ok {
			return
		}
		cursor := skillReviewCursor{User: currentUserID(c), Stage: c.Query("stage"), Status: c.Query("status")}
		if cursor.Status == "all" {
			cursor.Status = ""
		}
		if !skillhub.ValidReviewWorkflowStage(cursor.Stage) || !skillhub.ValidReviewWorkflowStatus(cursor.Status) {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if raw != "" {
			data, err := base64.RawURLEncoding.DecodeString(raw)
			if err != nil || len(raw) > 4096 {
				skillError(c, skillhub.ErrInvalidRequest)
				return
			}
			var decoded skillReviewCursor
			decoder := json.NewDecoder(bytes.NewReader(data))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&decoded) != nil || decoder.Decode(new(any)) != io.EOF || decoded.User != cursor.User || decoded.Stage != cursor.Stage || decoded.Status != cursor.Status || decoded.Time.IsZero() || decoded.ID == "" {
				skillError(c, skillhub.ErrInvalidRequest)
				return
			}
			cursor = decoded
		}
		items, err := opts.SkillHubService.ListReviewWorkflowRuns(c.Request.Context(), cursor.User, skillhub.ReviewWorkflowQuery{Stage: cursor.Stage, Status: cursor.Status, BeforeTime: cursor.Time, BeforeID: cursor.ID, Limit: limit + 1})
		if err != nil {
			skillError(c, err)
			return
		}
		next := ""
		if len(items) > limit {
			items = items[:limit]
			last := items[limit-1]
			cursor.Time, cursor.ID = last.CreatedAt, last.RequestID
			encoded, _ := json.Marshal(cursor)
			next = base64.RawURLEncoding.EncodeToString(encoded)
		}
		workflowList(c, items, next)
	})
}
