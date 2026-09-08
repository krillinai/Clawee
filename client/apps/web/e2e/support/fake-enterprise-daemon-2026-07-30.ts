import type { Page, Route } from '@playwright/test';

export type FakeEnterpriseRequest = {
  method: string;
  path: string;
  bodyKeys: string[];
};

export type FakeEnterpriseState = {
  session: 'signed_out' | 'signed_in';
  installed: boolean;
  mcpInstalled: boolean;
  mcpEnabled: boolean;
  createdThread: boolean;
  uploadedKnowledgeDocument: boolean;
  savedSharedFile: boolean;
};

const runtimePrefix = '/.clawee/runtime';
const project = {
  id: 'project-enterprise',
  name: '企业项目',
  cwd: '/workspace/enterprise',
  canonicalCwd: '/workspace/enterprise',
  directoryState: 'available',
  profile: 'default',
  model: null,
  reasoning: null,
  sandbox: 'workspace-write',
  status: 'active',
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
  archivedAt: null
};

export class FakeEnterpriseDaemon {
  private state: FakeEnterpriseState = {
    session: 'signed_out',
    installed: false,
    mcpInstalled: false,
    mcpEnabled: false,
    createdThread: false,
    uploadedKnowledgeDocument: false,
    savedSharedFile: false
  };
  private sharedFileDownloadAttempts = 0;
  private requests: FakeEnterpriseRequest[] = [];
  private unknownPaths: string[] = [];
  private nativeMcpServers: Array<{ name: string; enabled: boolean }> = [];

  reset(): void {
    this.state = {
      session: 'signed_out',
      installed: false,
      mcpInstalled: false,
      mcpEnabled: false,
      createdThread: false,
      uploadedKnowledgeDocument: false,
      savedSharedFile: false
    };
    this.sharedFileDownloadAttempts = 0;
    this.requests = [];
    this.unknownPaths = [];
    this.nativeMcpServers = [];
  }

  setMcpPreference(input: { installed: boolean; enabled: boolean }): void {
    this.state.mcpInstalled = input.installed;
    this.state.mcpEnabled = input.installed && input.enabled;
  }

  setNativeMcpServers(servers: Array<{ name: string; enabled: boolean }>): void {
    this.nativeMcpServers = servers.map(server => ({ ...server }));
  }

  completeDingTalkLogin(): void {
    this.state.session = 'signed_in';
  }

  async attach(page: Page): Promise<void> {
    await page.route('**/.clawee/runtime-config', route => route.fulfill({
      json: { baseUrl: runtimePrefix }
    }));
    await page.route('**/.clawee/runtime/**', route => this.handle(route));
  }

  snapshot(): FakeEnterpriseState {
    return { ...this.state };
  }

  requestLog(): FakeEnterpriseRequest[] {
    return this.requests.map(request => ({
      ...request,
      bodyKeys: [...request.bodyKeys]
    }));
  }

