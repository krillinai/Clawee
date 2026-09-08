import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  join,
  resolve
} from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CodexStatusResponse,
  RunResponse
} from '@clawee/protocol';
import {
  expect,
  type Page
} from '@playwright/test';
import {
  createCodexSessionIndexRepository
} from '../../daemon/src/codex/sessions/index-repository.js';
import {
  createCodexSessionIndexer
} from '../../daemon/src/codex/sessions/indexer.js';
import {
  resolvePrivateCredentialFilePath
} from '../../daemon/src/security/private-credential-file.js';
import { openRuntimeDatabase } from '../../daemon/src/storage/database.js';
import {
  createProjectRepository,
  createThreadRepository
} from '../../daemon/src/storage/repositories.js';
import {
  desktopE2EEnterpriseEmail,
  desktopE2EEnterprisePassword,
  FakeEnterpriseAuthServer,
  writeEnterpriseE2EConfig
} from './fake-enterprise-auth-2026-08-06.js';
import {
  packagedExecutable,
  packagedPackageRoot,
  packagedResourcesRoot,
  readDesktopPackageVersion,
  readDesktopBuildManifest,
  type DesktopBuildManifest
} from './package-artifact.js';
import {
  launchPackagedApp,
  relaunchPackagedApp,
  type PackagedApp
} from './packaged-app.js';
import {
  CONTROLLED_MODEL_API_KEY,
  ControlledModelServer
} from './controlled-model-server.js';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(e2eDir, '..');

export type LegacyRuntimeThread = {
  claweeThreadId: string;
  codexThreadId: string;
  title: string;
  rolloutRelativePath: string;
  sourceContents: string;
};

export type EmbeddedRuntimeFixture = {
  root: string;
  home: string;
  userData: string;
  dataDir: string;
  sourceHome: string;
  legacyRuntimeHome: string;
  targetHome: string;
  claweeConfigPath: string;
  workspace: string;
  newWorkspace: string;
  packageRoot: string;
  resourcesRoot: string;
  appVersion: string;
  hostileCodexPath: string;
  hostileSentinelPath: string;
  manifest: DesktopBuildManifest;
  legacyThreads: LegacyRuntimeThread[];
  modelServer: ControlledModelServer;
  launch(): Promise<PackagedApp>;
  relaunch(app: PackagedApp): Promise<PackagedApp>;
  writeControlledRuntimeConfig(): void;
  writeLegacyControlledRuntimeConfig(): void;
  hostileCodexWasUsed(): boolean;
  sourceRolloutsAreUnchanged(): boolean;
  targetRolloutPaths(): string[];
  dispose(): Promise<void>;
};

