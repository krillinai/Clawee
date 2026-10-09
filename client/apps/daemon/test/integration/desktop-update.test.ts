import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalManager } from '../../src/approvals/manager.js';
import { createUnknownCapabilityMatrix } from '../../src/codex/capabilities.js';
import { createRunManager } from '../../src/runs/manager.js';
import { createScheduleCoordinator } from '../../src/scheduler/coordinator.js';
import { ScheduleRepository } from '../../src/scheduler/repository.js';
import { createSchedulerService } from '../../src/scheduler/service.js';
import { createWorkflowSchedules } from '../../src/scheduler/workflow.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createRunRepository } from '../../src/storage/repositories.js';
import { createThreadManager } from '../../src/threads/manager.js';
import { buildServer, type BuildServerInput } from '../helpers/build-server.js';
import { createFakeCodex } from '../helpers/fake-codex.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { started?: boolean; serverDeployment?: boolean; modelServiceRuntime?: BuildServerInput['modelServiceRuntime'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-desktop-update-'));
  const db = openRuntimeDatabase(join(directory, 'runtime.sqlite'));
  const codexBin = createFakeCodex(directory, { stdoutLines: [], hang: true }).bin;
  const approvals = createApprovalManager({ db });
  const threads = createThreadManager({ db, dataDir: directory });
  const manager = createRunManager({
    db, dataDir: directory, codexBin, codexHome: join(directory, 'codex-home'),
    threadAccess: threads, approvalManager: approvals
  });
  let now = new Date('2026-10-09T00:00:00.000Z');
  const clock = { now: () => now };
  const repository = new ScheduleRepository(db, { now: () => now.toISOString() });
  const token = vi.fn(async () => 'workflow-token');
  const http = vi.fn(async (_token: string, method: 'GET' | 'POST'): Promise<{ data: unknown }> => ({
    data: method === 'GET' ? { status: 'enabled' } : { instance_id: 'instance-1' }
  }));
  const workflow = createWorkflowSchedules({
    db, repository, clock, origin: () => 'https://gateway.example.test',
    session: {
      getSnapshot: () => ({
        status: 'signed_in', transportSecurity: 'secure_https', agentId: 'agent-1',
        account: { subjectId: 'user-1', name: '测试', email: 'test@example.test' }
      }),
      requireAccessToken: token
    },
    http: { workflowRequest: http }
  });
  const timers: Array<{ callback(): void; ms: number; handle: object }> = [];
  const clearTimeout = vi.fn();
  const scheduler = createSchedulerService({
    repository, runManager: manager, workflowSchedules: workflow, clock,
    timers: {
      setTimeout(callback, ms) {
        const handle = {};
        timers.push({ callback, ms, handle });
        return handle;
      },
      clearTimeout
    }
  });
  const coordinator = createScheduleCoordinator({
    db, repository, threadManager: threads, runManager: manager, clock,
    defaultCwd: directory, workflowSchedules: workflow,
    profileValidator: { validateProfileForRun: () => ({ ok: true as const }) },
    onSchedulesChanged: () => scheduler.refreshTimer()
  });
  let server: FastifyInstance | undefined;
  cleanups.push(async () => {
    if (server) await server.close();
    else { scheduler.stop(); await manager.close(); }
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  server = await buildServer({
    token: 'daemon-token', db, dataDir: directory, codexBin,
    runManager: manager, scheduler, scheduleCoordinator: coordinator,
    approvalManager: approvals, schedulerAutostart: options.started ?? false,
    serverDeployment: options.serverDeployment,
    capabilities: { ...createUnknownCapabilityMatrix(), appServerApprovals: options.serverDeployment === true },
    modelServiceRuntime: options.modelServiceRuntime
  });
  const headers = { authorization: 'Bearer daemon-token' };
  const post = (url: string) => server!.inject({ method: 'POST', url, headers });
  const runInput = { prompt: '测试任务', cwd: directory, profile: 'default', sandbox: 'read-only' as const };
  function insertRun(id: string, publicStatus: string, internalStatus = publicStatus) {
    createRunRepository(db).insertRun({
      id, publicStatus, internalStatus, createdBy: 'api', profile: 'default',
      cwd: directory, canonicalCwd: directory, workspaceMode: 'directory',
      sandbox: 'read-only', codexVersion: 'test', codexBin,
      codexHome: join(directory, 'codex-home'), normalizerVersion: 1
    });
  }
  async function createWorkflow() {
    return coordinator.createWorkflow!({
      action: 'workflow_start', name: '工作流计划', cron: '* * * * *', timezone: 'UTC',
      workflow: { templateId: 'template-1', initialInput: {} }
    });
  }
  function createAgentSchedule() {
    return coordinator.createManual({ name: '任务计划', cron: '* * * * *', timezone: 'UTC', prompt: '测试任务' });
  }
  return {
    server, db, directory, manager, scheduler, repository, coordinator, approvals,
    timers, clearTimeout, token, http, headers, post, runInput, insertRun,
    createWorkflow, createAgentSchedule,
    setNow(value: string) { now = new Date(value); }
  };
}

describe('desktop update preparation', () => {
  it.each(['/desktop-update/prepare', '/desktop-update/cancel'])('requires the daemon token for %s', async url => {
    const context = await fixture();
    for (const authorization of [undefined, 'Bearer wrong-token']) {
      const response = await context.server.inject({ method: 'POST', url, headers: authorization ? { authorization } : {} });
      expect(response.statusCode).toBe(401);
    }
    expect(context.manager.prepareDesktopUpdate!()).toBe(true);
  });

  it.each([
    ['/desktop-update/prepare', true], ['/desktop-update/prepare', false],
    ['/desktop-update/cancel', true], ['/desktop-update/cancel', false]
  ] as const)('rejects server deployment for %s without changing scheduler state %s', async (url, started) => {
    const context = await fixture({ serverDeployment: true, started });
    context.createAgentSchedule();
    const timerCount = context.timers.length;
    const response = await context.post(url);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('DESKTOP_UPDATE_UNSUPPORTED');
    expect(context.timers).toHaveLength(timerCount);
    expect(context.clearTimeout).not.toHaveBeenCalled();
    expect(context.manager.startRun(context.runInput).status).toBe('running');
  });

  it.each(['manager', 'scheduler'] as const)('fails closed when an injected %s has no preparation methods', async target => {
    const context = await fixture({ started: true });
    context.createAgentSchedule();
    const gate = target === 'manager' ? context.manager : context.scheduler;
    delete gate.prepareDesktopUpdate;
    const timerCount = context.timers.length;
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(503);
    expect(context.timers).toHaveLength(timerCount);
    expect(context.manager.startRun(context.runInput).status).toBe('running');
  });

  it.each([
    ['running', 'running'], ['queued', 'queued'], ['waiting_approval', 'waiting_approval'],
    ['running', 'waiting_approval'], ['canceling', 'canceling'], ['running', 'spawning']
  ])('rejects unfinished run %s/%s and rolls back both gates', async (publicStatus, internalStatus) => {
    const context = await fixture({ started: true });
    context.createAgentSchedule();
    context.insertRun('busy-run', publicStatus, internalStatus);
    const timersBefore = context.timers.length;
    const response = await context.post('/desktop-update/prepare');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DESKTOP_UPDATE_BUSY');
    expect(context.timers.length).toBeGreaterThan(timersBefore);
    expect(context.manager.startRun(context.runInput).status).toBe('running');
  });

  it('checks all runs rather than a recent list limit', async () => {
    const context = await fixture();
    context.insertRun('old-queued', 'queued');
    for (let index = 0; index < 110; index++) context.insertRun(`terminal-${index}`, 'succeeded');
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(409);
  });

  it('rejects real queued runs and a running task waiting for an approval without canceling them', async () => {
    const context = await fixture();
    const schedule = context.createAgentSchedule();
    const threadId = context.repository.getById(schedule.id)!.threadId!;
    const first = context.manager.startRun({ ...context.runInput, threadId });
    const queued = context.manager.startRun({ ...context.runInput, threadId });
    expect(queued.status).toBe('queued');
    const pending = context.approvals.request({
      runId: first.id, threadId, turnId: 'turn-1', itemId: 'item-1', requestId: 'request-1',
      kind: 'command_execution', risk: 'high', title: '等待审批', summary: '测试', details: {}
    });
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(409);
    expect(context.approvals.get(pending.approval.id)?.status).toBe('pending');
    expect(context.manager.getRun(queued.id)?.status).toBe('queued');
  });

  it('allows terminal runs and makes repeated prepare/cancel idempotent', async () => {
    const context = await fixture({ started: true });
    context.createAgentSchedule();
    for (const status of ['succeeded', 'failed', 'canceled', 'orphaned']) context.insertRun(status, status);
    expect((await context.post('/desktop-update/prepare')).json()).toEqual({ prepared: true });
    const timerCount = context.timers.length;
    expect((await context.post('/desktop-update/prepare')).json()).toEqual({ prepared: true });
    expect(() => context.manager.startRun(context.runInput)).toThrow(expect.objectContaining({ code: 'DESKTOP_UPDATE_PREPARED' }));
    await expect(context.manager.createAndRun(context.runInput)).rejects.toMatchObject({ code: 'DESKTOP_UPDATE_PREPARED' });
    expect((await context.post('/desktop-update/cancel')).json()).toEqual({ prepared: false });
    expect(context.timers.length).toBeGreaterThan(timerCount);
    const resumedCount = context.timers.length;
    expect((await context.post('/desktop-update/cancel')).json()).toEqual({ prepared: false });
    expect(context.timers).toHaveLength(resumedCount);
    expect(context.manager.startRun(context.runInput).status).toBe('running');
  });

  it('does not start an unstarted scheduler on cancel or failed prepare', async () => {
    const context = await fixture();
    context.createAgentSchedule();
    await context.post('/desktop-update/cancel');
    await context.post('/desktop-update/prepare');
    context.scheduler.start();
    expect(context.timers).toHaveLength(0);
    await context.post('/desktop-update/cancel');
    expect(context.timers).toHaveLength(0);
    context.insertRun('queued', 'queued');
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(409);
    expect(context.timers).toHaveLength(0);
  });

  it('rejects a new run competing with a successful prepare, including direct manager calls', async () => {
    const context = await fixture();
    const preparation = context.post('/desktop-update/prepare');
    await preparation;
    const response = await context.server.inject({ method: 'POST', url: '/runs', headers: context.headers, payload: context.runInput });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DESKTOP_UPDATE_PREPARED');
    expect(() => context.manager.startRun({ ...context.runInput, createdBy: 'schedule' })).toThrow();
    expect(context.manager.listRuns()).toEqual([]);
  });

  it('rejects prepare when a run wins the race and keeps receiving runs', async () => {
    const context = await fixture();
    const preparation = context.post('/desktop-update/prepare');
    context.manager.startRun(context.runInput);
    expect((await preparation).statusCode).toBe(409);
    expect(context.manager.startRun(context.runInput).status).toBe('running');
  });

  it('returns HTTP 409 when a request passed authentication before prepare but starts its run afterwards', async () => {
    const context = await fixture();
    const schedule = context.createAgentSchedule();
    const entered = deferred<void>();
    const proceed = deferred<void>();
    context.server.addHook('preHandler', async request => {
      if (request.url !== '/runs') return;
      entered.resolve();
      await proceed.promise;
    });
    const response = context.server.inject({
      method: 'POST', url: '/runs', headers: context.headers,
      payload: { prompt: '竞争请求', threadId: context.repository.getById(schedule.id)!.threadId }
    }).then(result => result);
    await entered.promise;
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(200);
    proceed.resolve();
    expect((await response).statusCode).toBe(409);
    expect((await response).json().error.code).toBe('DESKTOP_UPDATE_PREPARED');
    expect(context.manager.listRuns()).toEqual([]);
  });

  it.each(['agent', 'workflow'] as const)('ignores a %s timer callback captured before stop', async action => {
    const context = await fixture({ started: true });
    if (action === 'workflow') await context.createWorkflow();
    else context.createAgentSchedule();
    const callback = context.timers.at(-1)!.callback;
    context.setNow('2026-10-09T00:01:00.000Z');
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(200);
    callback();
    context.scheduler.processDueSchedulesForTest!();
    context.scheduler.processPendingTriggersForTest!();
    expect(context.manager.listRuns()).toEqual([]);
    expect(context.http.mock.calls.filter(call => call[1] === 'POST')).toEqual([]);
    expect(context.repository.list()[0]?.nextRunAt).toBe('2026-10-09T00:01:00.000Z');
  });

  it('does not consume a pending agent trigger during preparation', async () => {
    const context = await fixture({ started: true });
    const schedule = context.createAgentSchedule();
    context.repository.setPendingTrigger(schedule.id, true);
    context.scheduler.start();
    const callback = context.timers.find(timer => timer.ms === 5_000)!.callback;
    await context.post('/desktop-update/prepare');
    callback();
    context.scheduler.processPendingTriggersForTest!();
    expect(context.repository.getById(schedule.id)?.pendingTrigger).toBe(true);
    expect(context.manager.listRuns()).toEqual([]);
    await context.post('/desktop-update/cancel');
    context.scheduler.processPendingTriggersForTest!();
    expect(context.manager.listRuns()).toHaveLength(1);
  });

  it.each(['manual', 'timer'] as const)('detects %s workflow requests already awaiting credentials', async source => {
    const context = await fixture({ started: true });
    const schedule = await context.createWorkflow();
    const credentials = deferred<string>();
    context.token.mockImplementation(() => credentials.promise);
    let trigger: Promise<unknown> | undefined;
    if (source === 'manual') trigger = context.scheduler.runWorkflowNow!(schedule.id);
    else {
      context.setNow('2026-10-09T00:01:00.000Z');
      context.timers.at(-1)!.callback();
    }
    const response = await context.post('/desktop-update/prepare');
    expect(response.statusCode).toBe(409);
    credentials.resolve('workflow-token');
    if (trigger) await trigger;
    await vi.waitFor(() => expect(context.http.mock.calls.some(call => call[1] === 'POST')).toBe(true));
    await vi.waitFor(async () => expect((await context.post('/desktop-update/prepare')).statusCode).toBe(200));
    await expect(context.scheduler.runWorkflowNow!(schedule.id)).rejects.toMatchObject({ code: 'DESKTOP_UPDATE_PREPARED' });
  });

  it('tracks every concurrent workflow request until its HTTP response settles', async () => {
    const context = await fixture();
    const first = await context.createWorkflow();
    const second = await context.createWorkflow();
    const firstResponse = deferred<{ data: unknown }>();
    const secondResponse = deferred<{ data: unknown }>();
    context.http.mockImplementationOnce(() => firstResponse.promise).mockImplementationOnce(() => secondResponse.promise);
    const firstTrigger = context.scheduler.runWorkflowNow!(first.id);
    const secondTrigger = context.scheduler.runWorkflowNow!(second.id);
    await vi.waitFor(() => expect(context.http).toHaveBeenCalledTimes(4));
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(409);
    firstResponse.resolve({ data: { instance_id: 'first' } });
    await firstTrigger;
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(409);
    secondResponse.resolve({ data: { instance_id: 'second' } });
    await secondTrigger;
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(200);
  });

  it('clears failed asynchronous workflow requests from the busy count', async () => {
    const context = await fixture();
    const schedule = await context.createWorkflow();
    context.http.mockRejectedValueOnce(new Error('offline'));
    await expect(context.scheduler.runWorkflowNow!(schedule.id)).rejects.toBeDefined();
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(200);
  });

  it.each(['manager', 'scheduler'] as const)('rolls back both gates if the %s busy check throws', async target => {
    const context = await fixture({ started: true });
    context.createAgentSchedule();
    const gate = target === 'manager' ? context.manager : context.scheduler;
    const original = gate.prepareDesktopUpdate!;
    vi.spyOn(gate as Required<typeof gate>, 'prepareDesktopUpdate').mockImplementationOnce(() => {
      original();
      throw new Error('busy check failed');
    });
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(503);
    expect(context.manager.startRun(context.runInput).status).toBe('running');
    expect(context.timers.length).toBe(target === 'manager' ? 1 : 2);
  });

  it('rejects manual agent and workflow schedules while prepared', async () => {
    const context = await fixture();
    const agent = context.createAgentSchedule();
    const workflow = await context.createWorkflow();
    await context.post('/desktop-update/prepare');
    expect(() => context.scheduler.runNow(agent.id)).toThrow(expect.objectContaining({ code: 'DESKTOP_UPDATE_PREPARED' }));
    for (const schedule of [agent, workflow]) {
      const response = await context.post(`/schedules/${schedule.id}/run-now`);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DESKTOP_UPDATE_PREPARED');
    }
    await context.post('/desktop-update/cancel');
    expect(context.scheduler.runNow(agent.id).run?.id).toBeDefined();
    await expect(context.scheduler.runWorkflowNow!(workflow.id)).resolves.toBeDefined();
  });

  it('supports preparation without a configured model and ignores readiness restarts while prepared', async () => {
    let ready = false;
    let onReady = () => {};
    const context = await fixture({
      started: true,
      modelServiceRuntime: {
        ready: () => ready,
        status: () => ({ status: 'configuration_required', mode: 'enterprise_managed' }),
        async readApiKey() { return null; },
        async check() { return { status: 'succeeded' }; },
        async configure() { throw new Error('unused'); },
        async resolve() {},
        async signOut() {},
        subscribeReady(listener) { onReady = listener; return () => {}; }
      }
    });
    context.createAgentSchedule();
    expect((await context.server.inject({ method: 'POST', url: '/desktop-update/prepare' })).statusCode).toBe(401);
    expect((await context.post('/desktop-update/prepare')).statusCode).toBe(200);
    for (const url of ['/runs', '/enterprise/knowledge-conversations/thread-1/runs', '/enterprise/workflow-tasks/task-1/execute']) {
      const response = await context.server.inject({ method: 'POST', url, headers: context.headers, payload: context.runInput });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DESKTOP_UPDATE_PREPARED');
    }
    const timerCount = context.timers.length;
    ready = true;
    onReady();
    expect(context.timers).toHaveLength(timerCount);
    expect((await context.post('/desktop-update/cancel')).statusCode).toBe(200);
    expect(context.timers.length).toBeGreaterThan(timerCount);
  });

  it.each([true, false])('keeps manager and workflow gates closed during server shutdown, prepared=%s', async prepared => {
    const context = await fixture({ started: true });
    const schedule = await context.createWorkflow();
    if (prepared) await context.post('/desktop-update/prepare');
    await context.server.close();
    context.manager.cancelDesktopUpdate!();
    context.scheduler.cancelDesktopUpdate!();
    context.scheduler.start();
    expect(() => context.manager.startRun(context.runInput)).toThrow();
    await expect(context.scheduler.runWorkflowNow!(schedule.id)).rejects.toBeDefined();
  });
});
