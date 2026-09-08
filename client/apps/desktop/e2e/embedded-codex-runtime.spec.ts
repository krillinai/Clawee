import {
  existsSync,
  realpathSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import { join, sep } from 'node:path';
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
  type PackagedApp
} from './packaged-app.js';

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
    const blockedStatus = await runtimeRequest<{
      error: { code: string };
    }>(app.page, 'GET', '/codex/status');
    expect(blockedStatus).toEqual({
      status: 428,
      body: {
        error: {
          code: 'MODEL_SERVICE_CONFIGURATION_REQUIRED',
          message: '请先配置并验证 Codex 模型服务'
        }
      }
    });
    expect((await runtimeRequest(
      app.page,
      'GET',
      '/projects'
    )).status).toBe(428);
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
    await expect(app.page.locator('.sidebar-brand-version')).toHaveText(
      `v${fixture.appVersion}`
    );

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
      findControlledFunctionCallOutput(
        fixture.modelServer.requests.slice(requestBaseline),
        CONTROLLED_EXEC_COMMAND_CALL_ID
      ) !== undefined
    )).toBe(true);
    const toolOutput = findControlledFunctionCallOutput(
      fixture.modelServer.requests.slice(requestBaseline),
      CONTROLLED_EXEC_COMMAND_CALL_ID
    );
    expect(JSON.stringify(toolOutput)).toContain(
      CONTROLLED_EXEC_COMMAND_OUTPUT
    );
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
