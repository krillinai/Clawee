package server

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/knowledge"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type createKnowledgeBaseRequest struct {
	KnowledgeBaseID string `json:"knowledge_base_id"`
	Name            string `json:"name"`
	Description     string `json:"description"`
}

type updateKnowledgeBaseRequest struct {
	KnowledgeBaseID string  `json:"knowledge_base_id"`
	Name            *string `json:"name"`
	Description     *string `json:"description"`
}

type knowledgeBaseActionRequest struct {
	KnowledgeBaseID string `json:"knowledge_base_id"`
	DocumentID      string `json:"document_id"`
}

type dataResourceGrantRequest struct {
	UserID          string   `json:"user_id"`
	KnowledgeBaseID string   `json:"knowledge_base_id"`
	Actions         []string `json:"actions"`
}

type knowledgeMemberResponse struct {
	UserID        string    `json:"user_id"`
	Name          string    `json:"name"`
	Email         string    `json:"email"`
	AccountStatus string    `json:"account_status"`
	Actions       []string  `json:"actions"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type knowledgeMemberCandidateResponse struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
}

type appKnowledgeBaseResponse struct {
	KnowledgeBaseID string                         `json:"knowledge_base_id"`
	Name            string                         `json:"name"`
	Description     string                         `json:"description"`
	Status          string                         `json:"status"`
	DocumentCount   int                            `json:"document_count"`
	Permissions     appKnowledgePermissionResponse `json:"permissions"`
}

type appKnowledgePermissionResponse struct {
	Read   bool `json:"read"`
	Upload bool `json:"upload"`
	MCP    bool `json:"mcp"`
}

func mountKnowledgeAppRoutes(app *gin.RouterGroup, opts Options) {
	if opts.KnowledgeService == nil || opts.DataAccessService == nil || opts.AccountService == nil {
		return
	}
	app.GET("/knowledge-bases", func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{
			UserID: account.UserID, ResourceType: dataaccess.ResourceKnowledgeBase,
		})
		if err != nil {
			dataAccessError(c, err)
			return
		}
		permissions := knowledgePermissionsByResource(grants)
		items, err := opts.KnowledgeService.ListKnowledgeBases(c.Request.Context())
		if err != nil {
			knowledgeError(c, err)
			return
		}
		out := make([]appKnowledgeBaseResponse, 0, len(items))
		for _, item := range items {
			permission := permissions[item.KnowledgeBaseID]
			if !permission.Read {
				continue
			}
			out = append(out, appKnowledgeBaseResponse{
				KnowledgeBaseID: item.KnowledgeBaseID, Name: item.Name, Description: item.Description,
				Status: item.Status, DocumentCount: item.DocumentCount, Permissions: permission,
			})
		}
		c.JSON(http.StatusOK, itemsResponse(out))
	})
	app.GET("/knowledge-bases/documents", func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		id := knowledgeBaseID(c)
		if !requireAccountKnowledgeAction(c, opts.DataAccessService, account.UserID, id, dataaccess.ActionRead) {
			return
		}
		items, err := opts.KnowledgeService.ListDocuments(c.Request.Context(), id)
		if err != nil {
			knowledgeError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	})
	app.POST("/knowledge-bases/documents", func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		handleKnowledgeDocumentUpload(c, opts.KnowledgeService, func(id string) bool {
			if !requireAccountKnowledgeAction(c, opts.DataAccessService, account.UserID, id, dataaccess.ActionRead) {
				return false
			}
			allowed, err := opts.DataAccessService.HasAction(c.Request.Context(), account.UserID, dataaccess.ResourceKnowledgeBase, id, dataaccess.ActionUpload)
			if err != nil {
				dataAccessError(c, err)
				return false
			}
			if !allowed {
				abortAuthorizationError(c, http.StatusForbidden, "document_upload_forbidden", "无权上传知识库文档")
				return false
			}
			return true
		})
	})
}

func mountKnowledgeAdminRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.KnowledgeService == nil {
		return
	}
	service := opts.KnowledgeService
	list := func(c *gin.Context) {
		items, err := service.ListKnowledgeBases(c.Request.Context())
		if err != nil {
			knowledgeError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
	create := func(c *gin.Context) {
		var req createKnowledgeBaseRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			knowledgeError(c, knowledge.ErrInvalidRequest)
			return
		}
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		item, err := service.CreateKnowledgeBase(c.Request.Context(), knowledge.CreateKnowledgeBaseInput{Name: req.Name, Description: req.Description, CreatedBy: account.DisplayName()})
		if err != nil {
			knowledgeError(c, err)
			return
		}
		c.JSON(http.StatusCreated, item)
	}
	detail := func(c *gin.Context) {
		item, err := service.GetKnowledgeBase(c.Request.Context(), knowledgeBaseID(c))
		if err != nil {
			knowledgeError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
	update := func(c *gin.Context) {
		var req updateKnowledgeBaseRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			knowledgeError(c, knowledge.ErrInvalidRequest)
			return
		}
		item, err := service.UpdateKnowledgeBase(c.Request.Context(), knowledge.UpdateKnowledgeBaseInput{
			KnowledgeBaseID: req.KnowledgeBaseID,
			Name:            req.Name,
			Description:     req.Description,
		})
		if err != nil {
			knowledgeError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
	remove := func(c *gin.Context) {
		id := knowledgeBaseID(c)
		if c.Request.Method == http.MethodPost {
			var req knowledgeBaseActionRequest
			if err := c.ShouldBindJSON(&req); err != nil {
				knowledgeError(c, knowledge.ErrInvalidRequest)
				return
			}
			id = strings.TrimSpace(req.KnowledgeBaseID)
		}
		if opts.DataAccessService != nil {
			hasGrants, err := opts.DataAccessService.HasResourceGrants(c.Request.Context(), dataaccess.ResourceKnowledgeBase, id)
			if err != nil {
				dataAccessError(c, err)
				return
			}
			if hasGrants {
				knowledgeError(c, knowledge.ErrKnowledgeBaseHasAccountGrants)
				return
			}
		}
		if err := service.DeleteKnowledgeBase(c.Request.Context(), id); err != nil {
			knowledgeError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
	listDocuments := func(c *gin.Context) {
		items, err := service.ListDocuments(c.Request.Context(), knowledgeBaseID(c))
		if err != nil {
			knowledgeError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
	syncDocuments := func(c *gin.Context) {
		var req knowledgeBaseActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			knowledgeError(c, knowledge.ErrInvalidRequest)
			return
		}
		id := strings.TrimSpace(req.KnowledgeBaseID)
		if id == "" {
			knowledgeError(c, knowledge.ErrInvalidRequest)
			return
		}
		items, err := service.SyncDocuments(c.Request.Context(), id)
		if err != nil {
			knowledgeError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
	removeDocument := func(c *gin.Context) {
		var req knowledgeBaseActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			knowledgeError(c, knowledge.ErrInvalidRequest)
			return
		}
		if err := service.DeleteDocument(c.Request.Context(), strings.TrimSpace(req.KnowledgeBaseID), strings.TrimSpace(req.DocumentID)); err != nil {
			knowledgeError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
	read := requirePermission(opts.RBACService, rbac.PermissionKnowledgeRead)
	admin.GET("/knowledge-bases", read, list)
	admin.GET("/knowledge-bases/detail", read, detail)
	admin.POST("/knowledge-bases", requirePermission(opts.RBACService, rbac.PermissionKnowledgeCreate), create)
	admin.PATCH("/knowledge-bases", requirePermission(opts.RBACService, rbac.PermissionKnowledgeUpdate), update)
	admin.POST("/knowledge-bases/remove", requirePermission(opts.RBACService, rbac.PermissionKnowledgeDelete), remove)
	admin.GET("/knowledge-bases/documents", read, listDocuments)
	admin.POST("/knowledge-bases/documents", requirePermission(opts.RBACService, rbac.PermissionKnowledgeDocumentUpload), func(c *gin.Context) { handleKnowledgeDocumentUpload(c, service, nil) })
	admin.POST("/knowledge-bases/documents/sync", requirePermission(opts.RBACService, rbac.PermissionKnowledgeDocumentSync), syncDocuments)
	admin.POST("/knowledge-bases/documents/remove", requirePermission(opts.RBACService, rbac.PermissionKnowledgeDocumentDelete), removeDocument)
	if opts.DataAccessService != nil && opts.AccountService != nil {
		mountKnowledgeDataGrantRoutes(admin, opts, read, requirePermission(opts.RBACService, rbac.PermissionKnowledgeMemberUpdate))
	}
}

func mountKnowledgeDataGrantRoutes(admin *gin.RouterGroup, opts Options, read, memberUpdate gin.HandlerFunc) {
	list := func(c *gin.Context) {
		id := knowledgeBaseID(c)
		if id == "" {
			dataAccessError(c, dataaccess.ErrInvalidRequest)
			return
		}
		if _, err := opts.KnowledgeService.GetKnowledgeBase(c.Request.Context(), id); err != nil {
			knowledgeError(c, err)
			return
		}
		items, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{
			ResourceType: dataaccess.ResourceKnowledgeBase, ResourceID: id,
		})
		if err != nil {
			dataAccessError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
	createOrReplace := func(replace bool) gin.HandlerFunc {
		return func(c *gin.Context) {
			var req dataResourceGrantRequest
			if err := c.ShouldBindJSON(&req); err != nil {
				dataAccessError(c, dataaccess.ErrInvalidRequest)
				return
			}
			account, ok := currentAccount(c)
			if !ok {
				abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
				return
			}
			if !validateKnowledgeGrantTarget(c, opts, req.UserID, req.KnowledgeBaseID) {
				return
			}
			input := dataaccess.SetInput{
				UserID: req.UserID, ResourceType: dataaccess.ResourceKnowledgeBase,
				ResourceID: req.KnowledgeBaseID, Actions: req.Actions, CreatedBy: account.DisplayName(),
				OperatorID: account.UserID, RequestID: requestIDFromContext(c.Request.Context()),
			}
			var (
				items []dataaccess.Grant
				err   error
			)
			if replace {
				items, err = opts.DataAccessService.Replace(c.Request.Context(), input)
			} else {
				items, err = opts.DataAccessService.Create(c.Request.Context(), input)
			}
			if err != nil {
				dataAccessError(c, err)
				return
			}
			status := http.StatusCreated
			if replace {
				status = http.StatusOK
			}
			c.JSON(status, itemsResponse(items))
		}
	}
	remove := func(c *gin.Context) {
		var req dataResourceGrantRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			dataAccessError(c, dataaccess.ErrInvalidRequest)
			return
		}
		account, _ := currentAccount(c)
		if err := opts.DataAccessService.RemoveBy(c.Request.Context(), req.UserID, dataaccess.ResourceKnowledgeBase, req.KnowledgeBaseID, account.UserID, requestIDFromContext(c.Request.Context())); err != nil {
			dataAccessError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
	listMembers := func(c *gin.Context) {
		members, err := knowledgeMembers(c, opts)
		if err != nil {
			return
		}
		c.JSON(http.StatusOK, itemsResponse(members))
	}
	listCandidates := func(c *gin.Context) {
		members, err := knowledgeMembers(c, opts)
		if err != nil {
			return
		}
		granted := make(map[string]struct{}, len(members))
		for _, member := range members {
			granted[member.UserID] = struct{}{}
		}
		accountItems, err := opts.AccountService.ListAccounts(c.Request.Context())
		if err != nil {
			authError(c, err)
			return
		}
		query := strings.ToLower(strings.TrimSpace(c.Query("query")))
		items := make([]knowledgeMemberCandidateResponse, 0)
		for _, account := range accountItems {
			if account.Status != accounts.StatusActive {
				continue
			}
			if _, ok := granted[account.UserID]; ok {
				continue
			}
			name := account.DisplayName()
			if query != "" && !strings.Contains(strings.ToLower(strings.Join([]string{account.UserID, name, account.Email}, " ")), query) {
				continue
			}
			items = append(items, knowledgeMemberCandidateResponse{UserID: account.UserID, Name: name, Email: account.Email})
		}
		sort.Slice(items, func(i, j int) bool {
			return items[i].Name < items[j].Name || (items[i].Name == items[j].Name && items[i].UserID < items[j].UserID)
		})
		c.JSON(http.StatusOK, itemsResponse(items))
	}
	admin.GET("/knowledge-bases/account-grants", read, list)
	admin.POST("/knowledge-bases/account-grants", requirePermission(opts.RBACService, rbac.PermissionKnowledgeMemberCreate), createOrReplace(false))
	admin.PATCH("/knowledge-bases/account-grants", memberUpdate, createOrReplace(true))
	admin.POST("/knowledge-bases/account-grants/remove", requirePermission(opts.RBACService, rbac.PermissionKnowledgeMemberDelete), remove)
	admin.GET("/knowledge-bases/members", read, listMembers)
	admin.GET("/knowledge-bases/member-candidates", requirePermission(opts.RBACService, rbac.PermissionKnowledgeMemberCreate), listCandidates)
}

func knowledgeMembers(c *gin.Context, opts Options) ([]knowledgeMemberResponse, error) {
	id := knowledgeBaseID(c)
	if id == "" {
		dataAccessError(c, dataaccess.ErrInvalidRequest)
		return nil, dataaccess.ErrInvalidRequest
	}
	if _, err := opts.KnowledgeService.GetKnowledgeBase(c.Request.Context(), id); err != nil {
		knowledgeError(c, err)
		return nil, err
	}
	grants, err := opts.DataAccessService.List(c.Request.Context(), dataaccess.Filter{
		ResourceType: dataaccess.ResourceKnowledgeBase, ResourceID: id,
	})
	if err != nil {
		dataAccessError(c, err)
		return nil, err
	}
	accountItems, err := opts.AccountService.ListAccounts(c.Request.Context())
	if err != nil {
		authError(c, err)
		return nil, err
	}
	accountsByID := make(map[string]accounts.Account, len(accountItems))
	for _, account := range accountItems {
		accountsByID[account.UserID] = account
	}
	query := strings.ToLower(strings.TrimSpace(c.Query("query")))
	byUserID := map[string]*knowledgeMemberResponse{}
	for _, grant := range grants {
		member := byUserID[grant.UserID]
		if member == nil {
			account := accountsByID[grant.UserID]
			member = &knowledgeMemberResponse{
				UserID: grant.UserID, Name: account.DisplayName(), Email: account.Email,
				AccountStatus: account.Status, Actions: []string{}, UpdatedAt: grant.UpdatedAt,
			}
			if member.Name == "" {
				member.Name = grant.UserID
			}
			byUserID[grant.UserID] = member
		}
		member.Actions = append(member.Actions, grant.Action)
		if grant.UpdatedAt.After(member.UpdatedAt) {
			member.UpdatedAt = grant.UpdatedAt
		}
	}
	items := make([]knowledgeMemberResponse, 0, len(byUserID))
	for _, member := range byUserID {
		if query != "" && !strings.Contains(strings.ToLower(strings.Join([]string{member.UserID, member.Name, member.Email}, " ")), query) {
			continue
		}
		sort.Strings(member.Actions)
		items = append(items, *member)
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Name < items[j].Name || (items[i].Name == items[j].Name && items[i].UserID < items[j].UserID)
	})
	return items, nil
}

func handleKnowledgeDocumentUpload(c *gin.Context, service *knowledge.Service, authorize func(string) bool) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, knowledge.MaxDocumentSize+(1<<20))
	reader, err := c.Request.MultipartReader()
	if err != nil {
		knowledgeError(c, knowledge.ErrInvalidRequest)
		return
	}
	var knowledgeBaseID, fileName string
	var data []byte
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			knowledgeError(c, knowledge.ErrInvalidRequest)
			return
		}
		switch part.FormName() {
		case "knowledge_base_id":
			if knowledgeBaseID != "" || part.FileName() != "" {
				part.Close()
				knowledgeError(c, knowledge.ErrInvalidRequest)
				return
			}
			value, readErr := io.ReadAll(io.LimitReader(part, 1025))
			part.Close()
			knowledgeBaseID = strings.TrimSpace(string(value))
			if readErr != nil || knowledgeBaseID == "" || len(value) > 1024 {
				knowledgeError(c, knowledge.ErrInvalidRequest)
				return
			}
			if authorize != nil && !authorize(knowledgeBaseID) {
				return
			}
		case "file":
			if fileName != "" || part.FileName() == "" || (authorize != nil && knowledgeBaseID == "") {
				part.Close()
				knowledgeError(c, knowledge.ErrInvalidRequest)
				return
			}
			fileName = part.FileName()
			data, err = io.ReadAll(io.LimitReader(part, knowledge.MaxDocumentSize+1))
			part.Close()
			if err != nil || len(data) == 0 || int64(len(data)) > knowledge.MaxDocumentSize {
				knowledgeError(c, knowledge.ErrInvalidRequest)
				return
			}
		default:
			part.Close()
			knowledgeError(c, knowledge.ErrInvalidRequest)
			return
		}
	}
	if knowledgeBaseID == "" || fileName == "" {
		knowledgeError(c, knowledge.ErrInvalidRequest)
		return
	}
	written := int64(len(data))
	validated, err := knowledge.ValidateDocumentFile(fileName, written, bytes.NewReader(data))
	if err != nil {
		knowledgeError(c, err)
		return
	}
	uploadedBy := "admin"
	if account, ok := currentAccount(c); ok {
		uploadedBy = account.UserID
	}
	doc, err := service.UploadDocument(c.Request.Context(), knowledge.UploadDocumentInput{KnowledgeBaseID: knowledgeBaseID, Name: validated.Name, SizeBytes: written, MIMEType: validated.MIMEType, Reader: bytes.NewReader(data), UploadedBy: uploadedBy})
	if err != nil {
		knowledgeError(c, err)
		return
	}
	c.JSON(http.StatusCreated, doc)
}

func knowledgePermissionsByResource(grants []dataaccess.Grant) map[string]appKnowledgePermissionResponse {
	out := map[string]appKnowledgePermissionResponse{}
	for _, grant := range grants {
		permission := out[grant.ResourceID]
		switch grant.Action {
		case dataaccess.ActionRead:
			permission.Read = true
		case dataaccess.ActionUpload:
			permission.Upload = true
		case dataaccess.ActionMCP:
			permission.MCP = true
		}
		out[grant.ResourceID] = permission
	}
	return out
}

func requireAccountKnowledgeAction(c *gin.Context, service *dataaccess.Service, userID, knowledgeBaseID, action string) bool {
	knowledgeBaseID = strings.TrimSpace(knowledgeBaseID)
	if knowledgeBaseID == "" {
		knowledgeError(c, knowledge.ErrInvalidRequest)
		return false
	}
	allowed, err := service.HasAction(c.Request.Context(), userID, dataaccess.ResourceKnowledgeBase, knowledgeBaseID, action)
	if err != nil {
		dataAccessError(c, err)
		return false
	}
	if !allowed {
		abortAuthorizationError(c, http.StatusNotFound, "knowledge_base_not_found", "知识库不存在")
		return false
	}
	return true
}

func validateKnowledgeGrantTarget(c *gin.Context, opts Options, userID, knowledgeBaseID string) bool {
	userID, knowledgeBaseID = strings.TrimSpace(userID), strings.TrimSpace(knowledgeBaseID)
	if userID == "" || knowledgeBaseID == "" {
		dataAccessError(c, dataaccess.ErrInvalidRequest)
		return false
	}
	account, err := opts.AccountService.Account(c.Request.Context(), userID)
	if err != nil {
		if errors.Is(err, accounts.ErrAccountNotFound) {
			dataAccessError(c, dataaccess.ErrNotFound)
		} else {
			dataAccessError(c, err)
		}
		return false
	}
	if account.Status != accounts.StatusActive {
		dataAccessError(c, dataaccess.ErrConflict)
		return false
	}
	kb, err := opts.KnowledgeService.GetKnowledgeBase(c.Request.Context(), knowledgeBaseID)
	if err != nil {
		knowledgeError(c, err)
		return false
	}
	if kb.Status != knowledge.KnowledgeBaseActive {
		knowledgeError(c, knowledge.ErrConflict)
		return false
	}
	return true
}

func dataAccessError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "internal_error", "数据权限操作失败"
	switch {
	case errors.Is(err, dataaccess.ErrInvalidRequest):
		status, code, message = http.StatusBadRequest, "invalid_request", "数据权限参数不合法"
	case errors.Is(err, dataaccess.ErrNotFound):
		status, code, message = http.StatusNotFound, "data_grant_not_found", "数据权限不存在"
	case errors.Is(err, dataaccess.ErrConflict):
		status, code, message = http.StatusConflict, "data_grant_conflict", "数据权限状态冲突"
	}
	c.JSON(status, gin.H{"code": code, "error": message})
}

func knowledgeBaseID(c *gin.Context) string {
	return strings.TrimSpace(c.Query("knowledge_base_id"))
}

func knowledgeError(c *gin.Context, err error) {
	status := http.StatusInternalServerError
	code := "internal_error"
	message := "知识库操作失败"
	details := []any{}
	switch {
	case errors.Is(err, knowledge.ErrInvalidRequest):
		status = http.StatusBadRequest
		code = "invalid_request"
		message = "请求参数或文件不合法"
	case errors.Is(err, knowledge.ErrNotFound):
		status = http.StatusNotFound
		code = "not_found"
		message = "知识库或文档不存在"
	case errors.Is(err, knowledge.ErrConflict):
		status = http.StatusConflict
		code = "conflict"
		message = "当前状态不允许执行该操作"
	case errors.Is(err, knowledge.ErrProvider):
		status = http.StatusBadGateway
		code = "knowledge_provider_error"
		message = "知识库服务暂时不可用"
	}
	if strings.TrimSpace(message) == "" {
		message = "知识库操作失败"
	}
	if reason := knowledgeConflictReason(err); reason != "" {
		details = append(details, gin.H{"reason": reason})
	}
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": details}})
}

func knowledgeConflictReason(err error) string {
	switch {
	case errors.Is(err, knowledge.ErrKnowledgeBaseHasAccountGrants):
		return "该知识库仍有账户授权，请先在知识库详情中撤销相关账户授权。"
	case errors.Is(err, knowledge.ErrKnowledgeBaseHasUploadingDocuments):
		return "该知识库存在正在上传的文档，请等待上传结束后重试。"
	case errors.Is(err, knowledge.ErrKnowledgeBaseCreating):
		return "该知识库仍在创建中，请等待创建完成后重试。"
	default:
		return ""
	}
}
