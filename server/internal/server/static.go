package server

import (
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/server/webdist"
)

func registerStaticFallback(router *gin.Engine, staticDir string) {
	embeddedStatic, _ := fs.Sub(webdist.Files, "dist")

	router.NoRoute(func(c *gin.Context) {
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(http.StatusNotFound)
			return
		}
		if isAPIPath(c.Request.URL.Path) {
			c.Status(http.StatusNotFound)
			return
		}

		urlPath := c.Request.URL.Path
		if strings.HasPrefix(urlPath, "/assets/") || isPublicRootAsset(strings.TrimPrefix(urlPath, "/")) {
			if serveStaticFile(c, staticDir, embeddedStatic, strings.TrimPrefix(urlPath, "/")) {
				return
			}
			c.Status(http.StatusNotFound)
			return
		}

		if !isStaticAppRoute(urlPath) {
			c.Status(http.StatusNotFound)
			return
		}

		requestPath := strings.TrimPrefix(urlPath, "/")
		if serveStaticFile(c, staticDir, embeddedStatic, requestPath) {
			return
		}
		if serveStaticFile(c, staticDir, embeddedStatic, "index.html") {
			return
		}
		c.Status(http.StatusNotFound)
	})
}

func isAPIPath(urlPath string) bool {
	for _, segment := range strings.Split(strings.Trim(urlPath, "/"), "/") {
		if segment == "api" {
			return true
		}
	}
	return false
}

func isStaticAppRoute(urlPath string) bool {
	return urlPath == "/admin" ||
		strings.HasPrefix(urlPath, "/admin/") ||
		urlPath == "/app" ||
		strings.HasPrefix(urlPath, "/app/") ||
		urlPath == "/login" ||
		urlPath == "/downloads" ||
		urlPath == "/register"
}

func isPublicRootAsset(name string) bool {
	switch name {
	case "favicon.ico", "favicon.svg",
		"logo-v2-black-logo.svg", "logo-v2-white-logo.svg",
		"krillinai-mark-black.png", "krillinai-mark-white.png",
		"krillinai-wordmark-black.png", "krillinai-wordmark-white.png":
		return true
	default:
		return false
	}
}

func serveStaticFile(c *gin.Context, staticDir string, embeddedStatic fs.FS, name string) bool {
	cleanName := cleanStaticName(name)
	if cleanName == "" {
		return false
	}

	if staticDir != "" {
		target := filepath.Join(staticDir, filepath.FromSlash(cleanName))
		if isFile(target) {
			setStaticCacheControl(c, cleanName)
			gzipTarget := target + ".gz"
			if isFile(gzipTarget) {
				addVaryHeader(c, "Accept-Encoding")
				if acceptsGzip(c.Request) && c.GetHeader("Range") == "" {
					setCompressedStaticHeaders(c, cleanName)
					c.File(gzipTarget)
					return true
				}
			}
			c.File(target)
			return true
		}
	}

	if embeddedStatic != nil && isEmbeddedFile(embeddedStatic, cleanName) {
		setStaticCacheControl(c, cleanName)
		gzipName := cleanName + ".gz"
		if isEmbeddedFile(embeddedStatic, gzipName) {
			addVaryHeader(c, "Accept-Encoding")
			if acceptsGzip(c.Request) && c.GetHeader("Range") == "" {
				setCompressedStaticHeaders(c, cleanName)
				serveEmbeddedFile(c, embeddedStatic, gzipName, cleanName)
				return true
			}
		}
		serveEmbeddedFile(c, embeddedStatic, cleanName, cleanName)
		return true
	}
	return false
}

func serveEmbeddedFile(c *gin.Context, fsys fs.FS, name string, contentName string) {
	data, err := fs.ReadFile(fsys, name)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	contentType := mime.TypeByExtension(path.Ext(contentName))
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Length", strconv.Itoa(len(data)))
	c.Status(http.StatusOK)
	if c.Request.Method != http.MethodHead {
		_, _ = c.Writer.Write(data)
	}
}

func setCompressedStaticHeaders(c *gin.Context, name string) {
	c.Header("Content-Encoding", "gzip")
	if contentType := mime.TypeByExtension(path.Ext(name)); contentType != "" {
		c.Header("Content-Type", contentType)
	}
}

func setStaticCacheControl(c *gin.Context, name string) {
	switch {
	case strings.HasPrefix(name, "assets/"):
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
	case isPublicRootAsset(name):
		c.Header("Cache-Control", "public, max-age=86400")
	case name == "index.html":
		c.Header("Cache-Control", "no-cache")
	}
}

func addVaryHeader(c *gin.Context, value string) {
	for _, existing := range c.Writer.Header().Values("Vary") {
		for _, item := range strings.Split(existing, ",") {
			if strings.EqualFold(strings.TrimSpace(item), value) {
				return
			}
		}
	}
	c.Writer.Header().Add("Vary", value)
}

func acceptsGzip(request *http.Request) bool {
	wildcardAccepted := false
	for _, item := range strings.Split(request.Header.Get("Accept-Encoding"), ",") {
		parts := strings.Split(item, ";")
		encoding := strings.TrimSpace(parts[0])
		quality := 1.0
		for _, parameter := range parts[1:] {
			keyValue := strings.SplitN(strings.TrimSpace(parameter), "=", 2)
			if len(keyValue) != 2 || !strings.EqualFold(keyValue[0], "q") {
				continue
			}
			parsed, err := strconv.ParseFloat(keyValue[1], 64)
			if err != nil {
				quality = 0
			} else {
				quality = parsed
			}
		}
		if strings.EqualFold(encoding, "gzip") {
			return quality > 0
		}
		if encoding == "*" {
			wildcardAccepted = quality > 0
		}
	}
	return wildcardAccepted
}

func cleanStaticName(name string) string {
	cleanName := path.Clean(strings.TrimPrefix(name, "/"))
	if cleanName == "." || cleanName == ".." || strings.HasPrefix(cleanName, "../") {
		return ""
	}
	return cleanName
}

func isEmbeddedFile(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && !info.IsDir()
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
