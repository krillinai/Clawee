package server

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

type storageActivateRequest struct {
	ProfileID        string `json:"profile_id"`
	ExpectedRevision int64  `json:"expected_revision"`
}

type storageMigrationRequest struct {
	SourceProfileID string `json:"source_profile_id"`
	TargetProfileID string `json:"target_profile_id"`
}

func mountSharedFileStorageRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.SharedFileStorageService == nil {
		return
	}
	read := requireStoragePermission(opts.RBACService, rbac.PermissionSharedFilesStorageRead)
	manage := requireStoragePermission(opts.RBACService, rbac.PermissionSharedFilesStorageManage)
	admin.GET("/shared-file-storage", read, handleStorageState(opts.SharedFileStorageService))
	admin.POST("/shared-file-storage/oss/test", manage, handleTestOSS(opts.SharedFileStorageService))
	admin.POST("/shared-file-storage/oss-profiles", manage, handleCreateOSSProfile(opts.SharedFileStorageService))
	admin.PATCH("/shared-file-storage/oss-profiles/:profile_id", manage, handleUpdateOSSProfile(opts.SharedFileStorageService))
	admin.POST("/shared-file-storage/profiles/:profile_id/probe", manage, handleProbeStorageProfile(opts.SharedFileStorageService))
	admin.POST("/shared-file-storage/profiles/:profile_id/retire", manage, handleRetireStorageProfile(opts.SharedFileStorageService))
	admin.POST("/shared-file-storage/activate", manage, handleActivateStorage(opts.SharedFileStorageService))

	if opts.SharedFileMigrationService == nil {
		return
	}
	migrate := requireStoragePermission(opts.RBACService, rbac.PermissionSharedFilesStorageMigrate)
	admin.POST("/shared-file-storage/migrations", migrate, handleCreateStorageMigration(opts.SharedFileMigrationService))
	admin.GET("/shared-file-storage/migrations/:migration_id", migrate, handleGetStorageMigration(opts.SharedFileMigrationService))
	admin.POST("/shared-file-storage/migrations/:migration_id/retry-failed", migrate, handleRetryStorageMigration(opts.SharedFileMigrationService))
	admin.POST("/shared-file-storage/migrations/:migration_id/cancel", migrate, handleCancelStorageMigration(opts.SharedFileMigrationService))
}

func requireStoragePermission(service *rbac.Service, permissionCode string) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		if service == nil {
			abortAuthorizationError(c, http.StatusServiceUnavailable, "authorization_unavailable", "权限服务不可用")
			return
		}
		allowed, err := service.HasPermission(c.Request.Context(), account.UserID, permissionCode)
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "permission_check_failed", "权限检查失败")
			return
		}
		if !allowed {
			abortAuthorizationError(c, http.StatusForbidden, "storage_operation_forbidden", "无权执行存储操作")
			return
		}
		c.Next()
	}
}

func handleStorageState(service *sharedfiles.StorageConfigurationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		state, err := service.State(c.Request.Context())
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": state})
	}
}

func handleTestOSS(service *sharedfiles.StorageConfigurationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request sharedfiles.OSSProfileInput
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidStorageConfiguration)
			return
		}
		testedAt, err := service.TestOSS(c.Request.Context(), request, currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"result": "success", "tested_at": testedAt}})
	}
}

func handleCreateOSSProfile(service *sharedfiles.StorageConfigurationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request sharedfiles.OSSProfileInput
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidStorageConfiguration)
			return
		}
		item, err := service.CreateOSSProfile(c.Request.Context(), request, currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"data": item})
	}
}

func handleUpdateOSSProfile(service *sharedfiles.StorageConfigurationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request sharedfiles.OSSProfileInput
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidStorageConfiguration)
			return
		}
		item, err := service.UpdateOSSProfile(c.Request.Context(), strings.TrimSpace(c.Param("profile_id")), request,
			currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func handleProbeStorageProfile(service *sharedfiles.StorageConfigurationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		testedAt, err := service.ProbeProfile(c.Request.Context(), strings.TrimSpace(c.Param("profile_id")),
			currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"result": "success", "tested_at": testedAt}})
	}
}

func handleRetireStorageProfile(service *sharedfiles.StorageConfigurationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		err := service.Retire(c.Request.Context(), strings.TrimSpace(c.Param("profile_id")),
			currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func handleActivateStorage(service *sharedfiles.StorageConfigurationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request storageActivateRequest
		if c.ShouldBindJSON(&request) != nil || request.ExpectedRevision < 1 {
			writeSharedFileError(c, sharedfiles.ErrInvalidStorageConfiguration)
			return
		}
		item, err := service.Activate(c.Request.Context(), request.ProfileID, request.ExpectedRevision,
			currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func handleCreateStorageMigration(service *sharedfiles.StorageMigrationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request storageMigrationRequest
		if c.ShouldBindJSON(&request) != nil {
			writeSharedFileError(c, sharedfiles.ErrInvalidStorageConfiguration)
			return
		}
		item, err := service.Create(c.Request.Context(), request.SourceProfileID, request.TargetProfileID,
			currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"data": item})
	}
}

func handleGetStorageMigration(service *sharedfiles.StorageMigrationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		item, err := service.Get(c.Request.Context(), strings.TrimSpace(c.Param("migration_id")))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": item})
	}
}

func handleRetryStorageMigration(service *sharedfiles.StorageMigrationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		err := service.RetryFailed(c.Request.Context(), strings.TrimSpace(c.Param("migration_id")),
			currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func handleCancelStorageMigration(service *sharedfiles.StorageMigrationService) gin.HandlerFunc {
	return func(c *gin.Context) {
		err := service.Cancel(c.Request.Context(), strings.TrimSpace(c.Param("migration_id")),
			currentUserID(c), requestIDFromContext(c.Request.Context()))
		if err != nil {
			writeSharedFileError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
}
