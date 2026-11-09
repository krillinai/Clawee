import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SharedDriveArtifact } from '@clawee/protocol';
import { createAgentCapabilityTokenStore, type AgentCapabilityTokenStoreOptions } from '../../src/agent-tools/capability-token.js';
import { registerAgentDriveRoutes } from '../../src/agent-tools/drive-routes.js';
import { createAgentScheduleProcessInjector, createAgentScheduleRunInjector } from '../../src/agent-tools/run-injection.js';
import { driveUploadSchema } from '../../src/agent-tools/drive-tools.js';
import { createSharedDriveRepository, sharedDriveDelivery } from '../../src/storage/shared-drive.js';
import { claweeDeveloperInstructions } from '../../src/codex/app-server-host-2026-07-28.js';
import type { RuntimeThread } from '../../src/threads/types.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import type { EnterpriseSharedDriveManager } from '../../src/enterprise/shared-drive-manager-2026-08-06.js';
import { MCP_CHAIN_TIMEOUT_MS } from '../../src/task-mcp/constants.js';

const artifact: SharedDriveArtifact = { space_id: 'employee-space', file_id: 'file_1', logical_path: 'tasks/remote/report.txt', file_name: 'report.txt', content_type: 'text/plain', size_bytes: 6, revision: 1, sha256: 'a'.repeat(64) };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(serverDeployment = true, initiator: string | null = 'employee', tokenOptions: AgentCapabilityTokenStoreOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clawee-p10-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'report.txt'), 'report');
  const db = new Database(join(root, 'runs.db'));
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,thread_id TEXT,public_status TEXT,initiator_user_id TEXT,canonical_cwd TEXT,shared_drive_state_json TEXT)');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,NULL)').run('run_1', 'thread_1', 'running', initiator, root);
  cleanup.push(() => { db.close(); });
  const thread = { id: 'thread_1', projectId: 'project_1', canonicalCwd: root, cwd: root, status: 'active', purpose: 'conversation', sandbox: 'workspace-write' } as RuntimeThread;
  const tokens = createAgentCapabilityTokenStore(tokenOptions); cleanup.push(() => tokens.close());
  const issued = tokens.issue({ runId: 'run_1', threadId: 'thread_1', createdBy: 'api', scopes: ['drive:upload', 'drive:download'] });
  const uploadFile = vi.fn(async (args: Parameters<EnterpriseSharedDriveManager['uploadFile']>[0]) => {
    for await (const _chunk of args.content) { /* 读取真实文件流。 */ }
    args.assertIdentity?.();
    return { fileId: artifact.file_id, spaceId: artifact.space_id, logicalPath: args.logicalPath, fileName: artifact.file_name, sizeBytes: artifact.size_bytes, contentType: artifact.content_type, revision: artifact.revision, sha256: artifact.sha256, created: true, reconciled: false, updatedAt: '2026-10-29T00:00:00Z' };
  });
  const downloadToProject = vi.fn(async (_args: Parameters<EnterpriseSharedDriveManager['downloadToProject']>[0]) => ({ fileId: artifact.file_id, projectId: 'project_1', relativePath: artifact.logical_path, sizeBytes: 6, sha256: artifact.sha256, revision: 1, overwritten: false }));
  const server = Fastify(); cleanup.push(() => server.close());
  await registerAgentDriveRoutes(server, { db, capabilities: tokens, threads: { getThread: () => thread }, session: { getSnapshot: () => ({ status: 'signed_in', account: { subjectId: 'operator' }, agentId: 'agent' }) } as EnterpriseSessionManager, drive: { uploadFile, downloadToProject } as unknown as EnterpriseSharedDriveManager, serverDeployment });
  const headers = { authorization: `Bearer ${issued.token}` };
  return { root, db, tokens, issued, server, headers, thread, uploadFile, downloadToProject };
}

