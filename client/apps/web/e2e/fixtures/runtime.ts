import { expect, test as base, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  FakeEnterpriseAuthServer,
  desktopE2EEnterpriseEmail,
  desktopE2EEnterprisePassword,
  writeEnterpriseE2EConfig
} from '../../../desktop/e2e/fake-enterprise-auth-2026-08-06.js';
import {
  resolvePrivateCredentialFilePath
} from '../../../daemon/src/security/private-credential-file.js';
import {
  WEB_E2E_ENTERPRISE_CONFIG_ENV,
  WEB_E2E_RUN_ID_ENV
} from '../../src/runtime/dev-daemon-launch.js';

export type FakeCodexInvocation = {
  threadId?: string;
  message?: string;
  initialDelayMs?: number;
  completionDelayMs?: number;
  turnStatus?: 'completed' | 'failed';
  approval?: boolean;
  command?: string;
  agentSchedule?: Record<string, unknown>;
  files?: Record<string, string>;
};

export type FakeCodexThread = {
  id: string;
  preview: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  cwd: string;
};

export type FakeCodexConfig = {
  invocations?: FakeCodexInvocation[];
  threads?: FakeCodexThread[];
  searchResults?: Array<{
    thread: FakeCodexThread;
    snippet: string;
  }>;
};

export type OpenAppOptions = {
  legacyProjects?: unknown[];
  currentProjectId?: string;
  selectedThreadId?: string;
};

export type RuntimeFixture = {
  origin: string;
  projectDir: string;
  projectId: string;
  ordinaryThreadId: string;
  configureInvocations(invocations: FakeCodexInvocation[]): void;
  configureCodex(config: FakeCodexConfig): void;
  openApp(page: Page, options?: OpenAppOptions): Promise<void>;
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  apiResult(method: string, path: string, body?: unknown): Promise<{
    status: number;
    body: unknown;
  }>;
  createSchedule(overrides?: Record<string, unknown>): Promise<ScheduleFixture>;
  runScheduleNow(scheduleId: string): Promise<RunNowFixture>;
  waitForRunStatus(
    runId: string,
    statuses: string | string[],
    timeoutMs?: number
  ): Promise<Record<string, unknown>>;
  readInvocationCount(): number;
  readCodexMethods(): string[];
};

type ScheduleFixture = {
  id: string;
  threadId: string;
  name: string;
};

type RunNowFixture = {
  run: null | { id: string; threadId?: string; status: string };
  queued: boolean;
  skipped: boolean;
};

type RuntimeConfig = {
  baseUrl: string;
  token: string;
};

type TestFixtures = {
  runtime: RuntimeFixture;
  browserGuard: void;
};

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const fakeCodexScript = join(repoRoot, 'apps/web/e2e/support/fake-codex.mjs');
const e2eModelService = {
  baseUrl: 'https://model.example.test/v1',
  model: 'clawee-web-e2e-model',
  apiKey: 'clawee-web-e2e-key'
};

