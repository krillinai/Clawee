package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/workflow"
)

func workflowError(c *gin.Context, err error) {
	status, code, message := 500, "internal_error", "工作流操作失败"
	switch {
	case errors.Is(err, workflow.ErrInvalid):
		status, code, message = 400, "invalid_request", "请求字段无效"
	case errors.Is(err, workflow.ErrLarge):
		status, code, message = 413, "payload_too_large", "输入或输出超过 1 MiB"
	case errors.Is(err, workflow.ErrMissing):
		status, code, message = 404, "not_found", "资源不存在"
	case errors.Is(err, workflow.ErrForbidden):
		status, code, message = 403, "forbidden", "无权操作"
	case errors.Is(err, workflow.ErrConflict):
		status, code, message = 409, "conflict", "状态或幂等键冲突"
	}
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}

func workflowPage(c *gin.Context) (int, string, bool) {
	limit := 20
	if raw := c.Query("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 50 {
			workflowError(c, workflow.ErrInvalid)
			return 0, "", false
		}
	}
	return limit, c.Query("cursor"), true
}

func workflowBody(c *gin.Context, value any) bool {
	if c.Request.ContentLength > 2<<20 {
		workflowError(c, workflow.ErrLarge)
		return false
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
	if err := c.ShouldBindJSON(value); err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			workflowError(c, workflow.ErrLarge)
		} else {
			workflowError(c, workflow.ErrInvalid)
		}
		return false
	}
	return true
}

func workflowList(c *gin.Context, data any, cursor string) {
	c.JSON(200, gin.H{"data": data, "meta": gin.H{"next_cursor": cursor, "has_next": cursor != ""}})
}

func workflowInstanceNames(c *gin.Context, s *workflow.Service, items []workflow.Instance) bool {
	ids := make(map[string]struct{})
	for _, item := range items {
		if item.StartedBy != "" {
			ids[item.StartedBy] = struct{}{}
		}
		for _, node := range item.Nodes {
			if node.Assignee != "" {
				ids[node.Assignee] = struct{}{}
			}
		}
		for _, task := range item.Tasks {
			if task.Assignee != "" {
				ids[task.Assignee] = struct{}{}
			}
			if task.HandledBy != "" {
				ids[task.HandledBy] = struct{}{}
			}
		}
	}
	if len(ids) == 0 {
		return true
	}
	userIDs := make([]string, 0, len(ids))
	for id := range ids {
		userIDs = append(userIDs, id)
	}
	rows, err := s.DB.Query(c.Request.Context(), `SELECT user_id,name,email FROM accounts WHERE user_id = ANY($1)`, userIDs)
	if err != nil {
		workflowError(c, err)
		return false
	}
	defer rows.Close()
	names := make(map[string]string, len(userIDs))
	for rows.Next() {
		var id, name, email string
		if err = rows.Scan(&id, &name, &email); err != nil {
			workflowError(c, err)
			return false
		}
		if name == "" {
			name = email
		}
		if name == "" {
			name = "未命名账号"
		}
		names[id] = name
	}
	if err = rows.Err(); err != nil {
		workflowError(c, err)
		return false
	}
	for index := range items {
		items[index].UserNames = make(map[string]string)
		item := &items[index]
		if name, ok := names[item.StartedBy]; ok {
			item.UserNames[item.StartedBy] = name
		}
		for _, node := range item.Nodes {
			if name, ok := names[node.Assignee]; ok {
				item.UserNames[node.Assignee] = name
			}
		}
		for _, task := range item.Tasks {
			if name, ok := names[task.Assignee]; ok {
				item.UserNames[task.Assignee] = name
			}
			if name, ok := names[task.HandledBy]; ok {
				item.UserNames[task.HandledBy] = name
			}
		}
	}
	return true
}

