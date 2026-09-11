package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

const (
	skillActionUpload            = "skill_version_upload"
	skillActionSet               = "skill_current_version_set"
	skillActionClear             = "skill_current_version_clear"
	skillActionDownload          = "skill_package_download"
	skillActionMoveSpace         = "skill_space_batch_update"
	skillSourceActionCreate      = "skill_source_create"
	skillSourceActionUpdate      = "skill_source_update"
	skillSourceActionSync        = "skill_source_sync"
	skillSourceActionLocalScan   = "skill_source_local_scan"
	skillSourceActionDisable     = "skill_source_disable"
	skillSourceActionEnable      = "skill_source_enable"
	skillSourceActionRemoveToken = "skill_source_token_remove"
	skillSourceActionBind        = "skill_source_item_bind"
	skillSourceActionUnbind      = "skill_source_item_unbind"

	skillActorKey    = "skill_actor_id"
	skillIDKey       = "skill_id"
	skillVersionKey  = "skill_version_id"
	skillSHAKey      = "skill_package_sha256"
	skillResultKey   = "skill_result"
	skillSourceIDKey = "skill_source_id"
	skillRunIDKey    = "skill_source_run_id"
	skillCommitKey   = "skill_source_commit_sha"
	skillIDsKey      = "skill_ids"
	skillSpaceIDKey  = "skill_space_id"
)

func mountSkillHubRoutes(app, admin *gin.RouterGroup, opts Options) {
	if opts.SkillHubService == nil || opts.AccountService == nil {
		return
	}
	list := handleSkillList(opts.SkillHubService)
	detail := handleSkillDetail(opts.SkillHubService)
	download := handleSkillDownload(opts.SkillHubService)

	app.GET("/skills", list)
	app.GET("/skills/detail", detail)
	app.GET("/skills/version-files", handlePublishedSkillVersionFiles(opts.SkillHubService))
	app.GET("/skills/version-file", handlePublishedSkillVersionFile(opts.SkillHubService))
	app.GET("/skills/package", skillOperationLog(opts.Logger, skillActionDownload), download)
	app.POST("/skills/versions", skillOperationLog(opts.Logger, skillActionUpload), requireSkillUploadCaller(), handleSkillUpload(opts.SkillHubService, true))
	app.GET("/skill-spaces", handleAppSkillSpaces(opts.SkillHubService))

	mountSkillHubAdminRoutes(admin, opts)
	mountSkillSpaceAdminRoutes(admin, opts)
}

func mountSkillHubAdminRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.SkillHubService == nil || opts.AccountService == nil {
		return
	}
	read := skillRequirePermission(opts.RBACService, rbac.PermissionSkillRead)
	admin.GET("/skills", read, handleAdminSkillList(opts.SkillHubService))
	admin.GET("/skills/detail", read, handleAdminSkillDetail(opts.SkillHubService))
	admin.GET("/skills/version-files", read, handleAdminSkillVersionFiles(opts.SkillHubService))
	admin.GET("/skills/version-file", read, handleAdminSkillVersionFile(opts.SkillHubService))
	admin.GET("/skills/version-package", skillOperationLog(opts.Logger, skillActionDownload), read, handleAdminSkillVersionPackage(opts.SkillHubService))
	admin.POST("/skills/versions", skillOperationLog(opts.Logger, skillActionUpload), skillRequirePermission(opts.RBACService, rbac.PermissionSkillVersionUpload), handleSkillUpload(opts.SkillHubService, false))
	admin.PATCH("/skills/space", skillBatchMoveOperationLog(opts.Logger), skillRequirePermission(opts.RBACService, rbac.PermissionSkillMove), handleSkillMoveSpace(opts.SkillHubService))
	admin.PUT("/skills/current-version", skillOperationLog(opts.Logger, skillActionSet), skillRequirePermission(opts.RBACService, rbac.PermissionSkillPublish), handleSkillSetCurrent(opts.SkillHubService))
	admin.POST("/skills/current-version/remove", skillOperationLog(opts.Logger, skillActionClear), skillRequirePermission(opts.RBACService, rbac.PermissionSkillUnpublish), handleSkillClearCurrent(opts.SkillHubService))
	if opts.SkillSourceService == nil {
		return
	}
	admin.GET("/skill-sources", read, handleSkillSourceList(opts.SkillSourceService))
	admin.POST("/skill-sources", skillSourceOperationLog(opts.Logger, skillSourceActionCreate), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceCreate), handleSkillSourceCreate(opts.SkillSourceService))
	admin.GET("/skill-sources/detail", read, handleSkillSourceDetail(opts.SkillSourceService))
	admin.GET("/skill-sources/token", skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceTokenReveal), handleSkillSourceToken(opts.SkillSourceService))
	admin.PUT("/skill-sources", skillSourceOperationLog(opts.Logger, skillSourceActionUpdate), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceUpdate), handleSkillSourceUpdate(opts.SkillSourceService))
	admin.POST("/skill-sources/sync", skillSourceOperationLog(opts.Logger, skillSourceActionSync), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceSync), handleSkillSourceSync(opts.SkillSourceService))
	admin.POST("/skill-sources/scan-local", skillSourceOperationLog(opts.Logger, skillSourceActionLocalScan), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceScan), handleSkillSourceLocalScan(opts.SkillSourceService))
	admin.POST("/skill-sources/disable", skillSourceOperationLog(opts.Logger, skillSourceActionDisable), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceDisable), handleSkillSourceStatus(opts.SkillSourceService, false))
	admin.POST("/skill-sources/enable", skillSourceOperationLog(opts.Logger, skillSourceActionEnable), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceEnable), handleSkillSourceStatus(opts.SkillSourceService, true))
	admin.POST("/skill-sources/token/remove", skillSourceOperationLog(opts.Logger, skillSourceActionRemoveToken), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceTokenRemove), handleSkillSourceRemoveToken(opts.SkillSourceService))
	admin.POST("/skill-sources/items/bind", skillSourceOperationLog(opts.Logger, skillSourceActionBind), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceBind), handleSkillSourceBind(opts.SkillSourceService))
	admin.POST("/skill-sources/items/unbind", skillSourceOperationLog(opts.Logger, skillSourceActionUnbind), skillRequirePermission(opts.RBACService, rbac.PermissionSkillSourceUnbind), handleSkillSourceUnbind(opts.SkillSourceService))
	admin.GET("/skill-sources/sync-runs", read, handleSkillSourceSyncRuns(opts.SkillSourceService))
}

type skillSourceCreateRequest struct {
	SpaceID         string   `json:"space_id"`
	RepositoryOwner string   `json:"repository_owner"`
	RepositoryName  string   `json:"repository_name"`
	Branch          string   `json:"branch"`
	ScanRoot        string   `json:"scan_root"`
	ExcludePaths    []string `json:"exclude_paths"`
	Token           string   `json:"token"`
	AutoPublish     bool     `json:"auto_publish"`
	Schedule        string   `json:"schedule"`
}

type skillSourceUpdateRequest struct {
	SourceID        string   `json:"source_id"`
	SpaceID         string   `json:"space_id"`
	RepositoryOwner string   `json:"repository_owner"`
	RepositoryName  string   `json:"repository_name"`
	Branch          string   `json:"branch"`
	ScanRoot        string   `json:"scan_root"`
	ExcludePaths    []string `json:"exclude_paths"`
	Token           *string  `json:"token"`
	AutoPublish     bool     `json:"auto_publish"`
	Schedule        string   `json:"schedule"`
}

