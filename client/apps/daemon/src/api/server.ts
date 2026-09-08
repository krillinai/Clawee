import type Database from 'better-sqlite3';
import type {
  CodexAvailabilityProbe,
  CodexRuntimeStatus,
  RuntimeHealthResponse
} from '@clawee/protocol';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { registerGatewayRoutes } from './routes.gateway.js';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  ATTACHMENT_DRAFT_TTL_MS,
  ATTACHMENT_MAX_SIZE_BYTES,
  createAttachmentService
} from '../attachments/service.js';
import {
  createApprovalManager,
  type ApprovalManager
} from '../approvals/manager.js';
import {
  createAgentCapabilityTokenStore,
  type AgentCapabilityTokenStore
} from '../agent-tools/capability-token.js';
import {
  createDefaultAgentScheduleOperations,
  isAgentToolInternalRequest,
  registerAgentToolRoutes,
  type AgentScheduleOperations
} from '../agent-tools/internal-routes.js';
import { registerAgentScheduleMcpRoute } from '../agent-tools/mcp-routes.js';
import {
  createAgentScheduleProcessInjector,
  createAgentScheduleRunInjector,
  type AgentToolRunInjection,
  type RunMcpInjector
} from '../agent-tools/run-injection.js';
import {
  createUnknownCapabilityMatrix,
  isResumeExecutionSupported,
  withRuntimeSkillCapabilities,
  type RuntimeCapabilityMatrix
} from '../codex/capabilities.js';
import {
  createCodexAppServerClient,
  type CodexAppServerRequestClient
} from '../codex/app-server-client.js';
import {
  resolveCodexHome,
  type ResolvedCodexHome
} from '../codex/home.js';
import type {
  ModelServiceRuntime
} from '../codex/model-service-configuration.js';
import {
  createCodexModelCatalog,
  type CodexModelCatalog
} from '../codex/model-catalog-2026-08-05.js';
import { createMcpManager } from '../codex/mcp/manager.js';
import type { McpPresetProvider } from '../codex/mcp/presets.js';
import {
  createCodexMcpRuntimeInjector
} from '../codex/mcp/runtime-injector-2026-08-12.js';
import { createMemoryService } from '../memory/service.js';
import { createNotificationService } from '../notifications/service.js';
import { createProjectManager } from '../projects/manager.js';
import {
  createNativeProjectDirectoryPicker,
  type ProjectDirectoryPicker
} from '../projects/native-directory-picker.js';
import { createProfileManager } from '../codex/profiles/manager.js';
import {
  createCodexSessionProvider,
  type CodexSessionProvider
} from '../codex/sessions/app-server-provider.js';
import { createSkillManager } from '../codex/skills/manager.js';
import { createSkillMarketManager } from '../codex/skills/market-manager.js';
import { createSkillMarketRecordRepository } from '../codex/skills/market-records.js';
import {
  createCodexSkillSourceInstaller,
  type CodexSkillSourceInstaller
} from '../codex/skills/source-installer.js';
import { buildCodexStatusResponse } from '../codex/status.js';
import { createCleanupService } from '../cleanup/service.js';
import { createRunManager, type RunManager } from '../runs/manager.js';
import {
  createPersistentAppServerExecutor,
  DEFAULT_PERSISTENT_APP_SERVER_MAX_CONCURRENCY,
  MAX_PERSISTENT_APP_SERVER_MAX_CONCURRENCY
} from '../runs/persistent-app-server-executor-2026-07-28.js';
import {
  createScheduleCoordinator,
  type ScheduleCoordinator
} from '../scheduler/coordinator.js';
import { ScheduleRepository } from '../scheduler/repository.js';
import { createSchedulerService, type SchedulerService } from '../scheduler/service.js';
import { openRuntimeDatabase } from '../storage/database.js';
import { createRunRepository, createThreadRepository } from '../storage/repositories.js';
import { createThreadManager } from '../threads/manager.js';
import { createTaskService } from '../tasks/service.js';
import { createTaskMcpService } from '../task-mcp/service.js';
import { isServerSkillDisclosureRequest } from '../task-mcp/server-skill-input-guard.js';
import { MCP_CHAIN_TIMEOUT_MS } from '../task-mcp/constants.js';
import { createDefaultRevealExecutor } from '../workspace-files/reveal.js';
import { createWorkspaceFileService } from '../workspace-files/service.js';
import { prepareSchedulerStartup } from '../startup.js';
import type { EnterpriseCredentialStore } from '../enterprise/credential-store-2026-07-30.js';
import {
  EnterpriseCredentialStoreError
} from '../enterprise/credential-store-2026-07-30.js';
import {
  createEnterpriseHttpClient,
  type EnterpriseHttpClient
} from '../enterprise/http-client-2026-07-30.js';
import {
  createEnterpriseActivityReporter,
  type EnterpriseActivityReporter
} from '../enterprise/activity-reporter-2026-08-28.js';
import {
  cleanupLegacyEnterpriseCollector
} from '../enterprise/legacy-collector-cleanup-2026-08-28.js';
import { resolveEnterpriseOrigin } from '../enterprise/config-2026-07-30.js';
import { createEnterpriseSessionManager } from '../enterprise/session-manager-2026-07-30.js';
import { createKnowledgeConversationManager } from '../enterprise/knowledge-conversation-2026-08-05.js';
import { createEnterpriseInstallRecordRepository } from '../enterprise/install-records-2026-07-30.js';
import {
  createEnterpriseSkillManager,
  type EnterpriseSkillManager
} from '../enterprise/skill-manager-2026-07-30.js';
import {
  createEnterpriseKnowledgeManager,
  type EnterpriseKnowledgeManager
} from '../enterprise/knowledge-manager-2026-08-05.js';
import {
  createEnterpriseSharedDriveManager,
  type EnterpriseSharedDriveManager
} from '../enterprise/shared-drive-manager-2026-08-06.js';
import {
  createEnterpriseAgentIdentityStore,
  type EnterpriseAgentIdentityStore
} from '../enterprise/agent-identity-2026-08-02.js';
import {
  createEnterpriseMcpManager,
  type EnterpriseMcpManager
} from '../enterprise/mcp-manager-2026-08-07.js';
import {
  createEnterpriseMcpPreferenceRepository
} from '../enterprise/mcp-preferences-2026-08-07.js';
import {
  createEnterpriseActivityManager,
  type EnterpriseActivityManager
} from '../enterprise/activity-manager-2026-08-18.js';
import {
  createEnterpriseBillingManager,
  type EnterpriseBillingManager
} from '../enterprise/billing-manager-2026-08-28.js';
import {
  createEnterpriseBusinessDashboardManager,
  type EnterpriseBusinessDashboardManager
} from '../enterprise/business-dashboard-manager-2026-08-30.js';
import { requireAuth } from './auth.js';
import { apiError } from './errors.js';
import { registerAttachmentRoutes } from './routes.attachments.js';
import { registerApprovalRoutes } from './routes.approvals.js';
import { registerCodexRoutes } from './routes.codex.js';
import { registerCleanupRoutes } from './routes.cleanup.js';
import { registerDiagnosticsRoutes } from './routes.diagnostics.js';
import { registerMcpRoutes } from './routes.mcp.js';
import { registerMemoryRoutes } from './routes.memory.js';
import { registerModelServiceRoutes } from './routes.model-service.js';
import { registerNotificationRoutes } from './routes.notifications.js';
import { registerProfileRoutes } from './routes.profiles.js';
import { registerProjectRoutes } from './routes.projects.js';
import { registerRunRoutes } from './routes.runs.js';
import { registerSearchRoutes } from './routes.search.js';
import { registerScheduleRoutes } from './routes.schedules.js';
import { registerSkillMarketRoutes } from './routes.skill-market.js';
import { registerSkillRoutes } from './routes.skills.js';
import { registerTaskRoutes } from './routes.tasks.js';
import { registerTaskMcpRoutes } from './routes.task-mcp.js';
import { registerThreadRoutes } from './routes.threads.js';
import { registerKnowledgeConversationRoutes } from './routes.knowledge-conversation-2026-08-05.js';
import { registerWorkspaceFileRoutes } from './routes.workspace-files.js';
import { registerEnterpriseRoutes } from './routes.enterprise-2026-07-30.js';
import {
  registerEnterpriseKnowledgeRoutes
} from './routes.enterprise-knowledge-2026-08-05.js';
import {
  registerEnterpriseDriveRoutes
} from './routes.enterprise-drive-2026-08-06.js';
import {
  registerEnterpriseActivityRoutes
} from './routes.enterprise-activity-2026-08-18.js';
import {
  registerEnterpriseBillingRoutes
} from './routes.enterprise-billing-2026-08-28.js';
import {
  registerEnterpriseBusinessDashboardRoutes
} from './routes.enterprise-business-dashboard-2026-08-30.js';

