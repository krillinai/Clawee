import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readIncidentEnterpriseKey, readIncidentGatewayOrigin } from '../src/main/desktop-incidents.js';
import {
  expect,
  test,
  type Page
} from '@playwright/test';
import type {
  ApprovalDecisionResponse,
  ApprovalListResponse,
  RunDiagnosticsResponse,
  RunResponse,
  RuntimeApproval,
  ThreadHistoryResponse
} from '@clawee/protocol';
import {
  CONTROLLED_EXEC_COMMAND_CALL_ID,
  CONTROLLED_EXEC_COMMAND_OUTPUT,
  CONTROLLED_EXEC_COMMAND_PROMPT,
  CONTROLLED_HANG_PROMPT,
  collectControlledModelToolNames,
  controlledModelRequestContainsText,
  findControlledCommandOutput,
  findControlledFunctionCallOutput,
  forbiddenMultiAgentToolNames
} from './controlled-model-server.js';
import {
  createEmbeddedRuntimeFixture,
  ensureEmbeddedEnterpriseSignedIn,
  ensureEmbeddedWorkspaceSignedIn,
  readCodexStatus,
  runtimeRequest,
  waitForAvailabilityProbe,
  waitForEmbeddedRuntimeReady,
  waitForRunTerminal,
  writeDesktopE2EReport
} from './embedded-runtime-fixture.js';
import {
  closePackagedApp,
  createPackagedIncidentReceiver,
  launchSecondInstance,
  waitForProcessExit,
  type PackagedApp
} from './packaged-app.js';
import { readProcessTree } from './desktop-e2e-evidence.js';
import {
  createWorkspaceDownloadArtifacts,
  expectWorkspaceDownload,
  observeWorkspaceFileRequests
} from '../../web/e2e/support/workspace-download.js';

test('关闭 Cookie 加密后可升级启动，重启保留登录和界面存储', async () => {
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  try {
    fixture.writeControlledRuntimeConfig();
    mkdirSync(fixture.userData, { recursive: true });
    writeFileSync(join(fixture.userData, 'Cookies'), 'legacy-cookie-store');
    app = await fixture.launch();
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    await app.page.evaluate(() => localStorage.setItem('cookie-migration-test', 'retained'));
    await app.page.context().addCookies([{
      name: 'cookie-migration-test', value: 'retained',
      url: 'https://clawee-cookie.example.invalid',
      expires: Math.floor(Date.now() / 1_000) + 3_600
    }]);
    await closePackagedApp(app);

    app = await fixture.relaunch(app);
    await waitForEmbeddedRuntimeReady(app.page);
    await expect.poll(async () => (
      await runtimeRequest<{ status: string }>(app!.page, 'GET', '/enterprise/session')
    ).body.status).toBe('signed_in');
    expect(await app.page.evaluate(() => localStorage.getItem('cookie-migration-test'))).toBe('retained');
    expect(await app.page.context().cookies('https://clawee-cookie.example.invalid'))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        name: 'cookie-migration-test', value: 'retained'
      })]));
  } finally {
    if (app !== undefined) await closePackagedApp(app).catch(() => undefined);
    await fixture.dispose();
  }
});

test('打包 App 连续刷新八次后仍能加载项目和模型目录长连接', async () => {
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  try {
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    const project = await runtimeRequest(app.page, 'POST', '/projects', {
      cwd: fixture.workspace, name: '刷新连接回归', sandbox: 'read-only'
    });
    expect(project.status).toBe(201);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const catalogStream = app.page.waitForResponse(response => (
        new URL(response.url()).pathname.endsWith('/codex/models/events')
      ), { timeout: 10_000 });
      await app.page.reload({ waitUntil: 'domcontentloaded' });
      expect((await catalogStream).status()).toBe(200);
      await expect(app.page.getByRole('button', { name: '刷新连接回归', exact: true })).toBeVisible();
      const health = await app.page.evaluate(async () => {
        const response = await fetch('/.clawee/runtime/healthz', {
          signal: AbortSignal.timeout(3_000)
        });
        return { status: response.status, body: await response.json() };
      });
      expect(health).toMatchObject({ status: 200, body: { ok: true } });
    }
    await fixture.captureEvidence('repeated-reload-connections', { reloads: 8 });
  } finally {
    if (app !== undefined) await closePackagedApp(app);
    await fixture.dispose();
  }
});

