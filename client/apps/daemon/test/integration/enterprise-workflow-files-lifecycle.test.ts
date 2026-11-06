import Fastify from 'fastify';
import type { EnterpriseWorkflowArtifact } from '@clawee/protocol';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCapabilityTokenStore } from '../../src/agent-tools/capability-token.js';
import { createAgentScheduleRunInjector } from '../../src/agent-tools/run-injection.js';
import { registerEnterpriseWorkflowRoutes } from '../../src/api/routes.enterprise-workflow.js';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import type { EnterpriseSharedDriveManager } from '../../src/enterprise/shared-drive-manager-2026-08-06.js';
import { createWorkflowRunHistory } from '../../src/enterprise/workflow-run-history.js';
import { createProjectManager } from '../../src/projects/manager.js';
import { createRunManager, type RunManager } from '../../src/runs/manager.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createThreadManager } from '../../src/threads/manager.js';
import type { WorkspaceFileService } from '../../src/workspace-files/service.js';
import { createFakeCodex } from '../helpers/fake-codex.js';

const workflowTools = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async callTool(input: unknown) { return workflowTools.call(input); }
    async close() {}
  }
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));

const task = {
  task_id: 'task-lifecycle', instance_id: 'instance-lifecycle', node_id: 'node-lifecycle',
  node_order: 0, type: 'agent', status: 'pending', instruction: '交付工作流结果',
  input: { text: '原始输入' }, assignee_user_ids: ['user-lifecycle']
};
const artifact: EnterpriseWorkflowArtifact = {
  file_id: 'file-lifecycle', logical_path: 'instances/instance-lifecycle/nodes/node-lifecycle/sub/attachments/report.txt',
  revision: 1, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
};
type Association = {
  user_id: string; run_id: string; complete_key: string; state: string;
  gateway_origin: string; agent_id: string; attachments_json: string;
};
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  workflowTools.call.mockImplementation(async (input: { name: string }) => ({
    structuredContent: input.name === 'workflow_get_task' ? task : { instance_id: task.instance_id, status: 'succeeded' }
  }));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  workflowTools.call.mockReset();
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-lifecycle-'));
  const db = openRuntimeDatabase(join(directory, 'app.sqlite'));
  const projects = createProjectManager({ db, homeDir: directory });
  const project = projects.createProject({ cwd: directory, profile: 'default', sandbox: 'workspace-write' });
  const threads = createThreadManager({ db, dataDir: directory, projectManager: projects });
  const thread = threads.createConversationThread({ projectId: project.id, title: '文件生命周期', profile: 'default', sandbox: 'workspace-write' });
  const identity = { userId: 'user-lifecycle', agentId: 'agent-lifecycle', origin: 'https://gateway.example' };
  const fixture = {
    directory, db, project, threads, thread, identity, server: Fastify(),
    capabilities: createAgentCapabilityTokenStore(),
    managers: [] as RunManager[],
    upload: vi.fn(async (): Promise<EnterpriseWorkflowArtifact> => artifact),
    session: {
      getSnapshot: () => ({ status: 'signed_in', account: { subjectId: identity.userId }, agentId: identity.agentId }),
      requireAccessToken: async () => 'access-token'
    } as unknown as EnterpriseSessionManager,
    http: { revealAccountMcpToken: async () => ({ token: 'mcp-token' }) } as unknown as EnterpriseHttpClient
  };
  cleanups.push(async () => {
    await fixture.server.close();
    for (const manager of fixture.managers) await manager.close({ timeoutMs: 2000 });
    fixture.capabilities.close();
    fixture.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

type Fixture = ReturnType<typeof createFixture>;

async function register(fixture: Fixture, runs: RunManager) {
  await registerEnterpriseWorkflowRoutes(fixture.server, {
    db: fixture.db, threads: fixture.threads, runs,
    session: fixture.session, http: fixture.http, origin: () => fixture.identity.origin,
    canExecute: () => true, capabilities: fixture.capabilities,
    workspaceFiles: {
      download: async ({ path }: { path: string }) => ({ name: path.split('/').at(-1), size: 3, stream: Readable.from([Buffer.from('abc')]) })
    } as unknown as WorkspaceFileService,
    sharedDrive: { uploadWorkflowFile: fixture.upload } as unknown as EnterpriseSharedDriveManager
  });
}

function association(fixture: Fixture) {
  return fixture.db.prepare<[string], Association>('SELECT * FROM enterprise_workflow_runs WHERE task_id=?').get(task.task_id);
}

function seedRun(fixture: Fixture, input: { state?: string; legacy?: boolean; attachments?: EnterpriseWorkflowArtifact[]; instanceId?: string } = {}) {
  fixture.db.prepare(`
    INSERT INTO runs (id,thread_id,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version)
    VALUES (?,?,'running','running','api','default',?,?,'external','workspace-write','test','codex',?,1)
  `).run('run-lifecycle', fixture.thread.id, fixture.directory, fixture.directory, fixture.directory);
  fixture.db.prepare(`
    INSERT INTO enterprise_workflow_runs (task_id,user_id,run_id,complete_key,state,gateway_origin,agent_id,attachments_json)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(task.task_id, fixture.identity.userId, 'run-lifecycle', 'original-complete-key', input.state ?? 'pending',
    input.legacy ? '' : fixture.identity.origin, input.legacy ? '' : fixture.identity.agentId, JSON.stringify(input.attachments ?? []));
  createWorkflowRunHistory(fixture.db).save('run-lifecycle', task.task_id, fixture.identity.userId, {
    instanceId: input.instanceId ?? task.instance_id, workflowName: '工作流', nodeTitle: '交付',
    nodeOrder: 0, instruction: task.instruction, input: '原始输入'
  });
  let status = 'running';
  const runs = {
    getRun: () => ({ id: 'run-lifecycle', threadId: fixture.thread.id, cwd: fixture.directory, status }),
    listEvents: () => [{ type: 'assistant_message', payload: { text: '原始最终结果' } }]
  } as unknown as RunManager;
  const token = fixture.capabilities.issue({
    runId: 'run-lifecycle', threadId: fixture.thread.id, createdBy: 'api', scopes: ['workflow:upload']
  }).token;
  return { runs, headers: { authorization: `Bearer ${token}` }, succeed: () => { status = 'succeeded'; } };
}

function execution(fixture: Fixture) {
  return fixture.server.inject(`/enterprise/workflow-tasks/${task.task_id}/execution`);
}

async function submit(fixture: Fixture) {
  const response = await execution(fixture);
  return fixture.server.inject({ method: 'POST', url: `/enterprise/workflow-tasks/${task.task_id}/submit`, payload: { version: response.json().delivery.version } });
}

function completeCalls() {
  return workflowTools.call.mock.calls.filter(([input]) => input.name === 'workflow_complete_task');
}

function uploadFile(fixture: Fixture, headers: { authorization: string }, path = 'report.txt') {
  return fixture.server.inject({ method: 'POST', url: '/internal/agent-tools/workflow/files/upload', headers, payload: { path } }).then(response => response);
}

function createRuntime(fixture: Fixture, transport: 'exec' | 'app-server') {
  if (transport === 'exec') {
    const fake = createFakeCodex(fixture.directory, {
      stdoutLines: [{ type: 'thread.started', thread_id: 'codex-lifecycle' }, { type: 'turn.started' }, { type: 'turn.completed' }]
    });
    return { bin: fake.bin, spawned: () => existsSync(join(fixture.directory, 'argv.json')), argv: () => fake.readArgv() };
  }
  const bin = join(fixture.directory, 'fake-workflow-app-server.js');
  const argvPath = join(fixture.directory, 'app-server-argv.json');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake-workflow' } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'codex-lifecycle' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-lifecycle', status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId: 'codex-lifecycle', turn: { id: 'turn-lifecycle', status: 'inProgress' } } });
    send({ method: 'turn/completed', params: { threadId: 'codex-lifecycle', turn: { id: 'turn-lifecycle', status: 'completed' } } });
  }
});
`, 'utf8');
  chmodSync(bin, 0o755);
  return { bin, spawned: () => existsSync(argvPath), argv: () => JSON.parse(readFileSync(argvPath, 'utf8')) as string[] };
}

describe('工作流文件生命周期独立回归', () => {
  it.each(['exec', 'app-server'] as const)('%s 真实首次注入前已事务绑定工作流 Run', async transport => {
    const fixture = createFixture();
    const runtime = createRuntime(fixture, transport);
    const enabled = vi.fn((runId: string) => {
      expect(association(fixture)).toMatchObject({
        run_id: runId, user_id: fixture.identity.userId, gateway_origin: fixture.identity.origin,
        agent_id: fixture.identity.agentId, state: 'pending'
      });
      expect(fixture.db.prepare('SELECT run_id FROM enterprise_workflow_run_contexts WHERE run_id=?').get(runId)).toBeDefined();
      return true;
    });
    const injector = createAgentScheduleRunInjector({
      capabilities: fixture.capabilities, getBaseUrl: () => 'http://127.0.0.1:1904',
      scheduleToolsEnabled: false, workflowToolsEnabled: enabled
    });
    const runs = createRunManager({
      db: fixture.db, dataDir: fixture.directory, codexBin: runtime.bin, codexHome: join(fixture.directory, 'codex-home'),
      threadAccess: fixture.threads, runtimeTransport: transport, agentToolInjector: injector
    });
    fixture.managers.push(runs);
    await register(fixture, runs);
    const response = await fixture.server.inject({
      method: 'POST', url: `/enterprise/workflow-tasks/${task.task_id}/execute`,
      payload: { projectId: fixture.project.id, threadId: fixture.thread.id, customInput: '原始输入' }
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(enabled).toHaveBeenCalledExactlyOnceWith(response.json().runId);
    await expect.poll(runtime.spawned, { timeout: 5000 }).toBe(true);
    expect(runtime.argv().join(' ')).toContain('clawee_workflow_upload_file');
    expect(runtime.argv().join(' ')).toContain('clawee_workflow_read_file');
    await expect.poll(() => runs.getRun(response.json().runId)?.status, { timeout: 5000 }).toBe('succeeded');
  });

  it.each(['exec', 'app-server'] as const)('%s 绑定失败回滚初始 Run 且不注入或启动 Runtime', async transport => {
    const fixture = createFixture();
    const runtime = createRuntime(fixture, transport);
    const prepare = vi.fn();
    const beforeRunSpawn = vi.fn();
    const runs = createRunManager({
      db: fixture.db, dataDir: fixture.directory, codexBin: runtime.bin, codexHome: join(fixture.directory, 'codex-home'),
      threadAccess: fixture.threads, runtimeTransport: transport, agentToolInjector: { prepare }, beforeRunSpawn
    });
    fixture.managers.push(runs);
    fixture.db.exec(`CREATE TRIGGER reject_workflow_binding BEFORE INSERT ON enterprise_workflow_run_contexts
      BEGIN SELECT RAISE(ABORT, 'workflow binding rejected'); END`);
    await register(fixture, runs);
    const response = await fixture.server.inject({
      method: 'POST', url: `/enterprise/workflow-tasks/${task.task_id}/execute`,
      payload: { projectId: fixture.project.id, threadId: fixture.thread.id, customInput: '原始输入' }
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('workflow binding rejected');
    expect(association(fixture)).toBeUndefined();
    expect(fixture.db.prepare('SELECT id FROM runs').all()).toEqual([]);
    expect(fixture.db.prepare('SELECT run_id FROM enterprise_workflow_run_contexts').all()).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(beforeRunSpawn).not.toHaveBeenCalled();
    await runs.close({ timeoutMs: 2000 });
    expect(runtime.spawned()).toBe(false);
  });

  it('附件登记期间不能提交，登记完成也不自动上传；人工提交串行防重', async () => {
    const fixture = createFixture();
    const seeded = seedRun(fixture);
    const taskLookup = deferred<{ structuredContent: typeof task }>();
    const first = deferred<EnterpriseWorkflowArtifact>();
    workflowTools.call.mockImplementationOnce(() => taskLookup.promise);
    fixture.upload.mockImplementationOnce(() => first.promise);
    await register(fixture, seeded.runs);
    const firstRequest = uploadFile(fixture, seeded.headers);
    let submission: ReturnType<typeof submit> | undefined;
    try {
      await expect.poll(() => workflowTools.call.mock.calls.length).toBe(1);
      expect(fixture.upload).not.toHaveBeenCalled();
      seeded.succeed();
      expect((await execution(fixture)).json().status).toBe('awaiting_confirmation');
      expect((await submit(fixture)).statusCode).toBe(409);
      expect(completeCalls()).toEqual([]);
      taskLookup.resolve({ structuredContent: task });
      expect((await firstRequest).statusCode).toBe(200);
      expect(JSON.parse(association(fixture)!.attachments_json)).toEqual([]);
      expect(fixture.upload).not.toHaveBeenCalled();
      expect(completeCalls()).toEqual([]);
      submission = submit(fixture);
      await expect.poll(() => fixture.upload.mock.calls.length).toBe(1);
      expect((await submit(fixture)).statusCode).toBe(409);
      expect((await execution(fixture)).json().status).toBe('submitting');
      first.resolve(artifact);
      expect((await submission).json().status).toBe('completed');
      expect(completeCalls()).toEqual([[{
        name: 'workflow_complete_task', arguments: {
          task_id: task.task_id, output: { text: '原始最终结果' }, idempotency_key: 'original-complete-key', attachments: [artifact]
        }
      }]]);
    } finally {
      taskLookup.resolve({ structuredContent: task });
      first.resolve(artifact);
      await Promise.all([firstRequest, submission]);
    }
  });

  it('人工提交部分附件失败保留已上传引用，重试只传剩余附件', async () => {
    const fixture = createFixture();
    const seeded = seedRun(fixture);
    const secondArtifact = { ...artifact, file_id: 'file-second', logical_path: artifact.logical_path.replace('report.txt', 'second.txt') };
    fixture.upload.mockResolvedValueOnce(artifact)
      .mockRejectedValueOnce(new Error('附件上传失败'))
      .mockResolvedValueOnce(secondArtifact);
    await register(fixture, seeded.runs);
    expect((await uploadFile(fixture, seeded.headers)).statusCode).toBe(200);
    expect((await uploadFile(fixture, seeded.headers, 'second.txt')).statusCode).toBe(200);
    seeded.succeed();
    expect((await submit(fixture)).statusCode).toBe(409);
    expect((await execution(fixture)).json().status).toBe('submit_failed');
    expect(JSON.parse(association(fixture)!.attachments_json)).toEqual([artifact]);
    expect(completeCalls()).toEqual([]);
    expect((await submit(fixture)).json().status).toBe('completed');
    expect(fixture.upload).toHaveBeenCalledTimes(3);
    expect(JSON.parse(association(fixture)!.attachments_json)).toEqual([artifact, secondArtifact]);
  });

  it('重开 SQLite 后残留 uploading 标记失败且不丢已存附件或自动完成', async () => {
    const fixture = createFixture();
    const seeded = seedRun(fixture, { state: 'uploading', attachments: [artifact] });
    seeded.succeed();
    fixture.db.close();
    fixture.db = openRuntimeDatabase(join(fixture.directory, 'app.sqlite'));
    const projects = createProjectManager({ db: fixture.db, homeDir: fixture.directory });
    fixture.threads = createThreadManager({ db: fixture.db, dataDir: fixture.directory, projectManager: projects });
    await register(fixture, seeded.runs);
    expect((await execution(fixture)).json().status).toBe('failed');
    expect(association(fixture)).toMatchObject({ state: 'failed', complete_key: 'original-complete-key' });
    expect(JSON.parse(association(fixture)!.attachments_json)).toEqual([artifact]);
    expect(completeCalls()).toEqual([]);
  });

  it('归档存储不可用时明确失败，不长期静默显示同步中', async () => {
    const fixture = createFixture();
    const seeded = seedRun(fixture);
    seeded.succeed();
    workflowTools.call.mockImplementation(async (input: { name: string }) => input.name === 'workflow_get_task' ? { structuredContent: task } : { isError: true, content: [{ text: 'storage_unavailable' }] });
    await register(fixture, seeded.runs);
    expect((await execution(fixture)).json().status).toBe('awaiting_confirmation');
    expect((await submit(fixture)).statusCode).toBe(409);
    expect(association(fixture)).toMatchObject({ state: 'submit_failed', complete_key: 'original-complete-key' });
    await execution(fixture);
    expect(completeCalls()).toHaveLength(1);
  });

  it('旧关联恢复后只进入人工确认，不自动归档结果', async () => {
    const fixture = createFixture();
    const seeded = seedRun(fixture, { legacy: true, attachments: [artifact] });
    seeded.succeed();
    await register(fixture, seeded.runs);
    const context = fixture.db.prepare('SELECT context_json FROM enterprise_workflow_run_contexts').get();
    expect((await execution(fixture)).json()).toMatchObject({ status: 'legacy_pending', runId: 'run-lifecycle' });
    expect(completeCalls()).toEqual([]);
    const response = await fixture.server.inject({ method: 'POST', url: `/enterprise/workflow-tasks/${task.task_id}/execution/recover` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: 'awaiting_confirmation', runId: 'run-lifecycle' });
    expect(association(fixture)).toMatchObject({
      gateway_origin: fixture.identity.origin, agent_id: fixture.identity.agentId,
      complete_key: 'original-complete-key', attachments_json: JSON.stringify([artifact])
    });
    expect(fixture.db.prepare('SELECT context_json FROM enterprise_workflow_run_contexts').get()).toEqual(context);
    expect(completeCalls()).toEqual([]);
    expect((await submit(fixture)).json().status).toBe('completed');
    expect(completeCalls()).toEqual([[{
      name: 'workflow_complete_task', arguments: {
        task_id: task.task_id, output: { text: '原始最终结果' }, idempotency_key: 'original-complete-key', attachments: [artifact]
      }
    }]]);
  });

  it.each(['instance', 'account', 'type', 'status', 'assignee'] as const)('旧关联 %s 不匹配时拒绝恢复且不绑定当前身份', async mismatch => {
    const fixture = createFixture();
    const seeded = seedRun(fixture, { legacy: true, instanceId: mismatch === 'instance' ? 'other-instance' : task.instance_id });
    seeded.succeed();
    if (mismatch === 'account') fixture.identity.userId = 'other-user';
    if (mismatch === 'type') workflowTools.call.mockResolvedValue({ structuredContent: { ...task, type: 'approval' } });
    if (mismatch === 'status') workflowTools.call.mockResolvedValue({ structuredContent: { ...task, status: 'completed' } });
    if (mismatch === 'assignee') workflowTools.call.mockResolvedValue({ isError: true, content: [{ text: 'forbidden' }] });
    await register(fixture, seeded.runs);
    const before = association(fixture);
    const response = await fixture.server.inject({ method: 'POST', url: `/enterprise/workflow-tasks/${task.task_id}/execution/recover` });
    expect(response.statusCode, response.body).toBe(409);
    expect(association(fixture)).toEqual(before);
    expect(association(fixture)).toMatchObject({ gateway_origin: '', agent_id: '', state: 'pending' });
    expect(completeCalls()).toEqual([]);
    if (mismatch === 'account') expect(workflowTools.call).not.toHaveBeenCalled();
  });
});
