package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/accountgovernance"
	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/agentactivitymcp"
	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/businessdatamcp"
	"github.com/krillinai/Clawee/server/internal/clawadmin"
	"github.com/krillinai/Clawee/server/internal/collectorpull"
	"github.com/krillinai/Clawee/server/internal/config"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/dingtalk"
	"github.com/krillinai/Clawee/server/internal/knowledge"
	knowledgeBuiltin "github.com/krillinai/Clawee/server/internal/knowledge/builtin"
	"github.com/krillinai/Clawee/server/internal/logger"
	"github.com/krillinai/Clawee/server/internal/mcpauth"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	officeClawee "github.com/krillinai/Clawee/server/internal/office/claweeactivity"
	officeDashboard "github.com/krillinai/Clawee/server/internal/office/dashboard"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	officeRealtime "github.com/krillinai/Clawee/server/internal/office/realtime"
	officeState "github.com/krillinai/Clawee/server/internal/office/state"
	officeStore "github.com/krillinai/Clawee/server/internal/office/store"
	"github.com/krillinai/Clawee/server/internal/platformbranding"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
	"github.com/krillinai/Clawee/server/internal/skillhub"
	"github.com/krillinai/Clawee/server/internal/store"
	"github.com/krillinai/Clawee/server/internal/sub2api"
)

type App struct {
	Config         config.Config
	Logger         *zap.Logger
	Router         http.Handler
	DB             *pgxpool.Pool
	CollectorDB    *pgxpool.Pool
	sqlDB          *sql.DB
	collectorSQLDB *sql.DB

	skillSourceScheduler  interface{ Close() }
	businessDataScheduler interface{ Close() }
	storageMigration      interface{ Close() }
	closeDatabases        func()
}

var skillHubGitLookPath = exec.LookPath