test('打包 App 接受 50 MiB 附件并拒绝超过上限的请求', async () => {
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  try {
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    expect((await waitForAvailabilityProbe(app.page)).status).toBe('succeeded');
    await expect(app.page.getByRole('button', { name: '选择模型 clawee-e2e-model', exact: true })).toBeEnabled();
    await app.page.getByRole('button', { name: '添加上下文', exact: true }).click();
    await expect(app.page.getByRole('menuitem', { name: '添加文件夹', exact: true })).toBeEnabled();
    await app.page.keyboard.press('Escape');
    const results = await app.page.evaluate(async () => {
      const uploads: Array<{ status: number; body: unknown }> = [];
      const maxBytes = 50 * 1024 * 1024;
      for (const size of [maxBytes, maxBytes + 1]) {
        const query = new URLSearchParams({
          draftId: 'attachment-limit-e2e', fileName: 'large.txt', mime: 'text/plain'
        });
        const response = await fetch(`/.clawee/runtime/attachments?${query}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(size).fill(65)
        });
        uploads.push({ status: response.status, body: await response.json() });
      }
      return uploads;
    });
    expect(results[0]).toMatchObject({ status: 201, body: { attachment: { size: 50 * 1024 * 1024 } } });
    expect(results[1]).toMatchObject({ status: 413, body: { error: { code: 'RUNTIME_PAYLOAD_TOO_LARGE' } } });
    await fixture.captureEvidence('attachment-size-limit', { results });
  } finally {
    if (app !== undefined) await closePackagedApp(app).catch(() => undefined);
    await fixture.dispose();
  }
});

test('实际内嵌 Runtime 的模型错误在客户端和自动上报中保留同一原因', async () => {
  const fixture = await createEmbeddedRuntimeFixture({ responseMode: 'task-failure' });
  const receiver = await createPackagedIncidentReceiver(fixture.userData, { enabled: true });
  const configPath = join(fixture.root, 'enterprise', 'config.toml');
  const enterpriseKey = readIncidentEnterpriseKey(configPath);
  mkdirSync(fixture.userData, { recursive: true });
  writeFileSync(join(fixture.userData, 'auto-incidents.json'), JSON.stringify({ installationId: randomUUID(), enterpriseKey,
    enabled: true, notified: true, noticeVersion: 2, routingVersion: 2, noticeOrigin: readIncidentGatewayOrigin(configPath), records: [],
    policy: { enterprise_key: enterpriseKey, allowed: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() }
  }), { mode: 0o600 });
  let app: PackagedApp | undefined;
  try {
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    const project = await runtimeRequest<{ project: { id: string } }>(app.page, 'POST', '/projects', { cwd: fixture.workspace, name: '模型错误排查', sandbox: 'read-only' });
    expect(project.status).toBe(201);
    const thread = await runtimeRequest<{ thread: { id: string } }>(app.page, 'POST', '/threads', { projectId: project.body.project.id, title: '模型错误排查', sandbox: 'read-only' });
    expect(thread.status).toBe(201);
    const threadUrl = new URL(app.page.url());
    threadUrl.hash = `/thread/${thread.body.thread.id}`;
    await app.page.goto(threadUrl.toString());
    await app.page.reload({ waitUntil: 'domcontentloaded' });
    await app.page.getByRole('textbox', { name: '输入任务' }).fill('测试模型接口错误');
    const runResponse = app.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/runs'));
    await app.page.getByRole('button', { name: '发送', exact: true }).click();
    const run = await (await runResponse).json() as RunResponse;
    expect((await waitForRunTerminal(app.page, run.id)).status).toBe('failed');
    const status = app.page.locator('.model-response-diagnostic');
    await expect(status).toHaveCount(1);
    await expect(status).toContainText('HTTP 503');
    await expect(status).toContainText('本次任务失败');
    await expect.poll(() => receiver.snapshots.some(snapshot => snapshot.run_id === run.id && snapshot.task_outcome === 'failed')).toBe(true);
    const snapshots = receiver.snapshots.filter(snapshot => snapshot.run_id === run.id);
    const last = snapshots.at(-1)!;
    expect(last).toMatchObject({ layer: 'codex_model', http_status: 503, task_outcome: 'failed', outcome: 'failed' });
    expect(last.first_diagnostics).toBeTruthy();
    expect(new Set(snapshots.map(snapshot => snapshot.incident_id)).size).toBe(1);
    await expect.poll(() => receiver.logs.some(log => log.incident_id === last.incident_id)).toBe(true);
    await fixture.captureEvidence('model-error-incident', { snapshots });
  } finally {
    if (app) await closePackagedApp(app);
    await receiver.close();
    await fixture.dispose();
  }
});

test('打包 App 上传旧版 Office 附件并将文字交给内嵌 Codex', async () => {
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  try {
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    expect((await waitForAvailabilityProbe(app.page)).status).toBe('succeeded');
    const project = await runtimeRequest<{ project: { id: string } }>(app.page, 'POST', '/projects', {
      cwd: fixture.workspace, name: '旧版 Office 附件', sandbox: 'read-only'
    });
    expect(project.status).toBe(201);
    const thread = await runtimeRequest<{ thread: { id: string } }>(app.page, 'POST', '/threads', {
      projectId: project.body.project.id, title: '旧版 Office 附件', sandbox: 'read-only'
    });
    expect(thread.status).toBe(201);
    const files = [
      ['doc', 'application/msword'], ['xls', 'application/vnd.ms-excel'], ['ppt', 'application/vnd.ms-powerpoint']
    ].map(([format, mime]) => ({
      fileName: `simple.${format}`, mime: mime!,
      bytes: Array.from(readFileSync(new URL(`../../daemon/test/fixtures/legacy-office/simple.${format}`, import.meta.url)))
    }));
    const draftId = 'legacy-office-e2e';
    const uploads = await app.page.evaluate(async ({ files, draftId }) => {
      const results: Array<{ status: number; attachment?: { id: string } }> = [];
      for (const file of files) {
        const query = new URLSearchParams({ draftId, fileName: file.fileName, mime: file.mime });
        const response = await fetch(`/.clawee/runtime/attachments?${query}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(file.bytes)
        });
        results.push({ ...await response.json(), status: response.status });
      }
      return results;
    }, { files, draftId });
    expect(uploads.map(upload => upload.status)).toEqual([201, 201, 201]);
    const baseline = fixture.modelServer.requests.length;
    const run = await runtimeRequest<RunResponse>(app.page, 'POST', '/runs', {
      threadId: thread.body.thread.id, prompt: '读取这三个旧版 Office 附件的内容', draftId,
      attachmentIds: uploads.map(upload => upload.attachment!.id)
    });
    expect(run.status).toBe(202);
    expect((await waitForRunTerminal(app.page, run.body.id)).status).toBe('succeeded');
    const requests = fixture.modelServer.requests.slice(baseline);
    for (const text of ['This is a simple file created with Word 97-SR2.', 'replaceMe', 'This is a test title']) {
      expect(requests.some(request => controlledModelRequestContainsText(request, text))).toBe(true);
    }
    await fixture.captureEvidence('legacy-office-attachments', { fileNames: files.map(file => file.fileName) });
  } finally {
    if (app !== undefined) await closePackagedApp(app).catch(() => undefined);
    await fixture.dispose();
  }
});