func mountWorkflowRoutes(app, admin *gin.RouterGroup, opts Options) {
	s := opts.WorkflowService
	if s == nil || s.DB == nil || opts.AccountService == nil {
		return
	}
	admin.GET("/workflow-templates", requirePermission(opts.RBACService, rbac.PermissionWorkflowTemplateManage), func(c *gin.Context) {
		limit, cursor, ok := workflowPage(c)
		if !ok {
			return
		}
		items, next, err := s.Templates(c.Request.Context(), "", true, limit, cursor)
		if err != nil {
			workflowError(c, err)
			return
		}
		workflowList(c, items, next)
	})
	admin.GET("/workflow-assignees", requirePermission(opts.RBACService, rbac.PermissionWorkflowTemplateManage), func(c *gin.Context) {
		query := strings.TrimSpace(c.Query("q"))
		if len(query) > 100 {
			workflowError(c, workflow.ErrInvalid)
			return
		}
		rows, err := s.DB.Query(c.Request.Context(), `SELECT user_id,name,email FROM accounts WHERE status='active' AND ($1='' OR user_id ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%') ORDER BY CASE WHEN user_id=$1 THEN 0 ELSE 1 END,name,user_id LIMIT 50`, query)
		if err != nil {
			workflowError(c, err)
			return
		}
		defer rows.Close()
		items := []gin.H{}
		for rows.Next() {
			var id, name, email string
			if err = rows.Scan(&id, &name, &email); err != nil {
				workflowError(c, err)
				return
			}
			items = append(items, gin.H{"user_id": id, "name": name, "email": email})
		}
		if err = rows.Err(); err != nil {
			workflowError(c, err)
			return
		}
		workflowList(c, items, "")
	})
	admin.GET("/workflow-templates/:id", requirePermission(opts.RBACService, rbac.PermissionWorkflowTemplateManage), func(c *gin.Context) {
		item, err := s.Template(c.Request.Context(), c.Param("id"), "", true)
		if err != nil {
			workflowError(c, err)
			return
		}
		c.JSON(200, gin.H{"data": item})
	})
	type saveRequest struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Expected    int             `json:"expected_revision"`
		Nodes       []workflow.Node `json:"nodes"`
	}
	save := func(c *gin.Context) {
		var body saveRequest
		if !workflowBody(c, &body) {
			return
		}
		item, err := s.Save(c.Request.Context(), currentUserID(c), c.Param("id"), body.Name, body.Description, body.Expected, body.Nodes)
		if err != nil {
			workflowError(c, err)
			return
		}
		c.JSON(200, gin.H{"data": item})
	}
	admin.POST("/workflow-templates", requirePermission(opts.RBACService, rbac.PermissionWorkflowTemplateManage), save)
	admin.PUT("/workflow-templates/:id", requirePermission(opts.RBACService, rbac.PermissionWorkflowTemplateManage), save)
	for _, enable := range []bool{true, false} {
		path := "/disable"
		if enable {
			path = "/enable"
		}
		admin.POST("/workflow-templates/:id"+path, requirePermission(opts.RBACService, rbac.PermissionWorkflowTemplateManage), func(c *gin.Context) {
			item, err := s.SetStatus(c.Request.Context(), c.Param("id"), currentUserID(c), enable)
			if err != nil {
				workflowError(c, err)
				return
			}
			c.JSON(200, gin.H{"data": item})
		})
	}
	admin.GET("/workflow-instances", requirePermission(opts.RBACService, rbac.PermissionWorkflowInstanceRead), func(c *gin.Context) {
		limit, cursor, ok := workflowPage(c)
		if !ok {
			return
		}
		items, next, err := s.Instances(c.Request.Context(), "", true, c.DefaultQuery("status", "all"), limit, cursor)
		if err != nil {
			workflowError(c, err)
			return
		}
		if !workflowInstanceNames(c, s, items) {
			return
		}
		workflowList(c, items, next)
	})
	admin.GET("/workflow-instances/:id", requirePermission(opts.RBACService, rbac.PermissionWorkflowInstanceRead), func(c *gin.Context) {
		item, err := s.Instance(c.Request.Context(), c.Param("id"), "", true)
		if err != nil {
			workflowError(c, err)
			return
		}
		items := []workflow.Instance{item}
		if !workflowInstanceNames(c, s, items) {
			return
		}
		c.JSON(200, gin.H{"data": items[0]})
	})
	admin.POST("/workflow-instances/:id/terminate", requirePermission(opts.RBACService, rbac.PermissionWorkflowInstanceTerminate), func(c *gin.Context) {
		var body struct {
			Reason string `json:"reason"`
		}
		if !workflowBody(c, &body) {
			return
		}
		err := s.Terminate(c.Request.Context(), c.Param("id"), currentUserID(c), body.Reason)
		if err != nil {
			workflowError(c, err)
			return
		}
		item, err := s.Instance(c.Request.Context(), c.Param("id"), "", true)
		if err != nil {
			workflowError(c, err)
			return
		}
		c.JSON(200, gin.H{"data": item})
	})
	app.GET("/workflow-templates", func(c *gin.Context) {
		limit, cursor, ok := workflowPage(c)
		if !ok {
			return
		}
		items, next, err := s.Templates(c.Request.Context(), currentUserID(c), false, limit, cursor)
		if err != nil {
			workflowError(c, err)
			return
		}
		workflowList(c, items, next)
	})
	app.GET("/workflow-templates/:id", func(c *gin.Context) {
		item, err := s.Template(c.Request.Context(), c.Param("id"), currentUserID(c), false)
		if err != nil {
			workflowError(c, err)
			return
		}
		c.JSON(200, gin.H{"data": item})
	})
	app.POST("/workflow-templates/:id/instances", func(c *gin.Context) {
		var body struct {
			Input json.RawMessage `json:"initial_input"`
			Key   string          `json:"idempotency_key"`
		}
		if !workflowBody(c, &body) {
			return
		}
		result, err := s.Start(c.Request.Context(), c.Param("id"), currentUserID(c), body.Key, body.Input)
		if err != nil {
			workflowError(c, err)
			return
		}
		c.JSON(200, gin.H{"data": result})
	})
	app.GET("/workflow-instances", func(c *gin.Context) {
		limit, cursor, ok := workflowPage(c)
		if !ok {
			return
		}
		items, next, err := s.Instances(c.Request.Context(), currentUserID(c), false, c.Query("status"), limit, cursor)
		if err != nil {
			workflowError(c, err)
			return
		}
		workflowList(c, items, next)
	})
	app.GET("/workflow-instances/:id", func(c *gin.Context) {
		item, err := s.Instance(c.Request.Context(), c.Param("id"), currentUserID(c), false)
		if err != nil {
			workflowError(c, err)
			return
		}
		c.JSON(200, gin.H{"data": item})
	})
	app.GET("/workflow-tasks", func(c *gin.Context) {
		limit, cursor, ok := workflowPage(c)
		if !ok {
			return
		}
		items, next, err := s.Tasks(c.Request.Context(), currentUserID(c), "", limit, cursor)
		if err != nil {
			workflowError(c, err)
			return
		}
		workflowList(c, items, next)
	})
	app.GET("/workflow-tasks/:id", func(c *gin.Context) {
		item, err := s.Task(c.Request.Context(), c.Param("id"), currentUserID(c), "")
		if err != nil {
			workflowError(c, err)
			return
		}
		c.JSON(200, gin.H{"data": item})
	})
	app.POST("/workflow-tasks/:id/decision", func(c *gin.Context) {
		var body struct {
			Decision string `json:"decision"`
			Comment  string `json:"comment"`
			Key      string `json:"idempotency_key"`
		}
		if !workflowBody(c, &body) {
			return
		}
		result, err := s.Complete(c.Request.Context(), c.Param("id"), currentUserID(c), "", body.Key, body.Decision, body.Comment, nil)
		if err != nil {
			workflowError(c, err)
			return
		}
		c.JSON(200, gin.H{"data": result})
	})
}