func New(ctx context.Context, cfg config.Config) (*App, error) {
	if len(cfg.MCP.Auth.DemoTokens) != 0 {
		return nil, errors.New("账户级 MCP Token 模式不支持 demo_tokens")
	}
	if err := cfg.Bilibili.Validate(); err != nil {
		return nil, err
	}
	sessionDuration, err := cfg.Security.Validate()
	if err != nil {
		return nil, err
	}
	clawAdminTimeout, err := cfg.ClawAdmin.Validate()
	if err != nil {
		return nil, err
	}
	clawAdminClient := clawadmin.NewClient(cfg.ClawAdmin.BaseURL, cfg.ClawAdmin.DeploymentCredential, clawAdminTimeout)
	snapshotClient, err := selectSnapshotClient(cfg, clawAdminClient)
	if err != nil {
		return nil, err
	}
	dingtalkStateTTL, dingtalkTimeout, err := cfg.DingTalk.Validate()
	if err != nil {
		return nil, err
	}
	log, err := logger.New(logger.Options{
		Level:  cfg.Logging.Level,
		Format: cfg.Logging.Format,
		Output: cfg.Logging.Output,
	})
	if err != nil {
		return nil, err
	}

	pool, collectorPool, err := openDatabasePools(ctx, cfg.Database.URL)
	if err != nil {
		return nil, err
	}
	if cfg.Bilibili.Enabled && pool == nil {
		return nil, errors.New("bilibili requires a PostgreSQL connection")
	}
	poolsOwned := true
	defer func() {
		if !poolsOwned {
			return
		}
		if collectorPool != nil {
			collectorPool.Close()
		}
		if pool != nil {
			pool.Close()
		}
	}()

	proxyMemoryStore := mcpgateway.NewMemoryStore()
	proxyStore := mcpgateway.Store(proxyMemoryStore)
	var mcpUsageStore activity.MCPUsageStore
	if pool != nil {
		proxyStore = store.NewMCPGatewayStore(pool)
		mcpUsageStore = store.NewMCPUsagePostgresStore(pool)
	}
	dataAccessStore := dataaccess.Store(dataaccess.NewMemoryStore())
	if pool != nil {
		dataAccessStore = dataaccess.NewPostgresStore(pool)
	}
	dataAccessSvc := dataaccess.NewService(dataAccessStore)
	tokenCipher, err := mcpgateway.NewTokenCipher([]byte(cfg.Security.AgentTokenEncryptionKey))
	if err != nil {
		return nil, err
	}
	var knowledgeSvc *knowledge.Service
	var knowledgeResolver mcpgateway.KnowledgeBindingResolver
	var credentialResolver func(string) (string, error)
	pullBroker := collectorpull.NewBroker()
	transportClient := mcpgateway.NewTransportRoutingUpstreamClient(
		mcpgateway.NewSDKUpstreamClient("claw-mcp-gateway"),
		map[string]mcpgateway.UpstreamClient{
			mcpgateway.TransportCollectorPull: collectorpull.NewClient(pullBroker),
		},
	)
	routingClient := mcpgateway.NewRoutingUpstreamClient(transportClient, nil)
	upstreamClient := mcpgateway.UpstreamClient(routingClient)
	if cfg.Knowledge.Enabled {
		runtime, err := knowledge.NewRuntime(cfg.Knowledge, log)
		if err != nil {
			return nil, err
		}
		builtinClient, err := knowledgeBuiltin.NewClient(runtime.Provider, cfg.Knowledge.ProviderType)
		if err != nil {
			return nil, err
		}
		if err := routingClient.Register(knowledge.AdapterServerID, builtinClient); err != nil {
			return nil, err
		}
		knowledgeStore := knowledge.Store(knowledge.NewMemoryStore())
		if pool != nil {
			knowledgeStore = knowledge.NewPostgresStore(pool)
		}
		knowledgeSvc = knowledge.NewService(knowledgeStore, runtime.Provider, log)
		knowledgeResolver = knowledgeBindingResolver{store: knowledgeStore}
		credentialResolver = knowledge.ResolveCredential
	}
	proxyGateway := mcpgateway.NewService(mcpgateway.Config{
		Store:                      proxyStore,
		UpstreamClient:             upstreamClient,
		TokenCipher:                tokenCipher,
		Logger:                     log,
		ResolveCredential:          credentialResolver,
		KnowledgeResolver:          knowledgeResolver,
		KnowledgeMCPAccessResolver: accountKnowledgeMCPAccessResolver{service: dataAccessSvc},
	})
	if err := reconcileKnowledgeBuiltin(ctx, proxyStore, cfg.Knowledge.Enabled); err != nil {
		return nil, err
	}

	accountMemoryStore := accounts.NewMemoryStore()
	accountStore := accounts.Store(accountMemoryStore)
	if pool != nil {
		accountStore = accounts.NewPostgresStore(pool)
	}
	accountSvc := accounts.NewService(accounts.Config{
		Store:           accountStore,
		SessionDuration: sessionDuration,
		JWTSigningKey:   []byte(cfg.Security.UserJWTSigningKey),
	})
	proxyGateway.SetIdentityResolvers(
		func(ctx context.Context, agentID string) (string, error) {
			account, err := accountSvc.AccountForAgent(ctx, agentID)
			return account.UserID, err
		},
		func(ctx context.Context, userID string) error {
			account, err := accountSvc.Account(ctx, userID)
			if err != nil {
				return err
			}
			if account.Status != accounts.StatusActive {
				return accounts.ErrAccountNotActive
			}
			return nil
		},
	)
	var accountGovernanceSvc *accountgovernance.Service
	if pool != nil {
		accountGovernanceSvc = accountgovernance.NewService(accountgovernance.NewPostgresStore(pool))
	}
	agentProvisioner := agentprovisioning.NewService(accountSvc, proxyGateway)
	if pool == nil {
		proxyMemoryStore.SetOwnedAgentBinder(func(ctx context.Context, userID, agentID string, createdAt time.Time) error {
			err := accountMemoryStore.SaveActiveAccountAgent(ctx, accounts.AccountAgent{UserID: userID, AgentID: agentID, CreatedAt: createdAt})
			if errors.Is(err, accounts.ErrAccountNotFound) || errors.Is(err, accounts.ErrAccountNotActive) {
				return mcpgateway.ErrAgentOwnerUnavailable
			}
			return err
		})
		proxyMemoryStore.SetOwnedAgentRemover(accountMemoryStore.DeleteAccountAgent)
	}
	rbacStore := rbac.Store(rbac.NewMemoryStore())
	if pool != nil {
		rbacStore = rbac.NewPostgresStore(pool)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbacStore, Accounts: accountSvc})
	if pool == nil {
		if err := rbacSvc.Initialize(ctx); err != nil {
			return nil, err
		}
	}
	platformBrandingStore := platformbranding.Store(platformbranding.NewMemoryStore())
	if pool != nil {
		platformBrandingStore = platformbranding.NewPostgresStore(pool)
	}
	platformBrandingSvc := platformbranding.NewService(platformBrandingStore)
	var dingtalkClient *dingtalk.Client
	if cfg.DingTalk.Enabled {
		dingtalkClient = dingtalk.NewClient(cfg.DingTalk.ClientID, cfg.DingTalk.ClientSecret, dingtalkTimeout)
	}
	skillHubRuntime, err := buildSkillHubRuntime(ctx, pool, cfg.SkillHub, tokenCipher, log)
	if err != nil {
		return nil, err
	}
	var sharedFilesSvc *sharedfiles.Service
	var sharedFileStorageConfigSvc *sharedfiles.StorageConfigurationService
	var sharedFileStorageMigrationSvc *sharedfiles.StorageMigrationService
	if pool != nil {
		sharedStorage, err := sharedfiles.NewFileSystemStorage(cfg.SharedFiles.StorageRoot)
		if err != nil {
			return nil, fmt.Errorf("prepare shared file storage: %w", err)
		}
		if err := sharedStorage.CleanStaleTemp(time.Now().UTC()); err != nil {
			return nil, fmt.Errorf("clean shared file temporary storage: %w", err)
		}
		sharedStore := sharedfiles.NewPostgresStore(pool)
		ossFactory := sharedfiles.NewOSSStorageFactory(tokenCipher, log, cfg.SharedFiles.OSS.AllowedEndpointHosts...)
		storageRegistry := sharedfiles.NewStorageRegistry(sharedStore, sharedStorage, ossFactory)
		sharedFilesSvc = sharedfiles.NewServiceWithRegistry(sharedStore, storageRegistry, log)
		sharedFileStorageConfigSvc = sharedfiles.NewStorageConfigurationService(
			sharedStore, storageRegistry, ossFactory, tokenCipher, cfg.SharedFiles.OSS.AllowedEndpointHosts, log)
		sharedFileStorageMigrationSvc = sharedfiles.NewStorageMigrationService(sharedStore, storageRegistry, log)
	}

	var officeCollectorAPI http.Handler
	var officeDashboardAPI *httpapi.DashboardAPI
	var officeUserDashboardAPI http.Handler
	var officeManagementAPI *httpapi.ManagementAPI
	var officeUserCollectorsAPI http.Handler
	var officeSQLDB *sql.DB
	var collectorSQLDB *sql.DB
	if pool != nil {
		officeSQLDB = stdlib.OpenDBFromPool(pool)
	}
	if collectorPool != nil {
		collectorSQLDB = stdlib.OpenDBFromPool(collectorPool)
	}
	officeAPIs := buildOfficeAPIs(officeSQLDB, collectorSQLDB, cfg.Office.Install, agentProvisioner, pullBroker)
	officeCollectorAPI = officeAPIs.collector
	officeDashboardAPI = officeAPIs.dashboard
	officeUserDashboardAPI = officeAPIs.userDashboard
	officeManagementAPI = officeAPIs.management
	officeUserCollectorsAPI = officeAPIs.userCollectors
	activitySvc, err := activity.NewService(snapshotClient, officeAPIs.activityStore, mcpUsageStore, "Asia/Shanghai")
	if err != nil {
		return nil, err
	}
	businessDashboardSvc := businessdata.NewDashboardService(nil)
	var businessScheduler *businessdata.Scheduler
	var bilibiliSourceService *businessdata.BilibiliSourceService
	var bilibiliIntegration *businessdata.BilibiliOAuthService
	if pool != nil {
		businessStore := businessdata.NewPostgresStore(pool)
		registry := businessdata.NewConnectorRegistry()
		if cfg.Bilibili.Enabled {
			bilibiliClient := businessdata.NewBilibiliHTTPClient(cfg.Bilibili.ClientID, cfg.Bilibili.ClientSecret, &http.Client{Timeout: 10 * time.Second})
			bilibiliIntegration = businessdata.NewBilibiliOAuthService(businessStore, bilibiliClient, tokenCipher, cfg.Bilibili.RedirectURL)
			if err := registry.Register(businessdata.NewBilibiliConnector(bilibiliIntegration, bilibiliClient)); err != nil {
				return nil, fmt.Errorf("register bilibili business data connector: %w", err)
			}
		}
		syncService := businessdata.NewSyncService(businessStore, registry, log)
		businessDashboardSvc = businessdata.NewDashboardService(businessStore)
		businessScheduler = businessdata.NewScheduler(businessStore, syncService, log)
		bilibiliSourceService = businessdata.NewBilibiliSourceService(businessStore, businessScheduler)
		if err := businessScheduler.Start(ctx); err != nil {
			return nil, fmt.Errorf("start business data scheduler: %w", err)
		}
	}
	agentActivityClient, err := agentactivitymcp.NewClient(activitySvc, officeAPIs.agentSummaryReader, dataAccessSvc)
	if err != nil {
		return nil, err
	}
	if err := routingClient.Register(agentactivitymcp.ServerID, agentActivityClient); err != nil {
		return nil, err
	}
	businessDataClient, err := businessdatamcp.NewClient(businessDashboardSvc, dataAccessSvc)
	if err != nil {
		return nil, err
	}
	if err := routingClient.Register(businessdatamcp.ServerID, businessDataClient); err != nil {
		return nil, err
	}
	if err := reconcileAgentActivityBuiltin(ctx, proxyStore); err != nil {
		return nil, err
	}
	if err := reconcileBusinessDataBuiltin(ctx, proxyStore); err != nil {
		return nil, err
	}
	if cfg.Knowledge.Enabled {
		if err := proxyGateway.SyncTools(ctx, knowledge.AdapterServerID, ""); err != nil {
			return nil, err
		}
	}
	for _, serverID := range []string{agentactivitymcp.ServerID, businessdatamcp.ServerID} {
		if err := proxyGateway.SyncTools(ctx, serverID, ""); err != nil {
			return nil, err
		}
	}

	application := &App{
		Config: cfg,
		Logger: log,
		Router: server.NewRouter(server.Options{
			ProxyGateway:               proxyGateway,
			AgentProvisioningService:   agentProvisioner,
			AccountService:             accountSvc,
			AccountGovernanceService:   accountGovernanceSvc,
			RBACService:                rbacSvc,
			DataAccessService:          dataAccessSvc,
			ActivityService:            activitySvc,
			ModelConfigurationProvider: clawAdminClient,
			ModelCredentialLifecycle:   clawAdminClient,
			BillingProvider:            clawAdminClient,
			ModelAccessMode:            server.ModelAccessMode(cfg.ModelAccess.Mode),
			BusinessDashboardService:   businessDashboardSvc,
			BilibiliIntegration:        bilibiliIntegration,
			BilibiliSyncRequester:      businessScheduler,
			BilibiliSourceManager:      bilibiliSourceService,
			BilibiliWebhookClientID:    cfg.Bilibili.ClientID,
			BilibiliWebhookSecret:      cfg.Bilibili.ClientSecret,
			Logger:                     log,
			StaticDir:                  cfg.Static.Dir,
			SessionCookieName:          cfg.Security.SessionCookieName,
			AdminSessionCookieName:     cfg.Security.AdminSessionCookieName,
			SessionCookieSecure:        cfg.Security.SessionCookieSecure,
			AccessLogEnabled:           cfg.Logging.AccessEnabled,
			ErrorResponseBodyLog:       cfg.Logging.ErrorResponseBody,
			OfficeCollectorAPI:         officeCollectorAPI,
			OfficeDashboardAPI:         officeDashboardAPI,
			OfficeUserDashboardAPI:     officeUserDashboardAPI,
			OfficeManagementAPI:        officeManagementAPI,
			AgentCollectorLookup:       officeAPIs.agentCollectorLookup,
			OfficeUserCollectorsAPI:    officeUserCollectorsAPI,
			ClaweeActivityReporter:     officeAPIs.activityReporter,
			ActivityReportingEnabled:   cfg.Activity.ReportingEnabled,
			KnowledgeService:           knowledgeSvc,
			SkillHubService:            skillHubRuntime.Service,
			SkillSourceService:         skillHubRuntime.Sources,
			SharedFilesService:         sharedFilesSvc,
			SharedFileStorageService:   sharedFileStorageConfigSvc,
			SharedFileMigrationService: sharedFileStorageMigrationSvc,
			PlatformBrandingService:    platformBrandingSvc,
			DingTalkAuth: server.DingTalkAuthOptions{
				Enabled: cfg.DingTalk.Enabled, ProviderKey: cfg.DingTalk.ProviderKey,
				RedirectURL: cfg.DingTalk.RedirectURL, AutoProvision: cfg.DingTalk.AutoProvision,
				StateTTL: dingtalkStateTTL, Client: dingtalkClient,
			},
			MCPAuth: server.MCPAuthOptions{
				Enabled:              cfg.MCP.Auth.Enabled,
				PublicBaseURL:        cfg.MCP.PublicBaseURL,
				Resource:             cfg.MCP.Auth.Resource,
				ResourceMetadataURL:  cfg.MCP.Auth.ResourceMetadataURL,
				AuthorizationServers: cfg.MCP.Auth.AuthorizationServers,
				RequiredScopes:       cfg.MCP.Auth.RequiredScopes,
				DemoTokens:           toMCPDemoTokens(cfg.MCP.Auth.DemoTokens),
				AccountTokenStore:    proxyStore,
				AccountService:       accountSvc,
			},
		}),
		DB:                    pool,
		CollectorDB:           collectorPool,
		sqlDB:                 officeSQLDB,
		collectorSQLDB:        collectorSQLDB,
		skillSourceScheduler:  skillHubRuntime.Scheduler,
		businessDataScheduler: businessScheduler,
		storageMigration:      sharedFileStorageMigrationSvc,
		closeDatabases: func() {
			if collectorSQLDB != nil {
				collectorSQLDB.Close()
			}
			if officeSQLDB != nil {
				officeSQLDB.Close()
			}
			if collectorPool != nil {
				collectorPool.Close()
			}
			if pool != nil {
				pool.Close()
			}
		},
	}
	if sharedFileStorageMigrationSvc != nil {
		sharedFileStorageMigrationSvc.Start(ctx)
	}
	poolsOwned = false
	return application, nil
}

