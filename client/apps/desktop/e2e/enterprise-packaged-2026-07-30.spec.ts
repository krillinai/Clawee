import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import { tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  join,
  resolve
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@iarna/toml';
import {
  expect,
  test,
  type Page
} from '@playwright/test';
import type { CodexStatusResponse } from '@clawee/protocol';
import {
  resolvePrivateCredentialFilePath
} from '../../daemon/src/security/private-credential-file.js';
import {
  CONTROLLED_MODEL_API_KEY,
  ControlledModelServer
} from './controlled-model-server.js';
import { writeControlledRuntimeConfig } from './embedded-runtime-fixture.js';
import {
  packagedExecutable,
  readDesktopBuildManifest
} from './package-artifact.js';
import {
  closePackagedApp,
  launchPackagedApp,
  relaunchPackagedApp,
  type PackagedApp
} from './packaged-app.js';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(e2eDir, '..');
const fakeCodexScript = join(e2eDir, 'fixtures', 'fake-codex.mjs');
const enterpriseEmail = 'packaged-e2e@example.com';
const enterprisePassword = 'packaged-e2e-password';
const enterpriseAccountId = 'acct_packaged_e2e';
const enterpriseSkillName = 'enterprise-review';
const enterpriseKnowledgeBaseId = 'kb_packaged_e2e';
const agentIdPattern =
  /^clawee_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.describe.configure({ mode: 'serial' });

test('实际打包 App 可登录、查看账单与充值记录、管理连接器、使用企业知识库并安装 Skill', async () => {
  test.setTimeout(240_000);

  const runId = randomUUID();
  const root = mkdtempSync(join(tmpdir(), 'clawee-enterprise-packaged-'));
  const codexHome = join(root, 'codex-home');
  const stateDir = join(root, 'fake-codex-state');
  const userData = join(root, 'user-data');
  const dataDir = join(userData, 'daemon');
  const homeDir = join(root, 'home');
  const runtimeHome = join(
    homeDir,
    '.clawee',
    'codex'
  );
  const credentialPath = resolvePrivateCredentialFilePath({
    dataDir,
    e2eRunId: runId
  });
  const binDir = join(root, 'bin');
  const modelServer = new ControlledModelServer();
  const server = new FakeEnterpriseServer(modelServer);
  let app: PackagedApp | undefined;
  let cleanupError: unknown;

  const codexBin = writeCodexShim(binDir);
  writeDesktopSettings(userData, codexBin);
  const [origin, modelOrigin] = await Promise.all([
    server.start(),
    modelServer.start()
  ]);
  writeEnterpriseClientConfig(homeDir, origin);
  writeControlledRuntimeConfig({
    targetHome: runtimeHome,
    dataDir,
    modelOrigin,
    e2eRunId: runId
  });

  try {
    app = await launchPackagedApp({
      executablePath: packagedExecutable(desktopDir),
      args: [
        `--user-data-dir=${userData}`,
        '--disable-gpu',
        `--clawee-enterprise-e2e=${runId}`,
        `--clawee-enterprise-e2e-config=${
          join(homeDir, '.clawee', 'config.toml')
        }`,
        `--clawee-enterprise-e2e-home=${homeDir}`
      ],
      env: {
        ...withoutElectronRunAsNode(process.env),
        HOME: homeDir,
        USERPROFILE: homeDir,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        SHELL: process.platform === 'win32' ? process.env.ComSpec : '/bin/false',
        CLAWEE_DEFAULT_PROJECT_ROOT: join(root, 'Documents'),
        CLAWEE_ENTERPRISE_E2E_HOME: homeDir,
        CODEX_HOME: codexHome,
        CLAWEE_E2E_FAKE_CODEX_STATE_DIR: stateDir,
        CLAWEE_E2E_FAKE_CODEX_MODE: 'success',
        CLAWEE_ENTERPRISE_E2E_RUN_ID: runId,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        NO_PROXY: 'localhost,127.0.0.1'
      },
      timeoutMs: 45_000
    });

    await waitForDesktopRuntime(app.page);
    await expect.poll(
      () => readEnterpriseSession(app!.page)
    ).toMatchObject({ status: 'signed_out' });
    expect(app.page.url()).toContain('clawee-app://app/');

    await expect(app.page.getByRole('heading', {
      name: '欢迎使用 Clawee'
    })).toBeVisible();
    await expect(app.page.getByText('扫码登录', { exact: true })).toHaveCount(0);
    await expect(app.page.getByRole('group', { name: '扫码平台' })).toHaveCount(0);
    await expect(app.page.getByRole('group', { name: '账户操作' })).toBeVisible();
    await expect(app.page.getByRole('button', { name: '钉钉登录' }))
      .toBeEnabled();
    await app.page.getByRole('checkbox').check();
    await app.page.getByRole('button', { name: '钉钉登录' }).click();
    await expect.poll(
      () => readEnterpriseSession(app!.page)
    ).toMatchObject({ status: 'signed_in' });
    await expect.poll(() => existsSync(credentialPath)).toBe(true);
    expect(JSON.parse(readFileSync(credentialPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      enterprise: {
        accessToken: expect.any(String),
        expiresAt: '2099-07-30T12:00:00.000Z'
      },
      modelService: {
        apiKey: expect.any(String)
      }
    });
    if (process.platform !== 'win32') {
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    }
    await app.page.reload();
    await waitForWorkspace(app.page);
    const runtimeCodexHome = await readRuntimeCodexHome(app.page);
    expect(runtimeCodexHome).not.toBe(codexHome);

    await expect(app.page.getByRole('button', {
      name: 'Packaged E2E',
      exact: true
    })).toBeVisible();
    await expect.poll(
      () => readEnterpriseSession(app!.page)
    ).toMatchObject({
      status: 'signed_in',
      account: {
        subjectId: enterpriseAccountId,
        email: enterpriseEmail,
        name: 'Packaged E2E'
      }
    });
    const persistedAgentId = readPersistedAgentId(homeDir);
    expect(persistedAgentId).toMatch(agentIdPattern);
    expect(server.agentIdentity()).toBe(persistedAgentId);

    const previous = app;
    await closePackagedApp(previous);
    app = await relaunchPackagedApp(previous, 45_000);
    await waitForWorkspace(app.page);

    await expect.poll(
      () => readEnterpriseSession(app!.page)
    ).toMatchObject({
      status: 'signed_in',
      account: {
        subjectId: enterpriseAccountId,
        email: enterpriseEmail,
        name: 'Packaged E2E'
      }
    });
    expect(readPersistedAgentId(homeDir)).toBe(persistedAgentId);
    expect(server.agentIdentity()).toBe(persistedAgentId);
    await expect(app.page.getByRole('button', {
      name: 'Packaged E2E',
      exact: true
    })).toBeVisible();

    await app.page.getByRole('button', {
      name: 'Agent动态',
      exact: true
    }).click();
    await expect(app.page.getByRole('heading', {
      name: 'Agent动态'
    })).toBeVisible();
    await expect(app.page.getByTestId('total-tokens'))
      .toHaveText('18,396,247');
    await expect(app.page.getByRole('table', {
      name: 'Token 使用排行'
    })).toBeVisible();
    await expect(app.page.getByRole('table', {
      name: 'Token 使用排行'
    }).getByText('Packaged E2E', { exact: true })).toBeVisible();
    await expect(app.page.getByRole('table', {
      name: 'Agent 列表'
    })).toBeVisible();
    await expect(app.page.getByRole('heading', {
      name: '账户额度'
    })).toBeVisible();
    await expect(app.page.getByText('¥256.50', { exact: true })).toBeVisible();
    await expect(app.page.getByText('当前区间实际费用', { exact: true }))
      .toHaveCount(0);
    await expect(app.page.getByText('¥12.34', { exact: true })).toHaveCount(0);
    await app.page.getByRole('button', { name: '充值', exact: true }).click();
    await expect.poll(() => server.requestLog().filter(request => (
      request.method === 'GET'
      && request.path === '/e2e/recharge-opened'
    )).length).toBe(1);
    await expect(app.page.getByText('无法打开充值页面，请重试', {
      exact: true
    })).toHaveCount(0);
    await app.page.getByRole('button', {
      name: '充值记录', exact: true
    }).click();
    await expect(app.page.getByRole('heading', {
      name: '充值记录'
    })).toBeVisible();
    await expect(app.page.getByRole('table', {
      name: '充值记录'
    })).toBeVisible();
    await expect(app.page.getByText('PAY202608280001', {
      exact: true
    })).toBeVisible();
    await expect(app.page.getByText('已到账', { exact: true })).toBeVisible();
    await app.page.getByRole('button', { name: '返回 Agent动态' }).click();
    await app.page.getByRole('button', {
      name: '查看 打包测试 Agent'
    }).click();
    await expect(app.page.getByRole('heading', {
      name: '打包测试 Agent'
    })).toBeVisible();
    await expect(app.page.getByText('WebSearch', { exact: true })).toBeVisible();
    await expect(app.page.getByText('1.8 秒', { exact: true })).toBeVisible();
    await expect(app.page.getByText(/packaged private tool/i)).toHaveCount(0);

    await app.page.getByRole('button', {
      name: '新建会话',
      exact: true
    }).click();
    await app.page.getByRole('button', { name: '添加上下文' }).click();
    await app.page.getByRole('menuitem', { name: '连接器' }).click();
    await expect(app.page.getByText('暂无本机 MCP', { exact: true })).toBeVisible();
    await expect(app.page.getByRole('menuitem', {
      name: /客户关系管理/
    })).toHaveCount(0);
    await expect(app.page.getByRole('searchbox', {
      name: '搜索连接器'
    })).toBeVisible();
    await app.page.keyboard.press('Escape');
    await app.page.keyboard.press('Escape');

    await app.page.getByRole('button', {
      name: '连接器',
      exact: true
    }).click();
    await expect(app.page.getByRole('heading', {
      name: '连接器'
    })).toBeVisible();
    const mcpCard = app.page.locator(
      '[data-testid="mcp-card"][data-connection-key="enterprise:crm-main"]'
    );
    await expect(mcpCard.getByRole('heading', {
      name: '客户关系管理'
    })).toBeVisible();
    await expect(mcpCard.getByText('sales', { exact: true })).toBeVisible();
    await expect(mcpCard.getByText('按条件查询客户资料', { exact: true })).toBeVisible();
    await expect(mcpCard.getByText('服务正常')).toHaveCount(0);
    await mcpCard.getByRole('button', { name: '安装' }).click();
    const installedMcpCard = app.page.locator(
      '[data-testid="mcp-card"][data-connection-key="native:enterprise_crm"]'
    );
    const mcpSwitch = installedMcpCard.getByRole('switch', {
      name: '客户关系管理 MCP'
    });
    await expect(mcpSwitch).toHaveAttribute('aria-checked', 'false');
    const installedConnectionKey = await installedMcpCard.getAttribute('data-connection-key');
    if (installedConnectionKey === null || !installedConnectionKey.startsWith('native:')) {
      throw new Error('Installed enterprise MCP did not expose its native Codex server name');
    }
    const nativeMcpName = installedConnectionKey.slice('native:'.length);
    expect(nativeMcpName).toBe('enterprise_crm');
    await mcpSwitch.click();
    await expect(mcpSwitch).toHaveAttribute('aria-checked', 'true');
    const localMcpState = await app.page.evaluate(async () => {
      const response = await fetch('/.clawee/runtime/enterprise/mcp');
      return await response.json() as Record<string, unknown>;
    });
    expect(localMcpState).toMatchObject({
      tokenStatus: 'ready',
      upstreams: [{
        upstreamId: 'crm-main',
        installed: true,
        enabled: true
      }]
    });
    expect(JSON.stringify(localMcpState)).not.toMatch(/packaged-e2e-mcp-/);
    const persistedMcp = readPersistedMcpByEndpoint(
      runtimeCodexHome,
      `${origin}/mcp/servers/crm-main`
    );
    expect(persistedMcp).toMatchObject({
      enabled: true,
      http_headers: {
        Authorization: expect.stringMatching(/^Bearer packaged-e2e-mcp-/)
      }
    });
    expect(persistedMcp).not.toHaveProperty('bearer_token_env_var');

    const mcpEnabled = app;
    await closePackagedApp(mcpEnabled);
    app = await relaunchPackagedApp(mcpEnabled, 45_000);
    await waitForWorkspace(app.page);
    await app.page.getByRole('button', {
      name: '连接器',
      exact: true
    }).click();
    const persistedMcpCard = app.page.locator(
      '[data-testid="mcp-card"][data-connection-key="native:enterprise_crm"]'
    );
    await expect(persistedMcpCard.getByRole('switch', {
      name: '客户关系管理 MCP'
    })).toHaveAttribute('aria-checked', 'true');

    await app.page.getByRole('button', {
      name: '新建会话',
      exact: true
    }).click();
    const enabledMcpIcon = app.page.getByRole('button', {
      name: '打开连接器列表，客户关系管理 MCP'
    });
    await expect(enabledMcpIcon).toBeVisible();
    await enabledMcpIcon.click();
    const quickMcpSwitch = app.page.getByRole('switch', {
      name: '客户关系管理 MCP'
    });
    await expect(quickMcpSwitch).toHaveAttribute('aria-checked', 'true');
    await app.page.keyboard.press('Escape');
    await app.page.getByRole('button', { name: '添加上下文' }).click();
    await app.page.getByRole('menuitem', { name: '连接器' }).click();
    await app.page.getByRole('menuitem', {
      name: /客户关系管理.*已开启/
    }).click();
    await expect(app.page.getByRole('textbox', { name: '输入任务' })).toHaveValue(
      '使用连接器「客户关系管理」（MCP：enterprise_crm） '
    );
    await app.page.getByRole('textbox', { name: '输入任务' }).fill('');
    await enabledMcpIcon.click();
    await quickMcpSwitch.click();
    await expect(quickMcpSwitch).toHaveAttribute('aria-checked', 'false');
    const selectMoreConnectors = app.page.getByRole('button', {
      name: '选择更多连接器'
    });
    await expect(selectMoreConnectors).toBeVisible();
    await selectMoreConnectors.click();
    await expect(app.page.getByRole('heading', {
      name: '连接器',
      exact: true
    })).toBeVisible();
    await expect.poll(() => app!.page.evaluate(() => window.location.hash))
      .toBe('#/connections');

    await app.page.getByRole('button', {
      name: '数据看板',
      exact: true
    }).click();
    await expect(app.page.getByText('已采集 24 个稿件', { exact: true }))
      .toBeVisible();
    await app.page.getByRole('button', {
      name: '打开哔哩哔哩运营详情看板'
    }).click();
    await expect(app.page.getByRole('heading', { name: '哔哩哔哩运营' }))
      .toBeVisible();
    await expect(app.page.getByText('实际 App 新品内容复盘', { exact: true }))
      .toBeVisible();

    await app.page.getByRole('button', {
      name: '企业知识库',
      exact: true
    }).click();
    await expect(app.page.getByRole('heading', {
      name: '企业制度'
    })).toBeVisible();
    await expect(app.page.getByText('员工手册.pdf')).toBeVisible();
    await app.page.getByLabel('选择知识库文档').setInputFiles({
      name: '发布流程.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 发布流程')
    });
    await expect(app.page.getByText(
      '发布流程.md 已提交处理，请关注文档状态'
    )).toBeVisible();
    await expect(app.page.getByText('发布流程.md', { exact: true })).toBeVisible();

    await app.page.getByRole('button', {
      name: '企业Skill中心',
      exact: true
    }).click();
    await expect(app.page.getByRole('tab', {
      name: '企业Skills',
      selected: true
    })).toBeVisible();
    const skillRow = app.page.getByTestId('enterprise-skill-skill_enterprise_review');
    await expect(skillRow).toBeVisible();
    await expect(skillRow).toHaveAttribute('data-status', 'not_installed');
    await skillRow.getByRole('button', { name: '安装', exact: true }).click();
    await expect(skillRow).toHaveAttribute('data-status', 'installed', {
      timeout: 30_000
    });

    const installedSkillPath = join(
      runtimeCodexHome,
      'skills',
      enterpriseSkillName,
      'SKILL.md'
    );
    expect(existsSync(installedSkillPath)).toBe(true);
    expect(readFileSync(installedSkillPath, 'utf8')).toContain(
      `name: ${enterpriseSkillName}`
    );

    await skillRow.getByRole('button', { name: '使用', exact: true }).click();
    const useDialog = app.page.getByRole('dialog', { name: '选择使用项目' });
    await expect(useDialog).toBeVisible();
    await useDialog.getByRole('button', {
      name: '使用所选项目'
    }).click();
    await expect(app.page.getByLabel(
      `已选择 Skill ${enterpriseSkillName}`
    )).toBeVisible();
    await expect(app.page.getByRole('group', { name: '默认项目 会话' }).getByRole('link', {
      name: enterpriseSkillName
    })).toBeVisible();
    await expect(app.page.getByLabel('最近会话').getByRole('button', {
      name: new RegExp(enterpriseSkillName)
    })).toBeVisible();
    await expect(app.page.getByRole('textbox', { name: '输入任务' }))
      .toHaveValue('');
    await expect.poll(() => app!.page.evaluate(() => window.location.hash))
      .toMatch(/^#\/thread\//);

    await app.page.getByRole('button', {
      name: 'Packaged E2E',
      exact: true
    }).click();
    await app.page.getByRole('button', { name: '退出登录' }).click();
    await expect.poll(
      () => readEnterpriseSession(app!.page)
    ).toMatchObject({ status: 'signed_out' });
    await expect.poll(() => existsSync(credentialPath)).toBe(false);

    const loggedOut = app;
    await closePackagedApp(loggedOut);
    app = await relaunchPackagedApp(loggedOut, 45_000);
    await waitForDesktopRuntime(app.page);
    await expect.poll(
      () => readEnterpriseSession(app!.page)
    ).toMatchObject({ status: 'signed_out' });

    const requests = server.requestLog();
    const tokenExchange = requests.find(request => (
      request.method === 'POST'
      && request.path === '/api/v1/auth/dingtalk/clawee/token'
    ));
    expect(tokenExchange).toMatchObject({
      bodyKeys: [
        'agent_id',
        'client_id',
        'code',
        'code_verifier',
        'grant_type',
        'redirect_uri'
      ],
      agentId: persistedAgentId,
      clientId: 'clawee-agent',
      cookiePresent: false
    });
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/auth/methods',
        authorizationPresent: false
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/auth/dingtalk/clawee/start',
        agentId: persistedAgentId,
        authorizationPresent: false
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/auth/me',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/data-views',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/business-dashboards/bilibili-operation',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/activity/statistics',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/activity/detail',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/billing/overview',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/app/billing/recharge-session',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/billing/recharge-orders',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/skills',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/app/mcp/token/reveal',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/mcp/catalog',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/skills/detail',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/skills/package',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/knowledge-bases',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/app/knowledge-bases/documents',
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/app/knowledge-bases/documents',
        bodyKeys: ['knowledge_base_id', 'file'],
        authorizationPresent: true
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/auth/logout',
        authorizationPresent: true
      })
    ]));
  } finally {
    if (app !== undefined) {
      await app.page.evaluate(async () => {
        await fetch('/.clawee/runtime/enterprise/logout', {
          method: 'POST'
        }).catch(() => undefined);
      }).catch(() => undefined);
      await closePackagedApp(app).catch(error => {
        cleanupError ??= error;
      });
    }
    await server.close().catch(error => {
      cleanupError ??= error;
    });
    await modelServer.close().catch(error => {
      cleanupError ??= error;
    });
    if (process.env.CLAWEE_E2E_KEEP_TEMP !== '1') {
      cleanupEnterpriseFixtureRoot(root);
    }
    if (cleanupError !== undefined) {
      console.error(`企业 E2E 清理失败：runId=${runId}`);
      throw cleanupError;
    }
  }
});

