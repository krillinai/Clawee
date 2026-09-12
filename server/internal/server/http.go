package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/krillinai/Clawee/server/internal/accountgovernance"
	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/buildinfo"
	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/clawadmin"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/dingtalk"
	"github.com/krillinai/Clawee/server/internal/knowledge"
	"github.com/krillinai/Clawee/server/internal/mcpauth"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/platformbranding"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

type Options struct {
	ProxyGateway               *mcpgateway.Service
	AgentProvisioningService   *agentprovisioning.Service
	AccountService             *accounts.Service
	AccountGovernanceService   *accountgovernance.Service
	RBACService                *rbac.Service
	DataAccessService          *dataaccess.Service
	ActivityService            *activity.Service
	ModelConfigurationProvider interface {
		EnsureModelConfiguration(context.Context, clawadmin.AccountReference) (clawadmin.ModelConfiguration, error)
	}
	ModelCredentialLifecycle interface {
		DisableModelCredential(context.Context, string) error
	}
	BillingProvider interface {
		GetBillingOverview(context.Context, string) (clawadmin.BillingSnapshot, error)
		CreateRechargeSession(context.Context) (clawadmin.RechargeSession, error)
		ListRechargeOrders(context.Context, int, int) (clawadmin.RechargeOrderPage, error)
	}
	ModelAccessMode            ModelAccessMode
	BusinessDashboardService   *businessdata.DashboardService
	Logger                     *zap.Logger
	StaticDir                  string
	SessionCookieName          string
	AdminSessionCookieName     string
	SessionCookieSecure        bool
	AccessLogEnabled           bool
	ErrorResponseBodyLog       bool
	MCPAuth                    MCPAuthOptions
	OfficeCollectorAPI         http.Handler
	OfficeDashboardAPI         *httpapi.DashboardAPI
	OfficeUserDashboardAPI     http.Handler
	OfficeManagementAPI        *httpapi.ManagementAPI
	AgentCollectorLookup       AgentCollectorLookup
	OfficeUserCollectorsAPI    http.Handler
	ClaweeActivityReporter     ClaweeActivityReporter
	ActivityReportingEnabled   bool
	KnowledgeService           *knowledge.Service
	SkillHubService            *skillhub.Service
	SkillSourceService         *skillhub.GitHubSourceService
	SharedFilesService         *sharedfiles.Service
	SharedFileStorageService   *sharedfiles.StorageConfigurationService
	SharedFileMigrationService *sharedfiles.StorageMigrationService
	PlatformBrandingService    *platformbranding.Service
	DingTalkAuth               DingTalkAuthOptions
	BilibiliIntegration        BilibiliIntegration
	BilibiliSyncRequester      BilibiliSyncRequester
	BilibiliSourceManager      BilibiliSourceManager
	BilibiliWebhookClientID    string
	BilibiliWebhookSecret      string
}

type BilibiliIntegration interface {
	AuthorizationURL(context.Context, string) (string, error)
	HandleCallback(context.Context, string, string) (businessdata.Source, error)
	HandleDeauthorize(context.Context, string) error
}

type BilibiliSyncRequester interface {
	RequestSync(context.Context, string) (businessdata.SyncRequestResult, error)
}

type BilibiliSourceManager interface {
	List(context.Context) ([]businessdata.BilibiliSourceItem, error)
	RequestSync(context.Context, string) (businessdata.SyncRequestResult, error)
	SetSyncEnabled(context.Context, string, bool) (businessdata.BilibiliSourceChange, error)
	Delete(context.Context, string) error
}

type DingTalkClient interface {
	AuthorizationURL(string, string) string
	ResolveMember(context.Context, string) (dingtalk.Member, error)
}

type DingTalkAuthOptions struct {
	Enabled       bool
	ProviderKey   string
	RedirectURL   string
	AutoProvision bool
	StateTTL      time.Duration
	Client        DingTalkClient
}

type AgentCollectorLookup interface {
	FindAgentCollector(context.Context, string, time.Time, time.Duration) (management.AgentCollectorInfo, bool, error)
}

type MCPAuthOptions struct {
	Enabled              bool
	PublicBaseURL        string
	Resource             string
	ResourceMetadataURL  string
	AuthorizationServers []string
	RequiredScopes       []string
	DemoTokens           map[string]mcpauth.TokenConfig
	AccountTokenStore    mcpgateway.Store
	AccountService       *accounts.Service
}