test('Runtime 启动失败时损坏更新记录自动重建，实际桌面仍可检查更新', async () => {
  const fixture = await createEmbeddedRuntimeFixture();
  const manifest = join(fixture.resourcesRoot, 'deployment', 'codex-runtime.json');
  const hidden = `${manifest}.update-recovery-test`;
  const journal = join(fixture.userData, 'customer-update-state.json');
  let app: PackagedApp | undefined;
  try {
    mkdirSync(fixture.userData, { recursive: true });
    writeFileSync(journal, '损坏的更新记录');
    renameSync(manifest, hidden);
    app = await fixture.launch();
    await expect.poll(() => app!.page.evaluate(async () => {
      const desktop = (window as Window & { claweeDesktop: { readBootstrapState(): Promise<{ phase: string }> } }).claweeDesktop;
      return (await desktop.readBootstrapState()).phase;
    })).toBe('failed');
    const result = await app.page.evaluate(async () => {
      const desktop = (window as Window & { claweeDesktop: {
        checkForUpdates(): Promise<{ ok: boolean }>;
        readUpdateState(): Promise<{ supported: boolean; status: string; errorCode?: string }>;
      } }).claweeDesktop;
      return { check: await desktop.checkForUpdates(), state: await desktop.readUpdateState() };
    });
    expect(result.check).toMatchObject({ ok: true });
    expect(result.state).toMatchObject({ supported: true, status: 'idle' });
    expect(result.state.errorCode).toBeUndefined();
    const backups = readdirSync(fixture.userData).filter(name => name.startsWith('customer-update-state.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fixture.userData, backups[0]!), 'utf8')).toBe('损坏的更新记录');
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual({ schemaVersion: 1, records: [] });
    await fixture.captureEvidence('failed-runtime-update-recovery', result);
  } finally {
    if (app) await closePackagedApp(app);
    if (existsSync(hidden)) renameSync(hidden, manifest);
    await fixture.dispose();
  }
});

for (const policy of ['unknown', 'fresh', 'allowed', 'expired', 'denied', 'disabled', 'invalid_config'] as const) {
test(`未登录Runtime启动失败的实际上报门禁：${policy}`, async () => {
  const fixture = await createEmbeddedRuntimeFixture();
  const receiver = await createPackagedIncidentReceiver(fixture.userData, policy === 'fresh' ? { enabled: true } : undefined);
  const manifest = join(fixture.resourcesRoot, 'deployment', 'codex-runtime.json');
  const hidden = `${manifest}.incident-test`;
  const queue = join(fixture.userData, 'auto-incidents.json');
  const configPath = join(fixture.root, 'enterprise', 'config.toml');
  const enterpriseKey = readIncidentEnterpriseKey(configPath);
  let app: PackagedApp | undefined;
  try {
    mkdirSync(fixture.userData, { recursive: true });
    writeFileSync(queue, JSON.stringify({ installationId: randomUUID(), enterpriseKey, enabled: policy !== 'disabled', notified: true, noticeVersion: 2, routingVersion: 2, noticeOrigin: readIncidentGatewayOrigin(configPath), records: [],
      ...(['unknown', 'fresh'].includes(policy) ? {} : { policy: { enterprise_key: enterpriseKey, allowed: policy !== 'denied' && policy !== 'invalid_config',
        expires_at: new Date(Date.now() + (policy === 'expired' ? -60_000 : 3_600_000)).toISOString() } })
    }), { mode: 0o600 });
    if (policy === 'invalid_config') writeFileSync(configPath, 'gateway = 123\n');
    renameSync(manifest, hidden);
    app = await fixture.launch();
    await expect.poll(() => app!.page.evaluate(async () => {
      const desktop = (window as Window & { claweeDesktop: { readBootstrapState(): Promise<{ phase: string }> } }).claweeDesktop;
      return (await desktop.readBootstrapState()).phase;
    })).toBe('failed');
    const shouldCollect = !['denied', 'invalid_config'].includes(policy);
    await expect.poll(() => {
      const state = JSON.parse(readFileSync(queue, 'utf8')) as { records: Array<{ snapshot: { source: string; outcome: string }; acknowledged: number }> };
      return state.records.filter(record => record.snapshot.source === 'desktop' && record.snapshot.outcome === 'failed').length;
    }).toBe(shouldCollect ? 1 : 0);
    if (policy === 'allowed' || policy === 'fresh' || policy === 'disabled') {
      await expect.poll(() => JSON.parse(readFileSync(queue, 'utf8')).records[0]?.acknowledged).toBeGreaterThan(0);
      await expect.poll(() => JSON.parse(readFileSync(queue, 'utf8')).records[0]?.logsAcknowledged).toBe(true);
      expect(receiver.requestCount).toBe(2);
      expect(receiver.logs).toHaveLength(1);
      expect(receiver.logs[0]!.content).toContain('desktop-main.log');
      expect(receiver.snapshots[0]).toMatchObject({ source: 'desktop', layer: 'desktop_bootstrap', outcome: 'failed' });
    } else {
      await app.page.waitForTimeout(250);
      expect(receiver.requestCount).toBe(0);
    }
    const state = JSON.parse(readFileSync(queue, 'utf8')) as { records: Array<{ snapshot: { run_id?: string; thread_id?: string; layer: string } }> };
    expect(state.records.every(record => record.snapshot.layer === 'desktop_bootstrap' && !record.snapshot.run_id && !record.snapshot.thread_id)).toBe(true);
    await closePackagedApp(app); app = undefined;
    expect(receiver.requestCount).toBe(policy === 'allowed' || policy === 'fresh' || policy === 'disabled' ? 2 : 0);
  } finally {
    if (existsSync(hidden)) renameSync(hidden, manifest);
    if (app) await closePackagedApp(app);
    await receiver.close();
    await fixture.dispose();
  }
});
}

test('Windows 更新未完成时等待资源写入，多次打开后自动进入新版工作台', async () => {
  test.skip(process.platform !== 'win32');
  const fixture = await createEmbeddedRuntimeFixture();
  const statePath = `${fixture.packageRoot}.clawee-update.json`;
  const deployment = join(fixture.resourcesRoot, 'deployment');
  const pendingDeployment = `${deployment}.installing`;
  let app: PackagedApp | undefined;
  try {
    renameSync(deployment, pendingDeployment);
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, state: 'installing', installerPid: process.pid, targetVersion: fixture.appVersion }));
    app = await fixture.launch();
    await expect(app.page.getByRole('heading', { name: 'Clawee 正在完成更新' })).toBeVisible();
    const startupLog = join(fixture.userData, 'logs', 'desktop-main.log');
    await expect.poll(() => existsSync(startupLog)).toBe(true);
    expect(readFileSync(startupLog, 'utf8')).not.toContain('Clawee Desktop starting');
    await launchSecondInstance(app, ['clawee://tasks']);
    await launchSecondInstance(app, ['--updated']);
    await expect(app.page.getByRole('heading', { name: 'Clawee 正在完成更新' })).toBeVisible();
    await app.page.screenshot({ path: test.info().outputPath('update-waiting.png') });
    const workspacePage = app.browser.contexts()[0]!.waitForEvent('page');
    renameSync(pendingDeployment, deployment);
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, state: 'complete', installerPid: process.pid, targetVersion: fixture.appVersion, elapsedMs: 3000 }));
    app.page = await workspacePage;
    await waitForEmbeddedRuntimeReady(app.page);
    await expect.poll(() => app!.page.url()).toContain('#/tasks');
    const log = readFileSync(startupLog, 'utf8');
    expect(log).toContain('Windows update installation completed');
    expect(log).toContain('Desktop workspace ready');
    expect(log).not.toContain('CODEX_RUNTIME_MANIFEST_MISSING');
    await fixture.captureEvidence('windows-update-waiting', { version: fixture.appVersion });
  } finally {
    if (existsSync(pendingDeployment)) renameSync(pendingDeployment, deployment);
    rmSync(statePath, { force: true });
    if (app !== undefined) await closePackagedApp(app);
    await fixture.dispose();
  }
});

