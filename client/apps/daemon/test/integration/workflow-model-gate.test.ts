import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import { EnterpriseHttpError } from '../../src/enterprise/http-client-2026-07-30.js';
import type { ModelServiceRuntime } from '../../src/codex/model-service-configuration.js';
import { createRunManager } from '../../src/runs/manager.js';
import { ScheduleRepository } from '../../src/scheduler/repository.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { buildServer } from '../helpers/build-server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const workflowRequest = { action: 'workflow_start', name: '无需模型工作流', cron: '* * * * *', timezone: 'UTC', enabled: false, workflow: { templateId: 'template-1', initialInput: { text: '初始输入' } } };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-model-gate-'));
  const db = openRuntimeDatabase(join(directory, 'runtime.sqlite'));
  const runs = createRunManager({ db, dataDir: directory, codexBin: join(directory, 'no-codex'), codexHome: join(directory, 'codex-home') });
  const startRun = vi.spyOn(runs, 'startRun').mockImplementation(input => ({ id: 'run-gated', threadId: input.threadId, status: 'running' } as ReturnType<typeof runs.startRun>));
  const repository = new ScheduleRepository(db);
  const agent = repository.create({ name: '旧 Agent 计划', cron: '* * * * *', timezone: 'UTC', enabled: false, prompt: '执行 Agent', promptHash: '', promptPreviewRedacted: '执行 Agent', profile: 'default', cwd: directory, canonicalCwd: directory, sandbox: 'read-only', concurrencyPolicy: 'skip', misfirePolicy: 'skip', nextRunAt: null });
  let ready = false;
  let subjectId = 'account-1';
  let credential: { accessToken: string; expiresAt: string } | undefined = { accessToken: 'test-enterprise-token', expiresAt: '2027-10-09T00:00:00Z' };
  let denied = false;
  const listeners = new Set<() => void>();
  const model: ModelServiceRuntime = {
    async check() { return { status: 'succeeded' }; },
    async readApiKey() { return null; },
    ready: () => ready,
    status: () => ready ? { status: 'ready', mode: 'enterprise_managed', configuration: { baseUrl: 'https://api.example.test/v1', model: 'model-1' } } : { status: 'configuration_required', mode: 'enterprise_managed' },
    async resolve() {}, async signOut() { ready = false; },
    async configure() {
      ready = true;
      for (const listener of listeners) listener();
      return { status: 'ready', configuration: { baseUrl: 'https://api.example.test/v1', model: 'model-1' }, apiKeyConfigured: true };
    },
    subscribeReady(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const account = () => ({ subjectId, email: 'test@example.test', name: '测试' });
  const agentId = 'clawee_550e8400-e29b-41d4-a716-446655440000';
  const upstream = vi.fn(async (token: string, method: string, path: string, body?: unknown) => {
    assert.equal(token, credential?.accessToken);
    if (denied) throw new EnterpriseHttpError('ENTERPRISE_FORBIDDEN', 'response', 403, 'forbidden');
    if (method === 'POST') return { data: { instance_id: 'instance-1', task_id: 'task-1', status: 'running' } };
    if (path === '/api/v1/app/workflow-templates') return { data: [{ id: 'template-1', status: 'enabled', nodes: [] }] };
    if (path === '/api/v1/app/workflow-instances') return { data: [{ id: 'instance-1', status: 'running', nodes: [] }] };
    if (path.includes('/workflow-instances/')) return { data: { id: 'instance-1', status: 'running', nodes: [] } };
    if (path.includes('/workflow-tasks')) return { data: [] };
    return { data: { id: 'template-1', status: 'enabled', nodes: [] } };
  });
  const server = await buildServer({
    token: 'test-local-token', dataDir: directory, db, runManager: runs, codexHome: join(directory, 'codex-home'), schedulerAutostart: true, modelServiceRuntime: model,
    enterpriseAgentIdentityStore: { getOrCreate: async () => agentId },
    enterpriseCredentialStore: { read: async () => credential, write: async next => { credential = next; }, delete: async () => { credential = undefined; } },
    enterpriseHttpClient: {
      getMe: async () => ({ account: account(), agentId, status: 'active', frontendAllowed: true }),
      login: async () => ({ account: account(), agentId, accessToken: 'test-enterprise-token', tokenType: 'Bearer', expiresAt: '2027-10-09T00:00:00Z' }),
      logout: async () => {}, workflowRequest: upstream
    } as unknown as EnterpriseHttpClient
  });
  const origin = await server.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => { await server.close(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  async function api(method: string, path: string, body?: unknown, auth = true) {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...(auth ? { Authorization: 'Bearer test-local-token' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  await vi.waitFor(async () => expect((await api('GET', '/enterprise/session')).body.status).toBe('signed_in'));
  return { api, agent, repository, startRun, upstream, model, deny(value: boolean) { denied = value; }, setSubject(value: string) { subjectId = value; } };
}

describe('完整 Server 无模型工作流门禁', () => {
  it('企业登录有效而模型未 ready 时允许模板、计划列表和 workflow_start 创建', async () => {
    const context = await fixture();
    expect(context.model.ready()).toBe(false);
    const capability = await context.api('GET', '/enterprise/workflow-capability');
    expect(capability.status).toBe(200);
    expect(capability.body).toEqual({ canExecute: false });
    expect((await context.api('GET', '/enterprise/workflow-templates')).status).toBe(200);
    const list = await context.api('GET', '/schedules');
    expect(list.status).toBe(200);
    expect(list.body.schedules).toEqual([]);
    const created = await context.api('POST', '/schedules', workflowRequest);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ action: 'workflow_start', threadId: null });
    expect(context.startRun).not.toHaveBeenCalled();
  });

  it('无需模型可管理、发起和查看工作流，但没有本地凭据仍拒绝', async () => {
    const context = await fixture();
    expect((await context.api('GET', '/enterprise/workflow-templates', undefined, false)).status).toBe(401);
    expect((await context.api('GET', '/enterprise/workflow-capability', undefined, false)).status).toBe(401);
    const creation = await context.api('POST', '/schedules', workflowRequest);
    expect(creation.status).toBe(201);
    const schedule = creation.body;
    for (const path of ['/enterprise/workflow-templates/template-1', '/enterprise/workflow-instances', '/enterprise/workflow-instances/instance-1', '/enterprise/workflow-tasks', '/enterprise/workflow-tasks/task-1', `/schedules/${schedule.id}`, `/schedules/${schedule.id}/operations`]) {
      expect((await context.api('GET', path)).status).toBe(200);
    }
    expect((await context.api('PATCH', `/schedules/${schedule.id}`, { name: '已编辑', enabled: true })).status).toBe(200);
    const started = await context.api('POST', `/schedules/${schedule.id}/run-now`);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ run: null, workflowInstanceId: 'instance-1', triggerId: expect.any(String) });
    expect((await context.api('POST', `/schedules/${schedule.id}/run-now`, { triggerId: started.body.triggerId })).status).toBe(202);
    expect((await context.api('POST', '/enterprise/workflow-templates/template-1/instances', { initialInput: {}, idempotencyKey: 'manual-start' })).status).toBe(200);
    expect((await context.api('POST', '/enterprise/workflow-tasks/task-1/decision', { decision: 'approve', comment: '', idempotencyKey: 'approve-start' })).status).toBe(200);
    expect((await context.api('POST', '/enterprise/workflow-tasks/task-1/decision', { decision: 'reject', comment: '', idempotencyKey: 'reject-start' })).status).toBe(200);
    expect((await context.api('DELETE', `/schedules/${schedule.id}`)).status).toBe(200);
    expect(context.startRun).not.toHaveBeenCalled();
  });

  it('对普通 Agent、混合动作和伪造目标保持门禁', async () => {
    const context = await fixture();
    const creation = await context.api('POST', '/schedules', workflowRequest);
    expect(creation.status).toBe(201);
    const schedule = creation.body;
    for (const [method, path, body] of [
      ['POST', '/schedules', { name: 'Agent', cron: '* * * * *', prompt: '运行' }],
      ['POST', '/schedules', { ...workflowRequest, action: 'agent_run', prompt: '运行' }],
      ['POST', '/schedules', { ...workflowRequest, action: ['workflow_start'] }],
      ['GET', `/schedules/${context.agent.id}`, undefined],
      ['GET', `/schedules/${context.agent.id}/operations`, undefined],
      ['PATCH', `/schedules/${context.agent.id}`, { action: 'workflow_start', workflow: workflowRequest.workflow }],
      ['POST', `/schedules/${context.agent.id}/run-now`, { action: 'workflow_start' }],
      ['DELETE', `/schedules/${context.agent.id}`, undefined],
      ['POST', '/runs', { prompt: '运行' }],
      ['POST', '/enterprise/workflow-tasks/task-1/prepare', { projectId: 'project' }],
      ['POST', '/enterprise/workflow-tasks/task-1/execute', { projectId: 'project', threadId: 'thread', customInput: '' }]
    ] as const) {
      const response = await context.api(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(428);
      expect(response.body.error.code).toBe('MODEL_SERVICE_CONFIGURATION_REQUIRED');
    }
    expect((await context.api('POST', '/schedules', { ...workflowRequest, prompt: '混入 Agent 提示词' })).status).toBe(400);
    expect((await context.api('PATCH', `/schedules/${schedule.id}`, { action: 'agent_run', prompt: '混入 Agent' })).status).toBe(400);
    expect((await context.api('POST', `/schedules/${schedule.id}/run-now`, { action: 'agent_run' })).status).toBe(400);
    expect((await context.api('POST', '/schedules/missing-id/run-now', { action: 'workflow_start' })).status).toBe(404);
    expect(context.repository.getById(context.agent.id)?.action).toBe('agent_run');
    expect(context.startRun).not.toHaveBeenCalled();
  });

  it('能力读取仅放行精确 GET 路由，不放行其他方法或路径', async () => {
    const context = await fixture();
    for (const [method, path] of [
      ['POST', '/enterprise/workflow-capability'],
      ['PATCH', '/enterprise/workflow-capability'],
      ['DELETE', '/enterprise/workflow-capability'],
      ['GET', '/enterprise/workflow-capability/other'],
      ['GET', '/enterprise/workflow-capabilities']
    ] as const) {
      const response = await context.api(method, path);
      expect([404, 428], `${method} ${path}`).toContain(response.status);
      expect(response.body.canExecute).toBeUndefined();
    }
    expect(context.startRun).not.toHaveBeenCalled();
  });

  it('放行无模型路由不绕过 Gateway 权限和本地计划归属', async () => {
    const context = await fixture();
    const creation = await context.api('POST', '/schedules', workflowRequest);
    expect(creation.status).toBe(201);
    const schedule = creation.body;
    context.deny(true);
    expect((await context.api('GET', '/enterprise/workflow-templates')).status).toBe(403);
    expect((await context.api('POST', '/schedules', workflowRequest)).status).toBe(403);
    expect((await context.api('POST', `/schedules/${schedule.id}/run-now`)).status).toBe(403);
    expect((await context.api('POST', '/enterprise/workflow-templates/template-1/instances', { initialInput: {}, idempotencyKey: 'denied-start' })).status).toBe(403);
    expect((await context.api('POST', '/enterprise/workflow-tasks/task-1/decision', { decision: 'approve', comment: '', idempotencyKey: 'denied-approve' })).status).toBe(403);
    context.deny(false);
    await context.api('POST', '/enterprise/logout', {});
    context.setSubject('account-2');
    expect((await context.api('POST', '/enterprise/login', { email: 'other@example.test', password: 'test-password' })).status).toBe(200);
    expect((await context.api('GET', `/schedules/${schedule.id}`)).status).toBe(403);
    expect((await context.api('POST', `/schedules/${schedule.id}/run-now`)).status).toBe(403);
    expect((await context.api('GET', '/schedules')).body.schedules).toEqual([]);
    expect(context.startRun).not.toHaveBeenCalled();
  });

  it('模型配置重新唤醒旧 Agent，退出后再次限制 Agent 和企业触发', async () => {
    const context = await fixture();
    const creation = await context.api('POST', '/schedules', workflowRequest);
    expect(creation.status).toBe(201);
    const schedule = creation.body;
    context.repository.update(context.agent.id, { enabled: true, nextRunAt: new Date(Date.now() - 100).toISOString() });
    expect(context.startRun).not.toHaveBeenCalled();
    const configuration = await context.api('POST', '/runtime/model-service/configure', { baseUrl: 'https://api.example.test/v1', model: 'model-1', apiKey: 'test-key' });
    expect(configuration.status).toBe(200);
    await vi.waitFor(() => expect(context.startRun).toHaveBeenCalledOnce());
    expect((await context.api('GET', '/schedules')).body.schedules).toEqual(expect.arrayContaining([expect.objectContaining({ id: context.agent.id }), expect.objectContaining({ id: schedule.id })]));
    expect((await context.api('GET', `/schedules/${context.agent.id}`)).status).toBe(200);
    expect((await context.api('POST', '/enterprise/logout', {})).status).toBe(200);
    expect(context.model.ready()).toBe(false);
    expect((await context.api('POST', `/schedules/${context.agent.id}/run-now`)).status).toBe(428);
    expect((await context.api('POST', `/schedules/${schedule.id}/run-now`)).status).toBe(401);
    expect((await context.api('POST', '/schedules', workflowRequest)).status).toBe(401);
    expect((await context.api('GET', '/enterprise/workflow-templates')).status).toBe(401);
    expect((await context.api('GET', '/enterprise/workflow-capability')).status).toBe(401);
    expect(context.startRun).toHaveBeenCalledOnce();
  });
});
