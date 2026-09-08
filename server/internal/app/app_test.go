package app

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/stdlib"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/agentactivitymcp"
	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/businessdatamcp"
	"github.com/krillinai/Clawee/server/internal/clawadmin"
	"github.com/krillinai/Clawee/server/internal/config"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/sub2api"
)

func TestSelectSnapshotClientByModelAccessMode(t *testing.T) {
	center := clawadmin.NewClient("http://127.0.0.1:8790", "", time.Second)
	t.Run("platform ignores sub2api config", func(t *testing.T) {
		selected, err := selectSnapshotClient(config.Config{
			ModelAccess: config.ModelAccessConfig{Mode: "platform_managed"},
			Sub2API:     config.Sub2APIConfig{BaseURL: "/invalid", AdminAPIKey: "partial"},
		}, center)
		if err != nil || selected != activity.SnapshotClient(center) {
			t.Fatalf("selected = %T, err = %v", selected, err)
		}
	})
	t.Run("enterprise complete", func(t *testing.T) {
		selected, err := selectSnapshotClient(config.Config{
			ModelAccess: config.ModelAccessConfig{Mode: "enterprise_managed"},
			Sub2API:     config.Sub2APIConfig{BaseURL: "http://127.0.0.1:8080", AdminAPIKey: "test-key", OrganizationUserID: 1},
		}, center)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := selected.(*sub2api.Client); !ok {
			t.Fatalf("selected = %T", selected)
		}
	})
	t.Run("enterprise empty", func(t *testing.T) {
		selected, err := selectSnapshotClient(config.Config{ModelAccess: config.ModelAccessConfig{Mode: "enterprise_managed"}}, center)
		if err != nil || selected != nil {
			t.Fatalf("selected = %T, err = %v", selected, err)
		}
	})
	for _, sub2APIConfig := range []config.Sub2APIConfig{
		{BaseURL: "http://127.0.0.1:8080"},
		{AdminAPIKey: "test-key"},
		{OrganizationUserID: 1},
		{BaseURL: "http://127.0.0.1:8080", AdminAPIKey: "test-key"},
		{BaseURL: "http://127.0.0.1:8080", AdminAPIKey: "test-key", OrganizationUserID: -1},
	} {
		t.Run("enterprise partial", func(t *testing.T) {
			selected, err := selectSnapshotClient(config.Config{ModelAccess: config.ModelAccessConfig{Mode: "enterprise_managed"}, Sub2API: sub2APIConfig}, center)
			if err == nil || selected != nil {
				t.Fatalf("selected = %T, err = %v", selected, err)
			}
		})
	}
}

func TestOpenDatabasePoolsCreatesSeparateAdminAndCollectorPools(t *testing.T) {
	adminPool, collectorPool, err := openDatabasePools(context.Background(), "postgres://test:test@127.0.0.1:1/claw_mcp?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	if adminPool != nil {
		t.Cleanup(adminPool.Close)
	}
	if collectorPool != nil {
		t.Cleanup(collectorPool.Close)
	}
	if adminPool == nil || collectorPool == nil {
		t.Fatalf("admin pool = %p, collector pool = %p", adminPool, collectorPool)
	}
	if adminPool == collectorPool {
		t.Fatal("admin and collector must not share the same pgx pool")
	}

	adminSQLDB := stdlib.OpenDBFromPool(adminPool)
	collectorSQLDB := stdlib.OpenDBFromPool(collectorPool)
	t.Cleanup(func() { _ = adminSQLDB.Close() })
	t.Cleanup(func() { _ = collectorSQLDB.Close() })
	if adminSQLDB == nil || collectorSQLDB == nil {
		t.Fatalf("admin sql db = %p, collector sql db = %p", adminSQLDB, collectorSQLDB)
	}
	if adminSQLDB == collectorSQLDB {
		t.Fatal("admin and collector must not share the same database/sql pool")
	}
}

func TestNewRejectsInvalidUserJWTConfigBeforeStartup(t *testing.T) {
	cfg := config.Config{
		Security: config.SecurityConfig{
			SessionCookieName:       "claw_front_token",
			AdminSessionCookieName:  "claw_admin_token",
			SessionDuration:         "1h",
			UserJWTSigningKey:       "short",
			AgentTokenEncryptionKey: "01234567890123456789012345678901",
		},
		Logging: config.LoggingConfig{Level: "info", Format: "json", Output: "stdout"},
	}
	application, err := New(context.Background(), cfg)
	if err == nil || application != nil {
		t.Fatalf("New() = %#v, %v; want invalid JWT config error", application, err)
	}
	if !strings.Contains(err.Error(), "user_jwt_signing_key") {
		t.Fatalf("New() error = %v, want user_jwt_signing_key validation", err)
	}
}