function cleanupEnterpriseFixtureRoot(root: string): void {
  try {
    rmSync(root, {
      force: true,
      recursive: true,
      maxRetries: process.platform === 'win32' ? 10 : 0,
      retryDelay: 100
    });
  } catch (error) {
    if (
      process.platform === 'win32'
      && error instanceof Error
      && ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(
        (error as NodeJS.ErrnoException).code ?? ''
      )
    ) {
      console.warn(`[desktop-e2e] 企业隔离目录仍被外部进程占用，已保留：${root}`);
      return;
    }
    throw error;
  }
}

type EnterpriseRequestRecord = {
  method: string;
  path: string;
  bodyKeys: string[];
  agentId?: string;
  clientId?: string;
  authorizationPresent: boolean;
  cookiePresent: boolean;
};

class FakeEnterpriseServer {
  private server: Server | undefined;
  private origin: string | undefined;
  private readonly requests: EnterpriseRequestRecord[] = [];
  private readonly token = `packaged-e2e-${randomUUID()}`;
  private readonly mcpToken = `packaged-e2e-mcp-${randomUUID()}`;
  private agentId: string | undefined;
  private pendingDingTalkLogin: {
    agentId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    code: string;
  } | undefined;
  private uploadedKnowledgeDocument = false;
  private readonly packageBytes = createZip([{
    name: 'SKILL.md',
    data: [
      '---',
      `name: ${enterpriseSkillName}`,
      'description: Review code with the enterprise workflow.',
      '---',
      '',
      '# Enterprise Review',
      '',
      'Review the requested code and report actionable findings.',
      ''
    ].join('\n')
  }]);
  private readonly packageSha256 = createHash('sha256')
    .update(this.packageBytes)
    .digest('hex');

