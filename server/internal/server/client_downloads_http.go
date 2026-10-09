package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/clientdownloads"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"go.uber.org/zap"
)

func mountClientDownloadsRoutes(api, admin *gin.RouterGroup, opts Options) {
	mountClientUpdateRoutes(api, admin, opts)
	if opts.ClientDownloadsService == nil {
		api.GET("/public/client-downloads", func(c *gin.Context) { clientDownloadsUnavailable(c) })
		return
	}
	api.GET("/public/client-downloads", func(c *gin.Context) {
		response, err := opts.ClientDownloadsService.Public(c.Request.Context(), requestOrigin(c))
		if err != nil {
			clientDownloadsUnavailable(c)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, response)
	})
	protected := admin.Group("/client-downloads")
	protected.GET("", requirePermission(opts.RBACService, rbac.PermissionClientDownloadsRead), func(c *gin.Context) {
		configuration, err := opts.ClientDownloadsService.Get(c.Request.Context())
		if err != nil {
			clientDownloadsUnavailable(c)
			return
		}
		if configuration.GatewayURL == "" {
			configuration.GatewayURL = requestOrigin(c)
		}
		status := "unavailable"
		version := ""
		packages := []clientdownloads.Artifact{}
		checkContext, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		manifest, manifestErr := opts.ClientDownloadsService.Public(checkContext, requestOrigin(c))
		cancel()
		if manifestErr == nil {
			status, version, packages = manifest.ManifestStatus, manifest.Version, manifest.Packages
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{
			"gateway_url": configuration.GatewayURL, "catalog_url": configuration.CatalogURL,
			"version": configuration.Version, "updated_by": configuration.UpdatedBy,
			"created_at": configuration.CreatedAt, "updated_at": configuration.UpdatedAt,
			"manifest_status": status, "manifest_version": version, "packages": packages,
		})
	})
	admin.PUT("/client-downloads", requirePermission(opts.RBACService, rbac.PermissionClientDownloadsUpdate), func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		var input struct {
			GatewayURL string `json:"gateway_url"`
			CatalogURL string `json:"catalog_url"`
			Version    int64  `json:"version"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			clientDownloadsInvalid(c, "请求内容无效")
			return
		}
		configuration, err := opts.ClientDownloadsService.Update(c.Request.Context(), clientdownloads.Config{GatewayURL: input.GatewayURL, CatalogURL: input.CatalogURL}, account.UserID, input.Version)
		if err != nil {
			if errors.Is(err, clientdownloads.ErrVersionConflict) {
				clientDownloadsConflict(c)
				return
			}
			clientDownloadsInvalid(c, err.Error())
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, configuration)
	})
}

func mountClientUpdateRoutes(api, admin *gin.RouterGroup, opts Options) {
	public := api.Group("/public/client-updates")
	public.Use(func(c *gin.Context) { c.Header("Cache-Control", "no-store"); c.Next() })
	public.GET("", func(c *gin.Context) {
		if opts.ClientDownloadsService == nil {
			clientDownloadsUnavailable(c)
			return
		}
		response, err := opts.ClientDownloadsService.PublicUpdate(c.Request.Context())
		if err != nil {
			clientDownloadsUnavailable(c)
			return
		}
		c.JSON(http.StatusOK, response)
	})
	public.GET("/:revision/:platform/:arch/:filename", func(c *gin.Context) {
		if opts.ClientDownloadsService == nil {
			clientDownloadsUnavailable(c)
			return
		}
		response, err := opts.ClientDownloadsService.PublicUpdate(c.Request.Context())
		if err != nil {
			clientDownloadsUnavailable(c)
			return
		}
		if response.Update == nil || strconv.FormatInt(response.Update.Revision, 10) != c.Param("revision") {
			c.Status(http.StatusNotFound)
			return
		}
		feed, ok := response.Update.Feed(c.Param("platform"), c.Param("arch"), c.Param("filename"))
		if !ok {
			c.Status(http.StatusNotFound)
			return
		}
		body, err := json.Marshal(feed)
		if err != nil {
			clientDownloadsUnavailable(c)
			return
		}
		c.Data(http.StatusOK, "application/yaml; charset=utf-8", body)
	})
	protected := admin.Group("/client-downloads/update")
	protected.Use(func(c *gin.Context) { c.Header("Cache-Control", "no-store"); c.Next() })
	protected.GET("", requirePermission(opts.RBACService, rbac.PermissionClientDownloadsRead), func(c *gin.Context) {
		if opts.ClientDownloadsService == nil {
			clientDownloadsUnavailable(c)
			return
		}
		response, err := opts.ClientDownloadsService.GetUpdate(c.Request.Context())
		if err != nil {
			clientDownloadsUnavailable(c)
			return
		}
		c.JSON(http.StatusOK, response)
	})
	protected.PUT("", requirePermission(opts.RBACService, rbac.PermissionClientDownloadsUpdate), func(c *gin.Context) {
		if opts.ClientDownloadsService == nil {
			clientDownloadsUnavailable(c)
			return
		}
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		var input struct {
			clientdownloads.CustomerUpdateManifest
			ExpectedRevision *int64 `json:"expected_revision"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10))
		if err := decoder.Decode(&input); err != nil || input.ExpectedRevision == nil {
			clientDownloadsInvalid(c, "请求内容无效，必须提供 expected_revision")
			return
		}
		if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
			clientDownloadsInvalid(c, "请求只能包含一个 JSON 对象")
			return
		}
		configuration, err := opts.ClientDownloadsService.Get(c.Request.Context())
		if err != nil {
			clientDownloadsUnavailable(c)
			return
		}
		response, err := opts.ClientDownloadsService.PublishUpdate(c.Request.Context(), input.CustomerUpdateManifest, configuration.GatewayURL, account.UserID, *input.ExpectedRevision)
		if err != nil {
			switch {
			case errors.Is(err, clientdownloads.ErrVersionConflict):
				clientDownloadsConflict(c)
			case errors.Is(err, clientdownloads.ErrInvalidUpdate):
				clientDownloadsInvalid(c, err.Error())
			default:
				clientDownloadsUnavailable(c)
			}
			return
		}
		if opts.Logger != nil {
			opts.Logger.Info("admin client update action", zap.String("request_id", requestIDFromContext(c.Request.Context())), zap.String("operator_user_id", account.UserID), zap.String("action", "publish"), zap.String("version", response.Update.Version), zap.Int64("revision", response.Revision), zap.String("result", "success"))
		}
		c.JSON(http.StatusOK, response)
	})
}

func requestOrigin(c *gin.Context) string {
	scheme := c.GetHeader("X-Forwarded-Proto")
	if scheme == "" {
		if c.Request.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	return strings.TrimRight(scheme+"://"+c.Request.Host, "/")
}
func clientDownloadsInvalid(c *gin.Context, message string) {
	c.Header("Cache-Control", "no-store")
	abortAuthorizationError(c, http.StatusBadRequest, "invalid_client_downloads", message)
}
func clientDownloadsConflict(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	abortAuthorizationError(c, http.StatusConflict, "client_downloads_version_conflict", "配置已被其他管理员修改，请刷新后重试")
}
func clientDownloadsUnavailable(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	abortAuthorizationError(c, http.StatusServiceUnavailable, "client_downloads_unavailable", "客户端发布清单暂时不可用")
}