  unknownRequestPaths(): string[] {
    return [...this.unknownPaths];
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = `${url.pathname.slice(runtimePrefix.length)}${url.search}` || '/';
    const body = readBodyKeys(request.postData());
    this.requests.push({
      method: request.method(),
      path,
      bodyKeys: body.keys
    });

    if (path === '/healthz') return fulfill(route, { ok: true });
    if (path === '/runtime/model-service') {
      return fulfill(route, modelServiceStatus());
    }
    if (path === '/codex/status') return fulfill(route, codexStatus());
    if (path === '/codex/models') return fulfill(route, codexModels());
    if (path === '/projects/migrations/local-storage-v1' && request.method() === 'POST') {
      return fulfill(route, {
        status: 'applied',
        projectIdMap: {},
        assignedThreadIds: [],
        unassignedThreadIds: []
      });
    }
    if (path === '/projects/directory-selection' && request.method() === 'POST') {
      return fulfill(route, {
        path: null
      });
    }
    if (path === '/projects?status=active' || path === '/projects?status=all') {
      return fulfill(route, { projects: [project] });
    }
    if (path.startsWith('/threads?') && path.includes('assignment=unassigned')) {
      return fulfill(route, { threads: [] });
    }
    if (
      path === '/threads?status=active&limit=50'
      || path === '/threads?status=active&excludePurpose=schedule_task&limit=50'
    ) {
      return fulfill(route, {
        threads: this.state.createdThread ? [createdThread()] : []
      });
    }
    if (path === '/threads?status=active&purpose=schedule_task&limit=100') {
      return fulfill(route, { threads: [] });
    }
    if (path === '/threads?status=active&purpose=conversation&limit=50') {
      return fulfill(route, { threads: [] });
    }
    if (path.startsWith('/tasks?')) return fulfill(route, { tasks: [], hasMore: false });
    if (path === '/schedules') return fulfill(route, { schedules: [] });
    if (path === '/enterprise/session') return fulfill(route, sessionResponse(this.state.session));
    if (path === '/enterprise/session/refresh' && request.method() === 'POST') {
      return fulfill(route, sessionResponse(this.state.session));
    }
    if (
      path === '/enterprise/activity/capability'
      && request.method() === 'GET'
    ) {
      return fulfill(route, {
        allowed: true,
        refreshedAt: '2026-08-18T08:00:00.000Z'
      });
    }
    if (
      path === '/enterprise/business-dashboards/bilibili-operation'
      && request.method() === 'GET'
    ) {
      return fulfill(route, {
        status: 'available',
        data: {
          capturedAt: '2026-08-30T01:30:00.000Z',
          followerCount: 128600,
          collectedContentCount: 24,
          viewCount: 8650000,
          interactionCount: 316800,
          topContents: [{
            externalContentId: 'BV1enterprise',
            title: '企业新品内容复盘',
            capturedAt: '2026-08-30T01:20:00.000Z',
            viewCount: 680000,
            interactionCount: 28600
          }]
        }
      });
    }
    if (
      path.startsWith('/enterprise/activity/statistics?')
      && request.method() === 'GET'
    ) {
      return fulfill(
        route,
        enterpriseActivityStatistics(
          normalizeActivityRange(url.searchParams.get('range'))
        )
      );
    }
    if (
      path.startsWith('/enterprise/activity/detail?')
      && request.method() === 'GET'
    ) {
      return fulfill(route, enterpriseActivityDetail({
        collectorId: url.searchParams.get('collectorId') ?? '',
        agentId: url.searchParams.get('agentId') ?? ''
      }));
    }
    if (
      path.startsWith('/enterprise/billing/overview?')
      && request.method() === 'GET'
    ) {
      return fulfill(route, {
        balanceCny: 100,
        generatedAt: '2026-08-28T10:00:00+08:00'
      });
    }
    if (
      path === '/enterprise/dingtalk/login/prepare'
      && request.method() === 'POST'
    ) {
      return fulfill(route, {
        authorizationUrl:
          'https://enterprise.example/api/v1/auth/dingtalk/clawee/start?state=prepared',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    if (path === '/enterprise/login' && request.method() === 'POST') {
      this.state.session = 'signed_in';
      return fulfill(route, sessionResponse('signed_in'));
    }
    if (path === '/enterprise/qr-login' && request.method() === 'POST') {
      const provider = readObjectBody(request.postData()).provider;
      if (!['feishu', 'dingtalk', 'wecom'].includes(String(provider))) {
        return fulfill(route, {
          error: { code: 'VALIDATION_FAILED', message: 'Invalid provider' }
        }, 400);
      }
      return fulfill(route, {
        requestId: `qr-${String(provider)}`,
        provider,
        qrCodeUrl: onePixelQrCode,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pollAfterMs: 1000
      });
    }
    if (path.startsWith('/enterprise/qr-login/') && request.method() === 'GET') {
      const provider = path.slice('/enterprise/qr-login/qr-'.length);
      this.state.session = 'signed_in';
      return fulfill(route, {
        requestId: `qr-${provider}`,
        provider,
        status: 'signed_in',
        session: sessionResponse('signed_in')
      });
    }
    if (path === '/enterprise/logout' && request.method() === 'POST') {
      this.state.session = 'signed_out';
      return fulfill(route, sessionResponse('signed_out'));
    }
    if (
      (path === '/enterprise/mcp' && request.method() === 'GET')
      || (path === '/enterprise/mcp/refresh' && request.method() === 'POST')
    ) {
      return fulfill(route, enterpriseMcpCatalog(this.state));
    }
    if (
      path === '/enterprise/mcp/upstreams/crm-main/preference'
      && request.method() === 'PATCH'
    ) {
      const update = readObjectBody(request.postData());
      if (typeof update.installed === 'boolean') {
        this.state.mcpInstalled = update.installed;
      }
      if (typeof update.enabled === 'boolean') {
        this.state.mcpEnabled = update.enabled;
      }
      if (!this.state.mcpInstalled) this.state.mcpEnabled = false;
      return fulfill(route, enterpriseMcpCatalog(this.state));
    }
    if (
      path === '/codex/mcp/enterprise_crm'
      && request.method() === 'PATCH'
    ) {
      const update = readObjectBody(request.postData());
      if (typeof update.enabled === 'boolean' && this.state.mcpInstalled) {
        this.state.mcpEnabled = update.enabled;
      }
      return fulfill(route, {
        server: enterpriseNativeMcp(this.state),
        operation: {
          id: 'operation-enable',
          operation: this.state.mcpEnabled ? 'enable' : 'disable',
          serverName: 'enterprise_crm',
          codexHome: '/tmp/codex',
          command: ['config', 'set'],
          status: 'succeeded',
          exitCode: 0,
          timedOut: false,
          createdAt: '2026-08-12T08:00:00.000Z'
        }
      });
    }
    if (path.startsWith('/codex/mcp/') && request.method() === 'PATCH') {
      const name = decodeURIComponent(path.slice('/codex/mcp/'.length));
      const server = this.nativeMcpServers.find(candidate => candidate.name === name);
      if (server !== undefined) {
        const update = readObjectBody(request.postData());
        if (typeof update.enabled === 'boolean') server.enabled = update.enabled;
        return fulfill(route, {
          server: standaloneNativeMcp(server),
          operation: {
            id: `operation-${server.enabled ? 'enable' : 'disable'}-${server.name}`,
            operation: server.enabled ? 'enable' : 'disable',
            serverName: server.name,
            codexHome: '/tmp/codex',
            command: ['config', 'set'],
            status: 'succeeded',
            exitCode: 0,
            timedOut: false,
            createdAt: '2026-08-12T08:00:00.000Z'
          }
        });
      }
    }
    if (path === '/enterprise/knowledge-bases' && request.method() === 'GET') {
      return fulfill(route, {
        knowledgeBases: [enterpriseKnowledgeBase(
          this.state.uploadedKnowledgeDocument ? 2 : 1
        )],
        meta: { nextCursor: '', hasNext: false },
        refreshedAt: '2026-08-05T08:00:00.000Z'
      });
    }
    if (
      path === '/enterprise/knowledge-bases/kb-enterprise/documents'
      && request.method() === 'GET'
    ) {
      return fulfill(route, {
        documents: [
          enterpriseKnowledgeDocument(),
          ...(this.state.uploadedKnowledgeDocument
            ? [uploadedKnowledgeDocument()]
            : [])
        ],
        meta: { nextCursor: '', hasNext: false },
        refreshedAt: '2026-08-05T08:00:00.000Z'
      });
    }
    if (
      path.startsWith('/enterprise/knowledge-bases/kb-enterprise/documents?')
      && request.method() === 'POST'
    ) {
      this.state.uploadedKnowledgeDocument = true;
      return fulfill(route, {
        document: uploadedKnowledgeDocument()
      }, 201);
    }
    if (path === '/enterprise/shared-spaces?limit=100' && request.method() === 'GET') {
      return fulfill(route, {
        spaces: [enterpriseSharedSpace()],
        meta: {
          nextCursor: '',
          hasNext: false,
          maxFileSizeBytes: 1024 * 1024 * 1024
        },
        refreshedAt: '2026-08-06T08:00:00.000Z'
      });
    }
    if (path === '/enterprise/shared-files?limit=100' && request.method() === 'GET') {
      return fulfill(route, {
        files: [enterpriseSharedFile()],
        meta: { nextCursor: '', hasNext: false },
        refreshedAt: '2026-08-06T08:00:00.000Z'
      });
    }
    if (
      path === '/enterprise/shared-files/file-design/download'
      && request.method() === 'POST'
    ) {
      this.sharedFileDownloadAttempts += 1;
      const download = readObjectBody(request.postData());
      if (download.projectId !== project.id) {
        return fulfill(route, {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: 'Project was not found'
          }
        }, 404);
      }
      if (
        this.sharedFileDownloadAttempts === 1
        && download.overwrite !== true
      ) {
        return fulfill(route, {
          error: {
            code: 'ENTERPRISE_SHARED_FILE_LOCAL_EXISTS',
            message: 'The project already contains this file',
            details: { relativePath: 'docs/design.md' }
          }
        }, 409);
      }
      this.state.savedSharedFile = true;
      return fulfill(route, {
        fileId: 'file-design',
        projectId: String(download.projectId ?? ''),
        relativePath: 'docs/design.md',
        sizeBytes: 13,
        sha256: 'a'.repeat(64),
        revision: 3,
        overwritten: download.overwrite === true
      });
    }
    if (path === '/enterprise/skills' && request.method() === 'GET') {
      return fulfill(route, {
        skills: [enterpriseSkill(this.state.installed)],
        refreshedAt: '2026-07-30T08:00:00.000Z'
      });
    }
    if (path === '/enterprise/skills/enterprise-skill' && request.method() === 'GET') {
      return fulfill(route, {
        ...enterpriseSkill(this.state.installed),
        changelog: '改进企业知识检索和输出格式。'
      });
    }
    if (
      path === '/enterprise/skills/enterprise-skill/install'
      && request.method() === 'POST'
    ) {
      this.state.installed = true;
      return fulfill(route, {
        skill: enterpriseSkill(true),
        localSkill: localSkill(),
        operation: {}
      });
    }
    if (path === '/codex/skills') {
      return fulfill(route, {
        codexHome: '/tmp/codex',
        codexHomeMode: 'global',
        skillsPath: '/tmp/codex/skills',
        skillsWritable: true,
        requiresWriteConfirmation: false,
        skills: this.state.installed ? [localSkill()] : [],
        diagnostics: []
      });
    }
    if (path === '/codex/mcp') {
      return fulfill(route, {
        codexHome: '/tmp/codex',
        codexHomeMode: 'global',
        requiresWriteConfirmation: false,
        servers: [
          ...(this.state.mcpInstalled ? [enterpriseNativeMcp(this.state)] : []),
          ...this.nativeMcpServers.map(standaloneNativeMcp)
        ],
        presets: [],
        diagnostics: []
      });
    }
    if (path === '/codex/profiles') {
      return fulfill(route, {
        codexHome: '/tmp/codex',
        codexHomeMode: 'global',
        writable: true,
        baseConfigValid: true,
        profiles: [],
        diagnostics: []
      });
    }
    if (path === '/codex/skill-market/install-records') {
      return fulfill(route, { records: [] });
    }
    if (path === '/threads' && request.method() === 'POST') {
      this.state.createdThread = true;
      return fulfill(route, { thread: createdThread() }, 201);
    }
    if (path === '/threads/thread-enterprise-skill/history?limit=50') {
      return fulfill(route, {
        threadId: 'thread-enterprise-skill',
        codexThreadId: null,
        items: []
      });
    }
    if (path === '/threads/thread-enterprise-skill/runs?limit=50') {
      return fulfill(route, { runs: [] });
    }

    this.unknownPaths.push(`${request.method()} ${path}`);
    return fulfill(route, {
      error: {
        code: 'FAKE_RUNTIME_ROUTE_NOT_FOUND',
        message: `Unhandled fake Runtime route: ${request.method()} ${path}`
      }
    }, 404);
  }
}

function readBodyKeys(raw: string | null): { keys: string[] } {
  const value = readObjectBody(raw);
  return { keys: Object.keys(value).sort() };
}

function readObjectBody(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.length === 0) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sessionResponse(status: 'signed_out' | 'signed_in') {
  return status === 'signed_in'
    ? {
        status,
        account: {
          subjectId: 'acct-enterprise-member',
          email: 'member@example.com',
          name: 'Enterprise Member'
        },
        expiresAt: '2026-08-30T12:00:00.000Z',
        transportSecurity: 'secure_https'
      }
    : {
        status,
        transportSecurity: 'secure_https'
      };
}

const onePixelQrCode =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function enterpriseSkill(installed: boolean) {
  return {
    skillId: 'enterprise-skill',
    name: 'enterprise-name',
    description: '企业知识检索与报告生成',
    version: '1.0.0',
    ...(installed ? { installedVersion: '1.0.0' } : {}),
    updatedAt: '2026-07-30T08:00:00.000Z',
    status: installed ? 'installed' : 'not_installed',
    integrity: installed ? 'verified' : 'not_applicable',
    actions: installed ? ['use'] : ['install']
  };
}

function normalizeActivityRange(
  value: string | null
): 'today' | '7d' | '30d' {
  return value === 'today' || value === '30d' ? value : '7d';
}

function enterpriseActivityStatistics(range: 'today' | '7d' | '30d') {
  return {
    range,
    timezone: 'Asia/Shanghai',
    startDate: range === 'today' ? '2026-08-18' : '2026-08-12',
    endDate: '2026-08-18',
    generatedAt: '2026-08-18T08:00:00.000Z',
    organization: {
      usage: {
        inputTokens: 18_279_996,
        cachedInputTokens: 16_894_080,
        outputTokens: 116_251,
        totalTokens: 18_396_247
      },
      activeEmployees: 3,
      activeAgents: 1,
      completedTurns: 42,
      mcpDistribution: [{
        id: 'filesystem',
        label: 'filesystem',
        invocationCount: 18,
        share: 0.6
      }]
    },
    trend: {
      granularity: range === 'today' ? 'hour' : 'day',
      points: [{
        bucketStart: '2026-08-18T00:00:00+08:00',
        inputTokens: 1_000,
        cachedInputTokens: 600,
        outputTokens: 200,
        totalTokens: 1_200
      }, {
        bucketStart: '2026-08-18T08:00:00+08:00',
        inputTokens: 2_000,
        cachedInputTokens: 900,
        outputTokens: 300,
        totalTokens: 2_300
      }]
    },
    modelDistribution: [{
      model: 'gpt-5.6-sol',
      requests: 20,
      inputTokens: 1_000,
      cachedInputTokens: 600,
      outputTokens: 200,
      totalTokens: 1_200,
      share: 0.8
    }],
    tokenUsageRanking: [{
      rank: 1,
      name: '企业团队',
      requests: 20,
      totalTokens: 18_396_247
    }],
    agents: [{
      collectorId: 'collector-enterprise',
      agentId: 'agent-enterprise',
      name: '企业研究 Agent',
      status: 'online',
      sessionCount: 4,
      turnCount: 12,
      lastActivityAt: '2026-08-18T07:59:00.000Z'
    }],
    dataStatus: {
      sub2api: 'available',
      activity: 'available'
    }
  };
}

function enterpriseActivityDetail(input: {
  collectorId: string;
  agentId: string;
}) {
  return {
    schemaVersion: 'office.v1',
    serverTime: '2026-08-18T08:00:00.000Z',
    agent: {
      collectorId: input.collectorId,
      agentId: input.agentId,
      displayName: '企业研究 Agent',
      agentType: 'clawee',
      workspaceName: '企业项目',
      status: 'online',
      activeSubAgentCount: 1,
      totalSubAgentCount: 1,
      recentToolCalls: 1,
      lastSeenAt: '2026-08-18T07:59:00.000Z'
    },
    sessions: [{
      sessionId: 'session-enterprise',
      title: '企业资料调研',
      status: 'active',
      summary: '整理公开资料',
      workspaceName: '企业项目',
      startedAt: '2026-08-18T07:00:00.000Z',
      durationMs: 3_600_000
    }],
    turns: [{
      turnId: 'turn-enterprise',
      sessionId: 'session-enterprise',
      title: '资料汇总',
      status: 'completed',
      prompt: '整理本周公开资料',
      assistantSummary: '已形成摘要',
      model: 'gpt-5.6-sol',
      startedAt: '2026-08-18T07:10:00.000Z'
    }],
    subAgents: [{
      subAgentId: 'sub-enterprise',
      name: '网页检索',
      status: 'completed',
      completedTurns: 3
    }],
    toolCalls: [{
      toolCallId: 'tool-enterprise',
      name: 'WebSearch',
      type: 'mcp',
      status: 'success',
      occurredAt: '2026-08-18T07:20:00.000Z',
      durationMs: 1_800
    }],
    statusTimeline: [],
    recentActivities: [{
      activityId: 'activity-enterprise',
      type: 'turn',
      title: '完成资料汇总',
      status: 'completed',
      occurredAt: '2026-08-18T07:30:00.000Z'
    }],
    stats: {
      sessionDurationMs: 3_600_000,
      activeSubAgents: 1,
      totalSubAgents: 1,
      recentActivityCount: 1,
      businessRiskLevel: 'unknown',
      activeSessions: 1,
      activeWorkMs: 180_000,
      toolTypeVariety: 1,
      toolCallCount: 1
    }
  };
}

function enterpriseMcpCatalog(state: FakeEnterpriseState) {
  return {
    agentId: 'clawee_550e8400-e29b-41d4-a716-446655440000',
    tokenStatus: 'ready',
    upstreams: [{
      upstreamId: 'crm-main',
      name: '客户关系管理',
      domain: 'sales',
      endpoint: 'https://enterprise.example/mcp/servers/crm-main',
      upstreamTransport: 'streamable_http',
      namespace: 'crm',
      status: 'active',
      codexServerName: 'enterprise_crm',
      ...(state.mcpInstalled
        ? { installedServerName: 'enterprise_crm' }
        : {}),
      installed: state.mcpInstalled,
      enabled: state.mcpEnabled,
      tools: [{
        toolId: 'cap_search',
        upstreamName: 'customer.search',
        name: 'customer.search',
        exposedName: 'crm.customer.search',
        title: '查询客户',
        description: '按条件查询客户资料',
        riskLevel: 'low',
        confirmRequired: false,
        status: 'active',
        authorized: true,
        authorizationExpiresAt: null
      }, {
        toolId: 'cap_update',
        upstreamName: 'customer.update',
        name: 'customer.update',
        exposedName: 'crm.customer.update',
        title: '更新客户',
        description: '更新客户资料',
        riskLevel: 'medium',
        confirmRequired: true,
        status: 'active',
        authorized: false,
        authorizationExpiresAt: null
      }]
    }],
    refreshedAt: '2026-08-07T08:00:00.000Z'
  };
}

function enterpriseNativeMcp(state: FakeEnterpriseState) {
  return {
    name: 'enterprise_crm',
    enabled: state.mcpEnabled,
    transport: 'http',
    status: 'configured',
    url: 'https://enterprise.example/mcp/servers/crm-main',
    bearerTokenEnvVar: 'CLAWEE_ENTERPRISE_MCP_TOKEN',
    envKeys: [],
    hasSecrets: false,
    codexHome: '/tmp/codex',
    codexHomeMode: 'global',
    diagnostics: []
  };
}

function standaloneNativeMcp(server: { name: string; enabled: boolean }) {
  return {
    name: server.name,
    enabled: server.enabled,
    transport: 'stdio',
    status: 'configured',
    command: server.name,
    args: [],
    envKeys: [],
    hasSecrets: false,
    codexHome: '/tmp/codex',
    codexHomeMode: 'global',
    diagnostics: []
  };
}

function enterpriseKnowledgeBase(documentCount: number) {
  return {
    knowledgeBaseId: 'kb-enterprise',
    name: '企业制度',
    description: '公司制度和员工手册',
    status: 'active',
    documentCount,
    permissions: {
      read: true,
      upload: true,
      search: false
    }
  };
}

function enterpriseKnowledgeDocument() {
  return {
    documentId: 'doc-handbook',
    knowledgeBaseId: 'kb-enterprise',
    name: '员工手册.pdf',
    sizeBytes: 102400,
    mimeType: 'application/pdf',
    status: 'ready',
    errorMessage: '',
    uploadedBy: 'member@example.com',
    createdAt: '2026-08-04T08:00:00.000Z',
    updatedAt: '2026-08-04T08:01:00.000Z'
  };
}

function uploadedKnowledgeDocument() {
  return {
    documentId: 'doc-release',
    knowledgeBaseId: 'kb-enterprise',
    name: '发布流程.md',
    sizeBytes: 18,
    mimeType: 'text/markdown',
    status: 'processing',
    errorMessage: '',
    uploadedBy: 'member@example.com',
    createdAt: '2026-08-05T08:00:00.000Z',
    updatedAt: '2026-08-05T08:00:00.000Z'
  };
}

function enterpriseSharedSpace() {
  return {
    spaceId: 'space-design',
    name: '设计资料',
    description: '产品设计规范与交付文件',
    updatedAt: '2026-08-06T08:00:00.000Z',
    permissions: {
      read: true,
      write: false
    }
  };
}

function enterpriseSharedFile() {
  return {
    fileId: 'file-design',
    spaceId: 'space-design',
    spaceName: '设计资料',
    logicalPath: 'docs/design.md',
    fileName: 'design.md',
    sizeBytes: 13,
    sha256: 'a'.repeat(64),
    contentType: 'text/markdown',
    revision: 3,
    createdByUserId: 'designer@example.com',
    updatedByUserId: 'designer@example.com',
    updatedByAgentId: '',
    createdAt: '2026-08-05T08:00:00.000Z',
    updatedAt: '2026-08-06T08:00:00.000Z'
  };
}

function localSkill() {
  return {
    id: 'enterprise-name',
    name: 'enterprise-name',
    description: '企业知识检索与报告生成',
    status: 'valid',
    diagnostics: [],
    codexHome: '/tmp/codex',
    codexHomeMode: 'global',
    skillsPath: '/tmp/codex/skills',
    skillPath: '/tmp/codex/skills/enterprise-name',
    skillFilePath: '/tmp/codex/skills/enterprise-name/SKILL.md'
  };
}

function createdThread() {
  return {
    id: 'thread-enterprise-skill',
    title: 'enterprise-name',
    projectId: project.id,
    origin: 'clawee_created',
    codexThreadId: null,
    cwd: project.cwd,
    canonicalCwd: project.canonicalCwd,
    workspaceMode: 'external',
    profile: 'default',
    model: null,
    reasoning: null,
    sandbox: 'workspace-write',
    status: 'active',
    purpose: 'conversation',
    createdAt: '2026-07-30T08:00:00.000Z',
    updatedAt: '2026-07-30T08:00:00.000Z',
    archivedAt: null
  };
}

function codexStatus() {
  return {
    codexBin: 'codex',
    codexVersion: 'codex-cli enterprise-e2e',
    codexHome: '/tmp/codex',
    codexHomeMode: 'global',
    codexHomeSource: 'default',
    codexHomeWritable: true,
    capabilities: {
      mcpList: true,
      mcpGet: true,
      mcpAdd: true,
      mcpRemove: true,
      mcpLogin: true,
      mcpLogout: true,
      mcpAddEnv: true,
      mcpAddUrl: true,
      mcpAddBearerTokenEnvVar: true,
      mcpAddOAuth: true
    },
    runtime: {
      runtimeId: 'codex-rust-v0.146.0-layout-1',
      source: 'embedded-package',
      version: '0.146.0',
      releaseTag: 'rust-v0.146.0',
      target: 'aarch64-apple-darwin',
      layoutVersion: 1,
      entryPath: '/Applications/Clawee.app/Contents/Resources/codex-runtime/bin/codex',
      homePath: '/Users/test/Library/Application Support/Clawee/codex/homes/codex-rust-v0.146.0-layout-1',
      contentSha256: 'a'.repeat(64),
      activationState: 'committed',
      minimumClaweeVersion: '1.0.0',
      committedAt: '2026-08-21T08:00:00.000Z'
    },
    diagnostics: []
  };
}

function codexModels() {
  return {
    models: [{
      id: 'clawee-web-e2e-model',
      model: 'clawee-web-e2e-model',
      displayName: 'clawee-web-e2e-model',
      description: 'Configured by the Clawee model service.',
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text'],
      isDefault: true
    }]
  };
}

function modelServiceStatus() {
  return {
    status: 'ready',
    mode: 'enterprise_managed',
    configuration: {
      baseUrl: 'https://model.example.test/v1',
      model: 'clawee-web-e2e-model'
    }
  };
}

function fulfill(route: Route, value: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value)
  });
}
