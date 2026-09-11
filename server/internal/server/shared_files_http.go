package server

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

type sharedSpaceRequest struct {
	SpaceID     string `json:"space_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type sharedMemberRequest struct {
	SpaceID string   `json:"space_id"`
	UserID  string   `json:"user_id"`
	Actions []string `json:"actions"`
}

type adminSharedFileResponse struct {
	sharedfiles.File
	UpdatedByUserName string `json:"updated_by_user_name"`
}

const (
	sharedFileLogFileIDKey  = "shared_file_log_file_id"
	sharedFileLogSpaceIDKey = "shared_file_log_space_id"
)

func mountSharedFileRoutes(app, admin *gin.RouterGroup, opts Options) {
	if opts.SharedFilesService == nil {
		return
	}
	appFiles := app.Group("")
	appFiles.Use(requireClaweeFileCaller())
	appFiles.GET("/shared-spaces", handleAppSharedSpaces(opts.SharedFilesService))
	appFiles.GET("/shared-files", handleAppSharedFiles(opts.SharedFilesService))
	appFiles.GET("/shared-files/detail", handleAppSharedFileDetail(opts.SharedFilesService))
	appFiles.GET("/shared-files/content", handleAppSharedFileDownload(opts.SharedFilesService))
	appFiles.POST("/shared-files/content", handleAppSharedFileUpload(opts.SharedFilesService))

	read := requirePermission(opts.RBACService, rbac.PermissionSharedFilesRead)
	admin.GET("/shared-spaces", read, handleAdminSharedSpaces(opts.SharedFilesService))
	admin.GET("/shared-spaces/detail", read, handleAdminSharedSpaceDetail(opts.SharedFilesService))
	admin.POST("/shared-spaces", requirePermission(opts.RBACService, rbac.PermissionSharedFilesSpaceCreate), handleAdminCreateSharedSpace(opts.SharedFilesService))
	admin.PATCH("/shared-spaces", requirePermission(opts.RBACService, rbac.PermissionSharedFilesSpaceUpdate), handleAdminUpdateSharedSpace(opts.SharedFilesService))
	admin.GET("/shared-spaces/account-grants", read, handleAdminSharedMembers(opts.SharedFilesService))
	admin.GET("/shared-spaces/member-candidates", requirePermission(opts.RBACService, rbac.PermissionSharedFilesMemberCreate), handleAdminSharedMemberCandidates(opts.SharedFilesService))
	admin.POST("/shared-spaces/account-grants", requirePermission(opts.RBACService, rbac.PermissionSharedFilesMemberCreate), handleAdminAddSharedMember(opts.SharedFilesService))
	admin.PATCH("/shared-spaces/account-grants", requirePermission(opts.RBACService, rbac.PermissionSharedFilesMemberUpdate), handleAdminUpdateSharedMember(opts.SharedFilesService))
	admin.POST("/shared-spaces/account-grants/remove", requirePermission(opts.RBACService, rbac.PermissionSharedFilesMemberDelete), handleAdminRemoveSharedMember(opts.SharedFilesService))
	admin.GET("/shared-files", read, handleAdminSharedFiles(opts.SharedFilesService, opts.AccountService))
	admin.GET("/shared-files/content", sharedFileOperationLog(opts.Logger, "download"), requirePermission(opts.RBACService, rbac.PermissionSharedFilesDownload), handleAdminSharedFileDownload(opts.SharedFilesService))
	admin.POST("/shared-files/content", sharedFileOperationLog(opts.Logger, "upload"), requirePermission(opts.RBACService, rbac.PermissionSharedFilesUpload), handleAdminSharedFileUpload(opts.SharedFilesService))
}

func requireClaweeFileCaller() gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, principalOK := currentPrincipal(c)
		_, agentOK := currentClaweeAgent(c)
		if bearerToken(c.Request) == "" || !principalOK || principal.ClientID != accounts.ClientClaweeAgent || principal.AgentID == "" || !agentOK {
			abortAuthorizationError(c, http.StatusForbidden, "agent_forbidden", "Agent 不可用")
			return
		}
		c.Next()
	}
}

func handleAppSharedSpaces(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		limit, ok := parseLimit(c)
		if !ok {
			return
		}
		page, err := service.ListSpaces(c.Request.Context(), account.UserID, limit, c.Query("cursor"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": page.Items, "meta": gin.H{"next_cursor": page.NextCursor, "has_next": page.HasNext, "max_file_size_bytes": sharedfiles.MaxFileSizeBytes}})
	}
}

func handleAppSharedFiles(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		limit, ok := parseLimit(c)
		if !ok {
			return
		}
		page, err := service.ListFiles(c.Request.Context(), account.UserID, c.Query("space_id"), c.Query("query"), c.Query("logical_path_prefix"), limit, c.Query("cursor"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": page.Items, "meta": gin.H{"next_cursor": page.NextCursor, "has_next": page.HasNext}})
	}
}

func handleAppSharedFileDetail(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		item, err := service.GetFile(c.Request.Context(), account.UserID, c.Query("file_id"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func handleAppSharedFileDownload(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		item, reader, err := service.OpenFile(c.Request.Context(), account.UserID, c.Query("file_id"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		writeSharedFileContent(c, item, reader)
	}
}

func handleAppSharedFileUpload(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		expectedRevision, ok := parseSharedFileUpload(c)
		if !ok {
			return
		}
		account, _ := currentAccount(c)
		principal, _ := currentPrincipal(c)
		result, err := service.Upload(c.Request.Context(), account.UserID, principal.AgentID, c.Query("space_id"), c.Query("logical_path"),
			c.GetHeader("Content-Type"), c.Request.ContentLength, strings.TrimSpace(c.GetHeader("X-Content-SHA256")), expectedRevision, c.Request.Body)
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		c.JSON(status, gin.H{"data": result})
	}
}

func handleAdminSharedFiles(service *sharedfiles.Service, accountService *accounts.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit, ok := parseLimit(c)
		if !ok {
			return
		}
		page, err := service.ListAdminFiles(c.Request.Context(), c.Query("space_id"), c.Query("query"), c.Query("logical_path_prefix"), limit, c.Query("cursor"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		accountItems := []accounts.Account{}
		if accountService != nil {
			accountItems, err = accountService.ListAccounts(c.Request.Context())
			if err != nil {
				writeSharedFileError(c, err)
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"data": adminSharedFileResponses(page.Items, accountItems), "meta": gin.H{"next_cursor": page.NextCursor, "has_next": page.HasNext}})
	}
}

func adminSharedFileResponses(items []sharedfiles.File, accountItems []accounts.Account) []adminSharedFileResponse {
	displayNames := make(map[string]string, len(accountItems))
	for _, account := range accountItems {
		displayNames[account.UserID] = account.DisplayName()
	}
	responses := make([]adminSharedFileResponse, 0, len(items))
	for _, item := range items {
		responses = append(responses, adminSharedFileResponse{
			File:              item,
			UpdatedByUserName: firstNonEmpty(displayNames[item.UpdatedByUserID], item.UpdatedByUserID),
		})
	}
	return responses
}

func handleAdminSharedFileDownload(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		item, reader, err := service.OpenAdminFile(c.Request.Context(), c.Query("file_id"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.Set(sharedFileLogFileIDKey, item.FileID)
		c.Set(sharedFileLogSpaceIDKey, item.SpaceID)
		writeSharedFileContent(c, item, reader)
	}
}

func handleAdminSharedFileUpload(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		expectedRevision, ok := parseSharedFileUpload(c)
		if !ok {
			return
		}
		account, _ := currentAccount(c)
		result, err := service.UploadAdmin(c.Request.Context(), account.UserID, c.Query("space_id"), c.Query("logical_path"),
			c.GetHeader("Content-Type"), c.Request.ContentLength, expectedRevision, c.Request.Body)
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.Set(sharedFileLogFileIDKey, result.FileID)
		c.Set(sharedFileLogSpaceIDKey, result.SpaceID)
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		c.JSON(status, gin.H{"data": result})
	}
}

func parseSharedFileUpload(c *gin.Context) (*int64, bool) {
	if c.Request.ContentLength < 0 {
		writeSharedFileCode(c, http.StatusLengthRequired, "length_required", "需要 Content-Length")
		return nil, false
	}
	if c.Request.ContentLength > sharedfiles.MaxFileSizeBytes {
		writeSharedFileCode(c, http.StatusRequestEntityTooLarge, "file_too_large", "文件超过大小限制")
		return nil, false
	}
	if raw := strings.TrimSpace(c.Query("expected_revision")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 1 {
			writeSharedFileError(c, sharedfiles.ErrInvalidRequest)
			return nil, false
		}
		return &value, true
	}
	return nil, true
}

func writeSharedFileContent(c *gin.Context, item sharedfiles.File, reader io.ReadCloser) {
	defer reader.Close()
	contentDisposition := mime.FormatMediaType("attachment", map[string]string{"filename": item.FileName})
	c.Header("Content-Type", item.ContentType)
	c.Header("Content-Length", strconv.FormatInt(item.SizeBytes, 10))
	c.Header("Content-Disposition", contentDisposition)
	c.Header("ETag", fmt.Sprintf(`"sha256:%s"`, item.SHA256))
	c.Header("X-Shared-File-ID", item.FileID)
	c.Header("X-File-Revision", strconv.FormatInt(item.Revision, 10))
	c.Header("X-Content-SHA256", item.SHA256)
	c.Status(http.StatusOK)
	c.Writer.Flush()
	if _, err := io.Copy(c.Writer, reader); err != nil {
		_ = c.Error(err)
	}
}

func sharedFileOperationLog(logger *zap.Logger, action string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if logger == nil {
			return
		}
		result := "success"
		if c.Writer.Status() >= http.StatusBadRequest {
			result = "failure"
		}
		account, _ := currentAccount(c)
		logger.Info("shared file admin operation",
			zap.String("request_id", requestIDFromContext(c.Request.Context())),
			zap.String("operator_user_id", account.UserID),
			zap.String("action", action),
			zap.String("space_id", firstNonEmpty(contextString(c, sharedFileLogSpaceIDKey), strings.TrimSpace(c.Query("space_id")))),
			zap.String("file_id", firstNonEmpty(contextString(c, sharedFileLogFileIDKey), strings.TrimSpace(c.Query("file_id")))),
			zap.String("result", result),
		)
	}
}

func contextString(c *gin.Context, key string) string {
	value, _ := c.Get(key)
	text, _ := value.(string)
	return text
}

func handleAdminSharedSpaces(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit, ok := parseLimit(c)
		if !ok {
			return
		}
		page, err := service.ListAdminSpaces(c.Request.Context(), c.Query("query"), limit, c.Query("cursor"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": page.Items, "meta": gin.H{"next_cursor": page.NextCursor, "has_next": page.HasNext}})
	}
}

func handleAdminSharedSpaceDetail(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		item, err := service.GetSpaceSummary(c.Request.Context(), c.Query("space_id"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func handleAdminCreateSharedSpace(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request sharedSpaceRequest
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidRequest)
			return
		}
		account, _ := currentAccount(c)
		item, err := service.CreateSpace(c.Request.Context(), request.Name, request.Description, account.UserID)
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"data": item})
	}
}

func handleAdminUpdateSharedSpace(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request sharedSpaceRequest
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidRequest)
			return
		}
		account, _ := currentAccount(c)
		item, err := service.UpdateSpace(c.Request.Context(), request.SpaceID, request.Name, request.Description, account.UserID)
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func handleAdminSharedMembers(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit, ok := parseLimit(c)
		if !ok {
			return
		}
		page, err := service.ListMembers(c.Request.Context(), c.Query("space_id"), c.Query("query"), limit, c.Query("cursor"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": page.Items, "meta": gin.H{"next_cursor": page.NextCursor, "has_next": page.HasNext}})
	}
}

func handleAdminSharedMemberCandidates(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit, ok := parseLimit(c)
		if !ok {
			return
		}
		page, err := service.ListMemberCandidates(c.Request.Context(), c.Query("space_id"), c.Query("query"), limit, c.Query("cursor"))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": page.Items, "meta": gin.H{"next_cursor": page.NextCursor, "has_next": page.HasNext}})
	}
}

func handleAdminAddSharedMember(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request sharedMemberRequest
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidRequest)
			return
		}
		account, _ := currentAccount(c)
		actions := request.Actions
		if len(actions) == 0 {
			actions = []string{sharedfiles.ActionRead, sharedfiles.ActionWrite}
		}
		item, err := service.AddMemberWithActions(c.Request.Context(), request.SpaceID, request.UserID, actions, account.UserID)
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"data": item})
	}
}

func handleAdminUpdateSharedMember(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request sharedMemberRequest
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidRequest)
			return
		}
		account, _ := currentAccount(c)
		item, err := service.UpdateMember(c.Request.Context(), request.SpaceID, request.UserID, request.Actions, account.UserID)
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func handleAdminRemoveSharedMember(service *sharedfiles.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request sharedMemberRequest
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidRequest)
			return
		}
		if err := service.RemoveMember(c.Request.Context(), request.SpaceID, request.UserID); err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func parseLimit(c *gin.Context) (int, bool) {
	if strings.TrimSpace(c.Query("limit")) == "" {
		return 0, true
	}
	limit, err := strconv.Atoi(c.Query("limit"))
	if err != nil {
		writeSharedFileError(c, sharedfiles.ErrInvalidRequest)
		return 0, false
	}
	return limit, true
}

func writeSharedFileError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "internal_error", "服务内部错误"
	switch {
	case errors.Is(err, sharedfiles.ErrInvalidLogicalPath):
		status, code, message = 400, "invalid_logical_path", "逻辑路径不符合规则"
	case errors.Is(err, sharedfiles.ErrInvalidDigest):
		status, code, message = 400, "invalid_digest", "SHA-256 摘要格式错误"
	case errors.Is(err, sharedfiles.ErrInvalidCursor):
		status, code, message = 400, "invalid_cursor", "分页游标无效"
	case errors.Is(err, sharedfiles.ErrInvalidRequest):
		status, code, message = 400, "invalid_request", "请求参数无效"
	case errors.Is(err, sharedfiles.ErrSharedSpaceNotFound):
		status, code, message = 404, "shared_space_not_found", "共享空间不存在"
	case errors.Is(err, sharedfiles.ErrSharedFileNotFound):
		status, code, message = 404, "shared_file_not_found", "网盘文件不存在"
	case errors.Is(err, sharedfiles.ErrMemberNotFound):
		status, code, message = 404, "member_not_found", "成员不存在"
	case errors.Is(err, sharedfiles.ErrSpaceNameConflict):
		status, code, message = 409, "space_name_conflict", "共享空间名称已存在"
	case errors.Is(err, sharedfiles.ErrMemberAlreadyExists):
		status, code, message = 409, "member_already_exists", "账号已经是空间成员"
	case errors.Is(err, sharedfiles.ErrFileAlreadyExists):
		status, code, message = 409, "file_already_exists", "网盘文件已存在"
	case errors.Is(err, sharedfiles.ErrRevisionConflict):
		var conflict *sharedfiles.RevisionConflictError
		details := []any{}
		if errors.As(err, &conflict) {
			details = append(details, gin.H{"field": "expected_revision", "current_revision": conflict.CurrentRevision})
		}
		c.JSON(409, gin.H{"error": gin.H{"code": "revision_conflict", "message": "文件已被其他成员修改", "details": details}})
		return
	case errors.Is(err, sharedfiles.ErrFileTooLarge):
		status, code, message = 413, "file_too_large", "文件超过大小限制"
	case errors.Is(err, sharedfiles.ErrContentLengthMismatch):
		status, code, message = 422, "content_length_mismatch", "文件实际大小与声明不一致"
	case errors.Is(err, sharedfiles.ErrDigestMismatch):
		status, code, message = 422, "digest_mismatch", "文件摘要校验失败"
	case errors.Is(err, sharedfiles.ErrStorageUnavailable):
		status, code, message = 500, "storage_unavailable", "文件存储不可用"
	}
	writeSharedFileCode(c, status, code, message)
}

func writeSharedFileCode(c *gin.Context, status int, code, message string) {
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}