test('打包 Electron 从只读服务工作区真实下载文本和普通二进制原文件', async ({}, testInfo) => {
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  const artifacts = createWorkspaceDownloadArtifacts().filter(artifact => (
    artifact.kind === 'text' || artifact.kind === 'binary'
  ));
  try {
    for (const artifact of artifacts) {
      const sourcePath = join(fixture.workspace, artifact.path);
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, artifact.bytes);
    }
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    const requests = observeWorkspaceFileRequests(app.page);
    const project = await runtimeRequest<{ project: { id: string } }>(
      app.page, 'POST', '/projects', {
        cwd: fixture.workspace,
        name: '成果下载回归',
        sandbox: 'read-only'
      }
    );
    expect(project.status).toBe(201);
    const thread = await runtimeRequest<{ thread: { id: string } }>(
      app.page, 'POST', '/threads', {
        projectId: project.body.project.id,
        title: '成果下载回归',
        sandbox: 'read-only'
      }
    );
    expect(thread.status).toBe(201);

    for (const artifact of artifacts) {
      await app.page.evaluate(({ threadId, path }) => {
        window.location.hash = `#/files?${new URLSearchParams({ threadId, path })}`;
      }, { threadId: thread.body.thread.id, path: artifact.path });
      await app.page.reload({ waitUntil: 'domcontentloaded' });
      await ensureEmbeddedWorkspaceSignedIn(app.page);
      await expect(app.page.getByRole('button', { name: '打开文件', exact: true })).toBeVisible();
      if (artifact.kind === 'binary') {
        await expect(app.page.getByText('暂不支持预览此文件', { exact: true })).toBeVisible();
      }
      await expectWorkspaceDownload({
        page: app.page,
        threadId: thread.body.thread.id,
        workspace: fixture.workspace,
        artifact,
        saveDirectory: testInfo.outputPath('Electron 下载副本'),
        requireBearer: false
      });
    }

    expect(requests.filter(request => request.pathname.endsWith('/download'))).toHaveLength(artifacts.length);
    expect(requests.filter(request => request.pathname.endsWith('/reveal'))).toEqual([]);
  } finally {
    if (app !== undefined) await closePackagedApp(app).catch(() => undefined);
    await fixture.dispose();
  }
});

test('打包 App 在空闲和任务执行中及时退出且不遗留 Runtime 进程', async () => {
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  const measurements: Array<{
    mode: string;
    durationMs: number;
    exited: boolean;
    quitRequestError?: string;
  }> = [];
  try {
    app = await fixture.launch();
    for (const mode of ['unconfigured', 'idle', 'running']) {
      if (app === undefined) throw new Error('退出回归 App 未启动');
      await waitForEmbeddedRuntimeReady(app.page);
      if (mode !== 'unconfigured') {
        await ensureEmbeddedWorkspaceSignedIn(app.page);
        expect((await waitForAvailabilityProbe(app.page)).status).toBe('succeeded');
      }
      let runId: string | undefined;
      if (mode === 'running') {
        const project = await runtimeRequest<{ project: { id: string } }>(
          app.page, 'POST', '/projects', {
            cwd: fixture.workspace, name: '退出回归', sandbox: 'read-only'
          }
        );
        expect(project.status).toBe(201);
        const thread = await runtimeRequest<{ thread: { id: string } }>(
          app.page, 'POST', '/threads', {
            projectId: project.body.project.id, title: '退出回归', sandbox: 'read-only'
          }
        );
        expect(thread.status).toBe(201);
        const baseline = fixture.modelServer.requests.length;
        const run = await startRun(app.page, {
          threadId: thread.body.thread.id, prompt: CONTROLLED_HANG_PROMPT
        });
        runId = run.id;
        await expect.poll(() => fixture.modelServer.requests.slice(baseline).some(
          request => controlledModelRequestContainsText(request, CONTROLLED_HANG_PROMPT)
        )).toBe(true);
      }
      const logPath = join(fixture.userData, 'logs', 'desktop-main.log');
      const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const daemonPid = entries.reverse().find(entry => entry.message === 'Daemon Utility Process ready')
        ?.details.pid as number;
      expect(daemonPid).toBeGreaterThan(0);
      const runtimePids = (await readProcessTree([daemonPid]))
        .filter(processRecord => processRecord.pid !== daemonPid)
        .map(processRecord => processRecord.pid);
      const previousApp = app;
      const startedAt = Date.now();
      const exited = waitForProcessExit(app.process, 5_500);
      let quitRequestError: string | undefined;
      await app.page.evaluate(() => {
        if (window.claweeDesktop === undefined) throw new Error('Desktop Bridge 未就绪');
        void window.claweeDesktop.quit();
      }).catch(error => { quitRequestError = String(error); });
      const processExited = await exited;
      const durationMs = Date.now() - startedAt;
      measurements.push({ mode, durationMs, exited: processExited, quitRequestError });
      writeDesktopE2EReport('clawee-desktop-shutdown-e2e.json', {
        generatedAt: new Date().toISOString(), measurements,
        result: processExited ? 'RUNNING' : 'FAIL'
      });
      if (!processExited) {
        await fixture.captureEvidence(`shutdown-${mode}`, {
          mode, durationMs, daemonPid, runtimePids, quitRequestError,
          mainPid: app.process.pid
        });
      }
      expect(processExited).toBe(true);
      expect(durationMs).toBeLessThan(mode === 'unconfigured' ? 2_000 : 5_500);
      for (const pid of [daemonPid, ...runtimePids]) {
        await expect.poll(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return typeof error === 'object' && error !== null && 'code' in error
              && error.code === 'ESRCH';
          }
        }).toBe(true);
      }
      await app.browser.close().catch(() => undefined);
      app = undefined;
      if (mode !== 'running') app = await fixture.relaunch(previousApp);
      if (runId !== undefined) {
        expect(readFileSync(join(fixture.dataDir, 'runs', runId, 'events.ndjson'), 'utf8'))
          .toContain('"type":"done"');
      }
    }
    writeDesktopE2EReport('clawee-desktop-shutdown-e2e.json', {
      generatedAt: new Date().toISOString(), measurements, result: 'PASS'
    });
  } finally {
    if (app !== undefined) await closePackagedApp(app).catch(() => undefined);
    await fixture.dispose();
  }
});

test('强制结束桌面主进程后 daemon 自退出且数据目录可以安全重开', async () => {
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  try {
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    const daemonPid = Number(readFileSync(join(fixture.dataDir, 'clawee-runtime.lock'), 'utf8').trim());
    expect(daemonPid).toBeGreaterThan(0);
    const previousApp = app;
    const exited = waitForProcessExit(app.process, 5_000);
    app.process.kill('SIGKILL');
    expect(await exited).toBe(true);
    await expect.poll(() => {
      try {
        process.kill(daemonPid, 0);
        return false;
      } catch (error) {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
      }
    }, { timeout: 20_000 }).toBe(true);
    await app.browser.close().catch(() => undefined);
    app = await fixture.relaunch(previousApp);
    await waitForEmbeddedRuntimeReady(app.page);
    expect(Number(readFileSync(join(fixture.dataDir, 'clawee-runtime.lock'), 'utf8').trim()))
      .not.toBe(daemonPid);
  } finally {
    if (app !== undefined) await closePackagedApp(app).catch(() => undefined);
    await fixture.dispose();
  }
});

