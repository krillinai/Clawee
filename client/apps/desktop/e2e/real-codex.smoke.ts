import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  expect,
  test
} from '@playwright/test';
import {
  collectControlledModelToolNames,
  forbiddenMultiAgentToolNames
} from './controlled-model-server.js';
import {
  createEmbeddedRuntimeFixture,
  ensureEmbeddedWorkspaceSignedIn,
  readCodexStatus,
  runtimeRequest,
  waitForAvailabilityProbe,
  waitForRunTerminal,
  writeDesktopE2EReport
} from './embedded-runtime-fixture.js';
import {
  closePackagedApp,
  type PackagedApp
} from './packaged-app.js';

test('实际包内 Codex 完成冷启动 Probe、真实会话和重启恢复', async () => {
  test.skip(
    process.env.CLAWEE_RUN_REAL_CODEX_SMOKE !== '1',
    '包内真实 Codex smoke 只在显式发布验收时运行'
  );
  test.setTimeout(180_000);
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;

  try {
    fixture.writeControlledRuntimeConfig();
    app = await fixture.launch();
    await ensureEmbeddedWorkspaceSignedIn(app.page);

    const bootstrapState = await app.page.evaluate(
      () => window.claweeDesktop?.readBootstrapState()
    );
    expect(bootstrapState).toMatchObject({
      phase: 'ready',
      attempt: 1,
      runtimeId: fixture.manifest.codexRuntimeId,
      runtimeSource: 'embedded-package',
      runtimeTarget: fixture.manifest.codexRuntimeTarget,
      runtimeContentSha256:
        fixture.manifest.codexRuntimeContentSha256
    });
    expect(realpathSync(bootstrapState!.codexEntryPath!).startsWith(
      `${realpathSync(join(fixture.resourcesRoot, 'codex-runtime'))}${sep}`
    )).toBe(true);
    expect(realpathSync(bootstrapState!.codexHome!)).toBe(
      realpathSync(fixture.targetHome)
    );

    const health = await app.page.evaluate(async () => {
      const response = await fetch('/.clawee/runtime/healthz');
      return {
        status: response.status,
        body: await response.json()
      };
    });
    expect(health).toEqual({
      status: 200,
      body: {
        ok: true,
        runtimeState: 'ready'
      }
    });

    const probe = await waitForAvailabilityProbe(app.page);
    expect(probe).toMatchObject({
      status: 'succeeded',
      responseReceived: true
    });
    const initialStatus = await readCodexStatus(app.page);
    expect(initialStatus.runtime).toMatchObject({
      runtimeId: fixture.manifest.codexRuntimeId,
      source: 'embedded-package',
      version: fixture.manifest.codexRuntimeVersion,
      target: fixture.manifest.codexRuntimeTarget,
      contentSha256: fixture.manifest.codexRuntimeContentSha256,
      activationState: 'active_uncommitted',
      committedAt: null
    });

    const createdProject = await runtimeRequest<{
      project: { id: string };
    }>(app.page, 'POST', '/projects', {
      cwd: fixture.workspace,
      name: '包内真实 Codex 验收项目',
      sandbox: 'read-only'
    });
    expect(createdProject.status).toBe(201);
    const createdThread = await runtimeRequest<{
      thread: { id: string };
    }>(app.page, 'POST', '/threads', {
      projectId: createdProject.body.project.id,
      title: '包内真实 Codex 验收会话',
      sandbox: 'read-only'
    });
    expect(createdThread.status).toBe(201);
    const createdRun = await runtimeRequest<{ id: string }>(
      app.page,
      'POST',
      '/runs',
      {
        threadId: createdThread.body.thread.id,
        prompt: 'hello'
      }
    );
    expect(createdRun.status).toBe(202);
    const terminal = await waitForRunTerminal(
      app.page,
      createdRun.body.id
    );
    expect(terminal).toMatchObject({
      status: 'succeeded',
      codexThreadId: expect.any(String)
    });

    const committedStatus = await readCodexStatus(app.page);
    expect(committedStatus.runtime).toMatchObject({
      activationState: 'committed',
      committedAt: expect.any(String)
    });
    expect(fixture.hostileCodexWasUsed()).toBe(false);

    const previous = app;
    await closePackagedApp(previous);
    app = undefined;
    app = await fixture.relaunch(previous);
    await ensureEmbeddedWorkspaceSignedIn(app.page);
    const restartedStatus = await readCodexStatus(app.page);
    expect(restartedStatus.runtime).toMatchObject({
      runtimeId: fixture.manifest.codexRuntimeId,
      source: 'embedded-package',
      activationState: 'committed',
      committedAt: committedStatus.runtime.committedAt
    });
    const persistedThread = await runtimeRequest<{
      thread: {
        id: string;
        codexThreadId: string | null;
      };
    }>(
      app.page,
      'GET',
      `/threads/${encodeURIComponent(createdThread.body.thread.id)}`
    );
    expect(persistedThread.status).toBe(200);
    expect(persistedThread.body.thread).toMatchObject({
      id: createdThread.body.thread.id,
      codexThreadId: terminal.codexThreadId
    });

    await fixture.modelServer.waitForRequestCount(3);
    const toolNames = collectControlledModelToolNames(
      fixture.modelServer.requests
    );
    expect(forbiddenMultiAgentToolNames(toolNames)).toEqual([]);
    expect(fixture.hostileCodexWasUsed()).toBe(false);

    writeDesktopE2EReport(
      'clawee-desktop-real-codex-smoke.json',
      {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        packageRoot: fixture.packageRoot,
        runtime: restartedStatus.runtime,
        probeDurationMs: probe.durationMs,
        availabilityProbe: probe,
        threadId: createdThread.body.thread.id,
        codexThreadId: terminal.codexThreadId,
        runId: terminal.id,
        runStatus: terminal.status,
        bootstrapAttempt: bootstrapState?.attempt,
        restartAttempt: (
          await app.page.evaluate(
            () => window.claweeDesktop?.readBootstrapState()
          )
        )?.attempt,
        modelRequestCount: fixture.modelServer.requests.length,
        modelToolNames: toolNames,
        forbiddenMultiAgentToolNames: [],
        hostileCodexInvoked: false,
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
