import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnterpriseSessionResponse } from '@clawee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerScheduleRoutes } from '../../src/api/routes.schedules.js';
import { EnterpriseHttpError } from '../../src/enterprise/http-client-2026-07-30.js';
import type { RunManager } from '../../src/runs/manager.js';
import { createScheduleCoordinator } from '../../src/scheduler/coordinator.js';
import { ScheduleRepository } from '../../src/scheduler/repository.js';
import { createSchedulerService, type SchedulerServiceOptions } from '../../src/scheduler/service.js';
import { scheduleOperationActors } from '../../src/scheduler/types.js';
import { createWorkflowSchedules } from '../../src/scheduler/workflow.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrations.js';
import { createThreadManager } from '../../src/threads/manager.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const request = { action: 'workflow_start', name: '本机工作流', cron: '* * * * *', timezone: 'UTC', enabled: true, workflow: { templateId: 'template-1', initialInput: { text: '固定输入' } } };

async function fixture(timers?: SchedulerServiceOptions['timers'], enforceModelGate = false) {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-schedule-'));
  const db = openRuntimeDatabase(join(directory, 'runtime.sqlite'));
  const server = Fastify();
  let snapshot: EnterpriseSessionResponse = { status: 'signed_in', account: { subjectId: 'user-1', email: 'test@example.test', name: '测试' }, agentId: 'agent-1', transportSecurity: 'insecure_http' };
  let origin = 'http://127.0.0.1:1904';
  let now = new Date('2026-10-09T00:00:00.000Z');
  let ready = false;
  const clock = { now: () => now };
  const token = vi.fn(async () => 'test-token');
  const http = vi.fn(async (_token: string, method: 'GET' | 'POST', _path: string, _body?: unknown): Promise<{ data: unknown }> => ({ data: method === 'GET' ? { status: 'enabled' } : { instance_id: 'instance-1' } }));
  const repository = new ScheduleRepository(db, { now: () => clock.now().toISOString() });
  const options = { db, repository, session: { getSnapshot: () => snapshot, requireAccessToken: token }, http: { workflowRequest: http }, origin: () => origin, clock };
  const workflow = createWorkflowSchedules(options);
  const threads = createThreadManager({ db, dataDir: directory });
  const createThread = vi.spyOn(threads, 'createScheduleThread');
  const profile = vi.fn(() => ({ ok: true as const }));
  const runs = { hasActiveRunForThread: vi.fn(() => false), startRun: vi.fn(() => ({ id: 'run-1', threadId: 'thread-1', status: 'running' })) } as unknown as RunManager;
  const coordinator = createScheduleCoordinator({ db, repository, threadManager: threads, runManager: runs, defaultCwd: directory, profileValidator: { validateProfileForRun: profile }, workflowSchedules: workflow, clock });
  const scheduler = createSchedulerService({ repository, runManager: runs, workflowSchedules: workflow, clock, canRunAgent: () => ready, timers });
  await registerScheduleRoutes(server, coordinator, scheduler, enforceModelGate ? () => ready : undefined);
  cleanups.push(async () => { scheduler.stop(); await server.close(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, db, server, repository, workflow, options, coordinator, scheduler, threads, createThread, profile, runs, http, token,
    setIdentity(change: Partial<EnterpriseSessionResponse>) { snapshot = { ...snapshot, ...change }; },
    setOrigin(value: string) { origin = value; }, setNow(value: string) { now = new Date(value); },
    setReady(value: boolean) { ready = value; },
    async create() {
      const response = await server.inject({ method: 'POST', url: '/schedules', payload: request });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    }
  };
}

describe('local workflow schedules', () => {
  it.each(['', 'not-a-uuid', 123, 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6'])('rejects invalid creation requestId %s', async requestId => {
    const context = await fixture();
    const response = await context.server.inject({ method: 'POST', url: '/schedules', payload: { ...request, requestId } });
    expect(response.statusCode).toBe(400);
    expect(context.repository.list()).toEqual([]);
    expect(context.http).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent creation retries and triggers the single plan once per Cron time', async () => {
    const context = await fixture();
    const payload = { ...request, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    const responses = await Promise.all(Array.from({ length: 4 }, () => context.server.inject({ method: 'POST', url: '/schedules', payload })));
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    const schedule = responses[0]!.json();
    expect(new Set(responses.map(response => response.json().id)).size).toBe(1);
    expect(context.repository.list()).toHaveLength(1);
    expect(context.repository.listOperations(schedule.id).filter(operation => operation.operation === 'create')).toHaveLength(1);
    expect(schedule).not.toHaveProperty('requestId');
    expect(schedule).not.toHaveProperty('createFingerprint');
    context.setNow('2026-10-09T00:01:00.000Z');
    context.scheduler.processDueSchedulesForTest?.();
    context.scheduler.processDueSchedulesForTest?.();
    await vi.waitFor(() => expect(context.http.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1));
    const operations = context.repository.listOperations(schedule.id).filter(operation => operation.operation === 'timer_trigger');
    expect(operations.filter(operation => operation.status === 'succeeded')).toHaveLength(1);
    expect(new Set(operations.map(operation => operation.triggerId)).size).toBe(1);
    expect(context.createThread).not.toHaveBeenCalled();
    expect(context.runs.startRun).not.toHaveBeenCalled();
  });

  it('reuses a committed creation after actual HTTP response loss and SQLite reopen', async () => {
    const context = await fixture();
    const payload = { ...request, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    context.server.addHook('onSend', async (_request, reply, body) => { reply.raw.destroy(); return body; });
    const origin = await context.server.listen({ port: 0, host: '127.0.0.1' });
    await expect(fetch(`${origin}/schedules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).rejects.toThrow();
    const original = context.repository.list()[0]!;
    expect(original).toBeDefined();
    await context.server.close();
    context.db.close();
    const db = openRuntimeDatabase(join(context.directory, 'runtime.sqlite'));
    cleanups.unshift(async () => { db.close(); });
    const repository = new ScheduleRepository(db);
    const workflow = createWorkflowSchedules({ ...context.options, db, repository });
    context.http.mockRejectedValue(new Error('template disabled or unavailable'));
    const retry = await workflow.create(payload as Parameters<typeof workflow.create>[0]);
    expect(retry.id).toBe(original.id);
    expect(repository.list()).toHaveLength(1);
    expect(repository.listOperations(original.id)).toHaveLength(1);
    expect(context.http).toHaveBeenCalledTimes(1);
  });

  it('serializes creation across separate SQLite connections without relying on local in-flight state', async () => {
    const context = await fixture();
    const db = openRuntimeDatabase(join(context.directory, 'runtime.sqlite'));
    cleanups.unshift(async () => { db.close(); });
    const repository = new ScheduleRepository(db);
    const workflow = createWorkflowSchedules({ ...context.options, db, repository });
    const payload = { ...request, action: 'workflow_start' as const, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    const schedules = await Promise.all([context.workflow.create(payload), workflow.create(payload)]);
    expect(schedules[0]!.id).toBe(schedules[1]!.id);
    expect(repository.list()).toHaveLength(1);
    expect(repository.listOperations(schedules[0]!.id)).toHaveLength(1);
  });

  it('returns current edited and disabled state for the original creation but rejects conflict and deletion', async () => {
    const context = await fixture();
    const payload = { ...request, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    const post = (body: typeof payload) => context.server.inject({ method: 'POST', url: '/schedules', payload: body });
    const first = await post(payload);
    expect(first.statusCode, first.body).toBe(201);
    const id = first.json().id;
    const edit = await context.server.inject({ method: 'PATCH', url: `/schedules/${id}`, payload: { name: '已编辑', enabled: false, workflow: { templateId: 'template-2', initialInput: { edited: true } } } });
    expect(edit.statusCode).toBe(200);
    context.http.mockRejectedValue(new Error('unavailable'));
    const retry = await post(payload);
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(edit.json());
    const conflict = await post({ ...payload, name: '不同内容' });
    expect(conflict.statusCode).toBe(400);
    expect(conflict.json().error.code).toBe('VALIDATION_FAILED');
    const updateKey = await context.server.inject({ method: 'PATCH', url: `/schedules/${id}`, payload: { requestId: payload.requestId } });
    expect(updateKey.statusCode).toBe(400);
    const deleted = await context.server.inject({ method: 'DELETE', url: `/schedules/${id}` });
    expect(deleted.statusCode).toBe(200);
    const afterDelete = await post(payload);
    expect(afterDelete.statusCode).toBe(404);
    expect(context.repository.list()).toEqual([]);
    expect(context.repository.listOperations(id).filter(operation => operation.operation === 'create')).toHaveLength(1);
    expect(context.http).toHaveBeenCalledTimes(2);
  });

  it('fingerprints normalized creation content independent of nested object key order', async () => {
    const context = await fixture();
    const payload = { ...request, name: ' 本机工作流 ', requestId: 'B2512789-C778-4B7C-B7AA-2B1B3C4D5E6F', workflow: { templateId: 'template-1', initialInput: { left: { beta: 2, alpha: 1 }, right: [1, 2] } } };
    const first = await context.server.inject({ method: 'POST', url: '/schedules', payload });
    expect(first.statusCode).toBe(201);
    const retry = await context.server.inject({ method: 'POST', url: '/schedules', payload: { ...payload, name: '本机工作流', enabled: undefined, requestId: payload.requestId.toLowerCase(), workflow: { templateId: 'template-1', initialInput: { right: [1, 2], left: { alpha: 1, beta: 2 } } } } });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    const conflict = await context.server.inject({ method: 'POST', url: '/schedules', payload: { ...payload, workflow: { ...payload.workflow, initialInput: { left: { beta: 2, alpha: 1 }, right: [2, 1] } } } });
    expect(conflict.statusCode).toBe(400);
  });

  it('rejects conflicting concurrent creation content with no duplicate plan or create operation', async () => {
    const context = await fixture();
    const payload = { ...request, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    const responses = await Promise.all([payload, { ...payload, name: '另一内容' }].map(body => context.server.inject({ method: 'POST', url: '/schedules', payload: body })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 400]);
    const schedules = context.repository.list();
    expect(schedules).toHaveLength(1);
    expect(context.repository.listOperations(schedules[0]!.id)).toHaveLength(1);
  });

  it('rolls back creation when the create operation cannot commit and permits the unchanged retry', async () => {
    const context = await fixture();
    const payload = { ...request, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    context.db.exec(`CREATE TRIGGER fail_create_operation BEFORE INSERT ON schedule_operations WHEN NEW.operation = 'create' BEGIN SELECT RAISE(ABORT, 'operation failed'); END`);
    const failed = await context.server.inject({ method: 'POST', url: '/schedules', payload });
    expect(failed.statusCode).toBe(500);
    expect(context.repository.list()).toEqual([]);
    context.db.exec('DROP TRIGGER fail_create_operation');
    const retry = await context.server.inject({ method: 'POST', url: '/schedules', payload });
    expect(retry.statusCode).toBe(201);
    expect(context.repository.list()).toHaveLength(1);
    expect(context.repository.listOperations(retry.json().id)).toHaveLength(1);
  });

  it.each(['signed_out', 'subject', 'agent', 'origin'])('rechecks keyed creation owner after template await during %s change', async change => {
    const context = await fixture();
    context.http.mockImplementationOnce(async () => {
      if (change === 'signed_out') context.setIdentity({ status: 'signed_out' });
      if (change === 'subject') context.setIdentity({ account: { subjectId: 'other', name: '另一账号', email: 'other@example.test' } });
      if (change === 'agent') context.setIdentity({ agentId: 'other-agent' });
      if (change === 'origin') context.setOrigin('http://127.0.0.1:1905');
      return { data: { status: 'enabled' } };
    });
    const response = await context.server.inject({ method: 'POST', url: '/schedules', payload: { ...request, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' } });
    expect(response.statusCode).toBe(change === 'signed_out' ? 401 : 403);
    expect(context.repository.list()).toEqual([]);
  });

  it('keeps original creation fingerprint while a concurrent retry waits for its template', async () => {
    const context = await fixture();
    const payload = { ...request, action: 'workflow_start' as const, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    let finish!: (value: { data: unknown }) => void;
    context.http.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = context.workflow.create(payload);
    await vi.waitFor(() => expect(context.http).toHaveBeenCalledTimes(1));
    const created = await context.workflow.create(payload);
    const edited = await context.workflow.update(created.id, { name: '等待期间已编辑', enabled: false });
    finish({ data: { status: 'enabled' } });
    expect(await pending).toEqual(edited);
    expect(context.repository.listOperations(created.id).filter(operation => operation.operation === 'create')).toHaveLength(1);
  });

  it('does not resurrect a deleted creation while a concurrent retry waits for its template', async () => {
    const context = await fixture();
    const payload = { ...request, action: 'workflow_start' as const, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    let finish!: (value: { data: unknown }) => void;
    context.http.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = context.workflow.create(payload);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SCHEDULE_NOT_FOUND' });
    await vi.waitFor(() => expect(context.http).toHaveBeenCalledTimes(1));
    const created = await context.workflow.create(payload);
    context.workflow.delete(created.id);
    finish({ data: { status: 'enabled' } });
    await rejected;
    expect(context.repository.list()).toEqual([]);
    expect(context.repository.listOperations(created.id).filter(operation => operation.operation === 'create')).toHaveLength(1);
  });

  it('adds a nullable creation fingerprint without backfilling legacy workflow contents', async () => {
    const context = await fixture();
    const schedule = await context.create();
    context.db.exec('ALTER TABLE schedules DROP COLUMN create_fingerprint');
    migrate(context.db);
    migrate(context.db);
    expect(context.repository.getById(schedule.id)).toMatchObject({ createFingerprint: null, workflow: request.workflow });
    expect(context.repository.listOperations(schedule.id)).toHaveLength(1);
  });

  it.each(['subject', 'agent', 'origin'])('isolates creation request IDs by owner %s', async change => {
    const context = await fixture();
    const payload = { ...request, requestId: 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f' };
    const first = await context.server.inject({ method: 'POST', url: '/schedules', payload });
    expect(first.statusCode).toBe(201);
    if (change === 'subject') context.setIdentity({ account: { subjectId: 'other', name: '另一账号', email: 'other@example.test' } });
    if (change === 'agent') context.setIdentity({ agentId: 'other-agent' });
    if (change === 'origin') context.setOrigin('http://127.0.0.1:1905');
    const second = await context.server.inject({ method: 'POST', url: '/schedules', payload });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(first.json().id);
    expect(context.repository.list()).toHaveLength(2);
    const list = await context.server.inject('/schedules?action=workflow_start');
    expect(list.json().schedules.map((schedule: { id: string }) => schedule.id)).toEqual([second.json().id]);
  });

  it('keeps no-key workflow and ordinary Agent creation compatible and distinct keys independent', async () => {
    const context = await fixture();
    const first = await context.create();
    const second = await context.create();
    expect(first.id).not.toBe(second.id);
    const responses = await Promise.all(['b2512789-c778-4b7c-b7aa-2b1b3c4d5e6f', 'b2512789-c778-4b7c-b7aa-2b1b3c4d5e60'].map(requestId => context.server.inject({ method: 'POST', url: '/schedules', payload: { ...request, requestId } })));
    for (const response of responses) expect(response.statusCode).toBe(201);
    expect(context.repository.list()).toHaveLength(4);
    const agent = await context.server.inject({ method: 'POST', url: '/schedules', payload: { name: '旧Agent', cron: '* * * * *', prompt: '任务', cwd: context.directory } });
    expect(agent.statusCode).toBe(201);
    expect(agent.json().threadId).not.toBeNull();
    expect(context.repository.list()).toHaveLength(5);
  });

  it.each([false, true])('filters workflows before damaged Agent binding assertions with readiness=%s', async ready => {
    const context = await fixture(undefined, true);
    const agent = context.coordinator.createManual({ name: '旧Agent', cron: '* * * * *', prompt: '任务', cwd: context.directory });
    context.repository.update(agent.id, { threadId: null, cwd: join(context.directory, 'missing'), canonicalCwd: join(context.directory, 'missing') });
    context.db.exec(`CREATE TRIGGER fail_legacy_binding BEFORE UPDATE OF thread_id ON schedules WHEN OLD.name = '旧Agent' BEGIN SELECT RAISE(ABORT, 'binding repair failed'); END`);
    const schedule = await context.create();
    expect(context.coordinator.ensureBindings()).toMatchObject({ failed: 1 });
    expect(context.repository.getById(agent.id)).toMatchObject({ enabled: false, threadId: null });
    context.setReady(ready);
    const response = await context.server.inject(ready ? '/schedules?action=workflow_start' : '/schedules');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().schedules.map((item: { id: string }) => item.id)).toEqual([schedule.id]);
    expect((await context.server.inject(`/schedules/${schedule.id}`)).statusCode).toBe(200);
    context.setIdentity({ agentId: 'other-agent' });
    const foreign = await context.server.inject(ready ? '/schedules?action=workflow_start' : '/schedules');
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().schedules).toEqual([]);
    context.setReady(true);
    expect((await context.server.inject('/schedules')).statusCode).toBe(500);
    expect(context.repository.getById(agent.id)).toMatchObject({ enabled: false, threadId: null });
  });

  it.each(['agent_run', '', 'workflow_start&action=workflow_start', 'workflow_start%2Fother'])('rejects unsupported schedule action query %s', async action => {
    const context = await fixture(undefined, true);
    const response = await context.server.inject(`/schedules?action=${action}`);
    expect(response.statusCode).toBe(400);
  });

  it('preserves the ordinary ready Agent list while explicitly selecting only workflows', async () => {
    const context = await fixture(undefined, true);
    const agent = context.coordinator.createManual({ name: '旧Agent', cron: '* * * * *', prompt: '任务', cwd: context.directory });
    const schedule = await context.create();
    context.setReady(true);
    const ordinary = await context.server.inject('/schedules');
    expect(ordinary.statusCode).toBe(200);
    expect(new Set(ordinary.json().schedules.map((item: { id: string }) => item.id))).toEqual(new Set([agent.id, schedule.id]));
    const selected = await context.server.inject('/schedules?action=workflow_start');
    expect(selected.statusCode).toBe(200);
    expect(selected.json().schedules.map((item: { id: string }) => item.id)).toEqual([schedule.id]);
    context.setReady(false);
    expect((await context.server.inject(`/schedules/${agent.id}`)).statusCode).toBe(428);
    expect((await context.server.inject({ method: 'POST', url: `/schedules/${agent.id}/run-now` })).statusCode).toBe(428);
    expect(context.runs.startRun).not.toHaveBeenCalled();
  });

  it('runs model-free workflow timers and wakes old Agent plans only after readiness', async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const context = await fixture({
      setTimeout(callback, delay) {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeout() {}
    });
    const agent = context.coordinator.createManual({ name: 'Agent', cron: '* * * * *', prompt: '执行', cwd: context.directory });
    await context.create();
    context.scheduler.start();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delay).toBe(60_000);
    context.setNow('2026-10-09T00:01:00.000Z');
    timers[0]!.callback();
    await vi.waitFor(() => expect(context.http.mock.calls.some(call => call[1] === 'POST')).toBe(true));
    expect(context.runs.startRun).not.toHaveBeenCalled();
    expect(context.repository.getById(agent.id)?.nextRunAt).toBe('2026-10-09T00:01:00.000Z');
    expect(() => context.scheduler.runNow(agent.id)).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
    expect(context.runs.startRun).not.toHaveBeenCalled();
    context.setReady(true);
    context.scheduler.start();
    expect(timers.at(-1)?.delay).toBe(0);
    timers.at(-1)!.callback();
    expect(context.runs.startRun).toHaveBeenCalledTimes(1);
    expect(context.repository.getById(agent.id)).toMatchObject({ lastRunId: 'run-1', nextRunAt: '2026-10-09T00:02:00.000Z' });
    expect(context.http.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
    const result = context.scheduler.runNow(agent.id);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.run?.id).toBe('run-1');
    expect(context.runs.startRun).toHaveBeenCalledTimes(2);
  });
  it('creates a real workflow action without Agent thread, model or profile validation', async () => {
    const context = await fixture();
    const schedule = await context.create();
    expect(schedule).toMatchObject({ action: 'workflow_start', threadId: null, workflow: request.workflow, lastWorkflowInstanceId: null });
    expect(schedule.owner).toBeUndefined();
    expect(JSON.stringify(schedule)).not.toContain('test-token');
    expect(context.repository.getById(schedule.id)?.owner).toEqual({ origin: 'http://127.0.0.1:1904', subjectId: 'user-1', agentId: 'agent-1' });
    expect(context.createThread).not.toHaveBeenCalled();
    expect(context.profile).not.toHaveBeenCalled();
    expect(context.runs.startRun).not.toHaveBeenCalled();
    expect(context.coordinator.ensureBindings()).toEqual({ scanned: 1, repaired: 0, failed: 0, unchanged: 1 });
  });

  it.each([
    { cron: 'invalid' }, { timezone: 'invalid' }, { enabled: 'yes' }, { owner: { subjectId: 'forged' } },
    { profile: 'forged' }, { workflow: { templateId: '', initialInput: {} } },
    { workflow: { templateId: 'template-1', initialInput: [] } },
    { workflow: { templateId: 'template-1', initialInput: { text: 'a'.repeat(1024 * 1024) } } }
  ])('rejects invalid workflow input before any persistence', async invalid => {
    const context = await fixture();
    const response = await context.server.inject({ method: 'POST', url: '/schedules', payload: { ...request, ...invalid } });
    expect([400, 413, 422]).toContain(response.statusCode);
    expect(context.repository.list()).toEqual([]);
    expect(context.http).not.toHaveBeenCalled();
  });

  it.each([401, 403])('rejects creation when template permission returns %s', async status => {
    const context = await fixture();
    context.http.mockRejectedValueOnce(new EnterpriseHttpError('ENTERPRISE_FORBIDDEN', 'response', status, 'private-path-token'));
    const response = await context.server.inject({ method: 'POST', url: '/schedules', payload: request });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain('private-path-token');
    expect(context.repository.list()).toEqual([]);
  });

  it.each(['signed_out', 'subject', 'agent', 'origin'])('protects every CRUD and trigger boundary after %s change', async change => {
    const context = await fixture();
    const schedule = await context.create();
    if (change === 'signed_out') context.setIdentity({ status: 'signed_out' });
    if (change === 'subject') context.setIdentity({ account: { subjectId: 'other', name: '另一账号', email: 'other@example.test' } });
    if (change === 'agent') context.setIdentity({ agentId: 'other-agent' });
    if (change === 'origin') context.setOrigin('http://127.0.0.1:1905');
    expect((await context.server.inject('/schedules')).json().schedules).toEqual([]);
    for (const [method, suffix, payload] of [
      ['GET', '', undefined], ['GET', '/operations', undefined], ['PATCH', '', { enabled: false }],
      ['DELETE', '', undefined], ['POST', '/run-now', undefined]
    ] as const) {
      const response = await context.server.inject({ method, url: `/schedules/${schedule.id}${suffix}`, ...(payload ? { payload } : {}) });
      expect(response.statusCode).toBe(change === 'signed_out' ? 401 : 403);
    }
    const creation = await context.server.inject({ method: 'POST', url: '/schedules', payload: { ...request, owner: { subjectId: 'user-1' } } });
    expect(creation.statusCode).toBe(400);
    expect(context.http).toHaveBeenCalledTimes(1);
    expect(context.repository.getById(schedule.id)?.enabled).toBe(true);
  });

  it('rejects signed out creation and action conversion', async () => {
    const context = await fixture();
    context.setIdentity({ status: 'signed_out' });
    const creation = await context.server.inject({ method: 'POST', url: '/schedules', payload: request });
    expect(creation.statusCode).toBe(401);
    context.setIdentity({ status: 'signed_in' });
    const schedule = await context.create();
    const updated = await context.server.inject({ method: 'PATCH', url: `/schedules/${schedule.id}`, payload: { action: 'agent_run' } });
    expect(updated.statusCode).toBe(400);
    expect(context.repository.getById(schedule.id)?.action).toBe('workflow_start');
  });

  it.each(['create', 'update', 'trigger'])('rechecks identity after awaiting credentials during %s', async operation => {
    const context = await fixture();
    const schedule = operation === 'create' ? undefined : await context.create();
    const previousCalls = context.http.mock.calls.length;
    context.token.mockImplementationOnce(async () => { context.setIdentity({ agentId: 'new-agent' }); return 'new-token'; });
    const response = await context.server.inject(operation === 'create'
      ? { method: 'POST', url: '/schedules', payload: request }
      : operation === 'update'
        ? { method: 'PATCH', url: `/schedules/${schedule.id}`, payload: { enabled: false } }
        : { method: 'POST', url: `/schedules/${schedule.id}/run-now` });
    expect(response.statusCode).toBe(403);
    expect(context.http.mock.calls.length).toBe(previousCalls);
    expect(response.body).not.toContain('new-token');
  });

  it('rechecks identity after Gateway response before returning plan data', async () => {
    const context = await fixture();
    context.http.mockImplementationOnce(async () => { context.setOrigin('http://127.0.0.1:1905'); return { data: { status: 'enabled' } }; });
    const response = await context.server.inject({ method: 'POST', url: '/schedules', payload: request });
    expect(response.statusCode).toBe(403);
    expect(context.repository.list()).toEqual([]);
  });

  it('persists trigger key and input snapshots across failure, editing and service restart', async () => {
    const context = await fixture();
    const schedule = await context.create();
    context.http.mockRejectedValueOnce(new Error('token /private/runtime.sqlite'));
    const first = await context.server.inject({ method: 'POST', url: `/schedules/${schedule.id}/run-now` });
    expect(first.statusCode).toBe(503);
    expect(first.body).not.toContain('/private');
    const triggerId = first.json().error.details.triggerId;
    expect(context.repository.getWorkflowTrigger(triggerId)?.status).toBe('failed');
    const firstBody = context.http.mock.calls[1]![3];
    const edited = await context.server.inject({ method: 'PATCH', url: `/schedules/${schedule.id}`, payload: { workflow: { templateId: 'template-2', initialInput: { text: '新输入' } } } });
    expect(edited.statusCode).toBe(200);
    const restarted = createWorkflowSchedules(context.options);
    const result = await restarted.trigger(context.repository.getById(schedule.id)!, scheduleOperationActors.user, null, triggerId);
    expect(result).toMatchObject({ run: null, triggerId, workflowInstanceId: 'instance-1', skipped: false, queued: false });
    expect(context.http.mock.calls.at(-1)![2]).toContain('template-1/instances');
    expect(context.http.mock.calls.at(-1)![3]).toEqual(firstBody);
    const before = context.http.mock.calls.length;
    await restarted.trigger(context.repository.getById(schedule.id)!, scheduleOperationActors.user, null, triggerId);
    expect(context.http.mock.calls.length).toBe(before);
    const operations = (await context.server.inject(`/schedules/${schedule.id}/operations`)).json().operations;
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({ triggerId, status: 'failed' }), expect.objectContaining({ triggerId, workflowInstanceId: 'instance-1', status: 'succeeded', runId: null })]));
    expect(context.runs.startRun).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent retries and preserves success after response identity changes', async () => {
    const context = await fixture();
    const schedule = await context.create();
    const trigger = context.repository.createWorkflowTrigger(context.repository.getById(schedule.id)!, null, scheduleOperationActors.user);
    let release!: (value: { data: unknown }) => void;
    context.http.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = context.workflow.trigger(context.repository.getById(schedule.id)!, scheduleOperationActors.user, null, trigger.id);
    const second = context.workflow.trigger(context.repository.getById(schedule.id)!, scheduleOperationActors.user, null, trigger.id);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(release).toBeDefined());
    context.setIdentity({ agentId: 'other-agent' });
    release({ data: { instance_id: 'instance-1' } });
    await expect(first).rejects.toMatchObject({ code: 'ENTERPRISE_FORBIDDEN' });
    expect(context.repository.getWorkflowTrigger(trigger.id)).toMatchObject({ status: 'succeeded', workflowInstanceId: 'instance-1' });
    expect(context.http).toHaveBeenCalledTimes(2);
  });

  it('uses existing timer grace and creates no catch-up queue or fake model run', async () => {
    const context = await fixture();
    const schedule = await context.create();
    context.setNow('2026-10-09T00:01:00.000Z');
    context.scheduler.processDueSchedulesForTest!();
    context.scheduler.processDueSchedulesForTest!();
    await vi.waitFor(() => expect(context.repository.getById(schedule.id)?.lastWorkflowInstanceId).toBe('instance-1'));
    expect(context.http.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
    context.setNow('2026-10-09T01:00:00.000Z');
    context.scheduler.processDueSchedulesForTest!();
    expect(context.repository.getById(schedule.id)?.lastStatus).toBe('skipped');
    expect(context.http.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
    expect(context.runs.startRun).not.toHaveBeenCalled();
  });

  it('does not reenable or resurrect a deleted plan while its trigger completes', async () => {
    const context = await fixture();
    const schedule = await context.create();
    let release!: (value: { data: unknown }) => void;
    context.http.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = context.workflow.trigger(context.repository.getById(schedule.id)!, scheduleOperationActors.user);
    await vi.waitFor(() => expect(release).toBeDefined());
    const deleted = await context.server.inject({ method: 'DELETE', url: `/schedules/${schedule.id}` });
    expect(deleted.statusCode).toBe(200);
    release({ data: { instance_id: 'instance-1' } });
    await running;
    expect(context.repository.getById(schedule.id)).toBeNull();
    expect(context.db.prepare('SELECT enabled,deleted_at FROM schedules WHERE id=?').get(schedule.id)).toMatchObject({ enabled: 0, deleted_at: expect.any(String) });
  });

  it('rejects a foreign trigger and ordinary Agent tool actions', async () => {
    const context = await fixture();
    const first = await context.create();
    const second = await context.create();
    const trigger = context.repository.createWorkflowTrigger(context.repository.getById(first.id)!, null, scheduleOperationActors.user);
    const response = await context.server.inject({ method: 'POST', url: `/schedules/${second.id}/run-now`, payload: { triggerId: trigger.id } });
    expect(response.statusCode).toBe(400);
    expect(() => context.scheduler.runNow(first.id, scheduleOperationActors.agent('agent-run'))).toThrow();
    expect(() => context.coordinator.updateFromAgent(first.id, { enabled: false }, { runId: 'agent-run', threadId: 'thread', createdBy: 'api' })).toThrow();
    expect(() => context.coordinator.createFromAgent(request, { runId: 'agent-run', threadId: 'thread', createdBy: 'api' })).toThrow();
  });

  it('upgrades old schedules and operations without modifying their Agent data', async () => {
    const context = await fixture();
    const agent = context.coordinator.createManual({ name: '旧计划', cron: '* * * * *', prompt: '旧任务', cwd: context.directory });
    const operation = context.repository.listOperations(agent.id)[0]!;
    context.db.exec('DROP TABLE workflow_schedule_triggers');
    for (const column of ['action', 'workflow_json', 'owner_origin', 'owner_subject_id', 'owner_agent_id', 'last_workflow_instance_id', 'create_fingerprint']) context.db.exec(`ALTER TABLE schedules DROP COLUMN ${column}`);
    for (const column of ['trigger_id', 'workflow_instance_id']) context.db.exec(`ALTER TABLE schedule_operations DROP COLUMN ${column}`);
    migrate(context.db);
    const restored = context.repository.getById(agent.id)!;
    expect(restored).toMatchObject({ action: 'agent_run', threadId: agent.threadId, prompt: '旧任务' });
    expect(restored.owner).toBeUndefined();
    expect(context.db.prepare('SELECT create_fingerprint FROM schedules WHERE id = ?').get(agent.id)).toEqual({ create_fingerprint: null });
    expect(context.repository.listOperations(agent.id)[0]).toEqual(operation);
    expect(context.coordinator.ensureBindings()).toEqual({ scanned: 1, repaired: 0, failed: 0, unchanged: 1 });
  });
});