var errMCPGatewayProxyDisabled = errors.New("mcp gateway proxy is disabled")
var errRBACServiceUnavailable = errors.New("rbac service is unavailable")

func itemsResponse[T any](items []T) gin.H {
	if items == nil {
		items = []T{}
	}
	return gin.H{"items": items}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func NewRouter(opts Options) http.Handler {
	gin.SetMode(gin.ReleaseMode)

	cookieName := strings.TrimSpace(opts.SessionCookieName)
	if cookieName == "" {
		cookieName = defaultSessionCookieName
	}
	adminCookieName := strings.TrimSpace(opts.AdminSessionCookieName)
	if adminCookieName == "" {
		adminCookieName = defaultAdminSessionCookieName
	}

	router := gin.New()
	router.Use(requestIDMiddleware())
	router.Use(accessLogMiddleware(opts.Logger, opts.AccessLogEnabled))
	router.Use(logAPIErrorResponses(opts.Logger, opts.ErrorResponseBodyLog))
	router.Use(recoveryMiddleware(opts.Logger))

	router.GET("/", func(c *gin.Context) {
		c.Redirect(http.StatusFound, "/app")
	})
	router.HEAD("/", func(c *gin.Context) {
		c.Redirect(http.StatusFound, "/app")
	})
	router.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok\n")
	})
	router.GET("/readyz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok\n")
	})
	router.GET("/version", func(c *gin.Context) {
		c.JSON(http.StatusOK, buildinfo.Info())
	})
	router.GET("/metrics", gin.WrapH(promhttp.Handler()))

	api := router.Group("/api/v1")
	authAPI := api.Group("/auth")
	appAPI := api.Group("/app")
	adminAPI := api.Group("/admin")
	authAPI.Use(unifiedAPIResponse())
	appAPI.Use(unifiedAPIResponse())
	adminAPI.Use(unifiedAPIResponse())

	mountDingTalkBrowserRoutes(api, opts, authCookieConfig{
		FrontendName: cookieName, AdminName: adminCookieName, Secure: opts.SessionCookieSecure,
	})
	mountBilibiliCallbackRoute(api, opts)

	mountAuthRoutes(authAPI, opts, authCookieConfig{
		FrontendName: cookieName, AdminName: adminCookieName, Secure: opts.SessionCookieSecure,
	})

	mountMCPEndpoints(router, opts)

	mountOfficePublicRoutes(router, opts)

	if opts.AccountService != nil {
		appAPI.Use(requireJWT(opts.AccountService, accounts.AudienceFrontend, cookieName))
		appAPI.Use(requireClaweeAgentBinding(opts.AccountService, opts.ProxyGateway))
		adminAPI.Use(requireJWT(opts.AccountService, accounts.AudienceAdmin, adminCookieName))
	}
	mountSkillHubRoutes(appAPI, adminAPI, opts)
	status := func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"service":              "clawee-gateway",
			"status":               "ok",
			"skill_source_enabled": opts.SkillSourceService != nil,
		})
	}
	adminAPI.GET("/status", requireAdminAccess(opts.RBACService), status)
	mountAccountAdminRoutes(adminAPI, opts)
	mountAccountGovernanceRoutes(adminAPI, opts)
	mountDataResourceGrantRoutes(adminAPI, opts)
	mountActivityRoutes(appAPI, opts)
	mountBilibiliAppRoutes(appAPI, opts)
	mountBillingRoutes(appAPI, opts)
	mountModelConfigurationRoutes(appAPI, opts)
	mountBusinessDataRoutes(appAPI, opts)
	mountPlatformBrandingRoutes(appAPI, adminAPI, opts)

	mountAgentRoutes(appAPI, opts)
	mountKnowledgeAppRoutes(appAPI, opts)
	mountOfficeAdminRoutes(adminAPI, opts)
	mountKnowledgeAdminRoutes(adminAPI, opts)
	mountAdminMCPRoutes(adminAPI, opts)
	mountSharedFileRoutes(appAPI, adminAPI, opts)
	mountSharedFileStorageRoutes(adminAPI, opts)
	mountRBACRoutes(adminAPI.Group("/rbac"), opts)

	registerStaticFallback(router, opts.StaticDir)

	return router
}