test('packaged App ignores a legacy Runtime Home without relocating it', async () => {
  test.setTimeout(240_000);
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;

  try {
    fixture.writeLegacyControlledRuntimeConfig();
    const claweeConfigBefore = readFileSync(fixture.claweeConfigPath, 'utf8');
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    await expect(app.page.locator('.enterprise-access-gate')).toBeVisible();

    const bootstrapState = await app.page.evaluate(
      () => window.claweeDesktop?.readBootstrapState()
    );
    expect(realpathSync(bootstrapState!.codexHome!)).toBe(
      realpathSync(fixture.targetHome)
    );
    expect(readFileSync(join(fixture.legacyRuntimeHome, 'config.toml'), 'utf8'))
      .toContain('[mcp_servers.relocation_probe]');
    expect(existsSync(join(
      fixture.legacyRuntimeHome,
      'skills',
      'relocation-probe',
      'SKILL.md'
    ))).toBe(true);
    expect(existsSync(join(
      fixture.legacyRuntimeHome,
      'plugins',
      'relocation-probe',
      'marker.txt'
    ))).toBe(true);
    expect(existsSync(join(
      fixture.targetHome,
      'migration-probe.sqlite'
    ))).toBe(false);
    expect(existsSync(join(
      fixture.targetHome,
      'skills',
      'relocation-probe'
    ))).toBe(false);
    expect(existsSync(join(
      fixture.dataDir,
      'codex',
      'home-relocations'
    ))).toBe(false);
    expect(readFileSync(fixture.claweeConfigPath, 'utf8'))
      .toBe(claweeConfigBefore);

    expect(JSON.parse(readFileSync(
      join(fixture.dataDir, 'codex', 'runtime-state.json'),
      'utf8'
    ))).toMatchObject({
      state: 'active_uncommitted',
      active: { homePath: fixture.targetHome },
      previous: null
    });

    await ensureEmbeddedWorkspaceSignedIn(app.page);
    const modelButton = app.page.getByRole('button', {
      name: '选择模型 clawee-e2e-model'
    });
    await expect(modelButton).toBeVisible({ timeout: 60_000 });
    await modelButton.click();
    await expect(app.page.getByRole('menuitemradio', {
      name: /clawee-e2e-model/
    })).toBeVisible();
    await expect(app.page.getByRole('menuitemradio', {
      name: /GPT-/
    })).toHaveCount(0);
    await modelButton.click();
    const probe = await waitForAvailabilityProbe(app.page);
    expect(probe.status).toBe('succeeded');
    const mcp = await runtimeRequest<{
      servers: Array<{ name: string; enabled: boolean }>;
    }>(app.page, 'GET', '/codex/mcp?refresh=true');
    expect(mcp.status).toBe(200);
    expect(mcp.body.servers).not.toContainEqual(expect.objectContaining({
      name: 'relocation_probe'
    }));

    const previousApp = app;
    await closePackagedApp(previousApp);
    app = undefined;
    app = await fixture.relaunch(previousApp);
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    await expect(app.page.getByRole('heading', {
      name: '配置 Codex 模型服务'
    })).toHaveCount(0);
    expect(fixture.hostileCodexWasUsed()).toBe(false);
  } finally {
    if (app !== undefined) {
      await closePackagedApp(app).catch(() => undefined);
    }
    await fixture.dispose();
  }
});