export type BuildServerInput = {
  token: string;
  dataDir?: string;
  db?: Database.Database;
  runtime?: import('@clawee/protocol').CodexRuntimeLaunchContext;
  codexBin: string;
  codexHome: string;
  resolvedCodexHome?: ResolvedCodexHome;
  defaultCwd?: string;
  defaultProjectRoot?: string;
  projectDirectoryPicker?: ProjectDirectoryPicker;
  runManager?: RunManager;
  scheduler?: SchedulerService;
  scheduleCoordinator?: ScheduleCoordinator;
  schedulerAutostart?: boolean;
  startupSessionClassifier?(): void;
  sseHeartbeatMs?: number;
  resumeCapabilityVerified?: boolean;
  capabilities?: RuntimeCapabilityMatrix;
  skillMarketSourceInstaller?: CodexSkillSourceInstaller;
  attachmentMaxSizeBytes?: number;
  attachmentDraftTtlMs?: number;
  approvalManager?: ApprovalManager;
  agentCapabilityTokens?: AgentCapabilityTokenStore;
  agentScheduleOperations?: AgentScheduleOperations;
  agentToolsEnabled?: boolean;
  persistentAppServerEnabled?: boolean;
  persistentAppServerMaxConcurrency?: number;
  onBeforeCodexWritableRequest?(): Promise<void>;
  codexThreadRotationRunThreshold?: number;
  codexSessionProvider?: CodexSessionProvider;
  codexModelCatalog?: CodexModelCatalog;
  codexAppServerClient?: CodexAppServerRequestClient;
  codexEnv?: Record<string, string>;
  modelServiceRuntime?: ModelServiceRuntime;
  mcpPresetProvider?: McpPresetProvider;
  subscribeModelCatalogChanges?(
    listener: (reason: string) => void
  ): () => void;
  getCodexAvailabilityProbe?(): CodexAvailabilityProbe | undefined;
  getCodexRuntimeStatus?(): CodexRuntimeStatus;
  memoryHistoryReader?(threadId: string): { items: import('@clawee/protocol').ThreadHistoryItem[] } | undefined;
  allowedWebOrigins?: string[];
  enterpriseAgentIdentityStore?: EnterpriseAgentIdentityStore;
  enterpriseConfigPath?: string;
  enterpriseCredentialStore?: EnterpriseCredentialStore;
  enterpriseActivityReporter?: EnterpriseActivityReporter;
  enterpriseHttpClient?: EnterpriseHttpClient;
  enterpriseOrigin?: string;
  enterpriseE2ERunId?: string;
  enterpriseSkillManager?: EnterpriseSkillManager;
  enterpriseMcpManager?: EnterpriseMcpManager;
  enterpriseKnowledgeManager?: EnterpriseKnowledgeManager;
  enterpriseKnowledgeDocumentMaxBytes?: number;
  enterpriseSharedDriveManager?: EnterpriseSharedDriveManager;
  enterpriseSharedFileMaxBytes?: number;
  enterpriseActivityManager?: EnterpriseActivityManager;
  enterpriseBillingManager?: EnterpriseBillingManager;
  enterpriseBusinessDashboardManager?: EnterpriseBusinessDashboardManager;
  taskMcpEnabled?: boolean;
  serverDeployment?: boolean;
  webDistDir?: string;
};

const ATTACHMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export async function buildServer(input: BuildServerInput) {
  const webDistDir = input.webDistDir === undefined
    ? undefined
    : resolve(input.webDistDir);
  if (webDistDir !== undefined && !existsSync(join(webDistDir, 'index.html'))) {
    throw new Error('SERVER_MODE_WEB_DIST_MISSING');
  }
  const server = Fastify({
    logger: false,
    ...(input.taskMcpEnabled === true
      ? { requestTimeout: MCP_CHAIN_TIMEOUT_MS }
      : {})
  });
  if (input.taskMcpEnabled === true) {
    server.server.requestTimeout = MCP_CHAIN_TIMEOUT_MS;
  }
  const allowedWebOrigins = new Set(
    input.allowedWebOrigins ?? ['http://127.0.0.1:19860']
  );
  await server.register(cors, {
    origin(origin, callback) {
      if (origin === undefined) return callback(null, false);
      if (allowedWebOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'],
    credentials: false,
    maxAge: 600
  });
  const auth = requireAuth(input.token);
  const dataDir = input.dataDir ?? '.runtime';
  const resolvedCodexHome =
    input.resolvedCodexHome
    ?? resolveCodexHome({ isolatedHome: input.codexHome });
  const codexHome = resolvedCodexHome.path;
  const enterpriseOrigin = resolveEnterpriseOrigin(input.enterpriseOrigin);
  const enterpriseConfigPath =
    input.enterpriseConfigPath ?? join(dataDir, 'config.toml');
  let activeEnterpriseHttpClient =
    input.enterpriseHttpClient ??
    createEnterpriseHttpClient({ origin: enterpriseOrigin.origin });
  const enterpriseHttpClient = new Proxy(activeEnterpriseHttpClient, {
    get(_target, property) {
      return Reflect.get(activeEnterpriseHttpClient, property);
    }
  });
  const rawEnterpriseCredentialStore = input.enterpriseCredentialStore ?? createUnavailableCredentialStore();
  const enterpriseCredentialStore = input.enterpriseConfigPath === undefined
    ? rawEnterpriseCredentialStore
    : {
        async read() {
          const credential = await rawEnterpriseCredentialStore.read();
          return credential?.origin === enterpriseOrigin.origin ? credential : undefined;
        },
        async write(credential: import('../enterprise/credential-store-2026-07-30.js').EnterpriseCredential) {
          await rawEnterpriseCredentialStore.write({ ...credential, origin: enterpriseOrigin.origin });
        },
        delete: () => rawEnterpriseCredentialStore.delete()
      };
  const enterpriseAgentIdentityStore =
    input.enterpriseAgentIdentityStore
    ?? createEnterpriseAgentIdentityStore({
      configPath: enterpriseConfigPath,
      legacyDataDir: dataDir
    });
  const initialEnterpriseAgentId = input.enterpriseConfigPath === undefined
    ? undefined
    : await enterpriseAgentIdentityStore.getOrCreate();
  let handleEnterpriseSessionSignedOut: (() => void) | undefined;
  let handleModelServiceSignedOut: (() => void) | undefined;
  let enterpriseSessionManager!: ReturnType<
    typeof createEnterpriseSessionManager
  >;
  let activityReporter: EnterpriseActivityReporter | undefined;
  enterpriseSessionManager = createEnterpriseSessionManager({
    agentIdentityStore: enterpriseAgentIdentityStore,
    initialAgentId: initialEnterpriseAgentId,
    credentialStore: enterpriseCredentialStore,
    httpClient: enterpriseHttpClient,
    get transportSecurity() { return enterpriseOrigin.transportSecurity; },
    onSignedIn(identity) {
      if (identity.activityReportingEnabled) {
        activityReporter?.resume();
      } else {
        activityReporter?.clear('reporting_disabled');
      }
      if (input.modelServiceRuntime === undefined) return;
      void input.modelServiceRuntime.resolve(
        identity.accessToken,
        accessToken => {
          const getConfiguration = enterpriseHttpClient.getModelConfiguration;
          if (getConfiguration === undefined) {
            throw new Error('MODEL_CONFIGURATION_UNAVAILABLE');
          }
          return getConfiguration(accessToken);
        }
      ).then(() => {
        const state = input.modelServiceRuntime?.status();
        if (
          state?.status === 'unavailable'
          && state.code === 'ENTERPRISE_UNAUTHORIZED'
        ) {
          void enterpriseSessionManager.invalidateUnauthorized()
            .catch(() => undefined);
        }
      });
    },
    onSignedOut() {
      activityReporter?.clear('signed_out');
      handleModelServiceSignedOut?.();
      void input.modelServiceRuntime?.signOut().catch(error => {
        console.warn(`Model service sign-out cleanup failed: ${formatError(error)}`);
      });
      handleEnterpriseSessionSignedOut?.();
    }
  });
  activityReporter = input.enterpriseActivityReporter
    ?? createEnterpriseActivityReporter({
      httpClient: {
        reportAgentActivity(accessToken, request) {
          const report = enterpriseHttpClient.reportAgentActivity;
          if (report === undefined) {
            throw new Error('ENTERPRISE_ACTIVITY_REPORTING_UNAVAILABLE');
          }
          return report(accessToken, request);
        }
      },
      onDiagnostic(diagnostic) {
        console.warn(JSON.stringify({
          code: diagnostic.code,
          statusCode: diagnostic.statusCode,
          eventCount: diagnostic.eventCount,
          byteCount: diagnostic.byteCount,
          droppedEvents: diagnostic.droppedEvents
        }));
      },
      requireAccessToken: () => enterpriseSessionManager.requireAccessToken()
    });
  if (input.enterpriseConfigPath !== undefined) {
    void cleanupLegacyEnterpriseCollector();
  }
  const codexBin = input.codexBin;
  const defaultCwd = input.defaultCwd ?? process.cwd();
  const resumeCapabilityVerified =
    input.resumeCapabilityVerified ?? (
      input.capabilities === undefined ? undefined : isResumeExecutionSupported(input.capabilities)
    );
  const capabilities = withRuntimeSkillCapabilities(
    input.capabilities ?? createUnknownCapabilityMatrix()
  );
  const runtimeTransport =
    capabilities.appServerApprovals === true ? 'app-server' : 'exec';
  if (input.serverDeployment === true && runtimeTransport !== 'app-server') {
    throw new Error('SERVER_MODE_APP_SERVER_REQUIRED');
  }
  const getCodexRuntimeStatus = input.getCodexRuntimeStatus ?? (() => {
    throw new Error('CODEX_RUNTIME_STATUS_UNAVAILABLE');
  });
  const db = input.db ?? openRuntimeDatabase(join(dataDir, 'app.sqlite'));
  const ownsDb = input.db === undefined;
  const runRepository = createRunRepository(db);
  const threadRepository = createThreadRepository(db);
  const scheduleRepository = new ScheduleRepository(db);
  const projectManager = createProjectManager({
    db,
    managedProjectRoot: input.defaultProjectRoot === undefined
      ? undefined
      : join(input.defaultProjectRoot, 'Clawee')
  });
  const projectDirectoryPicker =
    input.projectDirectoryPicker ?? createNativeProjectDirectoryPicker();
  const threadManager = createThreadManager({ db, dataDir, projectManager });
  const knowledgeConversationManager = createKnowledgeConversationManager({
    sessionManager: enterpriseSessionManager,
    threadManager
  });
  const codexAppServerClient =
    input.codexAppServerClient
    ?? createCodexAppServerClient({
      codexBin,
      codexHome,
      env: input.codexEnv
    });
  const codexSessionProvider = input.codexSessionProvider ?? createCodexSessionProvider({
    client: codexAppServerClient
  });
  const codexModelCatalog = input.codexModelCatalog ?? createCodexModelCatalog({
    client: codexAppServerClient
  });
  const workspaceFileService = createWorkspaceFileService({
    getThread: (id) => threadManager.getPublicThread(id),
    revealExecutor: createDefaultRevealExecutor()
  });
  const profileManager = createProfileManager({ codexHome: resolvedCodexHome });
  const skillManager = createSkillManager({ codexHome: resolvedCodexHome, db });
  const skillMarketRecords = createSkillMarketRecordRepository(db);
  const skillMarketManager = createSkillMarketManager({
    dataDir,
    skillManager,
    records: skillMarketRecords,
    sourceInstaller:
      input.skillMarketSourceInstaller ?? createCodexSkillSourceInstaller({ codexHome })
  });
  const enterpriseInstallRecords =
    createEnterpriseInstallRecordRepository(db);
  const enterpriseSkillManager =
    input.enterpriseSkillManager ??
    createEnterpriseSkillManager({
      dataDir,
      sessionManager: enterpriseSessionManager,
      httpClient: enterpriseHttpClient,
      skillManager,
      publicRecords: skillMarketRecords,
      records: enterpriseInstallRecords
    });
  const enterpriseKnowledgeManager =
    input.enterpriseKnowledgeManager ??
    createEnterpriseKnowledgeManager({
      dataDir,
      sessionManager: enterpriseSessionManager,
      httpClient: enterpriseHttpClient,
      maxDocumentBytes: input.enterpriseKnowledgeDocumentMaxBytes
    });
  const enterpriseSharedDriveManager =
    input.enterpriseSharedDriveManager ??
    createEnterpriseSharedDriveManager({
      dataDir,
      sessionManager: enterpriseSessionManager,
      httpClient: enterpriseHttpClient,
      projectManager,
      maxFileBytes: input.enterpriseSharedFileMaxBytes
    });
  const enterpriseActivityManager =
    input.enterpriseActivityManager ??
    createEnterpriseActivityManager({
      sessionManager: enterpriseSessionManager,
      httpClient: enterpriseHttpClient
    });
  const enterpriseBillingManager =
    input.enterpriseBillingManager ??
    createEnterpriseBillingManager({
      sessionManager: enterpriseSessionManager,
      httpClient: enterpriseHttpClient
    });
  const enterpriseBusinessDashboardManager =
    input.enterpriseBusinessDashboardManager
    ?? createEnterpriseBusinessDashboardManager({
      sessionManager: enterpriseSessionManager,
      httpClient: enterpriseHttpClient
    });
  const reportPerformance = (details: Record<string, unknown>) => {
    reportDaemonPerformance(details);
  };
  let persistentAppServerExecutor:
    | ReturnType<typeof createPersistentAppServerExecutor>
    | undefined;
  const invalidatePersistentRuntime = (reason: string) => {
    void persistentAppServerExecutor?.invalidate(reason).catch(error => {
      console.warn(
        `Persistent app-server invalidation failed: ${formatError(error)}`
      );
    });
  };
  const unsubscribeModelCatalogChanges = input.subscribeModelCatalogChanges?.(
    reason => invalidatePersistentRuntime(reason)
  );
  const mcpManager = createMcpManager({
    codexBin,
    codexHome: resolvedCodexHome,
    db,
    capabilities,
    presetProvider: input.mcpPresetProvider,
    onPerformanceEvent: reportPerformance,
    onConfigurationChanged: invalidatePersistentRuntime
  });
  const legacyEnterpriseMcpPreferences =
    createEnterpriseMcpPreferenceRepository(db);
  const enterpriseMcpManager =
    input.enterpriseMcpManager ??
    createEnterpriseMcpManager({
      get enterpriseOrigin() { return enterpriseOrigin.origin; },
      agentIdentityStore: enterpriseAgentIdentityStore,
      sessionManager: enterpriseSessionManager,
      httpClient: enterpriseHttpClient,
      mcpManager,
      legacyPreferences: legacyEnterpriseMcpPreferences,
      onRuntimeConfigurationChanged: invalidatePersistentRuntime
    });
  handleEnterpriseSessionSignedOut = () => {
    enterpriseActivityManager.clear();
    void enterpriseMcpManager.handleSessionSignedOut().catch(error => {
      console.warn(`Enterprise MCP sign-out cleanup failed: ${formatError(error)}`);
    });
  };
  enterpriseSessionManager.startRestore();
  const notificationService = createNotificationService({ db });
  const approvalManager = input.approvalManager ?? createApprovalManager({ db });
  const unsubscribeApprovalNotifications = approvalManager.subscribe(approval => {
    if (approval.status === 'pending') {
      notificationService.enqueueApproval(approval.id);
    }
  });
  const memoryService = createMemoryService({ db });
  const agentCapabilityTokens =
    input.agentCapabilityTokens ?? createAgentCapabilityTokenStore();
  const getAgentToolBaseUrl = () =>
    resolveListeningOrigin(server.server.address());
  const scheduleRunInjector = createAgentScheduleRunInjector({
    capabilities: agentCapabilityTokens,
    getBaseUrl: getAgentToolBaseUrl,
    scheduleToolsEnabled: input.agentToolsEnabled === true
  });
  const agentToolProcessInjector = input.agentToolsEnabled !== true
    ? undefined
    : createAgentScheduleProcessInjector({
        capabilities: agentCapabilityTokens,
        getBaseUrl: getAgentToolBaseUrl
      });
  const enterpriseMcpRunInjector: RunMcpInjector = {
    prepare(run) {
      return enterpriseMcpManager.prepareRuntime(run);
    }
  };
  const codexMcpRuntimeInjector = createCodexMcpRuntimeInjector({
    codexHome
  });
  const agentToolInjector = combineRunInjectors(
    scheduleRunInjector,
    codexMcpRuntimeInjector,
    enterpriseMcpRunInjector
  );
  persistentAppServerExecutor =
    input.runManager === undefined
    && input.persistentAppServerEnabled !== false
    && runtimeTransport === 'app-server'
      ? createPersistentAppServerExecutor({
          codexBin,
          codexHome,
          env: input.codexEnv,
          processInjector: agentToolProcessInjector,
          runtimeInjector: combineRunInjectors(
            codexMcpRuntimeInjector,
            enterpriseMcpRunInjector
          ),
          maxConcurrency:
            input.persistentAppServerMaxConcurrency
            ?? parsePositiveInteger(
              process.env.CLAWEE_MAX_PARALLEL_SESSIONS,
              MAX_PERSISTENT_APP_SERVER_MAX_CONCURRENCY
            )
            ?? DEFAULT_PERSISTENT_APP_SERVER_MAX_CONCURRENCY
        })
      : undefined;
  const runManager =
    input.runManager ??
    createRunManager({
      db,
      dataDir,
      codexBin,
      codexHome,
      env: input.codexEnv,
      threadAccess: threadManager,
      resumeCapabilityVerified,
      profileValidator: profileManager,
      runtimeTransport,
      approvalManager,
      persistentAppServerExecutor,
      serverDeployment: input.serverDeployment,
      activityReporter,
      onBeforeCodexWritableRequest:
        input.onBeforeCodexWritableRequest,
      codexThreadRotationRunThreshold:
        input.codexThreadRotationRunThreshold
        ?? parseNonNegativeInteger(process.env.CLAWEE_CODEX_THREAD_ROTATION_RUN_THRESHOLD),
      prepareThreadRotationContext: context =>
        memoryService.prepareThreadRotationContext(context),
      agentToolInjector,
      recordRunContext: (runId, items) => memoryService.recordRunContext(runId, items),
      onRunTerminal(runId) {
        agentCapabilityTokens.revokeRun(runId);
        notificationService.enqueueRunTerminal(runId);
      }
    });
  let scheduler = input.scheduler;
  const scheduleCoordinator = input.scheduleCoordinator ?? createScheduleCoordinator({
    db,
    repository: scheduleRepository,
    threadManager,
    runManager,
    defaultCwd,
    profileValidator: profileManager,
    onSchedulesChanged: () => scheduler?.refreshTimer()
  });
  prepareSchedulerStartup({
    coordinator: scheduleCoordinator,
    classifySessions: input.schedulerAutostart === true
      ? input.startupSessionClassifier
      : undefined
  });
  scheduler ??= createSchedulerService({
    repository: scheduleRepository,
    runManager,
    autostart: false
  });
  if (input.modelServiceRuntime !== undefined) {
    handleModelServiceSignedOut = () => {
      scheduler.stop();
      runManager.cancelAll();
      invalidatePersistentRuntime('model_service_signed_out');
    };
  }
  const agentScheduleOperations =
    input.agentScheduleOperations
    ?? createDefaultAgentScheduleOperations({
      coordinator: scheduleCoordinator,
      scheduler,
      threadManager
    });
  const taskService = createTaskService({
    db,
    approvals: approvalManager,
    runs: runManager
  });
  const cleanupService = createCleanupService({
    dataDir,
    runs: runRepository,
    threads: threadRepository
  });
  const attachmentService = createAttachmentService({
    db,
    dataDir,
    maxSizeBytes: input.attachmentMaxSizeBytes ?? ATTACHMENT_MAX_SIZE_BYTES,
    draftTtlMs: input.attachmentDraftTtlMs ?? ATTACHMENT_DRAFT_TTL_MS
  });
  const taskMcpService = input.taskMcpEnabled === true
    ? createTaskMcpService({
        projects: projectManager,
        threads: threadManager,
        runs: runManager,
        tasks: taskService,
        threadRunOptions: {
          threadManager,
          profileValidator: profileManager,
          attachmentService,
          capabilities,
          memoryService
        },
        serverSkillInputGuard: isServerSkillDisclosureRequest
      })
    : undefined;
  await attachmentService.cleanupExpiredDrafts();
  const attachmentCleanupTimer = setInterval(() => {
    void attachmentService.cleanupExpiredDrafts().catch(error => {
      console.warn(`Attachment cleanup failed: ${formatError(error)}`);
    });
  }, ATTACHMENT_CLEANUP_INTERVAL_MS);
  attachmentCleanupTimer.unref();
  let unsubscribeRuntimeReady: (() => void) | undefined;

  server.setErrorHandler((error, request, reply) => {
    if ((error as { code?: string }).code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply
        .code(400)
        .send(apiError('VALIDATION_FAILED', 'body must be valid JSON'));
    }
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      if (
        request.method === 'POST'
        && request.url.startsWith('/enterprise/knowledge-bases/')
      ) {
        return reply
          .code(413)
          .send(apiError(
            'ENTERPRISE_DOCUMENT_TOO_LARGE',
            'Enterprise document is too large'
          ));
      }
      if (
        request.method === 'POST'
        && request.url.startsWith('/enterprise/shared-spaces/')
      ) {
        return reply
          .code(413)
          .send(apiError(
            'ENTERPRISE_SHARED_FILE_TOO_LARGE',
            'Enterprise shared file is too large'
          ));
      }
      return reply
        .code(413)
        .send(apiError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds the configured size limit'));
    }
    throw error;
  });

  server.addHook('onClose', async () => {
    let firstError: unknown;
    const capture = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };

    await capture(() => clearInterval(attachmentCleanupTimer));
    await capture(() => unsubscribeRuntimeReady?.());
    await capture(() => unsubscribeModelCatalogChanges?.());
    await capture(() => input.modelServiceRuntime?.signOut());
    await capture(() => unsubscribeApprovalNotifications());
    await capture(() => scheduler.stop());
    await capture(() => runManager.close());
    await capture(() => activityReporter?.close());
    await capture(() => enterpriseSessionManager.close());
    await capture(() => codexSessionProvider.close());
    await capture(() => codexModelCatalog.close());
    await capture(() => agentCapabilityTokens.close());
    if (ownsDb) {
      await capture(() => {
        if (db.open) db.close();
      });
    }
    if (firstError !== undefined) throw firstError;
  });

  server.get('/healthz', async (): Promise<RuntimeHealthResponse> => ({
    ok: true,
    ...(input.modelServiceRuntime === undefined
      ? {}
      : {
          runtimeState: input.modelServiceRuntime.ready()
            ? 'ready' as const
            : 'configuration_required' as const
        })
  }));

  server.addHook('preHandler', async (request, reply) => {
    if (request.url === '/healthz') return;
    if (isAgentToolInternalRequest(request.url)) return;
    if (
      webDistDir !== undefined
      && request.method === 'GET'
      && (
        request.routeOptions.url === '/*'
        || request.routeOptions.url === '/.clawee/runtime-config'
      )
    ) {
      return;
    }
    if (
      request.method === 'GET'
      && request.routeOptions.url === '/enterprise/dingtalk/callback'
    ) {
      return;
    }
    await auth(request, reply);
    if (reply.sent) return;
    if (
      input.modelServiceRuntime !== undefined
      && !input.modelServiceRuntime.ready()
      && !isPreModelConfigurationRequest(
        request.method,
        request.routeOptions.url,
        input.taskMcpEnabled === true
      )
    ) {
      return reply.code(428).send(apiError(
        'MODEL_SERVICE_CONFIGURATION_REQUIRED',
        '请先配置并验证 Codex 模型服务'
      ));
    }
  });

  if (input.modelServiceRuntime !== undefined) {
    await registerModelServiceRoutes(server, {
      runtime: input.modelServiceRuntime,
      sessionManager: enterpriseSessionManager,
      httpClient: enterpriseHttpClient
    });
  }
  await registerCodexRoutes(server, {
    codexBin,
    codexHome: resolvedCodexHome,
    capabilities,
    modelCatalog: codexModelCatalog,
    getConfiguredModel: () => {
      const state = input.modelServiceRuntime?.status();
      return state?.status === 'ready'
        ? state.configuration.model
        : undefined;
    },
    getAvailabilityProbe: input.getCodexAvailabilityProbe,
    getRuntimeStatus: getCodexRuntimeStatus
  });
  await registerEnterpriseRoutes(server, {
    sessionManager: enterpriseSessionManager,
    skillManager: enterpriseSkillManager,
    mcpManager: enterpriseMcpManager
  });
  await registerGatewayRoutes(server, {
    configPath: input.enterpriseConfigPath,
    getOrigin: () => enterpriseOrigin.origin,
    canChange: () => ['signed_out', 'service_unavailable'].includes(enterpriseSessionManager.getSnapshot().status)
      && !runManager.listRuns(Number.MAX_SAFE_INTEGER).some(run => !['succeeded', 'failed', 'canceled', 'orphaned'].includes(run.status)),
    async clearSession() {
      await enterpriseSessionManager.invalidateUnauthorized();
      await enterpriseMcpManager.handleSessionSignedOut();
      await input.modelServiceRuntime?.signOut();
    },
    activate(origin) {
      activeEnterpriseHttpClient = createEnterpriseHttpClient({ origin });
      Object.assign(enterpriseOrigin, resolveEnterpriseOrigin(origin));
      enterpriseSessionManager.startRestore();
    }
  });
  await registerEnterpriseKnowledgeRoutes(
    server,
    enterpriseKnowledgeManager,
    { maxDocumentBytes: input.enterpriseKnowledgeDocumentMaxBytes }
  );
  await registerEnterpriseDriveRoutes(
    server,
    enterpriseSharedDriveManager,
    { maxFileBytes: input.enterpriseSharedFileMaxBytes }
  );
  await registerEnterpriseActivityRoutes(server, enterpriseActivityManager);
  await registerEnterpriseBillingRoutes(server, enterpriseBillingManager);
  await registerEnterpriseBusinessDashboardRoutes(
    server,
    enterpriseBusinessDashboardManager
  );
  await registerProfileRoutes(server, {
    codexHome: resolvedCodexHome,
    profileManager,
    getProfileUsage(name) {
      return {
        threads: threadRepository.listProfileReferences(name),
        schedules: scheduleRepository.listProfileReferences(name)
      };
    }
  });
  await registerProjectRoutes(
    server,
    projectManager,
    runManager,
    projectDirectoryPicker
  );
  await registerSkillRoutes(server, { skillManager });
  await registerSkillMarketRoutes(server, { skillMarketManager });
  await registerMcpRoutes(server, { mcpManager });
  await registerRunRoutes(server, runManager, {
    sseHeartbeatMs: input.sseHeartbeatMs,
    threadManager,
    profileValidator: profileManager,
    attachmentService,
    capabilities,
    memoryService
  });
  if (taskMcpService !== undefined) {
    await registerTaskMcpRoutes(server, { service: taskMcpService });
  }
  await registerScheduleRoutes(server, scheduleCoordinator, scheduler);
  await registerAgentToolRoutes(server, {
    capabilities: agentCapabilityTokens,
    schedules: agentScheduleOperations
  });
  if (input.agentToolsEnabled === true) {
    await registerAgentScheduleMcpRoute(server, {
      capabilities: agentCapabilityTokens,
      getBaseUrl: () => resolveListeningOrigin(server.server.address())
    });
  }
  await registerCleanupRoutes(server, cleanupService);
  await registerAttachmentRoutes(server, attachmentService, {
    maxSizeBytes: input.attachmentMaxSizeBytes
  });
  await registerApprovalRoutes(server, approvalManager);
  await registerNotificationRoutes(server, notificationService);
  await registerTaskRoutes(server, taskService);
  await registerMemoryRoutes(server, memoryService, {
    async readThreadHistory(threadId) {
      if (input.memoryHistoryReader !== undefined) {
        return input.memoryHistoryReader(threadId);
      }
      const thread = threadManager.getThread(threadId);
      if (thread === undefined) return undefined;
      if (thread.codexThreadId === undefined || thread.codexThreadId === null) {
        return { items: [] };
      }
      return {
        items: await readAllCodexHistory(codexSessionProvider, thread.codexThreadId)
      };
    }
  });
  await registerDiagnosticsRoutes(server, {
    dataDir,
    runs: runRepository,
    schedules: scheduleRepository,
    getCodexStatusSnapshot: () =>
      buildCodexStatusResponse({
        codexBin,
        codexHome: resolvedCodexHome,
        capabilities,
        runtime: getCodexRuntimeStatus(),
        availabilityProbe: input.getCodexAvailabilityProbe?.()
      })
  });
  await registerWorkspaceFileRoutes(server, workspaceFileService);
  await registerSearchRoutes(server, {
    provider: codexSessionProvider,
    threadManager
  });
  await registerThreadRoutes(server, threadManager, runManager, {
    profileValidator: profileManager,
    attachmentService,
    readThreadHistory(codexThreadId, options) {
      return codexSessionProvider.listTurns({
        codexThreadId,
        limit: options.limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor })
      });
    },
    onPerformanceEvent: reportPerformance
  });
  await registerKnowledgeConversationRoutes(
    server,
    knowledgeConversationManager,
    runManager,
    {
      attachmentService,
      async readHistory(thread, options) {
        if (thread.codexThreadId === undefined || thread.codexThreadId === null) {
          return { items: [], hasMore: false };
        }
        const request = {
          codexThreadId: thread.codexThreadId,
          limit: options.limit,
          ...(options.cursor === undefined ? {} : { cursor: options.cursor })
        };
        try {
          return await codexSessionProvider.listTurns(request);
        } catch (error) {
          const legacyCodexHome = join(thread.cwd, '.codex-runtime');
          if (!existsSync(join(legacyCodexHome, 'sessions'))) throw error;

          const provider = createCodexSessionProvider({
            client: createCodexAppServerClient({
              codexBin,
              codexHome: legacyCodexHome,
              env: input.codexEnv
            })
          });
          try {
            return await provider.listTurns(request);
          } finally {
            await provider.close();
          }
        }
      }
    }
  );

  if (input.schedulerAutostart === true) {
    if (input.modelServiceRuntime === undefined) {
      scheduler.start();
    } else {
      if (input.modelServiceRuntime.ready()) scheduler.start();
      unsubscribeRuntimeReady = input.modelServiceRuntime.subscribeReady(() => {
        scheduler.start();
      });
    }
  }
  if (webDistDir !== undefined) {
    try {
      await registerServerModeWeb(server, webDistDir, input.token);
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
  }
  return server;
}