func selectSnapshotClient(cfg config.Config, clawAdminClient activity.SnapshotClient) (activity.SnapshotClient, error) {
	if cfg.ModelAccess.Mode != "enterprise_managed" {
		return clawAdminClient, nil
	}
	baseURL := strings.TrimSpace(cfg.Sub2API.BaseURL)
	apiKey := strings.TrimSpace(cfg.Sub2API.AdminAPIKey)
	userID := cfg.Sub2API.OrganizationUserID
	switch {
	case baseURL == "" && apiKey == "" && userID == 0:
		return nil, nil
	case baseURL == "" || apiKey == "" || userID <= 0:
		return nil, errors.New("sub2api config must be either empty or complete")
	default:
		return sub2api.NewClient(sub2api.Config{BaseURL: baseURL, AdminAPIKey: apiKey, OrganizationUserID: userID})
	}
}

func openDatabasePools(ctx context.Context, databaseURL string) (*pgxpool.Pool, *pgxpool.Pool, error) {
	adminPool, err := store.OpenPostgres(ctx, databaseURL)
	if err != nil {
		return nil, nil, err
	}
	collectorPool, err := store.OpenPostgres(ctx, databaseURL)
	if err != nil {
		if adminPool != nil {
			adminPool.Close()
		}
		return nil, nil, err
	}
	return adminPool, collectorPool, nil
}