test('packaged App ignores external Codex sessions and starts with an isolated Runtime Home', async () => {
  test.setTimeout(240_000);
  const fixture = await createEmbeddedRuntimeFixture({
    legacyThreadCount: 2
  });
  let app: PackagedApp | undefined;

  try {
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    await assertDesktopRuntimeSurface(app.page);
    await expect(app.page.locator('.enterprise-access-gate')).toBeVisible();
    await expect(app.page.getByRole('heading', {
      name: '配置 Codex 模型服务'
    })).toHaveCount(0);
    await expect(app.page.locator('.clawee-shell')).toHaveCount(0);
    const initialRuntimeStatus = await runtimeRequest<{
      availabilityProbe: { status: string };
    }>(app.page, 'GET', '/codex/status');
    expect(initialRuntimeStatus).toMatchObject({
      status: 200,
      body: { availabilityProbe: { status: 'skipped' } }
    });
    expect((await runtimeRequest(
      app.page,
      'GET',
      '/projects'
    )).status).toBe(200);
    expect(await runtimeRequest(app.page, 'POST', '/runs', { prompt: '未就绪模型任务' })).toMatchObject({
      status: 428, body: { error: { code: 'MODEL_SERVICE_CONFIGURATION_REQUIRED' } }
    });
    expect(fixture.modelServer.requests).toHaveLength(0);

    const bootstrapState = await app.page.evaluate(
      () => window.claweeDesktop?.readBootstrapState()
    );
    expect(bootstrapState).toMatchObject({
      phase: 'ready',
      runtimeId: fixture.manifest.codexRuntimeId,
      runtimeSource: 'embedded-package',
      runtimeTarget: fixture.manifest.codexRuntimeTarget,
      runtimeContentSha256: fixture.manifest.codexRuntimeContentSha256
    });
    expect(realpathSync(bootstrapState!.codexEntryPath!).startsWith(
      `${realpathSync(join(fixture.resourcesRoot, 'codex-runtime'))}${sep}`
    )).toBe(true);
    expect(realpathSync(bootstrapState!.codexHome!)).toBe(
      realpathSync(fixture.targetHome)
    );
    expect(fixture.hostileCodexWasUsed()).toBe(false);
    expect(fixture.sourceRolloutsAreUnchanged()).toBe(true);
    expect(fixture.targetRolloutPaths()).toHaveLength(0);
    for (const thread of fixture.legacyThreads) {
      expect(existsSync(
        join(fixture.targetHome, ...thread.rolloutRelativePath.split('/')),
      )).toBe(false);
    }
    expect(findMigrationJournal(fixture.dataDir)).toBe(false);

    await ensureEmbeddedWorkspaceSignedIn(app.page);
    await app.page.getByRole('button', { name: '设置', exact: true }).click();
    await app.page.getByRole('button', { name: '关于 Clawee' }).click();
    await expect(app.page.locator('.settings-row').filter({ hasText: 'Clawee 版本' }).locator('strong'))
      .toHaveText(fixture.appVersion);
    await app.page.getByRole('button', { name: '返回应用' }).click();

    const probe = await waitForAvailabilityProbe(app.page);
    expect(probe).toMatchObject({
      status: 'succeeded',
      responseReceived: true
    });
    const initialStatus = await readCodexStatus(app.page);
    expect(initialStatus.capabilities).toMatchObject({ appServer: true });
    expect(initialStatus.runtime).toMatchObject({
      runtimeId: fixture.manifest.codexRuntimeId,
      source: 'embedded-package',
      version: fixture.manifest.codexRuntimeVersion,
      releaseTag: fixture.manifest.codexRuntimeReleaseTag,
      target: fixture.manifest.codexRuntimeTarget,
      layoutVersion: fixture.manifest.codexRuntimeLayoutVersion,
      contentSha256: fixture.manifest.codexRuntimeContentSha256,
      activationState: 'active_uncommitted',
      committedAt: null
    });
    const requestBaseline = fixture.modelServer.requests.length;
    const beforeWriteStatus = await readCodexStatus(app.page);
    expect(beforeWriteStatus.runtime.activationState).toBe(
      'active_uncommitted'
    );

    const createdProject = await runtimeRequest<{
      project: { id: string };
    }>(app.page, 'POST', '/projects', {
      cwd: fixture.newWorkspace,
      name: '包内 Runtime 新项目',
      sandbox: 'read-only'
    });
    expect(createdProject.status).toBe(201);
    const createdThread = await runtimeRequest<{
      thread: { id: string; codexThreadId: string | null };
    }>(app.page, 'POST', '/threads', {
      projectId: createdProject.body.project.id,
      title: '包内 Runtime 新会话',
      sandbox: 'read-only'
    });
    expect(createdThread.status).toBe(201);
    expect(createdThread.body.thread.codexThreadId).toBeNull();
    const newRun = await startRun(app.page, {
      threadId: createdThread.body.thread.id,
      prompt: '执行包内 Runtime 新会话'
    });
    const newTerminal = await waitForRunTerminal(app.page, newRun.id);
    expect(newTerminal.status).toBe('succeeded');
    expect(newTerminal.codexThreadId).toEqual(expect.any(String));
    expect(fixture.legacyThreads.map(thread => thread.codexThreadId))
      .not.toContain(newTerminal.codexThreadId);

    await fixture.modelServer.waitForRequestCount(
      requestBaseline + 1
    );
    const controlledRequests = fixture.modelServer.requests.slice(
      requestBaseline
    );
    expect(controlledRequests.some(request => (
      controlledModelRequestContainsText(
        request,
        `本会话唯一有效的 CODEX_HOME 是 ${JSON.stringify(fixture.targetHome)}`
      )
    ))).toBe(true);
    expect(controlledRequests.some(request => (
      controlledModelRequestContainsText(
        request,
        '不得使用、检查或依据 ~/.codex'
      )
    ))).toBe(true);
    expect(controlledRequests.some(request => (
      controlledModelRequestContainsText(
        request,
        '不得读取或输出 config.toml 中的 Authorization、token、secret'
      )
    ))).toBe(true);
    const toolNames = collectControlledModelToolNames(controlledRequests);
    expect(forbiddenMultiAgentToolNames(toolNames)).toEqual([]);
    expect(fixture.hostileCodexWasUsed()).toBe(false);
    expect(fixture.sourceRolloutsAreUnchanged()).toBe(true);
    expect(fixture.targetRolloutPaths()).toHaveLength(1);
    expect(findMigrationJournal(fixture.dataDir)).toBe(false);

    const committedStatus = await readCodexStatus(app.page);
    expect(committedStatus.runtime).toMatchObject({
      activationState: 'committed',
      committedAt: expect.any(String)
    });

    const previousCommittedApp = app;
    await closePackagedApp(previousCommittedApp);
    app = undefined;
    app = await fixture.relaunch(previousCommittedApp);
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    await expect(app.page.getByRole('heading', {
      name: '配置 Codex 模型服务'
    })).toHaveCount(0);
    const restartedStatus = await readCodexStatus(app.page);
    expect(restartedStatus.runtime).toMatchObject({
      runtimeId: fixture.manifest.codexRuntimeId,
      source: 'embedded-package',
      activationState: 'committed',
      committedAt: committedStatus.runtime.committedAt
    });

    const persistedThreads = await runtimeRequest<{
      threads: Array<{
        id: string;
        codexThreadId: string | null;
      }>;
    }>(app.page, 'GET', '/threads?status=all&limit=50');
    expect(persistedThreads.status).toBe(200);
    for (const thread of fixture.legacyThreads) {
      expect(persistedThreads.body.threads).toContainEqual(
        expect.objectContaining({
          id: thread.claweeThreadId,
          codexThreadId: thread.codexThreadId
        })
      );
    }
    expect(persistedThreads.body.threads).toContainEqual(
      expect.objectContaining({
        id: createdThread.body.thread.id,
        codexThreadId: newTerminal.codexThreadId
      })
    );

    const resumeRequestBaseline = fixture.modelServer.requests.length;
    const resumedRun = await startRun(app.page, {
      threadId: createdThread.body.thread.id,
      prompt: '验证恢复会话仍使用 Clawee Runtime Home'
    });
    const resumedTerminal = await waitForRunTerminal(
      app.page,
      resumedRun.id
    );
    expect(resumedTerminal).toMatchObject({
      status: 'succeeded',
      codexThreadId: newTerminal.codexThreadId
    });
    await fixture.modelServer.waitForRequestCount(
      resumeRequestBaseline + 1
    );
    const resumedRequests = fixture.modelServer.requests.slice(
      resumeRequestBaseline
    );
    expect(resumedRequests.some(request => (
      controlledModelRequestContainsText(
        request,
        `本会话唯一有效的 CODEX_HOME 是 ${JSON.stringify(fixture.targetHome)}`
      )
    ))).toBe(true);
    expect(fixture.hostileCodexWasUsed()).toBe(false);

    writeDesktopE2EReport(
      'clawee-desktop-embedded-runtime-e2e.json',
      {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        packageRoot: fixture.packageRoot,
        appVersion: fixture.appVersion,
        runtime: restartedStatus.runtime,
        ignoredExternalThreads: fixture.legacyThreads.map(thread => ({
          claweeThreadId: thread.claweeThreadId,
          codexThreadId: thread.codexThreadId
        })),
        migrationJournalCreated: false,
        newThreadId: createdThread.body.thread.id,
        newCodexThreadId: newTerminal.codexThreadId,
        newRunId: newTerminal.id,
        resumedRunId: resumedTerminal.id,
        resumedCodexThreadId: resumedTerminal.codexThreadId,
        resumedClaweeCodexHomeInstructionInjected: true,
        modelRequestCount:
          controlledRequests.length + resumedRequests.length,
        modelToolNames: toolNames,
        claweeCodexHomeInstructionInjected: true,
        defaultCodexHomeInferenceForbidden: true,
        mcpCredentialBypassForbidden: true,
        forbiddenMultiAgentToolNames: [],
        hostileCodexInvoked: false,
        sourceHomeUnchanged: true,
        targetRolloutCount: fixture.targetRolloutPaths().length,
        result: 'PASS'
      }
    );
  } finally {
    if (app !== undefined) {
      await closePackagedApp(app).catch(() => undefined);
    }
    await fixture.dispose();
  }
});