func TestOpenDatabasePoolsKeepsMemoryModeWithoutPostgres(t *testing.T) {
	adminPool, collectorPool, err := openDatabasePools(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if adminPool != nil || collectorPool != nil {
		t.Fatalf("admin pool = %p, collector pool = %p, want both nil", adminPool, collectorPool)
	}
}

func TestBuildOfficeAPIsKeepsAdminAndCollectorDatabasesIndependent(t *testing.T) {
	adminOnly := buildOfficeAPIs(new(sql.DB), nil, config.OfficeInstallConfig{}, nil, nil)
	if adminOnly.collector != nil {
		t.Fatal("collector API must not use the admin database")
	}
	if adminOnly.dashboard == nil || adminOnly.management == nil {
		t.Fatal("admin database should build dashboard and management APIs")
	}

	collectorOnly := buildOfficeAPIs(nil, new(sql.DB), config.OfficeInstallConfig{}, nil, nil)
	if collectorOnly.collector == nil {
		t.Fatal("collector database should build the collector API")
	}
	if collectorOnly.dashboard != nil || collectorOnly.management != nil {
		t.Fatal("dashboard and management APIs must not use the collector database")
	}
}

func TestBuildOfficeAPIsWithoutDatabaseLeavesHandlersDisabled(t *testing.T) {
	apis := buildOfficeAPIs(nil, nil, config.OfficeInstallConfig{}, nil, nil)
	if apis.collector != nil || apis.dashboard != nil || apis.management != nil {
		t.Fatalf("office APIs = %#v, want database-backed handlers disabled", apis)
	}
}

func TestBuildSkillHubServiceRequiresPostgresWhenEnabled(t *testing.T) {
	service, err := buildSkillHubService(context.Background(), nil, config.SkillHubConfig{})
	if err != nil || service != nil {
		t.Fatalf("disabled service = %#v, %v", service, err)
	}
	service, err = buildSkillHubService(context.Background(), nil, config.SkillHubConfig{Enabled: true, PackageRoot: t.TempDir()})
	if err == nil || service != nil {
		t.Fatalf("enabled service without postgres = %#v, %v", service, err)
	}
}

func TestBuildSkillHubRuntimeDoesNotCheckGitWhenSyncDisabled(t *testing.T) {
	original := skillHubGitLookPath
	t.Cleanup(func() { skillHubGitLookPath = original })
	called := false
	skillHubGitLookPath = func(string) (string, error) {
		called = true
		return "", errors.New("unexpected")
	}
	runtime, err := buildSkillHubRuntime(context.Background(), nil, config.SkillHubConfig{}, nil, nil)
	if err != nil || runtime.Service != nil || runtime.Sources != nil || runtime.Scheduler != nil {
		t.Fatalf("buildSkillHubRuntime() = %#v, %v", runtime, err)
	}
	if called {
		t.Fatal("disabled github sync checked git")
	}
}

func TestBuildSkillHubRuntimeValidatesGitAndRepositoryRoot(t *testing.T) {
	original := skillHubGitLookPath
	t.Cleanup(func() { skillHubGitLookPath = original })
	cfg := config.SkillHubConfig{Enabled: true, PackageRoot: t.TempDir(), GitHubSyncEnabled: true, RepositoryRoot: t.TempDir()}
	skillHubGitLookPath = func(string) (string, error) { return "", errors.New("missing git") }
	if runtime, err := buildSkillHubRuntime(context.Background(), nil, cfg, nil, nil); err == nil || runtime.Scheduler != nil || !strings.Contains(err.Error(), "git") {
		t.Fatalf("missing git runtime = %#v, error = %v", runtime, err)
	}

	notDirectory := t.TempDir() + "/repository-root"
	if err := os.WriteFile(notDirectory, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.RepositoryRoot = notDirectory
	skillHubGitLookPath = func(string) (string, error) { return "/usr/bin/git", nil }
	if runtime, err := buildSkillHubRuntime(context.Background(), nil, cfg, nil, nil); err == nil || runtime.Scheduler != nil {
		t.Fatalf("invalid repository root runtime = %#v, error = %v", runtime, err)
	}
}

func TestAppCloseStopsSchedulersBeforeDatabases(t *testing.T) {
	order := []string{}
	application := &App{
		businessDataScheduler: closeRecorder(func() { order = append(order, "business") }),
		skillSourceScheduler:  closeRecorder(func() { order = append(order, "skill") }),
		closeDatabases:        func() { order = append(order, "databases") },
	}
	application.Close()
	if strings.Join(order, ",") != "business,skill,databases" {
		t.Fatalf("close order = %#v", order)
	}
}

type closeRecorder func()

func (f closeRecorder) Close() { f() }

func TestEnsureKnowledgeBuiltinMigratesLegacyAdapterRecord(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{
		ID:            "knowledge-adapter",
		Transport:     mcpgateway.TransportStreamableHTTP,
		Endpoint:      "http://127.0.0.1:1905/mcp",
		AuthType:      "static_bearer",
		CredentialRef: "LEGACY_KNOWLEDGE_TOKEN",
		Status:        mcpgateway.StatusDisabled,
	}); err != nil {
		t.Fatal(err)
	}
	if err := reconcileKnowledgeBuiltin(ctx, store, true); err != nil {
		t.Fatal(err)
	}
	server, err := store.GetUpstreamServer(ctx, "knowledge-adapter")
	if err != nil {
		t.Fatal(err)
	}
	if server.Namespace != "knowledge" || server.AuthType != "" || server.Transport != mcpgateway.TransportBuiltin || server.Endpoint != "" || server.Status != mcpgateway.StatusActive {
		t.Fatalf("server = %#v", server)
	}
}

func TestReconcileKnowledgeBuiltinDisablesLegacyRecordWhenFeatureIsOff(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{
		ID: "knowledge-adapter", Transport: mcpgateway.TransportStreamableHTTP, Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := reconcileKnowledgeBuiltin(ctx, store, false); err != nil {
		t.Fatal(err)
	}
	server, err := store.GetUpstreamServer(ctx, "knowledge-adapter")
	if err != nil {
		t.Fatal(err)
	}
	if server.Transport != mcpgateway.TransportBuiltin || server.Status != mcpgateway.StatusDisabled {
		t.Fatalf("server = %#v", server)
	}
}

func TestReconcileDataBuiltinsCreatesActiveServers(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := reconcileAgentActivityBuiltin(ctx, store); err != nil {
		t.Fatal(err)
	}
	if err := reconcileBusinessDataBuiltin(ctx, store); err != nil {
		t.Fatal(err)
	}
	for serverID, namespace := range map[string]string{"agent-activity": "agent_activity", "business-data": "business_data"} {
		server, err := store.GetUpstreamServer(ctx, serverID)
		if err != nil {
			t.Fatal(err)
		}
		if server.Transport != mcpgateway.TransportBuiltin || server.Status != mcpgateway.StatusActive || server.Namespace != namespace {
			t.Fatalf("server %s = %#v", serverID, server)
		}
	}
}

func TestDataBuiltinsSyncEightCapabilitiesIdempotently(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	access := dataaccess.NewService(dataaccess.NewMemoryStore())
	activityService, err := activity.NewService(nil, nil, nil, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	agentClient, err := agentactivitymcp.NewClient(activityService, nil, access)
	if err != nil {
		t.Fatal(err)
	}
	businessClient, err := businessdatamcp.NewClient(businessdata.NewDashboardService(nil), access)
	if err != nil {
		t.Fatal(err)
	}
	router := mcpgateway.NewRoutingUpstreamClient(nil, nil)
	if err := router.Register(agentactivitymcp.ServerID, agentClient); err != nil {
		t.Fatal(err)
	}
	if err := router.Register(businessdatamcp.ServerID, businessClient); err != nil {
		t.Fatal(err)
	}
	if err := reconcileAgentActivityBuiltin(ctx, store); err != nil {
		t.Fatal(err)
	}
	if err := reconcileBusinessDataBuiltin(ctx, store); err != nil {
		t.Fatal(err)
	}
	gateway := mcpgateway.NewService(mcpgateway.Config{Store: store, UpstreamClient: router})
	for range 2 {
		if err := gateway.SyncTools(ctx, agentactivitymcp.ServerID, ""); err != nil {
			t.Fatal(err)
		}
		if err := gateway.SyncTools(ctx, businessdatamcp.ServerID, ""); err != nil {
			t.Fatal(err)
		}
	}
	capabilities, err := store.ListCapabilities(ctx, mcpgateway.CapabilityFilter{Type: mcpgateway.CapabilityTool})
	if err != nil {
		t.Fatal(err)
	}
	if len(capabilities) != 8 {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	counts := map[string]int{}
	for _, capability := range capabilities {
		counts[capability.UpstreamServerID]++
		if capability.RiskLevel != "low" || !capability.ReadOnly || capability.Destructive || !capability.Idempotent || capability.ApprovalRequired || capability.ConfirmRequired {
			t.Fatalf("capability = %#v", capability)
		}
	}
	if counts[agentactivitymcp.ServerID] != 4 || counts[businessdatamcp.ServerID] != 4 {
		t.Fatalf("capability counts = %#v", counts)
	}
}

func TestAccountKnowledgeMCPAccessResolverReturnsAccountMCPGrants(t *testing.T) {
	ctx := context.Background()
	service := dataaccess.NewService(dataaccess.NewMemoryStore())
	for _, input := range []dataaccess.SetInput{
		{UserID: "user-1", ResourceType: dataaccess.ResourceKnowledgeBase, ResourceID: "kb-mcp", Actions: []string{dataaccess.ActionMCP}, CreatedBy: "admin"},
		{UserID: "user-1", ResourceType: dataaccess.ResourceKnowledgeBase, ResourceID: "kb-read", Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"},
		{UserID: "user-2", ResourceType: dataaccess.ResourceKnowledgeBase, ResourceID: "kb-other", Actions: []string{dataaccess.ActionMCP}, CreatedBy: "admin"},
	} {
		if _, err := service.Create(ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	resolved, err := (accountKnowledgeMCPAccessResolver{service: service}).ResolveMCPKnowledgeBaseIDs(ctx, "user-1")
	if err != nil || len(resolved) != 1 || resolved[0] != "kb-mcp" {
		t.Fatalf("resolved = %#v, error = %v", resolved, err)
	}
}