func buildSkillHubService(ctx context.Context, pool *pgxpool.Pool, cfg config.SkillHubConfig) (*skillhub.Service, error) {
	service, _, err := buildSkillHubCore(ctx, pool, cfg)
	return service, err
}

type skillHubRuntime struct {
	Service   *skillhub.Service
	Sources   *skillhub.GitHubSourceService
	Scheduler *skillhub.SourceScheduler
}

func buildSkillHubRuntime(ctx context.Context, pool *pgxpool.Pool, cfg config.SkillHubConfig, tokenCipher mcpgateway.TokenCipher, log *zap.Logger) (skillHubRuntime, error) {
	if !cfg.Enabled {
		return skillHubRuntime{}, nil
	}
	gitExecutable := ""
	repositoryRoot := ""
	if cfg.GitHubSyncEnabled {
		var err error
		gitExecutable, err = skillHubGitLookPath("git")
		if err != nil {
			return skillHubRuntime{}, fmt.Errorf("find git executable: %w", err)
		}
		repositoryRoot, err = skillhub.PrepareRepositoryRoot(cfg.RepositoryRoot)
		if err != nil {
			return skillHubRuntime{}, fmt.Errorf("prepare skillhub repository root: %w", err)
		}
	}
	service, packageRoot, err := buildSkillHubCore(ctx, pool, cfg)
	if err != nil {
		return skillHubRuntime{}, err
	}
	runtime := skillHubRuntime{Service: service}
	if !cfg.GitHubSyncEnabled {
		return runtime, nil
	}
	if tokenCipher == nil {
		return skillHubRuntime{}, errors.New("skillhub github sync requires token cipher")
	}
	sourceStore := skillhub.NewPostgresSourceStore(pool)
	gitClient := skillhub.NewGitClient(gitExecutable, 300*time.Second, 64*1024, log)
	workspace := skillhub.NewRepositoryWorkspace(repositoryRoot, gitClient)
	syncService := skillhub.NewSourceSyncService(skillhub.SourceSyncServiceConfig{
		Store: sourceStore, TokenCipher: tokenCipher, Workspace: workspace, Git: gitClient,
		Discovery: &skillhub.SkillDiscovery{}, PackageBuilder: &skillhub.SourcePackageBuilder{},
		VersionService: service, PackageRoot: packageRoot,
	})
	runtime.Scheduler = skillhub.NewSourceScheduler(sourceStore, syncService, log)
	runtime.Sources = skillhub.NewGitHubSourceService(skillhub.GitHubSourceServiceConfig{
		Store: sourceStore, TokenCipher: tokenCipher, Workspace: workspace, OnRunQueued: runtime.Scheduler.NotifyRunQueued,
	})
	if err := runtime.Scheduler.Start(ctx); err != nil {
		return skillHubRuntime{}, fmt.Errorf("start skillhub source scheduler: %w", err)
	}
	return runtime, nil
}

