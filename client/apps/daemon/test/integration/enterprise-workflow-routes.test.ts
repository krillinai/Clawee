import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnterpriseHttpClient, EnterpriseHttpError, type EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import { createProjectManager } from '../../src/projects/manager.js';
import type { RunManager } from '../../src/runs/manager.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createThreadManager } from '../../src/threads/manager.js';
import { registerEnterpriseWorkflowRoutes } from '../../src/api/routes.enterprise-workflow.js';
import { registerThreadRoutes } from '../../src/api/routes.threads.js';
import { createWorkflowRunHistory } from '../../src/enterprise/workflow-run-history.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async callTool() { return { structuredContent: { instance_id: 'instance-1', node_id: 'node-1', node_order: 0, instruction: '整理内容', input: { text: '测试主题' }, assignee_user_id: 'other-user', assignee_user_ids: ['other-user', 'user-1'] } }; }
    async close() {}
  }
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('enterprise workflow execution', () => {
  it('真实多节点 approve 与历史 null 摘要返回成功，协议失败返回502且保留401/403', async () => {
    const server = Fastify();
    const origin = 'https://enterprise.example';
    const nextTask = { task_id: 'next', instance_id: 'instance-1', node_id: 'next-node', node_order: 1, type: 'agent', status: 'pending', instruction: '执行下一步', assignee_user_id: 'a', assignee_user_ids: ['a', 'b'], input: null };
    const data = { instance_id: 'instance-1', task_id: 'task-1', status: 'running', next_task: nextTask };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data }))
      .mockResolvedValueOnce(Response.json({ data }))
      .mockResolvedValueOnce(Response.json({ data: { ...data, next_task: { ...nextTask, input: [] } } }))
      .mockResolvedValueOnce(Response.json({ data: [nextTask], meta: { next_cursor: '', has_next: false } }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'unauthorized' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'forbidden' } }, { status: 403 }));
    const db = { prepare: () => ({ run: vi.fn(), get: vi.fn(), all: () => [] }), transaction: <Callback extends (...args: unknown[]) => unknown>(callback: Callback) => callback } as unknown as Database.Database;
    await registerEnterpriseWorkflowRoutes(server, {
      db, runs: {} as RunManager, threads: {} as ReturnType<typeof createThreadManager>,
      session: { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: 'b' } }), requireAccessToken: async () => 'token' } as unknown as EnterpriseSessionManager,
      http: createEnterpriseHttpClient({ origin, fetch: fetchMock }), origin: () => origin, canExecute: () => false
    });
    try {
      const request = { method: 'POST' as const, url: '/enterprise/workflow-tasks/task-1/decision', payload: { decision: 'approve', comment: '', idempotencyKey: 'same-user-key' } };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await server.inject(request);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ data });
      }
      const malformed = await server.inject(request);
      expect(malformed.statusCode).toBe(502);
      expect(malformed.json()).toMatchObject({ error: { code: 'ENTERPRISE_PROTOCOL_ERROR' } });
      const invalidTasks = await server.inject('/enterprise/workflow-tasks');
      expect(invalidTasks.statusCode).toBe(502);
      expect(invalidTasks.json()).toMatchObject({ error: { code: 'ENTERPRISE_PROTOCOL_ERROR' } });
      for (const statusCode of [401, 403]) {
        const response = await server.inject(request);
        expect(response.statusCode).toBe(statusCode);
        expect(response.json()).toMatchObject({ error: { code: statusCode === 401 ? 'ENTERPRISE_UNAUTHORIZED' : 'ENTERPRISE_FORBIDDEN' } });
      }
    } finally { await server.close(); }
  });
  it('透传多候选快照和实际处理人，仅转换操作请求的 camel 字段', async () => {
    const server = Fastify();
    const data = { id: 'instance-1', nodes: [{ assignee_role_ids: ['reviewers'], resolved_user_ids: ['a', 'b'] }], tasks: [{ task_id: 'task-1', assignee_user_id: 'a', assignee_user_ids: ['a', 'b'], handled_by: 'b' }] };
    const workflowRequest = vi.fn(async () => ({ data }));
    const db = { prepare: () => ({ run: vi.fn(), get: vi.fn(), all: () => [] }), transaction: <Callback extends (...args: unknown[]) => unknown>(callback: Callback) => callback } as unknown as Database.Database;
    await registerEnterpriseWorkflowRoutes(server, {
      db, runs: {} as RunManager, threads: {} as ReturnType<typeof createThreadManager>,
      session: { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: 'b' } }), requireAccessToken: async () => 'token' } as unknown as EnterpriseSessionManager,
      http: { workflowRequest } as unknown as EnterpriseHttpClient,
      origin: () => 'https://enterprise.example', canExecute: () => false
    });
    try {
      const detail = await server.inject('/enterprise/workflow-instances/instance-1');
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual({ data });
      await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/task-1/decision', payload: { decision: 'approve', comment: '通过', idempotencyKey: 'key-b' } });
      expect(workflowRequest).toHaveBeenLastCalledWith('token', 'POST', '/api/v1/app/workflow-tasks/task-1/decision', { decision: 'approve', comment: '通过', idempotency_key: 'key-b' });
      await server.inject({ method: 'POST', url: '/enterprise/workflow-templates/template-1/instances', payload: { initialInput: { text: '内容' }, idempotencyKey: 'start-b' } });
      expect(workflowRequest).toHaveBeenLastCalledWith('token', 'POST', '/api/v1/app/workflow-templates/template-1/instances', { initial_input: { text: '内容' }, idempotency_key: 'start-b' });
      workflowRequest.mockRejectedValueOnce(new EnterpriseHttpError('ENTERPRISE_INVALID_REQUEST', 'response', 400, 'invalid_assignees'));
      const invalid = await server.inject({ method: 'POST', url: '/enterprise/workflow-templates/template-1/instances', payload: { initialInput: {}, idempotencyKey: 'invalid' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'ENTERPRISE_INVALID_REQUEST', message: expect.stringContaining('角色没有有效成员') } });
      workflowRequest.mockRejectedValueOnce(new EnterpriseHttpError('ENTERPRISE_SKILL_VERSION_CHANGED', 'response', 409, 'conflict'));
      const conflict = await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/task-1/decision', payload: { decision: 'approve', comment: '', idempotencyKey: 'again' } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.message).toContain('其他候选处理');
    } finally { await server.close(); }
  });
  it('creates a visible project conversation and binds the run to it without duplicating pending runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-thread-'));
    directories.push(directory);
    const db = openRuntimeDatabase(join(directory, 'app.sqlite'));
    const projects = createProjectManager({ db, homeDir: directory });
    const project = projects.createProject({ cwd: directory, profile: 'default', sandbox: 'workspace-write' });
    const threads = createThreadManager({ db, dataDir: directory, projectManager: projects });
    const server = Fastify();
    const associations = new Map<string, { task_id: string; user_id: string; run_id: string; complete_key: string; state: string }>();
    const contexts = new Map<string, { task_id: string; user_id: string; context_json: string; state: string; updated_at: string }>();
    const associationDb = {
      transaction<T extends (...args: any[]) => unknown>(callback: T) { return callback; },
      prepare(sql: string) {
        if (sql.startsWith('INSERT INTO enterprise_workflow_run_contexts')) return { run: (runId: string, taskId: string, userId: string, context: string, state: string, _createdAt: string, updatedAt: string) => {
          contexts.set(runId, { task_id: taskId, user_id: userId, context_json: context, state, updated_at: updatedAt });
        } };
        if (sql.startsWith('UPDATE enterprise_workflow_run_contexts')) return { run: (state: string, updatedAt: string, runId: string) => {
          const context = contexts.get(runId);
          if (context) contexts.set(runId, { ...context, state, updated_at: updatedAt });
        } };
        if (sql.startsWith('SELECT task_id,context_json')) return { get: (runId: string, userId: string) => {
          const context = contexts.get(runId);
          return context?.user_id === userId ? context : undefined;
        } };
        if (sql.includes("WHERE state='pending'")) return { all: () => [...associations.values()].filter(row => row.state === 'pending') };
        if (sql.startsWith('SELECT task_id')) return { get: (id: string) => associations.get(id) };
        if (sql.startsWith('UPDATE enterprise_workflow_runs')) return { run: (state: string, taskId: string, runId: string) => {
          const association = associations.get(taskId);
          if (association?.run_id === runId) associations.set(taskId, { ...association, state });
        } };
        if (sql.startsWith('INSERT INTO')) return { run: (task_id: string, user_id: string, run_id: string, complete_key: string, state: string) => {
          associations.set(task_id, { task_id, user_id, run_id, complete_key, state });
        } };
        return { run: () => undefined };
      }
    } as unknown as Database.Database;
    const startRun = vi.fn((input: { threadId: string }) => ({ id: 'run-1', status: 'running', threadId: input.threadId }));
    const run = { id: 'run-1', status: 'running', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' };
    const runs = {
      startRun,
      getRun: vi.fn(() => ({ ...run, threadId: startRun.mock.results[0]?.value.threadId })),
      listEvents: vi.fn(() => [{ id: 'evt-1', runId: 'run-1', seq: 1, ts: '2026-09-22T00:00:01.000Z', type: 'assistant_message', payload: { type: 'assistant_message', text: '已整理' } }]),
      listRunsByThread: vi.fn(() => startRun.mock.calls.length ? [{ ...run, threadId: startRun.mock.results[0]?.value.threadId }] : []),
      hasActiveRunForThread: vi.fn(() => run.status === 'running'),
      getLastEventSeq: vi.fn(() => 0)
    } as unknown as RunManager;
    try {
      await registerEnterpriseWorkflowRoutes(server, {
        db: associationDb, threads, runs,
        session: {
          getSnapshot: () => ({ status: 'signed_in', account: { subjectId: 'user-1' }, agentId: 'agent-1' }),
          requireAccessToken: async () => 'access-token'
        } as unknown as EnterpriseSessionManager,
        http: {
          revealAccountMcpToken: async () => ({ token: 'mcp-token' }),
          workflowRequest: async (_token: string, _method: string, path: string) => ({ data: path.includes('workflow-instances')
            ? { template_id: 'template-1', nodes: [{ node_id: 'node-1', title: '热点整理' }] }
            : { name: '每日热点' } })
        } as unknown as EnterpriseHttpClient,
        origin: () => 'http://127.0.0.1:1904',
        canExecute: () => true
      });
      await registerThreadRoutes(server, threads, runs, {
        workflowHistoryItems: runList => createWorkflowRunHistory(associationDb).items(runList, 'user-1')
      });
      const prepared = await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/task-1/prepare', payload: { projectId: project.id } });
      expect(prepared.statusCode, prepared.body).toBe(200);
      const { threadId } = prepared.json();
      expect(prepared.json()).toMatchObject({ instruction: '整理内容', input: '测试主题', firstNode: true });
      expect(startRun).not.toHaveBeenCalled();
      expect(threads.listPublicThreads({ assignment: 'assigned' })).toEqual([
        expect.objectContaining({ id: threadId, projectId: project.id, title: '工作流 · 热点整理', purpose: 'conversation', sandbox: 'danger-full-access' })
      ]);
      const request = { method: 'POST' as const, url: '/enterprise/workflow-tasks/task-1/execute', payload: { projectId: project.id, threadId, customInput: '测试主题' } };
      const invalid = await server.inject({ method: 'POST', url: request.url, payload: { projectId: project.id, threadId: 'other-thread', customInput: '无效' } });
      expect(invalid.statusCode).toBe(409);
      expect(startRun).not.toHaveBeenCalled();
      const first = await server.inject(request);
      expect(first.statusCode, first.body).toBe(202);
      expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
        threadId, cwd: directory, sandbox: 'danger-full-access', prompt: '整理内容\n\n任务要求：\n测试主题'
      }));
      expect(createWorkflowRunHistory(associationDb).items([run], 'user-1')).toEqual([
        expect.objectContaining({ type: 'workflow_start', taskId: 'task-1', workflowName: '每日热点', nodeTitle: '热点整理', input: '测试主题', customInput: '测试主题' })
      ]);
      expect(createWorkflowRunHistory(associationDb).items([run], 'another-user')).toEqual([]);
      const initialHistory = await server.inject(`/threads/${threadId}/history`);
      expect(initialHistory.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'workflow_start', workflowName: '每日热点' })
      ]));
      const second = await server.inject(request);
      expect(second.json()).toMatchObject({ runId: 'run-1', threadId, status: 'pending' });
      expect(startRun).toHaveBeenCalledTimes(1);
      run.status = 'succeeded';
      expect(createWorkflowRunHistory(associationDb).items([run], 'user-1')).toEqual([
        expect.objectContaining({ type: 'workflow_start' }),
        expect.objectContaining({ type: 'workflow_status', status: 'syncing' })
      ]);
      const execution = await server.inject('/enterprise/workflow-tasks/task-1/execution');
      expect(execution.json()).toMatchObject({ status: 'completed', runStatus: 'succeeded' });
      expect(createWorkflowRunHistory(associationDb).items([run], 'user-1')).toEqual([
        expect.objectContaining({ type: 'workflow_start' }),
        expect.objectContaining({ type: 'workflow_status', status: 'completed' })
      ]);
      const completedHistory = await server.inject(`/threads/${threadId}/history`);
      expect(completedHistory.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'workflow_status', status: 'completed' })
      ]));
      createWorkflowRunHistory(associationDb).setState('run-1', 'failed');
      expect(createWorkflowRunHistory(associationDb).items([run], 'user-1')).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'workflow_status', status: 'sync_failed' })
      ]));
    } finally {
      await server.close();
      db.close();
    }
  });
});
