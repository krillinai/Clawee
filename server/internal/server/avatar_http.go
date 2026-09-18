package server

import (
	"bytes"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
)

const maxAccountAvatarBytes = 2 << 20

func handleGetAccountAvatar(accountSvc *accounts.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		userID := strings.TrimSpace(c.Param("user_id"))
		if userID == "" {
			userID = account.UserID
		}
		if userID != account.UserID {
			abortAuthorizationError(c, http.StatusForbidden, "forbidden", "无权读取该头像")
			return
		}
		avatar, err := accountSvc.AccountAvatar(c.Request.Context(), userID)
		if err != nil {
			if errors.Is(err, accounts.ErrAccountAvatarNotFound) {
				c.Status(http.StatusNotFound)
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "avatar_unavailable", "message": "头像暂不可用"}})
			return
		}
		contentType := strings.TrimSpace(avatar.ContentType)
		if contentType == "" {
			contentType = http.DetectContentType(avatar.Data)
		}
		c.Header("Cache-Control", "private, no-store")
		c.Data(http.StatusOK, contentType, avatar.Data)
	}
}

func handleUploadAccountAvatar(accountSvc *accounts.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAccountAvatarBytes+64<<10)
		file, _, err := c.Request.FormFile("avatar")
		if err != nil {
			avatarJSONError(c, http.StatusBadRequest, "avatar_required", "请选择头像文件")
			return
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, maxAccountAvatarBytes+1))
		if err != nil || len(data) == 0 || len(data) > maxAccountAvatarBytes {
			avatarJSONError(c, http.StatusBadRequest, "avatar_too_large", "头像文件不能超过 2MB")
			return
		}
		contentType, err := validateAvatar(data)
		if err != nil {
			avatarJSONError(c, http.StatusBadRequest, "avatar_invalid", "头像必须是有效的 JPEG 或 PNG 图片")
			return
		}
		if err := accountSvc.SaveAccountAvatar(c.Request.Context(), account.UserID, accounts.AccountAvatar{
			Data: data, ContentType: contentType, Source: accounts.AvatarSourceUpload,
		}); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "avatar_save_failed", "message": "头像保存失败"}})
			return
		}
		c.JSON(http.StatusOK, gin.H{"avatar_url": "/api/v1/auth/avatar/" + account.UserID})
	}
}

func handleDeleteAccountAvatar(accountSvc *accounts.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		if err := accountSvc.DeleteAccountAvatar(c.Request.Context(), account.UserID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "avatar_delete_failed", "message": "头像恢复失败"}})
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func validateAvatar(data []byte) (string, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 {
		return "", errInvalidAvatar
	}
	if format != "jpeg" && format != "png" {
		return "", errInvalidAvatar
	}
	if _, decodedFormat, err := image.Decode(bytes.NewReader(data)); err != nil || decodedFormat != format {
		return "", errInvalidAvatar
	}
	if format == "jpeg" {
		return "image/jpeg", nil
	}
	return "image/png", nil
}

var errInvalidAvatar = errors.New("invalid avatar")

func avatarJSONError(c *gin.Context, status int, code, message string) {
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}