func buildSkillHubCore(ctx context.Context, pool *pgxpool.Pool, cfg config.SkillHubConfig) (*skillhub.Service, string, error) {
	if !cfg.Enabled {
		return nil, "", nil
	}
	if pool == nil {
		return nil, "", errors.New("skillhub requires a PostgreSQL connection")
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, "", fmt.Errorf("connect skillhub PostgreSQL: %w", err)
	}
	packageRoot, err := skillhub.PreparePackageRoot(cfg.PackageRoot)
	if err != nil {
		return nil, "", err
	}
	return skillhub.NewService(skillhub.Config{
		Store:       skillhub.NewPostgresStore(pool),
		PackageRoot: packageRoot,
	}), packageRoot, nil
}

type knowledgeBindingResolver struct {
	store knowledge.Store
}

func (r knowledgeBindingResolver) ResolveKnowledgeBinding(ctx context.Context, id string) (mcpgateway.KnowledgeBinding, error) {
	kb, err := r.store.GetKnowledgeBase(ctx, id)
	if err != nil || kb.Status != knowledge.KnowledgeBaseActive {
		return mcpgateway.KnowledgeBinding{}, errors.New("knowledge_base_unavailable")
	}
	if kb.ProviderType == "" || kb.ExternalKnowledgeBaseID == "" {
		return mcpgateway.KnowledgeBinding{}, errors.New("knowledge_binding_not_found")
	}
	return mcpgateway.KnowledgeBinding{
		KnowledgeBaseID: kb.KnowledgeBaseID, KnowledgeBaseName: kb.Name,
		ProviderType: kb.ProviderType, ExternalKnowledgeBaseID: kb.ExternalKnowledgeBaseID,
	}, nil
}