test('packaged embedded Runtime executes tools, persists output, cancels a hanging turn, and recovers', async () => {
  test.setTimeout(240_000);
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  let probe: Awaited<ReturnType<typeof waitForAvailabilityProbe>> | undefined;
  let requestBaseline = 0;
  let toolThreadId: string | undefined;
  let toolRunId: string | undefined;
  let approvedToolApproval: RuntimeApproval | undefined;
  let reportWritten = false;

  try {
    fixture.writeControlledRuntimeConfig();
    app = await fixture.launch();
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    probe = await waitForAvailabilityProbe(app.page);
    expect(probe.status).toBe('succeeded');
    requestBaseline = fixture.modelServer.requests.length;

    const project = await runtimeRequest<{
      project: { id: string };
    }>(app.page, 'POST', '/projects', {
      cwd: fixture.workspace,
      name: '包内 Runtime 工具闭环',
      sandbox: 'workspace-write'
    });
    expect(project.status).toBe(201);
    const toolThread = await runtimeRequest<{
      thread: { id: string };
    }>(app.page, 'POST', '/threads', {
      projectId: project.body.project.id,
      title: '真实工具执行',
      sandbox: 'workspace-write'
    });
    expect(toolThread.status).toBe(201);
    toolThreadId = toolThread.body.thread.id;

    const toolRun = await startRun(app.page, {
      threadId: toolThread.body.thread.id,
      prompt: CONTROLLED_EXEC_COMMAND_PROMPT
    });
    toolRunId = toolRun.id;
    const toolGate = await waitForRunTerminalOrApproval(
      app.page,
      toolRun.id
    );
    if ('approval' in toolGate) {
      expect(toolGate.approval).toMatchObject({
        runId: toolRun.id,
        kind: 'command_execution',
        status: 'pending'
      });
      expect(JSON.stringify(toolGate.approval.details)).toContain(
        CONTROLLED_EXEC_COMMAND_OUTPUT
      );
      const approved = await runtimeRequest<ApprovalDecisionResponse>(
        app.page,
        'POST',
        `/approvals/${encodeURIComponent(toolGate.approval.id)}/approve`
      );
      expect(approved).toMatchObject({
        status: 200,
        body: {
          changed: true,
          approval: {
            id: toolGate.approval.id,
            status: 'approved'
          }
        }
      });
      approvedToolApproval = approved.body.approval;
    }
    const toolTerminal = 'terminal' in toolGate
      ? toolGate.terminal
      : await waitForRunTerminal(app.page, toolRun.id);
    expect(toolTerminal).toMatchObject({
      status: 'succeeded',
      codexThreadId: expect.any(String)
    });

    await expect.poll(() => (
      findControlledCommandOutput(
        fixture.modelServer.requests.slice(requestBaseline)
      ) !== undefined
    )).toBe(true);
    const toolOutput = findControlledCommandOutput(
      fixture.modelServer.requests.slice(requestBaseline)
    );
    expect(JSON.stringify(toolOutput)).toContain(
      CONTROLLED_EXEC_COMMAND_OUTPUT
    );
    if (collectControlledModelToolNames(
      fixture.modelServer.requests.slice(requestBaseline)
    ).includes('exec_command')) {
      expect(JSON.stringify(findControlledFunctionCallOutput(
        fixture.modelServer.requests.slice(requestBaseline),
        CONTROLLED_EXEC_COMMAND_CALL_ID
      ))).toContain('Process running with session ID');
    }
    const toolOutputPath = join(
      fixture.workspace,
      'clawee-tool-loop.txt'
    );
    await expect.poll(() => existsSync(toolOutputPath)).toBe(true);
    expect(readFileSync(toolOutputPath, 'utf8').trim()).toBe(
      CONTROLLED_EXEC_COMMAND_OUTPUT
    );

    const history = await runtimeRequest<ThreadHistoryResponse>(
      app.page,
      'GET',
      `/threads/${encodeURIComponent(
        toolThread.body.thread.id
      )}/history?limit=50`
    );
    expect(history.status).toBe(200);
    expect(history.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_use',
        name: 'command_execution'
      }),
      expect.objectContaining({
        type: 'tool_result',
        name: 'command_execution',
        isError: false
      }),
      expect.objectContaining({
        type: 'assistant_message',
        text: 'Clawee tool loop completed.'
      }),
      expect.objectContaining({
        type: 'done',
        status: 'succeeded'
      })
    ]));
    const persistedToolResult = history.body.items.find(
      item => (
        item.type === 'tool_result'
        && item.name === 'command_execution'
        && item.output.includes(CONTROLLED_EXEC_COMMAND_OUTPUT)
      )
    );
    expect(persistedToolResult?.type === 'tool_result'
      ? persistedToolResult.output
      : '').toContain(CONTROLLED_EXEC_COMMAND_OUTPUT);

    const cancelThread = await runtimeRequest<{
      thread: { id: string };
    }>(app.page, 'POST', '/threads', {
      projectId: project.body.project.id,
      title: '真实取消恢复',
      sandbox: 'workspace-write'
    });
    expect(cancelThread.status).toBe(201);
    const cancelRequestBaseline = fixture.modelServer.requests.length;
    const hangingRun = await startRun(app.page, {
      threadId: cancelThread.body.thread.id,
      prompt: CONTROLLED_HANG_PROMPT
    });
    await expect.poll(() => (
      fixture.modelServer.requests
        .slice(cancelRequestBaseline)
        .some(request => controlledModelRequestContainsText(
          request,
          CONTROLLED_HANG_PROMPT
        ))
    )).toBe(true);
    await expect.poll(async () => (
      await runtimeRequest<RunResponse>(
        app!.page,
        'GET',
        `/runs/${encodeURIComponent(hangingRun.id)}`
      )
    ).body.status).toBe('running');

    const canceled = await runtimeRequest<{
      id: string;
      canceled: boolean;
    }>(
      app.page,
      'POST',
      `/runs/${encodeURIComponent(hangingRun.id)}/cancel`
    );
    expect(canceled).toEqual({
      status: 202,
      body: {
        id: hangingRun.id,
        canceled: true
      }
    });
    const canceledTerminal = await waitForRunTerminal(
      app.page,
      hangingRun.id
    );
    expect(canceledTerminal.status).toBe('canceled');

    const recoveryThread = await runtimeRequest<{
      thread: { id: string };
    }>(app.page, 'POST', '/threads', {
      projectId: project.body.project.id,
      title: '取消后恢复',
      sandbox: 'workspace-write'
    });
    expect(recoveryThread.status).toBe(201);
    const recoveryRun = await startRun(app.page, {
      threadId: recoveryThread.body.thread.id,
      prompt: '验证取消后仍可继续普通会话'
    });
    const recoveryTerminal = await waitForRunTerminal(
      app.page,
      recoveryRun.id
    );
    expect(recoveryTerminal.status).toBe('succeeded');

    const functionalRequests = fixture.modelServer.requests.slice(
      requestBaseline
    );
    const toolNames = collectControlledModelToolNames(functionalRequests);
    expect(forbiddenMultiAgentToolNames(toolNames)).toEqual([]);
    expect(fixture.hostileCodexWasUsed()).toBe(false);
    const runtimeStatus = await readCodexStatus(app.page);
    expect(runtimeStatus.runtime.activationState).toBe('committed');

    writeDesktopE2EReport(
      'clawee-desktop-runtime-tool-loop-e2e.json',
      {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        packageRoot: fixture.packageRoot,
        runtime: runtimeStatus.runtime,
        toolRunId: toolTerminal.id,
        toolThreadId: toolThread.body.thread.id,
        toolCodexThreadId: toolTerminal.codexThreadId,
        toolOutput: CONTROLLED_EXEC_COMMAND_OUTPUT,
        toolOutputPersisted: true,
        toolApproval: approvedToolApproval ?? null,
        canceledRunId: canceledTerminal.id,
        canceledRunStatus: canceledTerminal.status,
        recoveryRunId: recoveryTerminal.id,
        recoveryRunStatus: recoveryTerminal.status,
        modelRequestCount: functionalRequests.length,
        modelToolNames: toolNames,
        forbiddenMultiAgentToolNames: [],
        hostileCodexInvoked: false,
        result: 'PASS'
      }
    );
    reportWritten = true;
  } catch (error) {
    if (!reportWritten) {
      const failureEvidence = app === undefined || app.page.isClosed()
        ? {}
        : await collectToolLoopFailureEvidence({
            page: app.page,
            runId: toolRunId,
            threadId: toolThreadId
          });
      const controlledRequests = fixture.modelServer.requests.slice(
        requestBaseline
      );
      writeDesktopE2EReport(
        'clawee-desktop-runtime-tool-loop-e2e.json',
        {
          generatedAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
          packageRoot: fixture.packageRoot,
          runtime: failureEvidence.codexStatus?.body.runtime ?? null,
          availabilityProbe: probe ?? null,
          toolRunId: toolRunId ?? null,
          toolThreadId: toolThreadId ?? null,
          approvedToolApproval: approvedToolApproval ?? null,
          modelRequestCount: controlledRequests.length,
          modelRequests: controlledRequests.map(request => ({
            path: request.path,
            marker: request.marker,
            responseText: request.responseText,
            toolNames: collectControlledModelToolNames([request]),
            containsToolPrompt: controlledModelRequestContainsText(
              request,
              CONTROLLED_EXEC_COMMAND_PROMPT
            ),
            containsFunctionCallOutput:
              findControlledFunctionCallOutput(
                [request],
                CONTROLLED_EXEC_COMMAND_CALL_ID
              ) !== undefined
          })),
          toolOutputPath: join(
            fixture.workspace,
            'clawee-tool-loop.txt'
          ),
          toolOutput: readFileIfExists(join(
            fixture.workspace,
            'clawee-tool-loop.txt'
          )),
          hostileCodexInvoked: fixture.hostileCodexWasUsed(),
          failureEvidence,
          error: errorDetails(error),
          result: 'FAIL'
        }
      );
    }
    throw error;
  } finally {
    if (app !== undefined) {
      await closePackagedApp(app).catch(() => undefined);
    }
    await fixture.dispose();
  }
});