export async function createEmbeddedRuntimeFixture(input: {
  legacyThreadCount?: number;
} = {}): Promise<EmbeddedRuntimeFixture> {
  const manifest = readDesktopBuildManifest(desktopDir);
  const fixtureBase = embeddedRuntimeFixtureBase();
  mkdirSync(fixtureBase, { recursive: true });
  const root = mkdtempSync(join(
    fixtureBase,
    'clawee-embedded-runtime-e2e-'
  ));
  const home = join(root, 'home');
  const userData = join(root, 'user-data');
  const dataDir = join(userData, 'daemon');
  const sourceHome = join(home, '.codex');
  const targetHome = join(home, '.clawee', 'codex');
  const legacyRuntimeHome = join(
    targetHome,
    'homes',
    manifest.codexRuntimeId
  );
  const claweeConfigPath = join(home, '.clawee', 'config.toml');
  const workspace = join(root, 'workspace');
  const newWorkspace = join(root, 'new-workspace');
  const hostileBin = join(root, 'hostile-bin');
  const hostileSentinelPath = join(root, 'hostile-codex-invoked.txt');
  const enterpriseConfigPath = join(root, 'enterprise', 'config.toml');
  const modelServer = new ControlledModelServer();
  const enterpriseServer = new FakeEnterpriseAuthServer();
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(newWorkspace, { recursive: true });
  console.log(`[desktop-e2e] Runtime fixture：${root}`);
  const hostileCodexPath = writeHostileCodex(
    hostileBin,
    hostileSentinelPath
  );

  try {
    const [modelOrigin, enterpriseOrigin] = await Promise.all([
      modelServer.start(),
      enterpriseServer.start()
    ]);
    enterpriseServer.setModelOrigin(modelOrigin);
    writeEnterpriseE2EConfig(enterpriseConfigPath, enterpriseOrigin);
    const legacyThreads = createLegacyThreads({
      count: input.legacyThreadCount ?? 0,
      sourceHome,
      dataDir,
      workspace
    });
    const enterpriseRunId = randomUUID();
    const executablePath = packagedExecutable(desktopDir);
    const packageRoot = packagedPackageRoot(desktopDir);
    const resourcesRoot = packagedResourcesRoot(desktopDir);
    const appVersion = readDesktopPackageVersion(desktopDir);
    const args = [
      `--user-data-dir=${userData}`,
      '--disable-gpu',
      `--clawee-enterprise-e2e=${enterpriseRunId}`,
      `--clawee-enterprise-e2e-config=${enterpriseConfigPath}`,
      `--clawee-enterprise-e2e-home=${home}`
    ];
    const env = packagedRuntimeEnvironment({
      home,
      workspace,
      hostileBin,
      hostileCodexPath,
      modelOrigin,
      enterpriseRunId
    });

    return {
      root,
      home,
      userData,
      dataDir,
      sourceHome,
      legacyRuntimeHome,
      targetHome,
      claweeConfigPath,
      workspace,
      newWorkspace,
      packageRoot,
      resourcesRoot,
      appVersion,
      hostileCodexPath,
      hostileSentinelPath,
      manifest,
      legacyThreads,
      modelServer,
      async launch() {
        return await launchPackagedApp({
          executablePath,
          args,
          env,
          timeoutMs: 45_000
        });
      },
      async relaunch(app) {
        return await relaunchPackagedApp(app, 45_000);
      },
      writeControlledRuntimeConfig() {
        writeControlledRuntimeConfig({
          targetHome,
          dataDir,
          modelOrigin,
          e2eRunId: enterpriseRunId
        });
      },
      writeLegacyControlledRuntimeConfig() {
        writeLegacyControlledRuntimeConfig({
          home,
          dataDir,
          legacyRuntimeHome,
          resourcesRoot,
          manifest,
          modelOrigin,
          e2eRunId: enterpriseRunId
        });
      },
      hostileCodexWasUsed() {
        return existsSync(hostileSentinelPath);
      },
      sourceRolloutsAreUnchanged() {
        return legacyThreads.every(thread => (
          readFileSync(
            join(sourceHome, ...thread.rolloutRelativePath.split('/')),
            'utf8'
          ) === thread.sourceContents
        ));
      },
      targetRolloutPaths() {
        return findFiles(targetHome, '.jsonl');
      },
      async dispose() {
        await Promise.all([
          modelServer.close(),
          enterpriseServer.close()
        ]);
        if (process.env.CLAWEE_E2E_KEEP_TEMP !== '1') {
          cleanupEmbeddedRuntimeFixture(root);
        }
      }
    };
  } catch (error) {
    await Promise.all([
      modelServer.close().catch(() => undefined),
      enterpriseServer.close().catch(() => undefined)
    ]);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function waitForEmbeddedRuntimeReady(
  page: Page,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown;
  while (Date.now() < deadline) {
    lastState = await page.evaluate(
      () => window.claweeDesktop?.readBootstrapState()
    ).catch(() => undefined);
    const state = await lastState;
    if (
      state?.phase === 'ready'
      && new URL(page.url()).protocol === 'clawee-app:'
      && new URL(page.url()).hostname === 'app'
    ) {
      return;
    }
    if (state?.phase === 'failed') {
      throw new Error(
        `Desktop Runtime 启动失败：${JSON.stringify(state.error ?? state)}`
      );
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `等待 Desktop Runtime 就绪超时（${timeoutMs}ms）：`
    + `url=${page.url()} state=${JSON.stringify(lastState)}`
  );
}

export async function ensureEmbeddedWorkspaceSignedIn(
  page: Page
): Promise<void> {
  await ensureEmbeddedEnterpriseSignedIn(page);
  await expect(page.locator('.clawee-shell')).toBeVisible({
    timeout: 60_000
  });
}

export async function ensureEmbeddedEnterpriseSignedIn(
  page: Page
): Promise<void> {
  await waitForEmbeddedRuntimeReady(page);
  await expect.poll(async () => (
    await runtimeRequest<{ status?: string }>(
      page,
      'GET',
      '/enterprise/session'
    )
  ).body.status).toMatch(/^(signed_in|signed_out)$/);
  const session = await runtimeRequest<{ status?: string }>(
    page,
    'GET',
    '/enterprise/session'
  );
  if (session.body.status === 'signed_out') {
    await expect(page.getByRole('heading', {
      name: '欢迎使用 Clawee'
    })).toBeVisible();
    await page.getByLabel('邮箱').fill(desktopE2EEnterpriseEmail);
    await page.getByLabel('密码').fill(desktopE2EEnterprisePassword);
    await page.getByRole('checkbox').check();
    await page.locator('.enterprise-email-submit').click();
  }
  await expect.poll(async () => (
    await runtimeRequest<{ status?: string }>(
      page,
      'GET',
      '/enterprise/session'
    )
  ).body.status).toBe('signed_in');
}

export async function runtimeRequest<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  return await page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(`/.clawee/runtime${path}`, {
      method,
      headers: body === undefined
        ? undefined
        : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return {
      status: response.status,
      body: await response.json() as T
    };
  }, { method, path, body });
}

export async function readCodexStatus(
  page: Page
): Promise<CodexStatusResponse> {
  const response = await runtimeRequest<CodexStatusResponse>(
    page,
    'GET',
    '/codex/status'
  );
  if (response.status !== 200) {
    throw new Error(`读取 Codex 状态失败：HTTP ${response.status}`);
  }
  return response.body;
}

export async function waitForAvailabilityProbe(
  page: Page,
  timeoutMs = 60_000
): Promise<NonNullable<CodexStatusResponse['availabilityProbe']>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readCodexStatus(page);
    if (
      status.availabilityProbe !== undefined
      && status.availabilityProbe.status !== 'pending'
    ) {
      return status.availabilityProbe;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`等待 Codex 后台可用性验证超时（${timeoutMs}ms）`);
}

export async function waitForRunTerminal(
  page: Page,
  runId: string,
  timeoutMs = 90_000
): Promise<RunResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await runtimeRequest<RunResponse>(
      page,
      'GET',
      `/runs/${encodeURIComponent(runId)}`
    );
    if (response.status !== 200) {
      throw new Error(
        `读取运行 ${runId} 失败：HTTP ${response.status}`
      );
    }
    if (
      response.body.status === 'succeeded'
      || response.body.status === 'failed'
      || response.body.status === 'canceled'
    ) {
      return response.body;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`等待运行完成超时：${runId}`);
}

