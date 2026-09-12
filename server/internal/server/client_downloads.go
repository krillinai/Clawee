package server

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/config"
)

func mountClientDownloadsRoute(api *gin.RouterGroup, downloads config.ClientDownloadsConfig) {
	if downloads.Standard.URL == "" {
		downloads.Standard = config.StandardClientDownload{URL: config.StandardClientDownloadURL}
	}
	if downloads.Packages == nil {
		downloads.Packages = []config.ClientDownload{}
	}
	downloads.Gateway = strings.TrimRight(downloads.Gateway, "/")
	api.GET("/public/client-downloads", func(c *gin.Context) {
		c.Header("Cache-Control", "no-cache")
		c.JSON(http.StatusOK, downloads)
	})
}