type RunTerminalOrApproval =
  | { terminal: RunResponse }
  | { approval: RuntimeApproval };

async function waitForRunTerminalOrApproval(
  page: Page,
  runId: string,
  timeoutMs = 30_000
): Promise<RunTerminalOrApproval> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [run, approvals] = await Promise.all([
      runtimeRequest<RunResponse>(
        page,
        'GET',
        `/runs/${encodeURIComponent(runId)}`
      ),
      runtimeRequest<ApprovalListResponse>(
        page,
        'GET',
        `/approvals?status=pending&runId=${encodeURIComponent(runId)}&limit=10`
      )
    ]);
    if (run.status !== 200) {
      throw new Error(`读取运行 ${runId} 失败：HTTP ${run.status}`);
    }
    if (
      run.body.status === 'succeeded'
      || run.body.status === 'failed'
      || run.body.status === 'canceled'
    ) {
      return { terminal: run.body };
    }
    const approval = approvals.body.approvals?.[0];
    if (approvals.status === 200 && approval !== undefined) {
      return { approval };
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`等待运行完成或进入审批超时：${runId}`);
}

async function collectToolLoopFailureEvidence(input: {
  page: Page;
  runId?: string;
  threadId?: string;
}): Promise<Record<string, unknown>> {
  const evidence: Record<string, unknown> = {};
  evidence.codexStatus = await runtimeRequest<Record<string, unknown>>(
    input.page,
    'GET',
    '/codex/status'
  ).catch(error => ({ error: errorDetails(error) }));
  if (input.runId !== undefined) {
    const encodedRunId = encodeURIComponent(input.runId);
    evidence.run = await runtimeRequest<RunResponse>(
      input.page,
      'GET',
      `/runs/${encodedRunId}`
    ).catch(error => ({ error: errorDetails(error) }));
    evidence.approvals = await runtimeRequest<ApprovalListResponse>(
      input.page,
      'GET',
      `/approvals?status=all&runId=${encodedRunId}&limit=50`
    ).catch(error => ({ error: errorDetails(error) }));
    evidence.diagnostics = await runtimeRequest<RunDiagnosticsResponse>(
      input.page,
      'GET',
      `/runs/${encodedRunId}/diagnostics?includeRawRedacted=true`
    ).catch(error => ({ error: errorDetails(error) }));
  }
  if (input.threadId !== undefined) {
    evidence.history = await runtimeRequest<ThreadHistoryResponse>(
      input.page,
      'GET',
      `/threads/${encodeURIComponent(input.threadId)}/history?limit=50`
    ).catch(error => ({ error: errorDetails(error) }));
  }
  return evidence;
}

function readFileIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function errorDetails(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack ?? null
      }
    : { message: String(error) };
}

async function assertDesktopRuntimeSurface(page: Page): Promise<void> {
  const surface = await page.evaluate(async () => {
    const health = await fetch('/.clawee/runtime/healthz');
    return {
      url: window.location.href,
      bridgeKind: window.claweeDesktop?.kind,
      readBootstrapState:
        typeof window.claweeDesktop?.readBootstrapState,
      healthStatus: health.status,
      healthBody: await health.json()
    };
  });
  expect(surface).toMatchObject({
    bridgeKind: 'desktop',
    readBootstrapState: 'function',
    healthStatus: 200,
    healthBody: {
      ok: true,
      runtimeState: 'configuration_required'
    }
  });
  expect(new URL(surface.url)).toMatchObject({
    protocol: 'clawee-app:',
    hostname: 'app'
  });
}

async function startRun(
  page: Page,
  input: {
    threadId: string;
    prompt: string;
    resumeMode?: 'resume_thread';
  }
): Promise<{ id: string }> {
  const response = await runtimeRequest<Record<string, unknown>>(
    page,
    'POST',
    '/runs',
    input
  );
  if (response.status !== 202 || typeof response.body.id !== 'string') {
    throw new Error(
      `POST /runs 失败：HTTP ${response.status} `
      + JSON.stringify(response.body)
    );
  }
  return { id: response.body.id };
}

function findMigrationJournal(dataDir: string): boolean {
  const migrationRoot = join(dataDir, 'codex', 'migrations');
  if (!existsSync(migrationRoot)) return false;
  const pending = [migrationRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.journal.jsonl')) return true;
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
  return false;
}