func handleSkillSourceList(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := service.List(c.Request.Context())
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleSkillSourceCreate(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request skillSourceCreateRequest
		if decodeSkillJSON(c, &request) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		source, err := service.Create(c.Request.Context(), skillhub.CreateGitHubSourceInput{
			SpaceID:         request.SpaceID,
			RepositoryOwner: request.RepositoryOwner, RepositoryName: request.RepositoryName, Branch: request.Branch,
			ScanRoot: request.ScanRoot, ExcludePaths: request.ExcludePaths, Token: request.Token,
			AutoPublish: request.AutoPublish, Schedule: request.Schedule, CreatedBy: account.DisplayName(),
		})
		if err != nil {
			skillError(c, err)
			return
		}
		setSkillSourceAudit(c, source.SourceID, "", source.LastSyncedCommitSHA)
		c.JSON(http.StatusCreated, source)
	}
}

func handleSkillSourceDetail(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := skillSourceQueryID(c)
		if !ok {
			return
		}
		source, err := service.Get(c.Request.Context(), id)
		if err != nil {
			skillError(c, err)
			return
		}
		items, err := service.ListItems(c.Request.Context(), id)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{
			"source": source, "items": items, "manual_clone": service.ManualCloneInstructions(source),
		}})
	}
}

func handleSkillSourceToken(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := skillSourceQueryID(c)
		if !ok {
			return
		}
		token, err := service.GetToken(c.Request.Context(), id)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"token": token})
	}
}

func handleSkillSourceUpdate(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request skillSourceUpdateRequest
		if decodeSkillJSON(c, &request) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		c.Set(skillSourceIDKey, strings.TrimSpace(request.SourceID))
		token := request.Token
		if token != nil && *token == "" {
			token = nil
		}
		source, err := service.Update(c.Request.Context(), strings.TrimSpace(request.SourceID), skillhub.UpdateGitHubSourceInput{
			RepositoryOwner: request.RepositoryOwner, RepositoryName: request.RepositoryName, Branch: request.Branch,
			ScanRoot: request.ScanRoot, ExcludePaths: request.ExcludePaths, Token: token,
			AutoPublish: request.AutoPublish, Schedule: request.Schedule,
		})
		if err != nil {
			skillError(c, err)
			return
		}
		setSkillSourceAudit(c, source.SourceID, "", source.LastSyncedCommitSHA)
		c.JSON(http.StatusOK, source)
	}
}

func handleSkillSourceSync(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return handleSkillSourceQueue(service, false)
}

func handleSkillSourceLocalScan(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return handleSkillSourceQueue(service, true)
}

func handleSkillSourceQueue(service *skillhub.GitHubSourceService, local bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := decodeSkillSourceID(c)
		if !ok {
			return
		}
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		var run skillhub.SourceSyncRun
		var err error
		if local {
			run, err = service.QueueLocalScan(c.Request.Context(), id, account.DisplayName())
		} else {
			run, err = service.QueueSync(c.Request.Context(), id, account.DisplayName())
		}
		if err != nil {
			skillError(c, err)
			return
		}
		setSkillSourceAudit(c, run.SourceID, run.RunID, run.BeforeCommitSHA)
		c.JSON(http.StatusAccepted, gin.H{"run_id": run.RunID})
	}
}

func handleSkillSourceStatus(service *skillhub.GitHubSourceService, enable bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := decodeSkillSourceID(c)
		if !ok {
			return
		}
		var source skillhub.GitHubSource
		var err error
		if enable {
			source, err = service.Enable(c.Request.Context(), id)
		} else {
			source, err = service.Disable(c.Request.Context(), id)
		}
		if err != nil {
			skillError(c, err)
			return
		}
		setSkillSourceAudit(c, source.SourceID, "", source.LastSyncedCommitSHA)
		c.JSON(http.StatusOK, source)
	}
}

func handleSkillSourceRemoveToken(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := decodeSkillSourceID(c)
		if !ok {
			return
		}
		source, err := service.RemoveToken(c.Request.Context(), id)
		if err != nil {
			skillError(c, err)
			return
		}
		setSkillSourceAudit(c, source.SourceID, "", source.LastSyncedCommitSHA)
		c.JSON(http.StatusOK, source)
	}
}

