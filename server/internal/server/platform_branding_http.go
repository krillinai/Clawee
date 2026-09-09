package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime/multipart"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/platformbranding"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

const platformBrandingRequestMaxBytes = 2*platformbranding.MaxImageSize + 64*1024

func mountPlatformBrandingRoutes(app, admin *gin.RouterGroup, opts Options) {
	if opts.PlatformBrandingService == nil {
		return
	}

	app.GET("/platform-branding", func(c *gin.Context) {
		configuration, err := opts.PlatformBrandingService.Get(c.Request.Context())
		if err != nil {
			platformBrandingUnavailable(c)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, appPlatformBrandingResponse(configuration))
	})
	mountPlatformBrandingImageRoute(app, "/platform-branding/sidebar-logo", opts.PlatformBrandingService, false)
	mountPlatformBrandingImageRoute(app, "/platform-branding/sidebar-compact-logo", opts.PlatformBrandingService, true)

	protected := admin.Group("/platform-branding")
	protected.Use(requirePermission(opts.RBACService, rbac.PermissionPlatformBrandingManage))
	protected.GET("", func(c *gin.Context) {
		configuration, err := opts.PlatformBrandingService.Get(c.Request.Context())
		if err != nil {
			platformBrandingUnavailable(c)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, adminPlatformBrandingResponse(configuration))
	})
	mountPlatformBrandingImageRoute(protected, "/sidebar-logo", opts.PlatformBrandingService, false)
	mountPlatformBrandingImageRoute(protected, "/sidebar-compact-logo", opts.PlatformBrandingService, true)
	protected.PUT("", func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, platformBrandingRequestMaxBytes)
		if err := c.Request.ParseMultipartForm(platformBrandingRequestMaxBytes); err != nil {
			platformBrandingInvalid(c, "上传内容无效或超过大小限制")
			return
		}
		defer c.Request.MultipartForm.RemoveAll()

		logoAction := platformbranding.Action(c.PostForm("sidebar_logo_action"))
		compactAction := platformbranding.Action(c.PostForm("sidebar_compact_logo_action"))
		logo, err := brandingUpload(c.Request.MultipartForm, "sidebar_logo", logoAction)
		if err != nil {
			platformBrandingInvalid(c, err.Error())
			return
		}
		compactLogo, err := brandingUpload(c.Request.MultipartForm, "sidebar_compact_logo", compactAction)
		if err != nil {
			platformBrandingInvalid(c, err.Error())
			return
		}
		configuration, err := opts.PlatformBrandingService.Update(c.Request.Context(), platformbranding.UpdateInput{
			SidebarLogoAction: logoAction, SidebarLogo: logo,
			SidebarCompactLogoAction: compactAction, SidebarCompactLogo: compactLogo,
			UpdatedBy: account.UserID,
		})
		if err != nil {
			if errors.Is(err, platformbranding.ErrInvalidAction) || errors.Is(err, platformbranding.ErrInvalidImage) || errors.Is(err, platformbranding.ErrImageTooLarge) {
				platformBrandingInvalid(c, "Logo 仅支持不超过 1 MiB、尺寸不超过 4096 像素的 PNG 或 JPEG 图片")
				return
			}
			platformBrandingUnavailable(c)
			return
		}
		logPlatformBrandingUpdate(opts.Logger, account.UserID, logoAction, compactAction, configuration)
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, adminPlatformBrandingResponse(configuration))
	})
}

func mountPlatformBrandingImageRoute(group *gin.RouterGroup, path string, service *platformbranding.Service, compact bool) {
	group.GET(path, func(c *gin.Context) {
		configuration, err := service.Get(c.Request.Context())
		if err != nil {
			platformBrandingUnavailable(c)
			return
		}
		image := configuration.SidebarLogo
		if compact {
			image = configuration.SidebarCompactLogo
		}
		if image == nil {
			c.Header("Cache-Control", "no-store")
			c.Status(http.StatusNotFound)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Data(http.StatusOK, image.ContentType, image.Content)
	})
}

func brandingUpload(form *multipart.Form, field string, action platformbranding.Action) ([]byte, error) {
	files := form.File[field]
	if action != platformbranding.ActionReplace {
		if len(files) != 0 {
			return nil, errors.New("保留或恢复默认时不能同时上传文件")
		}
		return nil, nil
	}
	if len(files) != 1 {
		return nil, errors.New("替换 Logo 时必须选择一个文件")
	}
	if files[0].Size > platformbranding.MaxImageSize {
		return nil, platformbranding.ErrImageTooLarge
	}
	file, err := files[0].Open()
	if err != nil {
		return nil, errors.New("无法读取上传文件")
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, platformbranding.MaxImageSize+1))
	if err != nil {
		return nil, errors.New("无法读取上传文件")
	}
	return content, nil
}

func appPlatformBrandingResponse(configuration platformbranding.Configuration) gin.H {
	return gin.H{
		"sidebar_logo_configured":         configuration.SidebarLogo != nil,
		"sidebar_compact_logo_configured": configuration.SidebarCompactLogo != nil,
	}
}

func adminPlatformBrandingResponse(configuration platformbranding.Configuration) gin.H {
	return gin.H{
		"sidebar_logo_configured":         configuration.SidebarLogo != nil,
		"sidebar_logo_url":                optionalBrandingURL(configuration.SidebarLogo, "/api/v1/admin/platform-branding/sidebar-logo"),
		"sidebar_compact_logo_configured": configuration.SidebarCompactLogo != nil,
		"sidebar_compact_logo_url":        optionalBrandingURL(configuration.SidebarCompactLogo, "/api/v1/admin/platform-branding/sidebar-compact-logo"),
	}
}

func optionalBrandingURL(image *platformbranding.Image, path string) any {
	if image == nil {
		return nil
	}
	return path
}

func platformBrandingInvalid(c *gin.Context, message string) {
	abortAuthorizationError(c, http.StatusBadRequest, "invalid_platform_branding", message)
}

func platformBrandingUnavailable(c *gin.Context) {
	abortAuthorizationError(c, http.StatusServiceUnavailable, "platform_branding_unavailable", "平台外观服务暂不可用")
}

func logPlatformBrandingUpdate(logger *zap.Logger, operator string, logoAction, compactAction platformbranding.Action, configuration platformbranding.Configuration) {
	if logger == nil {
		return
	}
	logger.Info("platform branding updated",
		zap.String("operator_user_id", operator),
		zap.Time("updated_at", configuration.UpdatedAt),
		zap.String("sidebar_logo_action", string(logoAction)),
		zap.String("sidebar_compact_logo_action", string(compactAction)),
		zap.Any("sidebar_logo", brandingImageSummary(configuration.SidebarLogo)),
		zap.Any("sidebar_compact_logo", brandingImageSummary(configuration.SidebarCompactLogo)),
	)
}

func brandingImageSummary(image *platformbranding.Image) any {
	if image == nil {
		return nil
	}
	digest := sha256.Sum256(image.Content)
	return map[string]any{
		"content_type": image.ContentType,
		"size_bytes":   len(image.Content),
		"sha256":       hex.EncodeToString(digest[:]),
	}
}
