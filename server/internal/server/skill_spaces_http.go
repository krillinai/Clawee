package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

type skillSpaceRequest struct {
	SpaceID     string `json:"space_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type skillSpaceMemberRequest struct {
	SpaceID string   `json:"space_id"`
	UserID  string   `json:"user_id"`
	Actions []string `json:"actions"`
}

type skillSpaceMemberResponse struct {
	skillhub.SpaceMemberGrant
	Name          string `json:"name"`
	Email         string `json:"email"`
	AccountStatus string `json:"account_status"`
}

type appSkillSpaceResponse struct {
	SpaceID     string    `json:"space_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	UpdatedAt   time.Time `json:"updated_at"`
	Actions     []string  `json:"actions"`
}

func mountSkillSpaceAdminRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.SkillHubService == nil || opts.AccountService == nil {
		return
	}
	read := skillRequirePermission(opts.RBACService, rbac.PermissionSkillRead)
	admin.GET("/skill-spaces", read, handleAdminSkillSpaces(opts.SkillHubService))
	admin.GET("/skill-spaces/detail", read, handleAdminSkillSpace(opts.SkillHubService))
	admin.POST("/skill-spaces", skillRequirePermission(opts.RBACService, rbac.PermissionSkillSpaceCreate), handleAdminCreateSkillSpace(opts.SkillHubService))
	admin.PATCH("/skill-spaces", skillRequirePermission(opts.RBACService, rbac.PermissionSkillSpaceUpdate), handleAdminUpdateSkillSpace(opts.SkillHubService))
	admin.GET("/skill-spaces/account-grants", read, handleAdminSkillSpaceMembers(opts.SkillHubService, opts.AccountService))
	admin.GET("/skill-spaces/member-candidates", skillRequirePermission(opts.RBACService, rbac.PermissionSkillSpaceMemberCreate), handleAdminSkillSpaceCandidates(opts.SkillHubService, opts.AccountService))
	admin.POST("/skill-spaces/account-grants", skillRequirePermission(opts.RBACService, rbac.PermissionSkillSpaceMemberCreate), handleAdminSetSkillSpaceMember(opts.SkillHubService, opts.AccountService, false))
	admin.PATCH("/skill-spaces/account-grants", skillRequirePermission(opts.RBACService, rbac.PermissionSkillSpaceMemberUpdate), handleAdminSetSkillSpaceMember(opts.SkillHubService, opts.AccountService, true))
	admin.POST("/skill-spaces/account-grants/remove", skillRequirePermission(opts.RBACService, rbac.PermissionSkillSpaceMemberDelete), handleAdminRemoveSkillSpaceMember(opts.SkillHubService))
}

func handleAppSkillSpaces(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, _ := currentAccount(c)
		items, err := service.ListAuthorizedSpaces(c.Request.Context(), account.UserID)
		if err != nil {
			skillError(c, err)
			return
		}
		response := make([]appSkillSpaceResponse, 0, len(items))
		for _, item := range items {
			response = append(response, appSkillSpaceResponse{
				SpaceID: item.SpaceID, Name: item.Name, Description: item.Description,
				UpdatedAt: item.UpdatedAt, Actions: item.Actions,
			})
		}
		c.JSON(http.StatusOK, itemsResponse(response))
	}
}

func handleAdminSkillSpaces(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := service.ListSpaces(c.Request.Context())
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleAdminSkillSpace(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		item, err := service.GetSpace(c.Request.Context(), c.Query("space_id"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleAdminCreateSkillSpace(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request skillSpaceRequest
		if decodeSkillJSON(c, &request) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		account, _ := currentAccount(c)
		item, err := service.CreateSpace(c.Request.Context(), request.Name, request.Description, account.UserID)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusCreated, item)
	}
}

func handleAdminUpdateSkillSpace(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request skillSpaceRequest
		if decodeSkillJSON(c, &request) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		account, _ := currentAccount(c)
		item, err := service.UpdateSpace(c.Request.Context(), request.SpaceID, request.Name, request.Description, account.UserID)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleAdminSkillSpaceMembers(service *skillhub.Service, accountService *accounts.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		grants, err := service.ListSpaceMembers(c.Request.Context(), c.Query("space_id"))
		if err != nil {
			skillError(c, err)
			return
		}
		accountItems, err := accountService.ListAccounts(c.Request.Context())
		if err != nil {
			skillError(c, err)
			return
		}
		query := strings.ToLower(strings.TrimSpace(c.Query("query")))
		byID := make(map[string]accounts.Account, len(accountItems))
		for _, account := range accountItems {
			byID[account.UserID] = account
		}
		items := []skillSpaceMemberResponse{}
		for _, grant := range grants {
			account := byID[grant.UserID]
			item := skillSpaceMemberResponse{SpaceMemberGrant: grant, Name: account.DisplayName(), Email: account.Email, AccountStatus: account.Status}
			if query == "" || strings.Contains(strings.ToLower(item.UserID+" "+item.Name+" "+item.Email), query) {
				items = append(items, item)
			}
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleAdminSkillSpaceCandidates(service *skillhub.Service, accountService *accounts.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		members, err := service.ListSpaceMembers(c.Request.Context(), c.Query("space_id"))
		if err != nil {
			skillError(c, err)
			return
		}
		memberIDs := map[string]bool{}
		for _, member := range members {
			memberIDs[member.UserID] = true
		}
		accountItems, err := accountService.ListAccounts(c.Request.Context())
		if err != nil {
			skillError(c, err)
			return
		}
		query := strings.ToLower(strings.TrimSpace(c.Query("query")))
		items := []gin.H{}
		for _, account := range accountItems {
			if account.Status != accounts.StatusActive || memberIDs[account.UserID] {
				continue
			}
			name := account.DisplayName()
			if query != "" && !strings.Contains(strings.ToLower(account.UserID+" "+name+" "+account.Email), query) {
				continue
			}
			items = append(items, gin.H{"user_id": account.UserID, "name": name, "email": account.Email})
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleAdminSetSkillSpaceMember(service *skillhub.Service, accountService *accounts.Service, replace bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request skillSpaceMemberRequest
		if decodeSkillJSON(c, &request) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if len(request.Actions) == 0 {
			request.Actions = []string{skillhub.SpaceActionRead, skillhub.SpaceActionWrite}
		}
		target, err := accountService.Account(c.Request.Context(), request.UserID)
		if err != nil || target.Status != accounts.StatusActive {
			skillError(c, skillhub.ErrMemberNotFound)
			return
		}
		account, _ := currentAccount(c)
		item, err := service.SetSpaceMember(c.Request.Context(), request.SpaceID, target.UserID, request.Actions, account.UserID, replace)
		if err != nil {
			skillError(c, err)
			return
		}
		status := http.StatusCreated
		if replace {
			status = http.StatusOK
		}
		c.JSON(status, item)
	}
}

func handleAdminRemoveSkillSpaceMember(service *skillhub.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request skillSpaceMemberRequest
		if decodeSkillJSON(c, &request) != nil {
			skillError(c, skillhub.ErrInvalidRequest)
			return
		}
		if err := service.RemoveSpaceMember(c.Request.Context(), request.SpaceID, request.UserID); err != nil {
			skillError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
}