func handleSkillSourceBind(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request struct {
			SourceItemID string `json:"source_item_id"`
			SkillID      string `json:"skill_id"`
		}
		if decodeSkillJSON(c, &request) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		item, err := service.BindItem(c.Request.Context(), request.SourceItemID, request.SkillID)
		if err != nil {
			skillError(c, err)
			return
		}
		setSkillSourceAudit(c, item.SourceID, "", item.LastSeenCommitSHA)
		c.JSON(http.StatusOK, item)
	}
}

func handleSkillSourceUnbind(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request struct {
			SourceItemID string `json:"source_item_id"`
		}
		if decodeSkillJSON(c, &request) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		item, err := service.UnbindItem(c.Request.Context(), request.SourceItemID)
		if err != nil {
			skillError(c, err)
			return
		}
		setSkillSourceAudit(c, item.SourceID, "", item.LastSeenCommitSHA)
		c.JSON(http.StatusOK, item)
	}
}

func handleSkillSourceSyncRuns(service *skillhub.GitHubSourceService) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := skillSourceQueryID(c)
		if !ok {
			return
		}
		items, err := service.ListSyncRuns(c.Request.Context(), id, 20)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func decodeSkillSourceID(c *gin.Context) (string, bool) {
	var request struct {
		SourceID string `json:"source_id"`
	}
	if decodeSkillJSON(c, &request) != nil || strings.TrimSpace(request.SourceID) == "" {
		skillError(c, skillhub.ErrInvalidRequest)
		return "", false
	}
	id := strings.TrimSpace(request.SourceID)
	c.Set(skillSourceIDKey, id)
	return id, true
}

func skillSourceQueryID(c *gin.Context) (string, bool) {
	query := c.Request.URL.Query()
	values, ok := query["source_id"]
	if !ok || len(query) != 1 || len(values) != 1 || strings.TrimSpace(values[0]) == "" {
		skillError(c, skillhub.ErrInvalidRequest)
		return "", false
	}
	return strings.TrimSpace(values[0]), true
}

func setSkillSourceAudit(c *gin.Context, sourceID, runID string, commit *string) {
	c.Set(skillSourceIDKey, sourceID)
	c.Set(skillRunIDKey, runID)
	if commit != nil {
		c.Set(skillCommitKey, *commit)
	}
}

