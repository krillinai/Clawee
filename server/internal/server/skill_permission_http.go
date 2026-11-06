package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

type skillPermissionCheckRequest struct {
	UserID  string `json:"user_id"`
	SkillID string `json:"skill_id"`
}

type skillPermissionCheckResult struct {
	UserID  string `json:"user_id"`
	SkillID string `json:"skill_id"`
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason"`
}

func handleSkillPermissionCheck(accountService *accounts.Service, skillService *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16*1024)
		var body skillPermissionCheckRequest
		if decodeSkillJSON(c, &body) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		body.UserID = strings.TrimSpace(body.UserID)
		body.SkillID = strings.TrimSpace(body.SkillID)
		if body.UserID == "" || body.SkillID == "" || len(body.UserID) > 128 || len(body.SkillID) > 128 {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		result := skillPermissionCheckResult{UserID: body.UserID, SkillID: body.SkillID}
		account, err := accountService.Account(c.Request.Context(), body.UserID)
		if errors.Is(err, accounts.ErrAccountNotFound) {
			result.Reason = "account_unavailable"
			c.JSON(http.StatusOK, gin.H{"data": result})
			return
		}
		if err != nil {
			skillError(c, err)
			return
		}
		if account.Status != accounts.StatusActive {
			result.Reason = "account_unavailable"
			c.JSON(http.StatusOK, gin.H{"data": result})
			return
		}
		err = skillService.CheckSkillRead(c.Request.Context(), body.UserID, body.SkillID)
		if errors.Is(err, skillhub.ErrNotFound) {
			result.Reason = "skill_read_denied"
			c.JSON(http.StatusOK, gin.H{"data": result})
			return
		}
		if err != nil {
			skillError(c, err)
			return
		}
		result.Allowed = true
		result.Reason = "allowed"
		c.JSON(http.StatusOK, gin.H{"data": result})
	}
}