  constructor(private readonly modelServer: ControlledModelServer) {}

  async start(): Promise<string> {
    if (this.server !== undefined) throw new Error('Fake enterprise server started twice');
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        sendJson(response, 500, {
          error: { code: 'fake_server_failed' }
        });
      });
    });
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolveStart());
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Fake enterprise server did not expose a TCP address');
    }
    this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
  }

  requestLog(): EnterpriseRequestRecord[] {
    return this.requests.map(request => ({
      ...request,
      bodyKeys: [...request.bodyKeys]
    }));
  }

  agentIdentity(): string | undefined {
    return this.agentId;
  }

  async close(): Promise<void> {
    const current = this.server;
    this.server = undefined;
    if (current === undefined) return;
    current.closeIdleConnections();
    current.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => {
      current.close(error => {
        if (error) reject(error);
        else resolveClose();
      });
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const requestBody = await readRequestBody(request);
    const body = requestBody.json;
    const bodyKeys = isRecord(body)
      ? Object.keys(body).sort()
      : requestBody.multipartFieldNames;
    this.requests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      bodyKeys,
      ...((isRecord(body) && typeof body.agent_id === 'string')
        ? { agentId: body.agent_id }
        : typeof url.searchParams.get('agent_id') === 'string'
            && url.searchParams.get('agent_id') !== null
          ? { agentId: url.searchParams.get('agent_id')! }
        : {}),
      ...(isRecord(body) && typeof body.client_id === 'string'
        ? { clientId: body.client_id }
        : {}),
      authorizationPresent:
        typeof request.headers.authorization === 'string',
      cookiePresent: request.headers.cookie !== undefined
    });

    const publicAuthRoute =
      (request.method === 'POST' && url.pathname === '/api/v1/auth/login')
      || (request.method === 'GET' && url.pathname === '/api/v1/auth/methods')
      || (
        request.method === 'GET'
        && url.pathname === '/api/v1/auth/dingtalk/clawee/start'
      )
      || (
        request.method === 'POST'
        && url.pathname === '/api/v1/auth/dingtalk/clawee/token'
      )
      || (
        request.method === 'GET'
        && url.pathname === '/e2e/recharge-opened'
      );
    if (!publicAuthRoute && request.headers.authorization !== `Bearer ${this.token}`) {
      sendJson(response, 401, { error: { code: 'unauthorized' } });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/auth/methods') {
      sendJson(response, 200, {
        data: { password: true, dingtalk: { enabled: true } }
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/e2e/recharge-opened') {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/auth/dingtalk/clawee/start'
    ) {
      const candidate = {
        agentId: url.searchParams.get('agent_id') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        state: url.searchParams.get('state') ?? '',
        codeChallenge: url.searchParams.get('code_challenge') ?? '',
        method: url.searchParams.get('code_challenge_method') ?? ''
      };
      let redirect: URL;
      try {
        redirect = new URL(candidate.redirectUri);
      } catch {
        sendJson(response, 400, { error: { code: 'invalid_request' } });
        return;
      }
      if (
        !agentIdPattern.test(candidate.agentId)
        || !/^[A-Za-z0-9_-]{43}$/.test(candidate.state)
        || !/^[A-Za-z0-9_-]{43}$/.test(candidate.codeChallenge)
        || candidate.method !== 'S256'
        || redirect.protocol !== 'http:'
        || redirect.hostname !== '127.0.0.1'
        || redirect.pathname !== '/enterprise/dingtalk/callback'
      ) {
        sendJson(response, 400, { error: { code: 'invalid_request' } });
        return;
      }
      const code = randomBytes(32).toString('base64url');
      this.agentId = candidate.agentId;
      this.pendingDingTalkLogin = {
        agentId: candidate.agentId,
        redirectUri: candidate.redirectUri,
        state: candidate.state,
        codeChallenge: candidate.codeChallenge,
        code
      };
      redirect.search = new URLSearchParams({
        code,
        state: candidate.state
      }).toString();
      response.statusCode = 302;
      response.setHeader('location', redirect.toString());
      response.setHeader('cache-control', 'no-store');
      response.end();
      return;
    }

    if (
      request.method === 'POST'
      && url.pathname === '/api/v1/auth/dingtalk/clawee/token'
    ) {
      const pending = this.pendingDingTalkLogin;
      this.pendingDingTalkLogin = undefined;
      if (
        pending === undefined
        || !isRecord(body)
        || body.grant_type !== 'authorization_code'
        || body.client_id !== 'clawee-agent'
        || body.agent_id !== pending.agentId
        || body.code !== pending.code
        || body.redirect_uri !== pending.redirectUri
        || typeof body.code_verifier !== 'string'
        || createHash('sha256')
          .update(body.code_verifier, 'ascii')
          .digest('base64url') !== pending.codeChallenge
      ) {
        sendJson(response, 400, { error: { code: 'invalid_grant' } });
        return;
      }
      sendJson(response, 200, {
        data: {
          account: enterpriseAccount(),
          agent: enterpriseAgent(pending.agentId),
          access_token: this.token,
          token_type: 'Bearer',
          expires_at: '2099-07-30T12:00:00.000Z'
        }
      });
      return;
    }

    if (
      request.method === 'POST'
      && url.pathname === '/api/v1/auth/login'
    ) {
      if (
        !isRecord(body)
        || body.email !== enterpriseEmail
        || body.password !== enterprisePassword
        || body.client_id !== 'clawee-agent'
        || typeof body.agent_id !== 'string'
        || !agentIdPattern.test(body.agent_id)
      ) {
        sendJson(response, 401, { error: { code: 'unauthorized' } });
        return;
      }
      this.agentId = body.agent_id;
      sendJson(response, 200, {
        data: {
          account: enterpriseAccount(),
          agent: enterpriseAgent(this.agentId),
          access_token: this.token,
          token_type: 'Bearer',
          expires_at: '2099-07-30T12:00:00.000Z'
        }
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/auth/me') {
      sendJson(response, 200, {
        data: {
          account: enterpriseAccount(),
          agent: enterpriseAgent(this.requireAgentId()),
          applications: { frontend: true }
        }
      });
      return;
    }

    if (
      request.method === 'POST'
      && url.pathname === '/api/v1/app/agent-activity/events'
    ) {
      sendJson(response, 200, {
        data: {
          accepted: true,
          received_events: isRecord(body) && Array.isArray(body.events)
            ? body.events.length
            : 0,
          server_time: new Date().toISOString()
        }
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (
      request.method === 'POST'
      && url.pathname === '/api/v1/app/model-configuration'
    ) {
      sendJson(response, 200, {
        data: {
          mode: 'platform_managed',
          base_url: `${this.modelServer.origin}/v1`,
          model: 'clawee-e2e-model',
          api_key: CONTROLLED_MODEL_API_KEY,
          credential_version: 1
        }
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/data-views'
    ) {
      if (url.searchParams.size !== 0) {
        sendJson(response, 400, { error: { code: 'invalid_request' } });
        return;
      }
      sendJson(response, 200, {
        data: [{
          view_id: 'agent_activity',
          actions: ['read']
        }]
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/business-data-sources/bilibili'
    ) {
      sendJson(response, 200, {
        data: { items: [{ source_id: 'bdsrc_packaged', status: 'active' }] }
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/business-dashboards/bilibili-operation'
    ) {
      if (
        url.searchParams.get('range') !== '7d'
        || url.searchParams.get('source_id') !== 'bdsrc_packaged'
        || url.searchParams.size !== 2
      ) {
        sendJson(response, 400, { error: { code: 'invalid_request' } });
        return;
      }
      sendJson(response, 200, {
        data: {
          status: 'available',
          data: {
            captured_at: '2026-08-30T01:30:00.000Z',
            follower_count: 128600,
            collected_content_count: 24,
            view_count: 8650000,
            interaction_count: 316800,
            top_contents: [{
              external_content_id: 'BV1packaged',
              title: '实际 App 新品内容复盘',
              captured_at: '2026-08-30T01:20:00.000Z',
              view_count: 680000,
              interaction_count: 28600
            }]
          }
        }
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/activity/statistics'
    ) {
      if (
        url.searchParams.size !== 1
        || url.searchParams.get('range') !== '7d'
      ) {
        sendJson(response, 400, {
          error: { code: 'invalid_activity_range' }
        });
        return;
      }
      sendJson(response, 200, enterpriseActivityStatisticsPayload());
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/activity/detail'
    ) {
      if (
        url.searchParams.size !== 2
        || url.searchParams.get('collector_id') !== 'collector-packaged'
        || url.searchParams.get('agent_id') !== 'agent-packaged'
      ) {
        sendJson(response, 404, { error: { code: 'not_found' } });
        return;
      }
      sendJson(response, 200, enterpriseActivityDetailPayload());
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/billing/overview'
    ) {
      if (
        url.searchParams.size !== 1
        || url.searchParams.get('range') !== '7d'
      ) {
        sendJson(response, 400, { error: { code: 'invalid_range' } });
        return;
      }
      sendJson(response, 200, {
        data: {
          currency: 'CNY',
          balance_cny: 256.5,
          generated_at: '2026-08-28T10:00:00+08:00'
        }
      });
      return;
    }

    if (
      request.method === 'POST'
      && url.pathname === '/api/v1/app/billing/recharge-session'
    ) {
      if (this.origin === undefined) {
        throw new Error('Fake enterprise server origin is unavailable');
      }
      const rechargeUrl = new URL('https://recharge.clawee.test/checkout');
      rechargeUrl.searchParams.set(
        'e2e_callback',
        `${this.origin}/e2e/recharge-opened`
      );
      sendJson(response, 200, {
        data: {
          recharge_url: rechargeUrl.toString(),
          expires_at: '2099-08-28T10:10:00+08:00'
        }
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/billing/recharge-orders'
    ) {
      if (
        url.searchParams.size !== 2
        || url.searchParams.get('page') !== '1'
        || url.searchParams.get('page_size') !== '20'
      ) {
        sendJson(response, 400, { error: { code: 'invalid_pagination' } });
        return;
      }
      sendJson(response, 200, {
        data: {
          items: [{
            order_no: 'PAY202608280001',
            amount_cents: 10_000,
            currency: 'CNY',
            channel: 'alipay',
            status: 'succeeded',
            payment_status: 'paid',
            fulfillment_status: 'succeeded',
            created_at: '2026-08-28T10:00:00+08:00',
            paid_at: '2026-08-28T10:01:00+08:00',
            fulfilled_at: '2026-08-28T10:01:05+08:00'
          }],
          page: 1,
          page_size: 20,
          total: 1
        }
      });
      return;
    }

    if (
      request.method === 'POST'
      && url.pathname === '/api/v1/app/mcp/token/reveal'
    ) {
      sendJson(response, 200, {
        data: {
          token: this.mcpToken,
          authorization_header: `Authorization: Bearer ${this.mcpToken}`,
          token_info: {
            user_id: enterpriseAccountId,
            token_id: 'token_packaged_e2e',
            token_fingerprint: createHash('sha256')
              .update(this.mcpToken)
              .digest('hex'),
            token_status: 'active',
            token_expires_at: null,
            token_scopes: ['mcp:call'],
            created_at: '2026-08-07T08:00:00.000Z'
          }
        }
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/mcp/catalog'
    ) {
      sendJson(response, 200, {
        data: {
          upstreams: [{
            id: 'crm-main',
            name: '客户关系管理',
            domain: 'sales',
            mcp_endpoint:
              `http://${request.headers.host ?? '127.0.0.1'}/mcp/servers/crm-main`,
            upstream_transport: 'streamable_http',
            namespace: 'crm',
            status: 'active',
            tools: [{
              id: 'cap_customer_search',
              upstream_name: 'customer.search',
              name: 'customer.search',
              exposed_name: 'crm.customer.search',
              title: '查询客户',
              description: '按条件查询客户资料',
              risk_level: 'low',
              confirm_required: false,
              status: 'active',
              authorized: true,
              authorization_expires_at: null
            }, {
              id: 'cap_customer_update',
              upstream_name: 'customer.update',
              name: 'customer.update',
              exposed_name: 'crm.customer.update',
              title: '更新客户',
              description: '更新客户资料',
              risk_level: 'medium',
              confirm_required: true,
              status: 'active',
              authorized: false,
              authorization_expires_at: null
            }]
          }]
        }
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/knowledge-bases'
    ) {
      sendJson(response, 200, {
        data: [this.remoteKnowledgeBase()],
        meta: { next_cursor: '', has_next: false }
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/knowledge-bases/documents'
      && url.searchParams.get('knowledge_base_id') === enterpriseKnowledgeBaseId
    ) {
      sendJson(response, 200, {
        data: [
          this.remoteKnowledgeDocument(),
          ...(this.uploadedKnowledgeDocument
            ? [this.remoteUploadedKnowledgeDocument()]
            : [])
        ],
        meta: { next_cursor: '', has_next: false }
      });
      return;
    }

    if (
      request.method === 'POST'
      && url.pathname === '/api/v1/app/knowledge-bases/documents'
    ) {
      if (
        requestBody.multipartFieldNames.join(',') !== 'knowledge_base_id,file'
        || !requestBody.raw.includes(Buffer.from(enterpriseKnowledgeBaseId))
        || !requestBody.raw.includes(Buffer.from('发布流程.md'))
      ) {
        sendJson(response, 400, {
          error: { code: 'invalid_knowledge_upload' }
        });
        return;
      }
      this.uploadedKnowledgeDocument = true;
      sendJson(response, 201, {
        data: this.remoteUploadedKnowledgeDocument()
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/app/skills') {
      sendJson(response, 200, { data: [this.remoteSkill()] });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/skills/detail'
      && url.searchParams.get('skill_id') === 'skill_enterprise_review'
    ) {
      sendJson(response, 200, {
        data: {
          ...this.remoteSkill(),
          changelog: 'Initial packaged E2E release.'
        }
      });
      return;
    }

    if (
      request.method === 'GET'
      && url.pathname === '/api/v1/app/skills/package'
      && url.searchParams.get('skill_id') === 'skill_enterprise_review'
      && url.searchParams.get('version_id') === 'version_1'
    ) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Length', String(this.packageBytes.byteLength));
      response.end(this.packageBytes);
      return;
    }

    sendJson(response, 404, { error: { code: 'not_found' } });
  }

  private remoteSkill() {
    return {
      skill_id: 'skill_enterprise_review',
      name: enterpriseSkillName,
      description: 'Enterprise review workflow',
      version_id: 'version_1',
      version: '1.0.0',
      package_sha256: this.packageSha256,
      updated_at: '2026-07-30T12:00:00.000Z'
    };
  }

  private remoteKnowledgeBase() {
    return {
      knowledge_base_id: enterpriseKnowledgeBaseId,
      name: '企业制度',
      description: '公司制度和员工手册',
      status: 'active',
      document_count: this.uploadedKnowledgeDocument ? 2 : 1,
      permissions: {
        read: true,
        upload: true,
        search: false
      }
    };
  }

  private remoteKnowledgeDocument() {
    return {
      document_id: 'doc_packaged_handbook',
      knowledge_base_id: enterpriseKnowledgeBaseId,
      name: '员工手册.pdf',
      size_bytes: 102400,
      mime_type: 'application/pdf',
      status: 'ready',
      error_message: '',
      uploaded_by: enterpriseEmail,
      created_at: '2026-08-04T08:00:00.000Z',
      updated_at: '2026-08-04T08:01:00.000Z'
    };
  }

  private remoteUploadedKnowledgeDocument() {
    return {
      document_id: 'doc_packaged_release',
      knowledge_base_id: enterpriseKnowledgeBaseId,
      name: '发布流程.md',
      size_bytes: Buffer.byteLength('# 发布流程'),
      mime_type: 'text/markdown',
      status: 'processing',
      error_message: '',
      uploaded_by: enterpriseEmail,
      created_at: '2026-08-05T08:00:00.000Z',
      updated_at: '2026-08-05T08:00:00.000Z'
    };
  }

  private requireAgentId(): string {
    if (this.agentId === undefined) {
      throw new Error('Fake enterprise session has no agent identity');
    }
    return this.agentId;
  }
}

function enterpriseActivityStatisticsPayload() {
  return {
    data: {
      range: '7d',
      timezone: 'Asia/Shanghai',
      start_date: '2026-08-12',
      end_date: '2026-08-18',
      generated_at: '2026-08-18T08:00:00.000Z',
      organization: {
        usage: {
          input_tokens: 18_279_996,
          cached_input_tokens: 16_894_080,
          output_tokens: 116_251,
          total_tokens: 18_396_247
        },
        active_employees: 3,
        active_agents: 1,
        completed_turns: 42,
        mcp_distribution: [{
          id: 'filesystem',
          label: 'filesystem',
          invocation_count: 18,
          share: 0.6
        }]
      },
      trend: {
        granularity: 'day',
        points: [{
          bucket_start: '2026-08-18T00:00:00+08:00',
          input_tokens: 1_000,
          cached_input_tokens: 600,
          output_tokens: 200,
          total_tokens: 1_200
        }]
      },
      model_distribution: [{
        model: 'gpt-5.6-sol',
        requests: 20,
        input_tokens: 1_000,
        cached_input_tokens: 600,
        output_tokens: 200,
        total_tokens: 1_200,
        share: 0.8
      }],
      token_usage_ranking: [{
        rank: 1,
        name: 'Packaged E2E',
        requests: 20,
        total_tokens: 18_396_247
      }],
      agents: [{
        collector_id: 'collector-packaged',
        agent_id: 'agent-packaged',
        name: '打包测试 Agent',
        status: 'online',
        session_count: 4,
        turn_count: 12,
        last_activity_at: '2026-08-18T07:59:00.000Z'
      }],
      data_status: {
        sub2api: 'available',
        activity: 'available'
      }
    }
  };
}

function enterpriseActivityDetailPayload() {
  return {
    schema_version: 'office.v1',
    server_time: '2026-08-18T08:00:00.000Z',
    agent: {
      collector_id: 'collector-packaged',
      agent_id: 'agent-packaged',
      display_name: '打包测试 Agent',
      agent_type: 'clawee',
      workspace_name: '默认项目',
      status: 'online',
      sessions: [],
      sub_agents: {
        active_count: 1,
        total_count: 1,
        preview: []
      },
      recent_tool_calls: 1,
      last_seen_at: '2026-08-18T07:59:00.000Z',
      updated_at: '2026-08-18T07:59:00.000Z'
    },
    sessions: [{
      session_id: 'session-packaged',
      title: '企业资料调研',
      status: 'active',
      summary: '整理公开资料',
      workspace_name: '默认项目',
      started_at: '2026-08-18T07:00:00.000Z',
      duration_ms: 3_600_000
    }],
    turns: [{
      turn_id: 'turn-packaged',
      session_id: 'session-packaged',
      title: '资料汇总',
      status: 'completed',
      prompt_summary: '整理本周公开资料',
      user_prompt: 'packaged private user prompt',
      assistant_summary: '已形成摘要',
      last_assistant_message: 'packaged private assistant response',
      model: 'gpt-5.6-sol',
      started_at: '2026-08-18T07:10:00.000Z'
    }],
    sub_agents: [{
      sub_agent_id: 'sub-packaged',
      name: '网页检索',
      status: 'completed',
      completed_turns: 3
    }],
    tool_calls: [{
      tool_call_id: 'tool-packaged',
      tool_name: 'WebSearch',
      tool_type: 'mcp',
      status: 'success',
      timestamp: '2026-08-18T07:20:00.000Z',
      duration_ms: 1_800,
      input: 'packaged private tool input',
      response: 'packaged private tool response',
      response_text: 'packaged private response text'
    }],
    status_timeline: [],
    recent_activities: [{
      activity_id: 'activity-packaged',
      type: 'turn',
      title: '完成资料汇总',
      status: 'completed',
      occurred_at: '2026-08-18T07:30:00.000Z'
    }],
    stats: {
      session_duration_ms: 3_600_000,
      active_sub_agents: 1,
      total_sub_agents: 1,
      recent_activity_count: 1,
      business_risk_level: 'unknown',
      active_sessions: 1,
      active_work_ms: 180_000,
      tool_type_variety: 1,
      tool_call_count: 1
    }
  };
}

async function waitForWorkspace(page: Page): Promise<void> {
  await waitForDesktopRuntime(page);
  await expect.poll(async () => await page.evaluate(async () => {
    const response = await fetch('/.clawee/runtime/healthz');
    if (!response.ok) return undefined;
    const health = await response.json() as { runtimeState?: string };
    return health.runtimeState;
  }), { timeout: 30_000 }).toBe('ready');
  await expect(page.getByRole('status', {
    name: '本地运行内核正常'
  })).toBeVisible();
}

async function waitForDesktopRuntime(page: Page): Promise<void> {
  await page.waitForURL(url => (
    url.protocol === 'clawee-app:' && url.hostname === 'app'
  ), { timeout: 45_000 });
  await expect.poll(async () => await page.evaluate(async () => (
    await window.claweeDesktop?.readBootstrapState()
  )?.phase), { timeout: 30_000 }).toBe('ready');
}

async function readEnterpriseSession(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(async () => {
    const response = await fetch('/.clawee/runtime/enterprise/session');
    return await response.json() as Record<string, unknown>;
  });
}

function writeCodexShim(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const scriptPath = process.platform === 'win32'
    ? join(binDir, 'codex.cmd')
    : join(binDir, 'codex');
  writeFileSync(
    scriptPath,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexScript}" "$@"\n`
  );
  if (process.platform !== 'win32') chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeDesktopSettings(userData: string, codexBin: string): void {
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    join(userData, 'desktop-settings.json'),
    `${JSON.stringify({
      closeBehavior: 'quit',
      notificationsEnabled: false,
      codexBin,
      successfulCodexBin: codexBin
    }, null, 2)}\n`
  );
}

function withoutElectronRunAsNode(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  delete next.CLAWEE_UPDATE_URL;
  delete next.CLAWEE_ENTERPRISE_E2E_AUTHORIZED;
  delete next.CLAWEE_ENTERPRISE_KEYRING_SERVICE;
  delete next.CLAWEE_ENTERPRISE_KEYRING_ACCOUNT;
  return next;
}

function writeEnterpriseClientConfig(
  homeDir: string,
  gateway: string
): void {
  const claweeHome = join(homeDir, '.clawee');
  mkdirSync(claweeHome, { recursive: true });
  writeFileSync(
    join(claweeHome, 'config.toml'),
    `gateway = ${JSON.stringify(gateway)}\n`
  );
}

async function readRequestBody(request: IncomingMessage): Promise<{
  raw: Buffer;
  json?: unknown;
  multipartFieldNames: string[];
}> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 1024 * 1024) throw new Error('Fake request body too large');
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks);
  const contentType = request.headers['content-type'] ?? '';
  if (raw.length === 0) {
    return { raw, multipartFieldNames: [] };
  }
  if (contentType.startsWith('application/json')) {
    return {
      raw,
      json: JSON.parse(raw.toString('utf8')) as unknown,
      multipartFieldNames: []
    };
  }
  if (contentType.startsWith('multipart/form-data')) {
    return {
      raw,
      multipartFieldNames: Array.from(
        raw.toString('utf8').matchAll(
          /content-disposition:\s*form-data;\s*name="([^"]+)"/gi
        ),
        match => match[1]!
      )
    };
  }
  return { raw, multipartFieldNames: [] };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  const contents = Buffer.from(JSON.stringify(body));
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Content-Length', String(contents.byteLength));
  response.end(contents);
}

function enterpriseAccount() {
  return {
    account_id: enterpriseAccountId,
    email: enterpriseEmail,
    name: 'Packaged E2E',
    status: 'active'
  };
}

function enterpriseAgent(agentId: string) {
  return {
    agent_id: agentId,
    name: 'Packaged E2E'
  };
}

function readPersistedAgentId(homeDir: string): string {
  const path = join(homeDir, '.clawee', 'config.toml');
  const value: unknown = parse(readFileSync(path, 'utf8'));
  if (
    !isRecord(value)
    || typeof value.agent_id !== 'string'
  ) {
    throw new Error(`Invalid persisted enterprise agent identity: ${path}`);
  }
  return value.agent_id;
}

async function readRuntimeCodexHome(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const response = await fetch('/.clawee/runtime/codex/status');
    if (!response.ok) {
      throw new Error(`Codex status failed: ${response.status}`);
    }
    const status = await response.json() as CodexStatusResponse;
    return status.runtime.homePath;
  });
}

function readPersistedMcpByEndpoint(
  codexHome: string,
  endpoint: string
): Record<string, unknown> {
  const path = join(codexHome, 'config.toml');
  const value: unknown = parse(readFileSync(path, 'utf8'));
  if (!isRecord(value) || !isRecord(value.mcp_servers)) {
    throw new Error('Codex config does not contain MCP servers');
  }
  const server = Object.values(value.mcp_servers)
    .find(candidate => isRecord(candidate) && candidate.url === endpoint);
  if (!isRecord(server)) {
    throw new Error(`Codex config does not contain MCP endpoint: ${endpoint}`);
  }
  return server;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ZipEntryInput = {
  name: string;
  data: string;
};

function createZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