func handleSkillList(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		items, err := service.ListPublishedForUser(c.Request.Context(), account.UserID)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleSkillDetail(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		item, err := service.GetPublishedForUser(c.Request.Context(), account.UserID, skillID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleSkillDownload(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		id := skillID(c)
		expectedVersionID := strings.TrimSpace(c.Query("version_id"))
		c.Set(skillIDKey, id)
		c.Set(skillVersionKey, expectedVersionID)
		download, err := service.OpenCurrentPackageForUser(c.Request.Context(), account.UserID, id, expectedVersionID)
		if err != nil {
			skillError(c, err)
			return
		}
		defer download.Reader.Close()
		c.Set(skillVersionKey, download.Detail.VersionID)
		c.Set(skillSHAKey, download.Detail.PackageSHA256)
		c.Header("Content-Type", "application/zip")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", download.Filename))
		c.Header("Content-Length", fmt.Sprintf("%d", download.Size))
		c.Status(http.StatusOK)
		if _, err := io.Copy(c.Writer, download.Reader); err != nil {
			c.Set(skillResultKey, "failure")
		}
	}
}

func handlePublishedSkillVersionFiles(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		items, err := service.ListPublishedVersionFilesForUser(c.Request.Context(), account.UserID, skillID(c), skillVersionID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handlePublishedSkillVersionFile(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		item, err := service.ReadPublishedVersionFileForUser(c.Request.Context(), account.UserID, skillID(c), skillVersionID(c), c.Query("path"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleAdminSkillList(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := service.ListAdmin(c.Request.Context())
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleAdminSkillDetail(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		item, err := service.GetAdmin(c.Request.Context(), skillID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleAdminSkillVersionFiles(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := service.ListVersionFiles(c.Request.Context(), skillID(c), skillVersionID(c))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleAdminSkillVersionFile(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		item, err := service.ReadVersionFile(c.Request.Context(), skillID(c), skillVersionID(c), c.Query("path"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleAdminSkillVersionPackage(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := skillID(c)
		versionID := skillVersionID(c)
		c.Set(skillIDKey, id)
		c.Set(skillVersionKey, versionID)
		download, err := service.OpenVersionPackage(c.Request.Context(), id, versionID)
		if err != nil {
			skillError(c, err)
			return
		}
		defer download.Reader.Close()
		c.Set(skillSHAKey, download.Detail.PackageSHA256)
		c.Header("Content-Type", "application/zip")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", download.Filename))
		c.Header("Content-Length", fmt.Sprintf("%d", download.Size))
		c.Status(http.StatusOK)
		if _, err := io.Copy(c.Writer, download.Reader); err != nil {
			c.Set(skillResultKey, "failure")
		}
	}
}

func handleSkillUpload(service *skillhub.Service, client bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, skillhub.MaxMultipartBodySize)
		if err := c.Request.ParseMultipartForm(1 << 20); err != nil || c.Request.MultipartForm == nil {
			if isSkillRequestTooLarge(err) {
				skillError(c, skillhub.ErrPackageTooLarge)
			} else {
				skillError(c, skillhub.ErrInvalidRequest)
			}
			return
		}
		defer c.Request.MultipartForm.RemoveAll()
		form := c.Request.MultipartForm
		if !validSkillUploadForm(form.Value, form.File) {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		header := form.File["package"][0]
		if header.Size > skillhub.MaxPackageSize {
			skillError(c, skillhub.ErrPackageTooLarge)
			return
		}
		file, err := header.Open()
		if err != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		defer file.Close()
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		changelog := ""
		if values := form.Value["changelog"]; len(values) == 1 {
			changelog = values[0]
		}
		input := skillhub.UploadVersionInput{
			SpaceID: firstSkillFormValue(form.Value, "space_id"), Version: form.Value["version"][0], Changelog: changelog,
			Package: file, CreatedBy: account.DisplayName(), UploadedByUserID: account.UserID,
		}
		var result skillhub.MutationResult
		if client {
			principal, _ := currentPrincipal(c)
			result, err = service.UploadVersionForUser(c.Request.Context(), account.UserID, principal.AgentID, input)
		} else {
			result, err = service.UploadVersion(c.Request.Context(), input)
		}
		if err != nil {
			skillError(c, err)
			return
		}
		c.Set(skillIDKey, result.Skill.SkillID)
		c.Set(skillVersionKey, result.Version.VersionID)
		c.Set(skillSHAKey, result.Version.PackageSHA256)
		c.JSON(http.StatusCreated, result)
	}
}

func validSkillUploadForm(values map[string][]string, files map[string][]*multipart.FileHeader) bool {
	for key := range values {
		if key != "space_id" && key != "version" && key != "changelog" {
			return false
		}
	}
	for key := range files {
		if key != "package" {
			return false
		}
	}
	return len(values["space_id"]) <= 1 && len(values["version"]) == 1 && len(values["changelog"]) <= 1 && len(files["package"]) == 1
}

func firstSkillFormValue(values map[string][]string, key string) string {
	if items := values[key]; len(items) == 1 {
		return strings.TrimSpace(items[0])
	}
	return ""
}

func requireSkillUploadCaller() gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, principalOK := currentPrincipal(c)
		if principalOK && principal.ClientID == accounts.ClientWeb {
			c.Next()
			return
		}
		_, agentOK := currentClaweeAgent(c)
		if bearerToken(c.Request) == "" || !principalOK || principal.ClientID != accounts.ClientClaweeAgent || principal.AgentID == "" || !agentOK {
			abortAuthorizationError(c, http.StatusForbidden, "agent_forbidden", "Agent 不可用")
			return
		}
		c.Next()
	}
}

type setCurrentVersionRequest struct {
	SkillID   string `json:"skill_id"`
	VersionID string `json:"version_id"`
}

type moveSkillsSpaceRequest struct {
	SkillIDs      []string `json:"skill_ids"`
	TargetSpaceID string   `json:"target_space_id"`
}

func handleSkillMoveSpace(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request moveSkillsSpaceRequest
		if err := decodeSkillJSON(c, &request); err != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		c.Set(skillIDsKey, append([]string(nil), request.SkillIDs...))
		c.Set(skillSpaceIDKey, strings.TrimSpace(request.TargetSpaceID))
		result, err := service.MoveSkillsToSpace(c.Request.Context(), request.SkillIDs, request.TargetSpaceID)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	}
}

func handleSkillSetCurrent(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request setCurrentVersionRequest
		if err := decodeSkillJSON(c, &request); err != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		id := strings.TrimSpace(request.SkillID)
		if id == "" {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		c.Set(skillIDKey, id)
		c.Set(skillVersionKey, request.VersionID)
		result, err := service.SetCurrentVersion(c.Request.Context(), id, request.VersionID)
		if err != nil {
			skillError(c, err)
			return
		}
		c.Set(skillSHAKey, result.Version.PackageSHA256)
		c.JSON(http.StatusOK, result)
	}
}

func handleSkillClearCurrent(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request struct {
			SkillID string `json:"skill_id"`
		}
		if err := decodeSkillJSON(c, &request); err != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		id := strings.TrimSpace(request.SkillID)
		if id == "" {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		c.Set(skillIDKey, id)
		cleared, err := service.ClearCurrentVersion(c.Request.Context(), id)
		if err != nil {
			skillError(c, err)
			return
		}
		if cleared != nil {
			c.Set(skillVersionKey, cleared.VersionID)
			c.Set(skillSHAKey, cleared.PackageSHA256)
		}
		c.Status(http.StatusNoContent)
	}
}

func skillRequirePermission(service *rbac.Service, permissionCode string) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": "forbidden", "error": "无权执行该操作"})
			return
		}
		if service == nil {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"code": "authorization_unavailable", "error": "权限服务不可用"})
			return
		}
		allowed, err := service.HasPermission(c.Request.Context(), account.UserID, permissionCode)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"code": "internal_error", "error": "技能中心鉴权失败"})
			return
		}
		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": "forbidden", "error": "无权执行该操作"})
			return
		}
		c.Next()
	}
}