type accountKnowledgeMCPAccessResolver struct {
	service *dataaccess.Service
}

func (r accountKnowledgeMCPAccessResolver) ResolveMCPKnowledgeBaseIDs(ctx context.Context, userID string) ([]string, error) {
	if r.service == nil || strings.TrimSpace(userID) == "" {
		return []string{}, nil
	}
	grants, err := r.service.List(ctx, dataaccess.Filter{
		UserID: strings.TrimSpace(userID), ResourceType: dataaccess.ResourceKnowledgeBase, Action: dataaccess.ActionMCP,
	})
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(grants))
	resolved := make([]string, 0, len(grants))
	for _, grant := range grants {
		if _, ok := seen[grant.ResourceID]; ok {
			continue
		}
		seen[grant.ResourceID] = struct{}{}
		resolved = append(resolved, grant.ResourceID)
	}
	return resolved, nil
}

func reconcileKnowledgeBuiltin(ctx context.Context, store mcpgateway.Store, enabled bool) error {
	const serverID = knowledge.AdapterServerID
	existing, err := store.GetUpstreamServer(ctx, serverID)
	if err != nil && !errors.Is(err, mcpgateway.ErrUpstreamServerNotFound) {
		return err
	}
	if errors.Is(err, mcpgateway.ErrUpstreamServerNotFound) && !enabled {
		return nil
	}
	status := mcpgateway.StatusDisabled
	if enabled {
		status = mcpgateway.StatusActive
	}
	return store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{
		ID:        serverID,
		Name:      "企业知识库",
		Domain:    "knowledge",
		Transport: mcpgateway.TransportBuiltin,
		Namespace: "knowledge",
		Status:    status,
		CreatedAt: existing.CreatedAt,
	})
}

