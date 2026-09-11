package server

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

func mountOfficePublicRoutes(router *gin.Engine, opts Options) {
	if opts.OfficeCollectorAPI != nil {
		for _, path := range []string{
			"/api/v1/collector/register",
			"/api/v1/collector/heartbeat",
			"/api/v1/collector/events",
			"/api/v1/collector/tasks/pull",
			"/api/v1/collector/tasks/result",
		} {
			router.Any(path, wrapOfficeHandler(opts.OfficeCollectorAPI))
		}
	}
}

func mountOfficeAdminRoutes(admin *gin.RouterGroup, opts Options) {
	if opts.OfficeManagementAPI != nil {
		admin.GET("/collectors", requirePermission(opts.RBACService, rbac.PermissionCollectorRead), wrapOfficeHandler(opts.OfficeManagementAPI.CollectorsHandler()))
		admin.GET("/collectors/detail", requirePermission(opts.RBACService, rbac.PermissionCollectorRead), wrapOfficeHandler(opts.OfficeManagementAPI.CollectorDetailHandler()))
		admin.GET("/collectors/overview", requirePermission(opts.RBACService, rbac.PermissionCollectorRead), wrapOfficeHandler(opts.OfficeManagementAPI.CollectorsOverviewHandler()))
		admin.POST("/collectors/token/revoke", requirePermission(opts.RBACService, rbac.PermissionCollectorTokenRevoke), wrapOfficeHandler(opts.OfficeManagementAPI.CollectorTokenRevokeHandler()))
		admin.POST("/collectors/remove", requirePermission(opts.RBACService, rbac.PermissionCollectorDelete), wrapOfficeHandler(opts.OfficeManagementAPI.CollectorDeleteHandler()))
		admin.GET("/collector-registration-codes", requirePermission(opts.RBACService, rbac.PermissionCollectorRegistrationCodeCreate), wrapOfficeHandler(opts.OfficeManagementAPI.RegistrationCodeHandler()))
		admin.POST("/collector-registration-codes", requirePermission(opts.RBACService, rbac.PermissionCollectorRegistrationCodeCreate), wrapOfficeHandler(opts.OfficeManagementAPI.RegistrationCodeHandler()))
		admin.PUT("/activity/mcp-agent-binding", requirePermission(opts.RBACService, rbac.PermissionAgentBind), wrapOfficeHandler(opts.OfficeManagementAPI.AgentBindingHandler()))
		admin.POST("/activity/mcp-agent-binding/remove", requirePermission(opts.RBACService, rbac.PermissionAgentUnbind), wrapOfficeHandler(opts.OfficeManagementAPI.AgentUnbindingHandler()))
		admin.POST("/activity/agents/remove", requirePermission(opts.RBACService, rbac.PermissionAgentDelete), wrapOfficeHandler(opts.OfficeManagementAPI.AgentDeleteHandler()))
	}

	if opts.OfficeDashboardAPI != nil {
		admin.GET("/activity/overview", requirePermission(opts.RBACService, rbac.PermissionActivityRead), wrapOfficeHandler(opts.OfficeDashboardAPI.OverviewHandler()))
		admin.GET("/activity/agents", requirePermission(opts.RBACService, rbac.PermissionActivityRead), wrapOfficeHandler(opts.OfficeDashboardAPI.AgentsHandler()))
		admin.GET("/activity/detail", requirePermission(opts.RBACService, rbac.PermissionActivityRead), wrapOfficeHandler(opts.OfficeDashboardAPI.DetailHandler()))
		admin.GET("/activity/sub-agents", requirePermission(opts.RBACService, rbac.PermissionActivityRead), wrapOfficeHandler(opts.OfficeDashboardAPI.SubAgentsHandler()))
		admin.GET("/activity/recent", requirePermission(opts.RBACService, rbac.PermissionActivityRead), wrapOfficeHandler(opts.OfficeDashboardAPI.RecentActivitiesHandler()))
		admin.GET("/activity/events", requirePermission(opts.RBACService, rbac.PermissionActivityRead), wrapOfficeHandler(opts.OfficeDashboardAPI.RealtimeEventsHandler()))
	}
}

func wrapOfficeHandler(handler http.Handler) gin.HandlerFunc {
	return func(c *gin.Context) {
		serveOfficeHandler(c, handler)
	}
}

func serveOfficeHandler(c *gin.Context, handler http.Handler) {
	req := c.Request.Clone(c.Request.Context())
	if account, ok := currentAccount(c); ok {
		req = req.WithContext(httpapi.ContextWithManagementOperator(req.Context(), account.UserID))
		req = req.WithContext(httpapi.ContextWithManagementOperatorName(req.Context(), account.DisplayName()))
	}
	officeErrors := httpapi.NewRequestErrorSink()
	req = req.WithContext(httpapi.ContextWithRequestErrorSink(req.Context(), officeErrors))
	handler.ServeHTTP(c.Writer, req)
	for _, err := range officeErrors.Errors() {
		_ = c.Error(err)
	}
	c.Abort()
}

func mountOfficeAgentRoutes(app *gin.RouterGroup, opts Options) {
	app.POST("/agent-activity/events", handleClaweeActivityEvents(opts.ClaweeActivityReporter, opts.ActivityReportingEnabled))
	if opts.OfficeUserDashboardAPI != nil {
		app.GET("/activity/overview", wrapOfficeHandler(opts.OfficeUserDashboardAPI))
		app.GET("/activity/agents", wrapOfficeHandler(opts.OfficeUserDashboardAPI))
		app.GET("/activity/sub-agents", wrapOfficeHandler(opts.OfficeUserDashboardAPI))
		app.GET("/activity/recent", wrapOfficeHandler(opts.OfficeUserDashboardAPI))
		app.GET("/activity/events", wrapOfficeHandler(opts.OfficeUserDashboardAPI))
	}
	if opts.OfficeDashboardAPI != nil {
		app.GET("/activity/detail", func(c *gin.Context) {
			if !requireAgentActivityRead(c, opts) {
				return
			}
			serveOfficeHandler(c, opts.OfficeDashboardAPI.DetailHandler())
		})
	}
	if opts.OfficeUserCollectorsAPI != nil {
		app.GET("/collectors", wrapOfficeHandler(opts.OfficeUserCollectorsAPI))
		app.GET("/collectors/detail", wrapOfficeHandler(opts.OfficeUserCollectorsAPI))
		app.POST("/collectors/token/revoke", wrapOfficeHandler(opts.OfficeUserCollectorsAPI))
	}
	if opts.OfficeManagementAPI != nil {
		app.POST("/collectors/remove", wrapOfficeHandler(opts.OfficeManagementAPI.UserCollectorDeleteHandler()))
		app.GET("/collector-registration-codes", func(c *gin.Context) {
			account, ok := currentAccount(c)
			if !ok {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
				return
			}
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				opts.OfficeManagementAPI.GetAccountRegistrationCode(w, r, account.UserID)
			})
			serveOfficeHandler(c, handler)
		})
		app.POST("/collector-registration-codes", func(c *gin.Context) {
			account, ok := currentAccount(c)
			if !ok {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
				return
			}
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				opts.OfficeManagementAPI.CreateAccountRegistrationCode(w, r, account.UserID)
			})
			serveOfficeHandler(c, handler)
		})
	}
}