func skillID(c *gin.Context) string {
	return strings.TrimSpace(c.Query("skill_id"))
}

func skillVersionID(c *gin.Context) string {
	return strings.TrimSpace(c.Query("version_id"))
}

func skillOperationLog(logger *zap.Logger, action string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if logger == nil {
			return
		}
		result := "success"
		if c.Writer.Status() >= http.StatusBadRequest {
			result = "failure"
		}
		if override := skillContextValue(c, skillResultKey); override != "" {
			result = override
		}
		actorID := skillContextValue(c, skillActorKey)
		if actorID == "" {
			if account, ok := currentAccount(c); ok {
				actorID = account.UserID
			}
		}
		logger.Info("skill operation",
			zap.String("request_id", requestIDFromContext(c.Request.Context())),
			zap.String("actor_id", actorID),
			zap.String("action", action),
			zap.String("skill_id", firstSkillValue(skillContextValue(c, skillIDKey), skillID(c))),
			zap.String("version_id", skillContextValue(c, skillVersionKey)),
			zap.String("result", result),
			zap.String("package_sha256", skillContextValue(c, skillSHAKey)),
		)
	}
}

func skillBatchMoveOperationLog(logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if logger == nil {
			return
		}
		result := "success"
		if c.Writer.Status() >= http.StatusBadRequest {
			result = "failure"
		}
		actorID := ""
		if account, ok := currentAccount(c); ok {
			actorID = account.UserID
		}
		skillIDs, _ := c.Get(skillIDsKey)
		ids, _ := skillIDs.([]string)
		logger.Info("skill operation",
			zap.String("request_id", requestIDFromContext(c.Request.Context())),
			zap.String("actor_id", actorID),
			zap.String("action", skillActionMoveSpace),
			zap.Strings("skill_ids", ids),
			zap.String("target_space_id", skillContextValue(c, skillSpaceIDKey)),
			zap.String("result", result),
		)
	}
}

