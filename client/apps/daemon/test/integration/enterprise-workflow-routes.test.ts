import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
import { createAgentCapabilityTokenStore } from '../../src/agent-tools/capability-token.js';
import type { EnterpriseSharedDriveManager } from '../../src/enterprise/shared-drive-manager-2026-08-06.js';
import type { WorkspaceFileService } from '../../src/workspace-files/service.js';

const workflowTools = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async callTool(input: unknown) { return await workflowTools.call(input) ?? { structuredContent: { instance_id: 'instance-1', node_id: 'node-1', node_order: 0, instruction: '整理内容', input: { text: '测试主题' }, assignee_user_id: 'other-user', assignee_user_ids: ['other-user', 'user-1'] } }; }
    async close() {}
  }
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));

const directories: string[] = [];
afterEach(() => {
  workflowTools.call.mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('enterprise workflow execution', () => {
  it.each(['named', 'unnamed', 'missing-task', 'unavailable', 'identity-changed'] as const)('完成消息保存实际处理人，名称补充不影响完成：%s', async scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-completion-'));
    directories.push(directory);
    const databasePath = join(directory, 'app.sqlite');
    const db = openRuntimeDatabase(databasePath);
    const projects = createProjectManager({ db, homeDir: directory });
    const project = projects.createProject({ cwd: directory, profile: 'default', sandbox: 'workspace-write' });
    const threads = createThreadManager({ db, dataDir: directory, projectManager: projects });
    const thread = threads.createConversationThread({ projectId: project.id, title: '工作流', profile: 'default', sandbox: 'workspace-write' });
    db.prepare(`INSERT INTO runs (id,thread_id,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version) VALUES (?,?,'succeeded','succeeded','api','default',?,?,'external','workspace-write','test','codex',?,1)`).run('run-completion', thread.id, directory, directory, directory);
    db.prepare('INSERT INTO enterprise_workflow_runs (task_id,user_id,run_id,complete_key,state,gateway_origin,agent_id) VALUES (?,?,?,?,?,?,?)').run('task-completion', 'user-1', 'run-completion', 'completion-key', 'pending', 'https://gateway.example', 'agent-1');
    createWorkflowRunHistory(db).save('run-completion', 'task-completion', 'user-1', {
      instanceId: 'instance/1', workflowName: '每日热点', nodeTitle: '生成', nodeOrder: 0, instruction: '生成', input: '主题'
    });
    let userId = 'user-1';
    workflowTools.call.mockImplementation(async (input: { name: string }) => ({ structuredContent: input.name === 'workflow_get_task'
      ? { task_id: 'task-completion', type: 'agent', status: 'pending' }
      : { instance_id: 'instance/1', task_id: 'task-completion', status: 'succeeded' } }));
    const workflowRequest = vi.fn(async () => {
      if (scenario === 'unavailable') throw new Error('display metadata unavailable');
      if (scenario === 'identity-changed') userId = 'another-user';
      return { data: {
        id: 'instance/1', tasks: [{ task_id: scenario === 'missing-task' ? 'another-task' : 'task-completion', status: 'completed', assignee_user_id: 'first-user', assignee_user_ids: ['first-user', 'user-1'], handled_by: 'user-1' }],
        user_names: scenario === 'unnamed' ? {} : { 'first-user': '张三', 'user-1': '李四' }
      } };
    });
    const run = { id: 'run-completion', threadId: thread.id, status: 'succeeded', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:01:00.000Z' };
    const server = Fastify();
    try {
      await registerEnterpriseWorkflowRoutes(server, {
        db, threads,
        runs: { getRun: () => run, listEvents: () => [{ type: 'assistant_message', payload: { text: '已完成' } }] } as unknown as RunManager,
        session: { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: userId }, agentId: 'agent-1' }), requireAccessToken: async () => 'access-token' } as unknown as EnterpriseSessionManager,
        http: { revealAccountMcpToken: async () => ({ token: 'mcp-token' }), workflowRequest } as unknown as EnterpriseHttpClient,
        origin: () => 'https://gateway.example', canExecute: () => true
      });
      const draft = await server.inject('/enterprise/workflow-tasks/task-completion/execution');
      expect(draft.json().status).toBe('awaiting_confirmation');
      expect(workflowRequest).not.toHaveBeenCalled();
      const response = await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/task-completion/submit', payload: { version: draft.json().delivery.version } });
      expect(workflowRequest).toHaveBeenCalledWith('access-token', 'GET', '/api/v1/app/workflow-instances/instance%2F1');
      if (scenario === 'identity-changed') {
        expect(response.statusCode).toBe(409);
        expect(createWorkflowRunHistory(db).items([run], userId)).toEqual([]);
        expect(createWorkflowRunHistory(db).items([run], 'user-1').at(-1)).not.toHaveProperty('completion');
      } else {
        expect(response.json()).toMatchObject({ status: 'completed', runId: run.id });
        const completion = scenario === 'named' ? { handledBy: 'user-1', handledByName: '李四' } : { handledBy: 'user-1' };
        expect(response.json().completion).toEqual(completion);
        expect(createWorkflowRunHistory(db).items([run], 'user-1').at(-1)).toMatchObject({ type: 'workflow_status', status: 'completed' });
        expect((createWorkflowRunHistory(db).items([run], 'user-1').at(-1) as { completion?: unknown }).completion).toEqual(completion);
        await server.inject('/enterprise/workflow-tasks/task-completion/execution');
        expect(workflowTools.call).toHaveBeenCalledTimes(2);
        expect(workflowRequest).toHaveBeenCalledTimes(1);
      }
    } finally {
      await server.close();
      db.close();
    }
    const reopened = openRuntimeDatabase(databasePath);
    try {
      const history = createWorkflowRunHistory(reopened).items([run], 'user-1');
      if (scenario === 'named') expect(history.at(-1)).toMatchObject({ status: 'completed', completion: { handledBy: 'user-1', handledByName: '李四' } });
      expect(createWorkflowRunHistory(reopened).items([run], 'another-user')).toEqual([]);
    } finally { reopened.close(); }
  });

  it('binds file tools to the active identity and uploads only after manual submission', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-files-'));
    directories.push(directory);
    const db = openRuntimeDatabase(join(directory, 'app.sqlite'));
    const projects = createProjectManager({ db, homeDir: directory });
    const project = projects.createProject({ cwd: directory, profile: 'default', sandbox: 'workspace-write' });
    const threads = createThreadManager({ db, dataDir: directory, projectManager: projects });
    const thread = threads.createConversationThread({ projectId: project.id, title: '附件', profile: 'default', sandbox: 'workspace-write' });
    db.prepare(`INSERT INTO runs (id,thread_id,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version) VALUES (?,?,'running','running','api','default',?,?,'external','workspace-write','test','codex',?,1)`).run('run-files', thread.id, directory, directory, directory);
    db.prepare('INSERT INTO enterprise_workflow_runs (task_id,user_id,run_id,complete_key,state,gateway_origin,agent_id) VALUES (?,?,?,?,?,?,?)').run('task-files', 'user-1', 'run-files', 'complete-files', 'pending', 'https://gateway.example', 'agent-1');
    const artifact = { file_id: 'file-1', logical_path: 'instances/i/nodes/n/sub/attachments/report.txt', revision: 1, sha256: 'a'.repeat(64) };
    workflowTools.call.mockResolvedValue({ structuredContent: { type: 'agent', status: 'pending', upstream_artifacts: [artifact] } });
    let userId = 'user-1';
    let agentId = 'agent-1';
    let origin = 'https://gateway.example';
    let status = 'running';
    const capabilities = createAgentCapabilityTokenStore();
    const token = capabilities.issue({ runId: 'run-files', threadId: thread.id, createdBy: 'api', scopes: ['workflow:upload', 'workflow:read'] }).token;
    const downloadLocal = vi.fn(async () => ({ name: 'report.txt', size: 3, stream: Readable.from([Buffer.from('abc')]) }));
    const uploadWorkflowFile = vi.fn(async () => artifact);
    const downloadToProject = vi.fn(async () => ({ relativePath: artifact.logical_path }));
    const server = Fastify();
    try {
      await registerEnterpriseWorkflowRoutes(server, {
        db, threads, capabilities,
        runs: { getRun: () => ({ id: 'run-files', threadId: thread.id, cwd: thread.cwd, status }), listEvents: () => [{ type: 'assistant_message', payload: { text: '最终文本' } }] } as unknown as RunManager,
        session: { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: userId }, agentId }), requireAccessToken: async () => 'token' } as unknown as EnterpriseSessionManager,
        http: { revealAccountMcpToken: async () => ({ token: 'mcp-token' }) } as unknown as EnterpriseHttpClient,
        workspaceFiles: { download: downloadLocal } as unknown as WorkspaceFileService,
        sharedDrive: { uploadWorkflowFile, downloadToProject } as unknown as EnterpriseSharedDriveManager,
        origin: () => origin, canExecute: () => true
      });
      const headers = { authorization: `Bearer ${token}` };
      const upload = await server.inject({ method: 'POST', url: '/internal/agent-tools/workflow/files/upload', headers, payload: { path: 'report.txt' } });
      expect(upload.statusCode, upload.body).toBe(200);
      expect(downloadLocal).toHaveBeenCalledWith({ threadId: thread.id, path: 'report.txt' });
      expect(uploadWorkflowFile).not.toHaveBeenCalled();
      expect(JSON.parse((db.prepare('SELECT attachments_json FROM enterprise_workflow_runs').get() as { attachments_json: string }).attachments_json)).toEqual([]);
      const readFile = () => server.inject({ method: 'POST', url: '/internal/agent-tools/workflow/files/read', headers, payload: { fileId: 'file-1' } });
      expect((await readFile()).statusCode).toBe(200);
      expect(downloadToProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id, expectedArtifact: artifact, overwrite: false }));
      const unknown = await server.inject({ method: 'POST', url: '/internal/agent-tools/workflow/files/read', headers, payload: { fileId: 'outside-context' } });
      expect(unknown.statusCode).toBe(409);
      userId = 'other';
      expect((await readFile()).statusCode).toBe(409);
      userId = 'user-1'; agentId = 'other-agent';
      expect((await readFile()).statusCode).toBe(409);
      agentId = 'agent-1'; origin = 'https://other.example';
      expect((await readFile()).statusCode).toBe(409);
      status = 'succeeded';
      expect((await server.inject('/enterprise/workflow-tasks/task-files/execution')).json().status).toBe('idle');
      expect(workflowTools.call).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'workflow_complete_task' }));
      origin = 'https://gateway.example';
      const draft = await server.inject('/enterprise/workflow-tasks/task-files/execution');
      expect(draft.json().status).toBe('awaiting_confirmation');
      expect(uploadWorkflowFile).not.toHaveBeenCalled();
      await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/task-files/submit', payload: { version: draft.json().delivery.version } });
      expect(uploadWorkflowFile).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-files', idempotencyKey: 'complete-files', fileName: 'report.txt' }));
      await server.inject('/enterprise/workflow-tasks/task-files/execution');
      expect(workflowTools.call).toHaveBeenCalledWith({ name: 'workflow_complete_task', arguments: { task_id: 'task-files', output: { text: '最终文本' }, idempotency_key: 'complete-files', attachments: [artifact] } });
      expect((db.prepare('SELECT state FROM enterprise_workflow_runs').get() as { state: string }).state).toBe('completed');
    } finally {
      await server.close();
      capabilities.close();
      db.close();
    }
  });

  it.each([
    ['failed', true], ['canceled', true], ['failed', false], ['running', false]
  ] as const)('retries a %s pending run only with current permission %s', async (status, allowed) => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-retry-'));
    directories.push(directory);
    const db = openRuntimeDatabase(join(directory, 'app.sqlite'));
    const projects = createProjectManager({ db, homeDir: directory });
    const project = projects.createProject({ cwd: directory, profile: 'default', sandbox: 'workspace-write' });
    const threads = createThreadManager({ db, dataDir: directory, projectManager: projects });
    const thread = threads.createConversationThread({ projectId: project.id, title: '重试', profile: 'default', sandbox: 'workspace-write' });
    const insertRun = (id: string, state: string, threadId = thread.id) => db.prepare(`
      INSERT INTO runs (id,thread_id,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version)
      VALUES (?,? ,?,?,'api','default',?,?,'external','workspace-write','test','codex',?,1)
    `).run(id, threadId, state, state, directory, directory, directory);
    insertRun('old-run', status);
    db.prepare('INSERT INTO enterprise_workflow_runs (task_id,user_id,run_id,complete_key,state,gateway_origin,agent_id) VALUES (?,?,?,?,?,?,?)').run('retry-task', 'user-1', 'old-run', 'old-key', 'pending', 'http://127.0.0.1:1904', 'agent-1');
    const startRun = vi.fn((input: { threadId: string }, onCreated?: (runId: string) => void) => { insertRun('new-run', 'running', input.threadId); onCreated?.('new-run'); return { id: 'new-run', threadId: input.threadId, status: 'running' }; });
    if (!allowed) workflowTools.call.mockResolvedValueOnce({ isError: true, content: [{ text: '权限不足' }] });
    const server = Fastify();
    try {
      await registerEnterpriseWorkflowRoutes(server, {
        db, threads, runs: { startRun, getRun: (id: string) => ({ id, threadId: thread.id, status: id === 'old-run' ? status : 'running' }), listRunsByThread: () => [], listEvents: () => [] } as unknown as RunManager,
        session: { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: 'user-1' }, agentId: 'agent-1' }), requireAccessToken: async () => 'access-token' } as unknown as EnterpriseSessionManager,
        http: { revealAccountMcpToken: async () => ({ token: 'mcp-token' }) } as unknown as EnterpriseHttpClient,
        origin: () => 'http://127.0.0.1:1904', canExecute: () => true
      });
      let threadId = thread.id;
      if (allowed) {
        const preparation = await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/retry-task/prepare', payload: { projectId: project.id } });
        expect(preparation.statusCode, preparation.body).toBe(200);
        threadId = preparation.json().threadId;
        expect(threadId).toBe(thread.id);
      }
      const response = await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/retry-task/execute', payload: { projectId: project.id, threadId, customInput: '重试' } });
      expect(workflowTools.call).toHaveBeenCalled();
      if (allowed) {
        expect(response.statusCode, response.body).toBe(202);
        expect(response.json().runId).toBe('new-run');
        expect(startRun).toHaveBeenCalledTimes(1);
        expect(db.prepare('SELECT state,run_id FROM enterprise_workflow_runs WHERE task_id=?').get('retry-task')).toMatchObject({ state: 'pending', run_id: 'new-run' });
      } else {
        expect(response.statusCode).toBe(409);
        expect(startRun).not.toHaveBeenCalled();
      }
    } finally { await server.close(); db.close(); }
  });
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
  it.each(['token', 'response'] as const)('审批转发在 %s 等待中换号时拒绝旧表单或结果', async stage => {
    const server = Fastify();
    let userId = 'user-a';
    const workflowRequest = vi.fn(async () => {
      if (stage === 'response') userId = 'user-b';
      return { data: { instance_id: 'private-instance', task_id: 'task-1', status: 'running' } };
    });
    const db = { prepare: () => ({ run: vi.fn(), get: vi.fn(), all: () => [] }), transaction: <Callback extends (...args: unknown[]) => unknown>(callback: Callback) => callback } as unknown as Database.Database;
    await registerEnterpriseWorkflowRoutes(server, {
      db, runs: {} as RunManager, threads: {} as ReturnType<typeof createThreadManager>,
      session: { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: userId }, agentId: 'agent-1' }), requireAccessToken: async () => {
        if (stage === 'token') userId = 'user-b';
        return 'token-b';
      } } as unknown as EnterpriseSessionManager,
      http: { workflowRequest } as unknown as EnterpriseHttpClient,
      origin: () => 'https://enterprise.example', canExecute: () => false
    });
    try {
      const response = await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/task-1/decision', payload: { decision: 'approve', comment: '原账号意见', idempotencyKey: 'key-a' } });
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain('private-instance');
      expect(workflowRequest).toHaveBeenCalledTimes(stage === 'token' ? 0 : 1);
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
    const associationDb = db;
    const startRun = vi.fn((input: { threadId: string }, onCreated?: (runId: string) => void) => {
      db.prepare("INSERT INTO runs (id,thread_id,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version) VALUES ('run-1',?,'running','running','api','default',?,?,'external','danger-full-access','test','codex',?,1)").run(input.threadId, directory, directory, directory);
      onCreated?.('run-1'); return { id: 'run-1', status: 'running', threadId: input.threadId };
    });
    const run = { id: 'run-1', status: 'running', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' };
    const runs = {
      startRun,
      getRun: vi.fn(() => ({ ...run, threadId: startRun.mock.results[0]?.value.threadId })),
      listEvents: vi.fn(() => [{ id: 'evt-1', runId: 'run-1', seq: 1, ts: '2026-09-22T00:00:01.000Z', type: 'assistant_message', payload: { type: 'assistant_message', text: '已整理' } }]),
      listRunsByThread: vi.fn(() => startRun.mock.calls.length ? [{ ...run, threadId: startRun.mock.results[0]?.value.threadId }] : []),
      hasActiveRunForThread: vi.fn(() => startRun.mock.calls.length > 0 && run.status === 'running'),
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
        threadId, cwd: directory, sandbox: 'danger-full-access', prompt: expect.stringContaining('整理内容\n\n任务要求：\n测试主题')
      }), expect.any(Function));
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
        expect.objectContaining({ type: 'workflow_status', status: 'awaiting_confirmation' })
      ]);
      const execution = await server.inject('/enterprise/workflow-tasks/task-1/execution');
      expect(execution.json()).toMatchObject({ status: 'awaiting_confirmation', runStatus: 'succeeded' });
      expect(createWorkflowRunHistory(associationDb).items([run], 'user-1')).toEqual([
        expect.objectContaining({ type: 'workflow_start' }),
        expect.objectContaining({ type: 'workflow_status', status: 'awaiting_confirmation' })
      ]);
      const completedHistory = await server.inject(`/threads/${threadId}/history`);
      expect(completedHistory.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'workflow_status', status: 'awaiting_confirmation' })
      ]));
      createWorkflowRunHistory(associationDb).setState('run-1', 'failed');
      expect(createWorkflowRunHistory(associationDb).items([run], 'user-1')).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'workflow_status', status: 'awaiting_confirmation' })
      ]));
    } finally {
      await server.close();
      db.close();
    }
  });

  it('passes first-node temporary input and attachments to the current run only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-input-'));
    directories.push(directory);
    const db = openRuntimeDatabase(join(directory, 'app.sqlite'));
    const projects = createProjectManager({ db, homeDir: directory });
    const project = projects.createProject({ cwd: directory, profile: 'default', sandbox: 'workspace-write' });
    const threads = createThreadManager({ db, dataDir: directory, projectManager: projects });
    workflowTools.call.mockResolvedValue({ structuredContent: {
      instance_id: 'instance-1', task_id: 'task-input', node_id: 'node-1', node_order: 0,
      type: 'agent', status: 'pending', instruction: '整理课程', input: { text: '原始课程要求' },
      assignee_user_id: 'user-1', assignee_user_ids: ['user-1']
    } });
    const startRun = vi.fn((input: { threadId: string; prompt: string; attachmentIds?: string[]; imagePaths?: string[] }, onCreated?: (runId: string) => void) => {
      db.prepare("INSERT INTO runs (id,thread_id,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version) VALUES ('run-input',?,'running','running','api','default',?,?,'external','danger-full-access','test','codex',?,1)").run(input.threadId, directory, directory, directory);
      onCreated?.('run-input');
      return { id: 'run-input', status: 'running', threadId: input.threadId };
    });
    const resolveForRun = vi.fn(async () => ({ imagePaths: [], textContext: '[附件上下文]\n课程资料' }));
    const commit = vi.fn(async () => []);
    const runs = {
      startRun,
      cancelRun: vi.fn(),
      getRun: vi.fn(() => ({ id: 'run-input', threadId: startRun.mock.results[0]?.value.threadId, status: 'running' })),
      listEvents: vi.fn(() => []),
      listRunsByThread: vi.fn(() => []),
      hasActiveRunForThread: vi.fn(() => false)
    } as unknown as RunManager;
    const server = Fastify();
    try {
      const thread = threads.createConversationThread({ projectId: project.id, title: '工作流', profile: 'default', sandbox: 'workspace-write' });
      await registerEnterpriseWorkflowRoutes(server, {
        db, threads, runs,
        session: { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: 'user-1' }, agentId: 'agent-1' }), requireAccessToken: async () => 'token' } as unknown as EnterpriseSessionManager,
        http: { revealAccountMcpToken: async () => ({ token: 'mcp-token' }) } as unknown as EnterpriseHttpClient,
        origin: () => 'https://gateway.example', canExecute: () => true,
        attachmentService: { resolveForRun, commit } as never
      });
      const prepared = await server.inject({ method: 'POST', url: '/enterprise/workflow-tasks/task-input/prepare', payload: { projectId: project.id } });
      expect(prepared.statusCode).toBe(200);
      expect(prepared.json().threadId).not.toBe(thread.id);
      const threadId = prepared.json().threadId as string;
      const response = await server.inject({
        method: 'POST',
        url: '/enterprise/workflow-tasks/task-input/execute',
        payload: {
          projectId: project.id, threadId, customInput: '原始课程要求，聚焦高中阶段',
          draftId: 'draft-input', attachmentIds: ['attachment-input']
        }
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(resolveForRun).toHaveBeenCalledWith({ ids: ['attachment-input'], draftId: 'draft-input' });
      expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.stringContaining('[附件上下文]\n课程资料'),
        attachmentIds: ['attachment-input'],
        imagePaths: []
      }), expect.any(Function));
      expect(startRun.mock.calls[0]?.[0].prompt).not.toContain('初始输入');
      expect(commit).toHaveBeenCalledWith({ ids: ['attachment-input'], draftId: 'draft-input', threadId, runId: 'run-input' });
    } finally {
      await server.close();
      db.close();
    }
  });
});
