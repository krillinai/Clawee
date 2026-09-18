package server

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

func writeSharedFilePreview(c *gin.Context, item sharedfiles.File, reader io.Reader) {
	kind, contentType := "", ""
	limit := int64(20 * 1024 * 1024)
	switch strings.ToLower(path.Ext(item.FileName)) {
	case ".png":
		kind, contentType = "image", "image/png"
	case ".jpg", ".jpeg":
		kind, contentType = "image", "image/jpeg"
	case ".gif":
		kind, contentType = "image", "image/gif"
	case ".webp":
		kind, contentType = "image", "image/webp"
	case ".pdf":
		kind, contentType = "pdf", "application/pdf"
	case ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".svg", ".js", ".jsx", ".ts", ".tsx", ".css", ".py", ".go", ".java", ".c", ".h", ".cpp", ".rs", ".sh", ".sql":
		kind, contentType = "text", "text/plain; charset=utf-8"
		limit = 1024 * 1024
	default:
		writeSharedFileCode(c, http.StatusUnsupportedMediaType, "preview_not_supported", "暂不支持预览此文件，请下载后查看")
		return
	}
	if item.SizeBytes > limit {
		writeSharedFileCode(c, http.StatusRequestEntityTooLarge, "preview_too_large", "文件超过预览大小限制，请下载后查看")
		return
	}
	content, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		writeSharedFileCode(c, http.StatusInternalServerError, "storage_unavailable", "文件读取失败")
		return
	}
	if int64(len(content)) > limit {
		writeSharedFileCode(c, http.StatusRequestEntityTooLarge, "preview_too_large", "文件超过预览大小限制，请下载后查看")
		return
	}
	// 不信任上传时填写的 MIME；只将通过基础格式检查的媒体交给浏览器。
	valid := http.DetectContentType(content) == contentType
	if kind == "text" {
		valid = utf8.Valid(content) && !bytes.ContainsRune(content, '\x00')
	}
	if !valid {
		writeSharedFileCode(c, http.StatusUnsupportedMediaType, "preview_not_supported", "文件内容不支持预览，请下载后查看")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": item.FileName}))
	c.Header("X-Preview-Kind", kind)
	c.Data(http.StatusOK, contentType, content)
}