async function registerServerModeWeb(
  server: import('fastify').FastifyInstance,
  webDistDir: string,
  token: string
): Promise<void> {
  await server.register(fastifyStatic, {
    root: webDistDir,
    serve: false
  });
  server.get('/.clawee/runtime-config', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { baseUrl: '', token };
  });
  server.get('/*', async (request, reply) => {
    const requested = (request.params as { '*': string })['*'];
    const relativePath = requested.length === 0 ? 'index.html' : requested;
    const resolvedPath = resolve(webDistDir, relativePath);
    const insideRoot = !isAbsolute(relative(webDistDir, resolvedPath))
      && !relative(webDistDir, resolvedPath).startsWith('..');
    if (insideRoot && existsSync(resolvedPath)) {
      return reply.sendFile(relativePath);
    }
    return reply.sendFile('index.html');
  });
}

function isModelAccessRequest(
  route: string | undefined
): boolean {
  return route === '/runtime/model-service'
    || route === '/runtime/model-service/configure'
    || route === '/runtime/model-service/retry'
    || route === '/enterprise/session'
    || route === '/enterprise/gateway'
    || route === '/enterprise/session/refresh'
    || route === '/enterprise/login'
    || route === '/enterprise/register'
    || route === '/enterprise/qr-login'
    || route === '/enterprise/qr-login/:requestId'
    || route === '/enterprise/dingtalk/login/prepare'
    || route === '/enterprise/logout';
}

