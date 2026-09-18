package server

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func handleSkillParticipantAvatar(service *skillhub.Service, accountService *accounts.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		detail, err := service.GetPublishedForUser(c.Request.Context(), account.UserID, c.Query("skill_id"))
		if err != nil {
			skillError(c, err)
			return
		}
		userID := strings.TrimSpace(c.Query("user_id"))
		allowed := userID != "" && detail.Creator != nil && detail.Creator.UserID == userID
		for _, contributor := range detail.Contributors {
			allowed = allowed || (userID != "" && contributor.UserID == userID)
		}
		if !allowed {
			c.Status(http.StatusNotFound)
			return
		}
		avatar, err := accountService.AccountAvatar(c.Request.Context(), userID)
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		c.Header("Cache-Control", "private, no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Data(http.StatusOK, avatar.ContentType, avatar.Data)
	}
}