func reconcileAgentActivityBuiltin(ctx context.Context, store mcpgateway.Store) error {
	return reconcileDataBuiltin(ctx, store, mcpgateway.UpstreamServer{
		ID: agentactivitymcp.ServerID, Name: "Agent 动态", Domain: "agent_activity", Transport: mcpgateway.TransportBuiltin, Namespace: "agent_activity", Status: mcpgateway.StatusActive,
	})
}

func reconcileBusinessDataBuiltin(ctx context.Context, store mcpgateway.Store) error {
	return reconcileDataBuiltin(ctx, store, mcpgateway.UpstreamServer{
		ID: businessdatamcp.ServerID, Name: "业务数据", Domain: "business_data", Transport: mcpgateway.TransportBuiltin, Namespace: "business_data", Status: mcpgateway.StatusActive,
	})
}

func reconcileDataBuiltin(ctx context.Context, store mcpgateway.Store, server mcpgateway.UpstreamServer) error {
	existing, err := store.GetUpstreamServer(ctx, server.ID)
	if err != nil && !errors.Is(err, mcpgateway.ErrUpstreamServerNotFound) {
		return err
	}
	server.CreatedAt = existing.CreatedAt
	return store.SaveUpstreamServer(ctx, server)
}

type officeAPIs struct {
	collector            http.Handler
	dashboard            *httpapi.DashboardAPI
	userDashboard        http.Handler
	management           *httpapi.ManagementAPI
	agentCollectorLookup server.AgentCollectorLookup
	userCollectors       http.Handler
	activityStore        activity.ActivityStore
	agentSummaryReader   activity.AgentSummaryReader
	activityReporter     server.ClaweeActivityReporter
}