function isPreModelConfigurationRequest(
  method: string,
  route: string | undefined,
  taskMcpEnabled: boolean
): boolean {
  return isModelAccessRequest(route)
    || (
      taskMcpEnabled
      && (route === '/mcp' || (method === 'GET' && route === '/projects'))
    );
}

function reportDaemonPerformance(details: Record<string, unknown>): void {
  const parentPort = (
    process as NodeJS.Process & {
      parentPort?: {
        postMessage(message: unknown): void;
      };
    }
  ).parentPort;
  const message = {
    type: 'clawee_runtime_performance',
    details
  };
  try {
    if (parentPort !== undefined) {
      parentPort.postMessage(message);
      return;
    }
  } catch {
    // Performance diagnostics must not affect Runtime requests.
  }
  console.info(JSON.stringify(message));
}

function createUnavailableCredentialStore(): EnterpriseCredentialStore {
  return {
    async read() {
      return undefined;
    },
    async write() {
      throw new EnterpriseCredentialStoreError('write');
    },
    async delete() {
      throw new EnterpriseCredentialStoreError('delete');
    }
  };
}

function combineRunInjectors(
  ...injectors: Array<RunMcpInjector | undefined>
): RunMcpInjector | undefined {
  const active = injectors.filter(
    (injector): injector is RunMcpInjector => injector !== undefined
  );
  if (active.length === 0) return undefined;
  return {
    async prepare(run) {
      const prepared = (
        await Promise.all(active.map(injector => injector.prepare(run)))
      ).filter(
        (injection): injection is AgentToolRunInjection =>
          injection !== undefined
      );
      if (prepared.length === 0) return undefined;
      return {
        mcpServers: prepared.flatMap(injection => injection.mcpServers),
        env: Object.assign({}, ...prepared.map(injection => injection.env)),
        builtInTools: prepared.find(
          injection => injection.builtInTools !== undefined
        )?.builtInTools,
        configurationFingerprint: prepared
          .map(injection => injection.configurationFingerprint)
          .filter((value): value is string => value !== undefined)
          .join(':')
      };
    }
  };
}