describe('统一网盘工具', () => {
  it('重复上传失败保留已有成功回执，重试成功后恢复完整交付', async () => {
    const f = await fixture();
    const request = { method: 'POST' as const, url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt'] } };
    const first = (await f.server.inject(request)).json();
    f.uploadFile.mockRejectedValueOnce({ code: 'ENTERPRISE_SHARED_FILE_PATH_CONFLICT' });
    expect((await f.server.inject(request)).json()).toMatchObject({ files: [], errors: [{ code: 'ENTERPRISE_SHARED_FILE_PATH_CONFLICT' }] });
    expect(sharedDriveDelivery(createSharedDriveRepository(f.db).read('run_1'))).toMatchObject({ delivery_status: 'incomplete', files: first.files, delivery_errors: [{ code: 'ENTERPRISE_SHARED_FILE_PATH_CONFLICT' }] });
    await f.server.inject(request);
    expect(sharedDriveDelivery(createSharedDriveRepository(f.db).read('run_1'))).toEqual({ delivery_status: 'complete', files: first.files, delivery_errors: [] });
  });
  it.each([false, true])('并行上传晚到的失败不抹掉成功回执（已有回执：%s）', async hasReceipt => {
    const f = await fixture();
    const request = { method: 'POST' as const, url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt'] } };
    const first = hasReceipt ? (await f.server.inject(request)).json() : { files: [] };
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let fail!: () => void;
    const failure = new Promise<void>(resolve => { fail = resolve; });
    f.uploadFile.mockImplementationOnce(async () => { started(); await failure; throw { code: 'UPLOAD_FAILED' }; });
    const pending = f.server.inject(request);
    await ready;
    expect(sharedDriveDelivery(createSharedDriveRepository(f.db).read('run_1'))).toMatchObject({ delivery_status: 'incomplete', files: first.files });
    const success = (await f.server.inject(request)).json();
    fail();
    await pending;
    expect(sharedDriveDelivery(createSharedDriveRepository(f.db).read('run_1'))).toMatchObject({ delivery_status: 'incomplete', files: success.files, delivery_errors: [{ code: 'UPLOAD_FAILED' }] });
  });
  it('只从可信运行取发起员工，逐文件保存成功和失败，不暴露绝对路径', async () => {
    const f = await fixture();
    const response = await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt', '../outside', 'missing.txt'] } });
    expect(response.statusCode).toBe(200);
    expect(f.uploadFile).toHaveBeenCalledOnce();
    expect(f.uploadFile.mock.calls[0]?.[0]).toMatchObject({ forUserId: 'employee', logicalPath: 'tasks/run_1/report.txt' });
    expect(response.json().files).toHaveLength(1); expect(response.json().errors).toHaveLength(2);
    expect(JSON.stringify(response.json())).not.toContain(f.root);
    const state = createSharedDriveRepository(f.db).read('run_1');
    expect(sharedDriveDelivery(state)).toMatchObject({ delivery_status: 'incomplete', files: [expect.objectContaining({ file_id: 'file_1' })], delivery_errors: [expect.anything(), expect.anything()] });
    const repeated = await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt'] } });
    expect(repeated.statusCode).toBe(200);
    expect(createSharedDriveRepository(f.db).read('run_1').uploads.filter(item => item.path === 'report.txt')).toHaveLength(1);
    await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt'], spaceId: 'other-space' } });
    expect(createSharedDriveRepository(f.db).read('run_1').uploads.filter(item => item.path === 'report.txt')).toHaveLength(2);
    expect(sharedDriveDelivery(createSharedDriveRepository(f.db).read('run_1')).files).toHaveLength(1);
  });
  it('本地普通会话不传目标员工，拒绝模型伪造身份和越界链接', async () => {
    const f = await fixture(false);
    expect(driveUploadSchema.safeParse({ paths: ['report.txt'], userId: 'other' }).success).toBe(false);
    const response = await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt'] } });
    expect(response.statusCode).toBe(200); expect(f.uploadFile.mock.calls[0]?.[0].forUserId).toBeUndefined();
    symlinkSync(tmpdir(), join(f.root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['outside/nope.txt'] } });
    expect(escaped.json().errors).toHaveLength(1); expect(f.uploadFile).toHaveBeenCalledOnce();
  });
  it('服务端缺失发起身份时明确失败，绝不使用操作者空间', async () => {
    const f = await fixture(true, null);
    const response = await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt'] } });
    expect(response.json().errors[0].code).toBe('DRIVE_INITIATOR_MISSING'); expect(f.uploadFile).not.toHaveBeenCalled();
    expect(sharedDriveDelivery(createSharedDriveRepository(f.db).read('run_1'))).toMatchObject({ delivery_status: 'incomplete', files: [], delivery_errors: [{ code: 'DRIVE_INITIATOR_MISSING' }] });
  });
  it('长任务和文件传输不因默认五分钟授权过期，运行结束后仍撤销能力', async () => {
    let now = 1_000;
    const f = await fixture(true, 'employee', { clock: { now: () => now } });
    now += 6 * 60_000;
    const upload = f.uploadFile.getMockImplementation()!;
    f.uploadFile.mockImplementationOnce(async args => { now += 31 * 60_000; return upload(args); });
    const response = await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt'] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().files).toHaveLength(1);
    expect(response.json().errors).toEqual([]);
    f.tokens.revokeRun('run_1');
    const revoked = await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/upload', headers: f.headers, payload: { paths: ['report.txt'] } });
    expect(revoked.statusCode).toBe(401);
    expect(f.uploadFile).toHaveBeenCalledOnce();
  });
  it('下载回执持久化，页面重试只处理失败项并保留成功项', async () => {
    const f = await fixture(false);
    const second = { ...artifact, file_id: 'file_2', file_name: 'second.txt' };
    f.downloadToProject.mockResolvedValueOnce({ fileId: artifact.file_id, projectId: 'project_1', relativePath: artifact.logical_path, sizeBytes: 6, sha256: artifact.sha256, revision: 1, overwritten: false }).mockRejectedValueOnce({ code: 'ENTERPRISE_SHARED_FILE_LOCAL_EXISTS' });
    const response = await f.server.inject({ method: 'POST', url: '/internal/agent-tools/drive/download', headers: f.headers, payload: { files: [artifact, second] } });
    expect(response.json().downloads.map((item: { status: string }) => item.status)).toEqual(['downloaded', 'failed']);
    const reopened = new Database(join(f.root, 'runs.db'));
    expect(createSharedDriveRepository(reopened).read('run_1').downloads).toHaveLength(2); reopened.close();
    f.db.prepare("UPDATE runs SET public_status='succeeded'").run();
    const retry = await f.server.inject({ method: 'POST', url: '/runs/run_1/shared-drive/download' });
    expect(retry.statusCode).toBe(200); expect(f.downloadToProject).toHaveBeenCalledTimes(3);
    expect(f.downloadToProject.mock.calls[2]?.[0]).toMatchObject({ fileId: 'file_2', expectedArtifact: second, overwrite: false });
    expect(retry.json().downloads.every((item: { status: string }) => item.status === 'downloaded')).toBe(true);
  });
  it('短事务合并保留并行调用的回执，遗留 pending 不被视为成功', async () => {
    const f = await fixture(); const first = createSharedDriveRepository(f.db); const second = createSharedDriveRepository(f.db);
    first.merge('run_1', state => state.uploads.push({ path: 'a.txt', logicalPath: 'tasks/a.txt', status: 'pending' }));
    second.merge('run_1', state => state.downloads.push({ artifact, status: 'downloaded', relativePath: artifact.logical_path }));
    expect(first.read('run_1').downloads).toHaveLength(1);
    expect(sharedDriveDelivery(first.read('run_1'))).toMatchObject({ delivery_status: 'incomplete', files: [], delivery_errors: [{ code: 'TRANSFER_INTERRUPTED' }] });
    expect(sharedDriveDelivery()).toEqual({ delivery_status: 'none', files: [], delivery_errors: [] });
  });
  it('同一成果并行取回时，后完成的冲突不覆盖已落盘的成功回执', async () => {
    const f = await fixture(false);
    let secondStarted!: () => void;
    const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
    let releaseSecond!: () => void;
    const firstSaved = new Promise<void>(resolve => { releaseSecond = resolve; });
    f.downloadToProject.mockImplementationOnce(async () => {
      await secondReady;
      return { fileId: artifact.file_id, projectId: 'project_1', relativePath: artifact.logical_path, sizeBytes: 6, sha256: artifact.sha256, revision: 1, overwritten: false };
    }).mockImplementationOnce(async () => { secondStarted(); await firstSaved; throw { code: 'ENTERPRISE_SHARED_FILE_LOCAL_EXISTS' }; });
    const options = { method: 'POST' as const, url: '/internal/agent-tools/drive/download', headers: f.headers, payload: { files: [artifact] } };
    const first = f.server.inject(options);
    const second = f.server.inject(options);
    expect((await first).json().downloads[0].status).toBe('downloaded');
    releaseSecond();
    expect((await second).json().downloads[0].status).toBe('downloaded');
    expect(createSharedDriveRepository(f.db).read('run_1').downloads[0]?.relativePath).toBe(artifact.logical_path);
  });
  it('进程复用时清空旧运行能力，隔离审核运行不接收网盘工具', async () => {
    let now = 1_000;
    const f = await fixture(true, 'employee', { clock: { now: () => now } });
    const config = { capabilities: f.tokens, getBaseUrl: () => 'http://127.0.0.1:12345', scheduleToolsEnabled: false, driveToolsEnabled: (thread: RuntimeThread) => thread.purpose !== 'skill_review' };
    const lease = createAgentScheduleProcessInjector(config).create()!;
    expect(lease.mcpServers[0]?.toolTimeoutSec).toBe(MCP_CHAIN_TIMEOUT_MS / 1000);
    expect(createAgentScheduleRunInjector(config).prepare({ runId: 'budget', thread: f.thread, createdBy: 'api' })?.mcpServers[0]?.toolTimeoutSec).toBe(MCP_CHAIN_TIMEOUT_MS / 1000);
    lease.activate({ runId: 'first', thread: f.thread, createdBy: 'api' });
    now += 60 * 60_000;
    f.tokens.cleanupExpired();
    expect(f.tokens.authorize(lease.env.CLAWEE_AGENT_CAPABILITY_TOKEN, { scope: 'drive:upload' }).runId).toBe('first');
    lease.deactivate('first');
    lease.activate({ runId: 'review', thread: { ...f.thread, purpose: 'skill_review' }, createdBy: 'api' });
    expect(() => f.tokens.authorize(lease.env.CLAWEE_AGENT_CAPABILITY_TOKEN, { scope: 'drive:upload' })).toThrow();
    expect(createAgentScheduleRunInjector(config).prepare({ runId: 'review2', thread: { ...f.thread, purpose: 'skill_review' }, createdBy: 'api' })).toBeUndefined();
    lease.close();
  });
  it('服务端加载独立规则，本地只注入取回指令', () => {
    expect(claweeDeveloperInstructions('/tmp/codex', true)).toContain('clawee_drive_upload');
    expect(claweeDeveloperInstructions('/tmp/codex', true)).toContain('严禁');
    expect(claweeDeveloperInstructions('/tmp/codex', false)).toContain('clawee_drive_download');
    expect(claweeDeveloperInstructions('/tmp/codex', false)).not.toContain('默认省略 `spaceId`');
  });
});