func skillSourceOperationLog(logger *zap.Logger, action string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if logger == nil {
			return
		}
		result := "success"
		if c.Writer.Status() >= http.StatusBadRequest {
			result = "failure"
		}
		actorID := ""
		if account, ok := currentAccount(c); ok {
			actorID = account.UserID
		}
		logger.Info("skill source operation",
			zap.String("request_id", requestIDFromContext(c.Request.Context())),
			zap.String("actor_id", actorID),
			zap.String("action", action),
			zap.String("source_id", skillContextValue(c, skillSourceIDKey)),
			zap.String("run_id", skillContextValue(c, skillRunIDKey)),
			zap.String("commit_sha", skillContextValue(c, skillCommitKey)),
			zap.String("result", result),
		)
	}
}

func skillContextValue(c *gin.Context, key string) string {
	value, ok := c.Get(key)
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}

func firstSkillValue(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func decodeSkillJSON(c *gin.Context, target any) error {
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return skillhub.ErrInvalidRequest
	}
	return nil
}

func skillError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "internal_error", "技能中心操作失败"
	switch {
	case errors.Is(err, skillhub.ErrInvalidRequest):
		status, code, message = http.StatusBadRequest, "invalid_request", "请求参数不合法"
	case errors.Is(err, skillhub.ErrPackageInvalid):
		status, code, message = http.StatusBadRequest, "package_invalid", "Skill 包格式不合法"
		if reason := skillhub.PackageInvalidReason(err); reason != "" {
			message += "：" + reason
		}
	case errors.Is(err, skillhub.ErrPackageTooLarge):
		status, code, message = http.StatusRequestEntityTooLarge, "package_too_large", "Skill 包超过大小限制"
	case errors.Is(err, skillhub.ErrNotFound):
		status, code, message = http.StatusNotFound, "not_found", "Skill、版本或来源不存在"
	case errors.Is(err, skillhub.ErrSpaceNotFound):
		status, code, message = http.StatusNotFound, "skill_space_not_found", "技能空间不存在"
	case errors.Is(err, skillhub.ErrSpaceNameConflict):
		status, code, message = http.StatusConflict, "skill_space_name_conflict", "技能空间名称已存在"
	case errors.Is(err, skillhub.ErrMemberNotFound):
		status, code, message = http.StatusNotFound, "skill_space_member_not_found", "技能空间成员不存在"
	case errors.Is(err, skillhub.ErrMemberAlreadyExists):
		status, code, message = http.StatusConflict, "skill_space_member_exists", "账户已是技能空间成员"
	case errors.Is(err, skillhub.ErrVersionChanged):
		status, code, message = http.StatusConflict, "version_changed", "Skill 当前发布版本已变化"
	case errors.Is(err, skillhub.ErrConflict):
		status, code, message = http.StatusConflict, "conflict", "资源状态冲突"
	case errors.Is(err, skillhub.ErrFileNotPreviewable):
		status, code, message = http.StatusUnprocessableEntity, "file_not_previewable", "该文件不支持在线预览"
	case errors.Is(err, skillhub.ErrSourceCredentialFailure):
		status, code, message = http.StatusInternalServerError, "source_credential_failure", "来源凭据处理失败"
	case errors.Is(err, skillhub.ErrSourceStoreFailure):
		status, code, message = http.StatusInternalServerError, "source_store_failure", "来源存储操作失败"
	}
	c.JSON(status, gin.H{"code": code, "error": message})
}

func isSkillRequestTooLarge(err error) bool {
	var maxBytesError *http.MaxBytesError
	return errors.As(err, &maxBytesError) || (err != nil && strings.Contains(strings.ToLower(err.Error()), "too large"))
}