export function writeDesktopE2EReport(
  filename: string,
  report: Record<string, unknown>
): string {
  const reportDir = resolve(desktopDir, '../../test-results');
  mkdirSync(reportDir, { recursive: true });
  const path = join(reportDir, filename);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function createLegacyThreads(input: {
  count: number;
  sourceHome: string;
  dataDir: string;
  workspace: string;
}): LegacyRuntimeThread[] {
  if (input.count === 0) return [];
  mkdirSync(input.sourceHome, { recursive: true, mode: 0o700 });
  const database = openRuntimeDatabase(join(input.dataDir, 'app.sqlite'));
  try {
    const projects = createProjectRepository(database);
    const threads = createThreadRepository(database);
    const canonicalWorkspace = realpathSync(input.workspace);
    projects.insertProject({
      id: 'legacy-project',
      name: '迁移前项目',
      cwd: input.workspace,
      canonicalCwd: canonicalWorkspace,
      profile: 'default',
      sandbox: 'read-only'
    });
    const legacyThreads = Array.from(
      { length: input.count },
      (_, index): LegacyRuntimeThread => {
        const codexThreadId = randomUUID();
        const claweeThreadId = `legacy-thread-${index + 1}`;
        const title = `迁移前会话 ${index + 1}`;
        threads.insertThread({
          id: claweeThreadId,
          title,
          projectId: 'legacy-project',
          cwd: input.workspace,
          canonicalCwd: canonicalWorkspace,
          workspaceMode: 'external',
          profile: 'default',
          sandbox: 'read-only',
          status: 'active'
        });
        threads.setCodexThreadId(claweeThreadId, codexThreadId);
        const rolloutRelativePath = [
          'sessions',
          '2026',
          '08',
          '20',
          `rollout-2026-08-20T10-00-0${index}-${codexThreadId}.jsonl`
        ].join('/');
        const sourceContents = rolloutContents({
          codexThreadId,
          workspace: input.workspace,
          title,
          second: index
        });
        const path = join(
          input.sourceHome,
          ...rolloutRelativePath.split('/')
        );
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, sourceContents, 'utf8');
        return {
          claweeThreadId,
          codexThreadId,
          title,
          rolloutRelativePath,
          sourceContents
        };
      }
    );
    createCodexSessionIndexer({
      codexHome: input.sourceHome,
      repository: createCodexSessionIndexRepository(database),
      collections: ['sessions', 'archived_sessions']
    }).sync();
    return legacyThreads;
  } finally {
    database.close();
  }
}