export const test = base.extend<TestFixtures>({
  runtime: async ({}, use, testInfo) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'clawee-web-e2e-'));
    const dataDir = join(rootDir, 'runtime');
    const codexHome = join(rootDir, 'codex-home');
    const stateDir = join(rootDir, 'fake-codex-state');
    const projectDir = join(rootDir, 'workspace');
    const configPath = join(rootDir, 'fake-codex-config.json');
    const enterpriseConfigPath = join(rootDir, 'enterprise-config.toml');
    const wrapperPath = join(
      rootDir,
      process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex'
    );
    const serverLogPath = join(rootDir, 'server.log');
    const enterpriseRunId = randomUUID();
    const enterpriseServer = new FakeEnterpriseAuthServer();
    enterpriseServer.setModelConfiguration(e2eModelService);
    const enterpriseOrigin = await enterpriseServer.start();
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      invocations: [{ message: 'E2E 默认结果' }],
      threads: [],
      searchResults: []
    }));
    writeFileSync(
      wrapperPath,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexScript}" "$@"\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(stateDir, 'runtime-config.json'),
      JSON.stringify({
        agents_enabled: false,
        multi_agent: false,
        multi_agent_v2: false,
        model: e2eModelService.model,
        model_provider: 'clawee',
        model_provider_name: 'Clawee',
        model_provider_base_url: e2eModelService.baseUrl,
        model_provider_wire_api: 'responses',
        model_provider_requires_openai_auth: false,
        model_provider_env_key: 'CLAWEE_MODEL_API_KEY'
      })
    );
    const credentialPath = resolvePrivateCredentialFilePath({
      dataDir,
      e2eRunId: enterpriseRunId
    });
    mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
    writeFileSync(credentialPath, `${JSON.stringify({
      schemaVersion: 1,
      modelService: {
        apiKey: e2eModelService.apiKey
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const runtimeDescriptor = {
      candidate: {
        runtimeId: 'codex-web-e2e-layout-1',
        source: 'external-development',
        codexVersion: '0.0.0-e2e',
        releaseTag: 'rust-v0.0.0-e2e',
        target: runtimeTarget(process.platform, process.arch),
        layoutVersion: 1,
        entryPath: wrapperPath,
        homePath: codexHome,
        contentSha256: createHash('sha256')
          .update(readFileSync(wrapperPath))
          .digest('hex'),
        minimumClaweeVersion: '1.0.0',
        migrationSourceHome: null
      },
      previous: null,
      claweeVersion: '1.0.0'
    };
    writeEnterpriseE2EConfig(enterpriseConfigPath, enterpriseOrigin);

    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    let serverLog = '';
    const viteArgs = [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort'
    ];
    const child = spawn(
      process.execPath,
      [resolve(repoRoot, 'apps/web/node_modules/vite/bin/vite.js'), ...viteArgs],
      {
        cwd: resolve(repoRoot, 'apps/web'),
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          CODEX_BIN: undefined,
          CODEX_HOME: undefined,
          CLAWEE_CODEX_BIN: undefined,
          CLAWEE_CODEX_HOME: undefined,
          CLAWEE_CODEX_DEV_BIN: undefined,
          CLAWEE_CODEX_DEV_HOME: undefined,
          CLAWEE_DATA_DIR: dataDir,
          CLAWEE_CODEX_RUNTIME_DESCRIPTOR: JSON.stringify(runtimeDescriptor),
          CLAWEE_CODEX_THREAD_ROTATION_RUN_THRESHOLD: '0',
          CLAWEE_E2E_FAKE_CODEX_CONFIG: configPath,
          CLAWEE_E2E_FAKE_CODEX_STATE_DIR: stateDir,
          [WEB_E2E_RUN_ID_ENV]: enterpriseRunId,
          [WEB_E2E_ENTERPRISE_CONFIG_ENV]: enterpriseConfigPath
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    child.stdout?.on('data', chunk => {
      serverLog += chunk.toString();
    });
    child.stderr?.on('data', chunk => {
      serverLog += chunk.toString();
    });

    try {
      const runtimeConfig = await waitForRuntime(origin, child, () => serverLog);
      const runtimeBaseUrl = new URL(runtimeConfig.baseUrl, origin).toString().replace(/\/+$/, '');
      const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await fetch(`${runtimeBaseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${runtimeConfig.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        if (!response.ok) {
          throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
        }
        return await response.json() as T;
      };
      const apiResult = async (
        method: string,
        path: string,
        body?: unknown
      ): Promise<{ status: number; body: unknown }> => {
        const response = await fetch(`${runtimeBaseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${runtimeConfig.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const text = await response.text();
        return {
          status: response.status,
          body: text.length === 0 ? {} : JSON.parse(text) as unknown
        };
      };
      await api('POST', '/enterprise/login', {
        email: desktopE2EEnterpriseEmail,
        password: desktopE2EEnterprisePassword
      });
      await waitForModelServiceReady(apiResult);
      const project = await api<{ project: { id: string } }>('POST', '/projects', {
        cwd: projectDir,
        name: 'workspace'
      });
      const ordinary = await api<{ thread: { id: string } }>('POST', '/threads', {
        title: '普通会话',
        projectId: project.project.id,
        profile: 'default',
        sandbox: 'workspace-write'
      });
      const writeCodexConfig = (update: FakeCodexConfig) => {
        const current = JSON.parse(readFileSync(configPath, 'utf8')) as FakeCodexConfig;
        const temporaryPath = `${configPath}.tmp`;
        writeFileSync(temporaryPath, JSON.stringify({ ...current, ...update }));
        renameSync(temporaryPath, configPath);
      };

      const fixture: RuntimeFixture = {
        origin,
        projectDir,
        projectId: project.project.id,
        ordinaryThreadId: ordinary.thread.id,
        configureInvocations(invocations) {
          writeCodexConfig({ invocations });
        },
        configureCodex(config) {
          writeCodexConfig(config);
        },
        async openApp(page, options = {}) {
          const projectId = options.currentProjectId ?? project.project.id;
          const ordinaryThreadId = ordinary.thread.id;
          const selectedThreadId = options.selectedThreadId ?? ordinaryThreadId;
          await page.addInitScript(({
            projectId: storedProjectId,
            selectedThreadId: storedThreadId,
            legacyProjects
          }) => {
            if (window.top !== window) return;
            localStorage.setItem('clawee.preferences.dynamicBackground', 'false');
            localStorage.setItem('clawee.tasks.notifications.v1', JSON.stringify({
              enabled: true,
              permission: 'granted'
            }));
            localStorage.setItem('clawee.navigation.v3', JSON.stringify({
              currentProjectId: storedProjectId,
              selectedThreadId: storedThreadId
            }));
            if (legacyProjects !== undefined) {
              localStorage.setItem('clawee.projects.v1', JSON.stringify(legacyProjects));
            }
            const notifications: Array<{
              title: string;
              body?: string;
              click(): void;
            }> = [];
            Object.defineProperty(window, '__claweeE2eNotifications', {
              configurable: true,
              value: notifications
            });
            class E2ENotification {
              static permission = 'granted';
              static requestPermission = async () => 'granted';
              onclick: null | (() => void) = null;
              constructor(title: string, options?: NotificationOptions) {
                notifications.push({
                  title,
                  body: options?.body,
                  click: () => this.onclick?.()
                });
              }
              close() {}
            }
            Object.defineProperty(window, 'Notification', {
              configurable: true,
              value: E2ENotification
            });
          }, {
            projectId,
            selectedThreadId,
            legacyProjects: options.legacyProjects
          });
          await page.goto(origin);
          await expect(page.getByRole('status', { name: '本地运行内核正常' })).toBeVisible();
        },
        api,
        apiResult,
        createSchedule(overrides = {}) {
          return api<ScheduleFixture>('POST', '/schedules', {
            name: 'E2E 计划任务',
            cron: '0 * * * *',
            timezone: 'Asia/Shanghai',
            enabled: true,
            prompt: '生成 E2E 测试结果',
            profile: 'default',
            cwd: projectDir,
            sandbox: 'workspace-write',
            concurrencyPolicy: 'queue',
            misfirePolicy: 'skip',
            ...overrides
          });
        },
        runScheduleNow(scheduleId) {
          return api<RunNowFixture>('POST', `/schedules/${encodeURIComponent(scheduleId)}/run-now`);
        },
        async waitForRunStatus(runId, statuses, timeoutMs = 15_000) {
          const accepted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
          const deadline = Date.now() + timeoutMs;
          let latest: Record<string, unknown> = {};
          while (Date.now() < deadline) {
            latest = await api<Record<string, unknown>>(
              'GET',
              `/runs/${encodeURIComponent(runId)}`
            );
            if (accepted.has(String(latest.status))) return latest;
            await delay(50);
          }
          throw new Error(`Run ${runId} did not reach ${[...accepted].join(', ')}: ${JSON.stringify(latest)}`);
        },
        readInvocationCount() {
          try {
            return Number(readFileSync(join(stateDir, 'invocation-count.txt'), 'utf8'));
          } catch {
            return 0;
          }
        },
        readCodexMethods() {
          try {
            return readFileSync(join(stateDir, 'messages.ndjson'), 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .flatMap(line => {
                const parsed = JSON.parse(line) as {
                  message?: { method?: unknown };
                };
                return typeof parsed.message?.method === 'string'
                  ? [parsed.message.method]
                  : [];
              });
          } catch {
            return [];
          }
        }
      };

      await use(fixture);
    } finally {
      writeFileSync(serverLogPath, serverLog);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('vite-daemon.log', {
          path: serverLogPath,
          contentType: 'text/plain'
        });
      }
      await stopProcessTree(child);
      await enterpriseServer.close();
      if (process.env.CLAWEE_E2E_KEEP_TEMP !== '1') {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }
  },

  browserGuard: [async ({ page, runtime: _runtime }, use, testInfo) => {
    const issues: string[] = [];
    page.on('pageerror', error => {
      if (error.message.includes("document is sandboxed and lacks the 'allow-same-origin' flag")) {
        return;
      }
      issues.push(`pageerror: ${error.message}`);
    });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (
        message.text().includes("Blocked script execution in 'about:srcdoc'")
        && message.text().includes("'allow-scripts'")
      ) {
        return;
      }
      issues.push(`console: ${message.text()}`);
    });
    page.on('response', response => {
      if (response.status() >= 500) {
        issues.push(`http ${response.status()}: ${response.url()}`);
      }
    });

    await use();

    if (issues.length > 0) {
      await testInfo.attach('browser-errors.txt', {
        body: Buffer.from(issues.join('\n')),
        contentType: 'text/plain'
      });
    }
    expect(issues, '浏览器控制台或网络不应出现未处理错误').toEqual([]);
  }, { auto: true }]
});

export { expect };

function runtimeTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): string {
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin';
  }
  if (platform === 'win32') {
    return arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : 'x86_64-pc-windows-msvc';
  }
  return arch === 'arm64'
    ? 'aarch64-unknown-linux-musl'
    : 'x86_64-unknown-linux-musl';
}

async function reservePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve a local port'));
        return;
      }
      const port = address.port;
      server.close(error => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

async function waitForRuntime(
  origin: string,
  child: ChildProcess,
  readLog: () => string
): Promise<RuntimeConfig> {
  const deadline = Date.now() + 45_000;
  let latestError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited with code ${child.exitCode}.\n${readLog()}`);
    }
    try {
      const response = await fetch(`${origin}/.clawee/runtime-config`);
      if (response.ok) return await response.json() as RuntimeConfig;
      latestError = `${response.status} ${await response.text()}`;
    } catch (error) {
      latestError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Runtime did not become ready: ${latestError}\n${readLog()}`);
}

async function waitForModelServiceReady(
  apiResult: (
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: unknown }>
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let latest: { status: number; body: unknown } | undefined;
  while (Date.now() < deadline) {
    latest = await apiResult('GET', '/healthz');
    if (
      latest.status === 200
      && typeof latest.body === 'object'
      && latest.body !== null
      && 'runtimeState' in latest.body
      && latest.body.runtimeState === 'ready'
    ) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Model service did not become ready: ${JSON.stringify(latest)}`);
}

async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>(resolveExit => {
    child.once('exit', () => resolveExit());
  });
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await Promise.race([exited, delay(3_000)]);
}