async function readAllCodexHistory(
  provider: CodexSessionProvider,
  codexThreadId: string
): Promise<import('@clawee/protocol').ThreadHistoryItem[]> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let items: import('@clawee/protocol').ThreadHistoryItem[] = [];
  do {
    const page = await provider.listTurns({
      codexThreadId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor })
    });
    items = [...page.items, ...items];
    cursor = page.nextCursor;
    if (cursor !== undefined && seenCursors.has(cursor)) {
      throw new Error('Codex app-server returned a repeated history cursor');
    }
    if (cursor !== undefined) seenCursors.add(cursor);
  } while (cursor !== undefined);
  return items;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePositiveInteger(
  value: string | undefined,
  maximum: number
): number | undefined {
  const parsed = parseNonNegativeInteger(value);
  return parsed === undefined || parsed < 1
    ? undefined
    : Math.min(parsed, maximum);
}

function resolveListeningOrigin(
  address: ReturnType<typeof import('node:net').Server.prototype.address>
): string | undefined {
  if (address === null || typeof address === 'string') return undefined;
  const host = address.address === '::' || address.address === '0.0.0.0'
    ? '127.0.0.1'
    : address.address.includes(':')
      ? `[${address.address}]`
      : address.address;
  return `http://${host}:${address.port}`;
}
