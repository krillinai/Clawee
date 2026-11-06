import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseWorkflowExecution } from '@clawee/protocol';
import { registerEnterpriseWorkflowRoutes } from '../../src/api/routes.enterprise-workflow.js';
import { createAgentCapabilityTokenStore } from '../../src/agent-tools/capability-token.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseSharedDriveManager } from '../../src/enterprise/shared-drive-manager-2026-08-06.js';
import { createWorkflowRunHistory } from '../../src/enterprise/workflow-run-history.js';
import { createProjectManager } from '../../src/projects/manager.js';
import type { RunManager } from '../../src/runs/manager.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createThreadManager } from '../../src/threads/manager.js';
import type { WorkspaceFileService } from '../../src/workspace-files/service.js';

const tools = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  async connect() {}
  async close() {}
  async callTool(input: unknown) { return tools.call(input); }
} }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  tools.call.mockReset();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-manual-delivery-'));
  const path = join(directory, 'runtime.sqlite');
  const db = openRuntimeDatabase(path);
  const projects = createProjectManager({ db, homeDir: directory });
  const project = projects.createProject({ cwd: directory, profile: 'default', sandbox: 'workspace-write' });
  const threads = createThreadManager({ db, dataDir: directory, projectManager: projects });
  const thread = threads.createConversationThread({ projectId: project.id, title: '人工交付', profile: 'default', sandbox: 'workspace-write' });
  const identity = { userId: 'user-1', agentId: 'agent-1', origin: 'https://gateway.example' };
  const task = { task_id: 'task-1', instance_id: 'instance-1', node_id: 'node-1', node_order: 0, type: 'agent', status: 'pending', instruction: '生成报告', input: { text: '主题' } };
  const records: Array<{ id: string; threadId: string; cwd: string; status: string; createdAt: string; updatedAt: string; text: string }> = [];
  const files = new Map([['report.md', '附件原文'], ['second.md', '另一个附件']]);
  tools.call.mockImplementation(async ({ name }: { name: string }) => ({ structuredContent: name === 'workflow_get_task' ? task : { instance_id: 'instance-1', status: 'succeeded' } }));
  const startRun = vi.fn((input: { threadId: string; prompt: string }, onCreated?: (id: string) => void) => {
    const run = { id: `run-${records.length + 1}`, threadId: input.threadId, cwd: directory, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), text: '' };
    db.prepare("INSERT INTO runs (id,thread_id,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version) VALUES (?,?,'running','running','api','default',?,?,'external','workspace-write','test','codex',?,1)").run(run.id, run.threadId, directory, directory, directory);
    records.push(run);
    onCreated?.(run.id);
    return run;
  });
  const runs = {
    startRun, getRun: (id: string) => records.find(run => run.id === id),
    listRunsByThread: (id: string) => records.filter(run => run.threadId === id),
    hasActiveRunForThread: (id: string) => records.some(run => run.threadId === id && run.status === 'running'),
    listEvents: (id: string) => [{ type: 'assistant_message', payload: { text: records.find(run => run.id === id)?.text ?? '' } }]
  } as unknown as RunManager;
  const capabilities = createAgentCapabilityTokenStore();
  const upload = vi.fn(async (input: { fileName: string; expectedSha256: string }) => ({
    file_id: `file-${input.fileName}`, file_name: input.fileName, logical_path: `attachments/${input.fileName}`, revision: 1, sha256: input.expectedSha256
  }));
  const session = { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: identity.userId }, agentId: identity.agentId }), requireAccessToken: async () => 'token' } as unknown as EnterpriseSessionManager;
  const server = Fastify();
  await registerEnterpriseWorkflowRoutes(server, {
    db, threads, runs, session, http: { revealAccountMcpToken: async () => ({ token: 'mcp' }) } as unknown as EnterpriseHttpClient,
    origin: () => identity.origin, canExecute: () => true, capabilities,
    workspaceFiles: { download: async ({ path }: { path: string }) => {
      const text = files.get(path);
      if (text === undefined) throw new Error('文件不可用');
      return { name: path, size: Buffer.byteLength(text), stream: Readable.from([Buffer.from(text)]) };
    } } as unknown as WorkspaceFileService,
    sharedDrive: { uploadWorkflowFile: upload } as unknown as EnterpriseSharedDriveManager
  });
  server.post('/runs', async () => ({ unexpected: true }));
  cleanups.push(async () => { await server.close(); capabilities.close(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = (suffix: string, payload?: Record<string, unknown>) => server.inject({ method: payload === undefined ? 'GET' : 'POST', url: `/enterprise/workflow-tasks/task-1/${suffix}`, ...(payload === undefined ? {} : { payload }) });
  const execute = (customInput = '主题') => api('execute', { projectId: project.id, threadId: thread.id, customInput });
  const state = async () => (await api('execution')).json<EnterpriseWorkflowExecution>();
  const succeed = (text = 'AI 初稿') => { const run = records.at(-1)!; run.status = 'succeeded'; run.text = text; };
  const stage = (path = 'report.md') => {
    const token = capabilities.issue({ runId: records.at(-1)!.id, threadId: thread.id, createdBy: 'api', scopes: ['workflow:upload'] }).token;
    return server.inject({ method: 'POST', url: '/internal/agent-tools/workflow/files/upload', headers: { authorization: `Bearer ${token}` }, payload: { path } });
  };
  const submit = async () => api('submit', { version: (await state()).delivery!.version });
  return { directory, db, path, server, thread, project, identity, task, records, files, runs, startRun, upload, api, execute, state, succeed, stage, submit };
}

describe('工作流人工交付', () => {
  it('回复结束、轮询和恢复历史都不自动上传或完成', async () => {
    const context = await fixture();
    expect((await context.execute()).statusCode).toBe(202);
    expect((await context.stage()).json()).toMatchObject({ staged: true });
    expect(context.upload).not.toHaveBeenCalled();
    context.succeed();
    const state = await context.state();
    expect(state).toMatchObject({ status: 'awaiting_confirmation', threadId: context.thread.id, delivery: { text: 'AI 初稿', edited: false, locked: false } });
    await context.state();
    expect(tools.call.mock.calls.filter(([input]) => input.name === 'workflow_complete_task')).toHaveLength(0);
    expect(context.upload).not.toHaveBeenCalled();
    expect(createWorkflowRunHistory(context.db).items(context.records, 'user-1').at(-1)).toMatchObject({ status: 'awaiting_confirmation' });
  });

  it('多轮复用会话、幂等键和附件，人工草稿不被后续回复覆盖', async () => {
    const context = await fixture();
    await context.execute();
    await context.stage();
    context.succeed();
    const initial = await context.state();
    const key = context.db.prepare('SELECT complete_key FROM enterprise_workflow_runs').get();
    const saved = await context.api('draft', { version: initial.delivery!.version, text: '人工定稿' });
    expect(saved.json()).toMatchObject({ delivery: { text: '人工定稿', edited: true } });
    const prepared = await context.api('prepare', { projectId: context.project.id });
    expect(prepared.json()).toMatchObject({ threadId: context.thread.id, resuming: true });
    expect((await context.execute('增加论据')).statusCode).toBe(202);
    expect(context.startRun.mock.calls[1]![0]).toMatchObject({ threadId: context.thread.id, prompt: '增加论据' });
    context.succeed('AI 第二稿');
    const next = await context.state();
    expect(next.delivery).toMatchObject({ text: '人工定稿', latestText: 'AI 第二稿', edited: true, files: [expect.objectContaining({ path: 'report.md' })] });
    expect(context.db.prepare('SELECT complete_key FROM enterprise_workflow_runs').get()).toEqual(key);
    const history = createWorkflowRunHistory(context.db).items(context.records, 'user-1');
    expect(history.filter(item => item.type === 'workflow_start')).toHaveLength(1);
    expect(history.filter(item => item.type === 'workflow_status')).toHaveLength(1);
    const submitted = await context.submit();
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().status).toBe('completed');
    expect(context.upload).toHaveBeenCalledTimes(1);
    expect(tools.call).toHaveBeenCalledWith({ name: 'workflow_complete_task', arguments: expect.objectContaining({ output: { text: '人工定稿' }, attachments: [expect.objectContaining({ file_name: 'report.md' })] }) });
  });

  it('未编辑时跟随最新完整回复，人工可主动替换或取消附件', async () => {
    const context = await fixture();
    await context.execute();
    await context.stage();
    context.succeed();
    await context.state();
    await context.execute('重写');
    context.succeed('新版');
    const state = await context.state();
    expect(state.delivery!.text).toBe('新版');
    const changed = await context.api('draft', { version: state.delivery!.version, text: '手动', selectedPaths: [] });
    const reset = await context.api('draft', { version: changed.json().delivery.version, useLatest: true });
    expect(reset.json().delivery).toMatchObject({ text: '新版', edited: false, files: [expect.objectContaining({ selected: false })] });
    await context.submit();
    expect(context.upload).not.toHaveBeenCalled();
  });

  it('拒绝运行中提交、过期版本、非本节点附件和绕过工作流的续聊', async () => {
    const context = await fixture();
    await context.execute();
    expect((await context.api('submit', { version: 0 })).statusCode).toBe(409);
    const bypass = await context.server.inject({ method: 'POST', url: '/runs', payload: { threadId: context.thread.id, prompt: '绕过' } });
    expect(bypass.statusCode).toBe(409);
    context.succeed();
    const state = await context.state();
    expect((await context.api('draft', { version: state.delivery!.version + 1, text: '过期' })).statusCode).toBe(409);
    expect((await context.api('draft', { version: state.delivery!.version, selectedPaths: ['../outside'] })).statusCode).toBe(409);
    expect((await context.api('draft', { version: state.delivery!.version, text: '中'.repeat(400000) })).statusCode).toBe(413);
    expect((await context.api('submit', { version: state.delivery!.version + 1 })).statusCode).toBe(409);
  });

  it.each(['userId', 'agentId', 'origin'] as const)('切换 %s 后不能读取、编辑、续聊或提交原节点', async field => {
    const context = await fixture();
    await context.execute(); context.succeed();
    const state = await context.state();
    context.identity[field] = 'changed';
    expect((await context.state()).status).toBe('idle');
    expect((await context.api('draft', { version: state.delivery!.version, text: '篡改' })).statusCode).toBe(409);
    expect((await context.execute()).statusCode).toBe(409);
    expect((await context.api('submit', { version: state.delivery!.version })).statusCode).toBe(409);
    expect(context.upload).not.toHaveBeenCalled();
  });

  it('提交超时冻结快照，只有人工重试，不重复上传且沿用原幂等键', async () => {
    const context = await fixture();
    await context.execute(); await context.stage(); context.succeed();
    const original = await context.state();
    tools.call.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'workflow_complete_task') throw new Error('连接超时');
      return { structuredContent: context.task };
    });
    expect((await context.submit()).statusCode).toBe(409);
    const frozen = await context.state();
    expect(frozen).toMatchObject({ status: 'submit_failed', delivery: { locked: true } });
    expect((await context.api('draft', { version: frozen.delivery!.version, text: '不同内容' })).statusCode).toBe(409);
    expect((await context.execute('不能续聊')).statusCode).toBe(409);
    await context.state();
    expect(context.upload).toHaveBeenCalledTimes(1);
    tools.call.mockResolvedValue({ structuredContent: { ...context.task, status: 'completed', instance_id: 'instance-1' } });
    expect((await context.api('submit', { version: original.delivery!.version })).json().status).toBe('completed');
    expect(context.upload).toHaveBeenCalledTimes(1);
    const completions = tools.call.mock.calls.filter(([input]) => input.name === 'workflow_complete_task');
    expect(completions).toHaveLength(2);
    expect(completions[0]).toEqual(completions[1]);
    expect((await context.submit()).json().status).toBe('completed');
    expect(tools.call.mock.calls.filter(([input]) => input.name === 'workflow_complete_task')).toHaveLength(2);
  });

  it('文件变化先拒绝上传，允许重新登记后确认', async () => {
    const context = await fixture();
    await context.execute(); await context.stage(); context.succeed();
    await context.state();
    context.files.set('report.md', '已修改');
    const response = await context.submit();
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('文件已变化');
    expect((await context.state()).delivery!.locked).toBe(false);
    expect(context.upload).not.toHaveBeenCalled();
    await context.execute('重新登记');
    await context.stage(); context.succeed('定稿');
    expect((await context.submit()).statusCode).toBe(200);
    expect(context.upload.mock.calls[0]![0].expectedSha256).toBe(createHash('sha256').update('已修改').digest('hex'));
  });

  it('本地草稿通过数据库迁移持久化，重新打开后内容和版本不丢失', async () => {
    const context = await fixture();
    await context.execute(); context.succeed();
    const initial = await context.state();
    await context.api('draft', { version: initial.delivery!.version, text: '重启后保留的人工结果' });
    const before = context.db.prepare('SELECT delivery_json,thread_id FROM enterprise_workflow_runs').get();
    const reopened = openRuntimeDatabase(context.path);
    try { expect(reopened.prepare('SELECT delivery_json,thread_id FROM enterprise_workflow_runs').get()).toEqual(before); }
    finally { reopened.close(); }
  });

  it('其他负责人已完成时拒绝提交，不上传附件', async () => {
    const context = await fixture();
    await context.execute(); await context.stage(); context.succeed();
    await context.state(); context.task.status = 'completed';
    expect((await context.submit()).statusCode).toBe(409);
    expect((await context.state()).status).toBe('conflict');
    expect(context.upload).not.toHaveBeenCalled();
  });
});