function rolloutContents(input: {
  codexThreadId: string;
  workspace: string;
  title: string;
  second: number;
}): string {
  const timestamp =
    `2026-08-20T10:00:0${input.second}.000Z`;
  return [
    JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: {
        session_id: input.codexThreadId,
        id: input.codexThreadId,
        timestamp,
        cwd: input.workspace,
        originator: 'codex',
        cli_version: '0.151.0',
        source: 'cli',
        model_provider: 'clawee',
        history_mode: 'legacy'
      }
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: input.title
        }]
      }
    }),
    JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: input.title,
        kind: 'plain'
      }
    }),
    ''
  ].join('\n');
}

export function writeControlledRuntimeConfig(
  input: {
    targetHome: string;
    dataDir: string;
    modelOrigin: string;
    e2eRunId: string;
  }
): void {
  mkdirSync(input.targetHome, { recursive: true, mode: 0o700 });
  mkdirSync(input.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(input.targetHome, 'config.toml'), [
    'model = "clawee-e2e-model"',
    'model_provider = "clawee"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'check_for_update_on_startup = false',
    '',
    '[agents]',
    'enabled = false',
    '',
    '[features]',
    'multi_agent = false',
    'multi_agent_v2 = false',
    '',
    '[model_providers.clawee]',
    'name = "Clawee"',
    `base_url = "${input.modelOrigin}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'env_key = "CLAWEE_MODEL_API_KEY"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    ''
  ].join('\n'), { mode: 0o600 });
  const credentialPath = resolvePrivateCredentialFilePath({
    dataDir: input.dataDir,
    e2eRunId: input.e2eRunId
  });
  mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
  writeFileSync(credentialPath, `${JSON.stringify({
    schemaVersion: 1,
    modelService: {
      apiKey: CONTROLLED_MODEL_API_KEY
    }
  }, null, 2)}\n`, { mode: 0o600 });
}

function writeLegacyControlledRuntimeConfig(input: {
  home: string;
  dataDir: string;
  legacyRuntimeHome: string;
  resourcesRoot: string;
  manifest: DesktopBuildManifest;
  modelOrigin: string;
  e2eRunId: string;
}): void {
  const minimumClaweeVersion = readRuntimeMinimumClaweeVersion(
    input.resourcesRoot
  );
  writeControlledRuntimeConfig({
    targetHome: input.legacyRuntimeHome,
    dataDir: input.dataDir,
    modelOrigin: input.modelOrigin,
    e2eRunId: input.e2eRunId
  });
  writeFileSync(join(input.legacyRuntimeHome, 'config.toml'), [
    readFileSync(join(input.legacyRuntimeHome, 'config.toml'), 'utf8').trimEnd(),
    '',
    '[mcp_servers.relocation_probe]',
    'command = "node"',
    'args = ["--version"]',
    'enabled = false',
    ''
  ].join('\n'), { mode: 0o600 });
  writeFixtureFile(
    join(input.legacyRuntimeHome, 'skills', 'relocation-probe', 'SKILL.md'),
    [
      '---',
      'name: relocation-probe',
      'description: Verify CODEX_HOME relocation.',
      '---',
      '',
      '# Relocation probe',
      ''
    ].join('\n')
  );
  writeFixtureFile(
    join(input.legacyRuntimeHome, 'plugins', 'relocation-probe', 'marker.txt'),
    'plugin relocation marker\n'
  );
  writeFixtureFile(
    join(input.legacyRuntimeHome, 'migration-probe.sqlite'),
    'sqlite relocation marker'
  );
  writeFixtureFile(
    join(input.home, '.clawee', 'config.toml'),
    'gateway = "https://gateway.example.invalid"\nagent_id = "clawee-e2e"\n'
  );
  const descriptor = {
    runtimeId: input.manifest.codexRuntimeId,
    source: 'embedded-package',
    codexVersion: input.manifest.codexRuntimeVersion,
    releaseTag: input.manifest.codexRuntimeReleaseTag,
    target: input.manifest.codexRuntimeTarget,
    layoutVersion: input.manifest.codexRuntimeLayoutVersion,
    entryPath: join(
      input.resourcesRoot,
      'codex-runtime',
      ...input.manifest.codexRuntimeEntrypoint.split('/')
    ),
    homePath: input.legacyRuntimeHome,
    contentSha256: input.manifest.codexRuntimeContentSha256,
    minimumClaweeVersion,
    migrationSourceHome: null
  };
  writeFixtureFile(
    join(input.dataDir, 'codex', 'runtime-state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'committed',
      active: descriptor,
      previous: null,
      migrationManifestSha256: null,
      updatedAt: '2026-08-25T12:00:00.000Z'
    }, null, 2)}\n`
  );
  writeFixtureFile(
    join(input.dataDir, 'codex', 'runtime-commit.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      runtimeId: input.manifest.codexRuntimeId,
      homePath: input.legacyRuntimeHome,
      minimumClaweeVersion,
      committedAt: '2026-08-25T12:00:00.000Z'
    }, null, 2)}\n`
  );
}

function readRuntimeMinimumClaweeVersion(resourcesRoot: string): string {
  const manifest = JSON.parse(readFileSync(
    join(resourcesRoot, 'deployment', 'codex-runtime.json'),
    'utf8'
  )) as { minimumClaweeVersion?: unknown };
  if (typeof manifest.minimumClaweeVersion !== 'string') {
    throw new Error('Codex Runtime manifest is missing minimumClaweeVersion');
  }
  return manifest.minimumClaweeVersion;
}

function writeFixtureFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeHostileCodex(
  directory: string,
  sentinelPath: string
): string {
  mkdirSync(directory, { recursive: true });
  const path = process.platform === 'win32'
    ? join(directory, 'codex.cmd')
    : join(directory, 'codex');
  writeFileSync(
    path,
    process.platform === 'win32'
      ? [
          '@echo off',
          `echo hostile>"${sentinelPath}"`,
          'exit /b 91',
          ''
        ].join('\r\n')
      : [
          '#!/bin/sh',
          `printf hostile > "${sentinelPath}"`,
          'exit 91',
          ''
        ].join('\n')
  );
  if (process.platform !== 'win32') chmodSync(path, 0o755);
  return path;
}

function packagedRuntimeEnvironment(input: {
  home: string;
  workspace: string;
  hostileBin: string;
  hostileCodexPath: string;
  modelOrigin: string;
  enterpriseRunId: string;
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'CLAWEE_UPDATE_URL',
    'CLAWEE_ENTERPRISE_ORIGIN',
    'CLAWEE_ENTERPRISE_E2E_AUTHORIZED',
    'CLAWEE_ENTERPRISE_E2E_RUN_ID',
    'CLAWEE_ENTERPRISE_KEYRING_SERVICE',
    'CLAWEE_ENTERPRISE_KEYRING_ACCOUNT',
    'CLAWEE_MODEL_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL'
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: input.home,
    USERPROFILE: input.home,
    PATH: `${input.hostileBin}${delimiter}${minimalSystemPath()}`,
    SHELL: process.platform === 'win32'
      ? process.env.ComSpec
      : '/bin/false',
    CLAWEE_DEFAULT_PROJECT_ROOT: join(input.home, 'Documents'),
    CLAWEE_ENTERPRISE_E2E_RUN_ID: input.enterpriseRunId,
    CLAWEE_ENTERPRISE_E2E_HOME: input.home,
    CLAWEE_MODEL_API_KEY: 'hostile-inherited-model-key',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: 'localhost,127.0.0.1',
    CODEX_BIN: input.hostileCodexPath,
    CLAWEE_CODEX_BIN: input.hostileCodexPath,
    CODEX_HOME: join(input.home, 'hostile-codex-home'),
    CLAWEE_CODEX_HOME: join(input.home, 'hostile-clawee-codex-home'),
    CLAWEE_DESKTOP_DEV: '1',
    CLAWEE_CODEX_DEV_BIN: input.hostileCodexPath,
    CLAWEE_CODEX_DEV_HOME: join(input.home, 'hostile-development-home'),
    CLAWEE_DEFAULT_CWD: input.workspace
  };
}

function minimalSystemPath(): string {
  if (process.platform === 'win32') {
    return process.env.SystemRoot === undefined
      ? ''
      : join(process.env.SystemRoot, 'System32');
  }
  return '/usr/bin:/bin:/usr/sbin:/sbin';
}

function embeddedRuntimeFixtureBase(): string {
  const explicit = process.env.CLAWEE_E2E_RUNTIME_ROOT?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return resolve(explicit);
  }
  // Codex refuses helper setup when its isolated Home is under Windows TEMP.
  if (
    process.platform === 'win32'
    && process.env.LOCALAPPDATA !== undefined
  ) {
    return join(process.env.LOCALAPPDATA, 'Clawee', 'e2e');
  }
  return tmpdir();
}

function cleanupEmbeddedRuntimeFixture(root: string): void {
  try {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 10 : 0,
      retryDelay: 100
    });
  } catch (error) {
    if (
      process.platform === 'win32'
      && isNodeError(error)
      && ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code ?? '')
    ) {
      console.warn(
        `[desktop-e2e] 隔离 Runtime 目录仍被外部进程占用，已保留：${root}`
      );
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function findFiles(root: string, suffix: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? findFiles(path, suffix)
      : entry.isFile() && entry.name.endsWith(suffix)
        ? [path]
        : [];
  });
}