func buildOfficeAPIs(adminDB *sql.DB, collectorDB *sql.DB, installConfig config.OfficeInstallConfig, agentProvisioner *agentprovisioning.Service, taskBroker httpapi.TaskBroker) officeAPIs {
	broker := officeRealtime.NewBroker()
	apis := officeAPIs{}
	if collectorDB != nil {
		collectorStore := officeStore.NewPostgresStore(collectorDB)
		reducer := officeState.NewReducer(collectorStore)
		notifier := officeDashboard.NewNotifier(collectorStore, func(eventType string, scope officeDashboard.RealtimeScope, data json.RawMessage, emittedAt time.Time) {
			broker.Publish(eventType, scope, data, emittedAt)
		}, nil)
		apis.collector = httpapi.NewCollectorAPIWithOptions(httpapi.CollectorAPIOptions{
			Authenticator:     collectorStore,
			Reducer:           reducer,
			Registrar:         collectorStore,
			DashboardNotifier: notifier,
			AgentProvisioner:  agentProvisioner,
			AgentBinder:       collectorStore,
			TaskBroker:        taskBroker,
		}).Handler()
		apis.activityReporter = officeClawee.NewService(collectorStore, reducer, collectorStore, notifier, nil)
	}
	if adminDB != nil {
		adminStore := officeStore.NewPostgresStore(adminDB)
		apis.activityStore = adminStore
		apis.agentSummaryReader = adminStore
		dashboardAPI := httpapi.NewDashboardAPI(adminStore, broker, nil)
		apis.dashboard = dashboardAPI
		apis.userDashboard = dashboardAPI.UserHandler(adminStore, adminStore)
		managementAPI := httpapi.NewManagementAPIWithOptions(adminStore, nil, httpapi.ManagementAPIOptions{
			PublicBaseURL: installConfig.PublicBaseURL,
		})
		apis.management = managementAPI
		apis.agentCollectorLookup = adminStore
		apis.userCollectors = managementAPI.UserCollectorsHandler()
	}
	return apis
}

func (a *App) Close() {
	if a == nil {
		return
	}
	if a.storageMigration != nil {
		a.storageMigration.Close()
	}
	if a.businessDataScheduler != nil {
		a.businessDataScheduler.Close()
	}
	if a.skillSourceScheduler != nil {
		a.skillSourceScheduler.Close()
	}
	if a.closeDatabases != nil {
		a.closeDatabases()
		return
	}
	if a.collectorSQLDB != nil {
		a.collectorSQLDB.Close()
	}
	if a.sqlDB != nil {
		a.sqlDB.Close()
	}
	if a.CollectorDB != nil {
		a.CollectorDB.Close()
	}
	if a.DB != nil {
		a.DB.Close()
	}
}

func toMCPDemoTokens(tokens map[string]config.MCPTokenConfig) map[string]mcpauth.TokenConfig {
	out := make(map[string]mcpauth.TokenConfig, len(tokens))
	for token, entry := range tokens {
		out[token] = mcpauth.TokenConfig{
			Subject:  entry.Subject,
			ClientID: entry.ClientID,
			AgentID:  entry.AgentID,
			Issuer:   entry.Issuer,
			TokenID:  entry.TokenID,
			Scopes:   entry.Scopes,
		}
	}
	return out
}
