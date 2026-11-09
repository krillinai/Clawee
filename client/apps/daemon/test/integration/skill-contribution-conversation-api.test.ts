import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelServiceRuntime } from '../../src/codex/model-service-configuration.js';
import { EnterpriseHttpError, type EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import { createRunManager } from '../../src/runs/manager.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createRunRepository } from '../../src/storage/repositories.js';
import { createThreadManager } from '../../src/threads/manager.js';
import { buildServer } from '../helpers/build-server.js';
import { createFakeCodex } from '../helpers/fake-codex.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-contribution-api-'));
  const db = openRuntimeDatabase(join(directory, 'runtime.sqlite'));
  const threads = createThreadManager({ db, dataDir: directory });
  const fake = createFakeCodex(directory, { stdoutLines: [
    { type: 'thread.started', thread_id: 'codex-contribution-1' },
    { type: 'turn.started' },
    { type: 'turn.completed' }
  ] });
  const runs = createRunManager({ db, dataDir: directory, codexBin: fake.bin, codexHome: join(directory, 'codex-home'), threadAccess: threads });
  const readHistory = vi.fn(async () => ({ items: [{
    id: 'history-question', type: 'user_message' as const, text: fake.readPrompt(),
    createdAt: runs.listRuns()[0]?.createdAt ?? new Date().toISOString()
  }], hasMore: true, nextCursor: 'older-page' }));
  let ready = true;
  let allowed = true;
  let subjectId = 'account-1';
  let credential: { accessToken: string; expiresAt: string } | undefined = { accessToken: 'enterprise-token', expiresAt: '2099-01-01T00:00:00Z' };
  const agentId = 'clawee_550e8400-e29b-41d4-a716-446655440000';
  const account = () => ({ subjectId, email: 'test@example.test', name: '测试' });
  const getSkillContributions = vi.fn(async () => {
    if (!allowed) throw new EnterpriseHttpError('ENTERPRISE_DATA_VIEW_FORBIDDEN', 'response', 403);
    return { query: {}, timezone: 'Asia/Shanghai', generated_at: '2026-10-13T00:00:00Z', coverage: { first_approvals_from: '2026-10-01T00:00:00Z', uploads_from: null, notice: '' }, items: [], total: 0 };
  });
  const exportSkillContributions = vi.fn(async () => {
    if (!allowed) throw new EnterpriseHttpError('ENTERPRISE_DATA_VIEW_FORBIDDEN', 'response', 403);
    return { content: '员工 ID\n', filename: 'skill-contributions.csv', rowCount: 0 };
  });
  const model: ModelServiceRuntime = {
    ready: () => ready,
    status: () => ready ? { status: 'ready', mode: 'enterprise_managed', configuration: { baseUrl: 'https://api.example.test/v1', model: 'model-1' } } : { status: 'configuration_required', mode: 'enterprise_managed' },
    async check() { return { status: 'succeeded' }; },
    async readApiKey() { return null; },
    async resolve() {},
    async signOut() {},
    subscribeReady() { return () => undefined; },
    async configure() { return { status: 'ready', configuration: { baseUrl: 'https://api.example.test/v1', model: 'model-1' }, apiKeyConfigured: true }; }
  };
  const server = await buildServer({
    token: 'secret', dataDir: directory, db, runManager: runs, codexBin: fake.bin, codexHome: join(directory, 'codex-home'), schedulerAutostart: false, modelServiceRuntime: model,
    codexSessionProvider: { listTurns: readHistory, search: async () => ({ results: [], hasMore: false }), close: async () => {} },
    enterpriseAgentIdentityStore: { getOrCreate: async () => agentId },
    enterpriseCredentialStore: { read: async () => credential, write: async next => { credential = next; }, delete: async () => { credential = undefined; } },
    enterpriseHttpClient: {
      getMe: async () => ({ account: account(), agentId, status: 'active', frontendAllowed: true }),
      login: async () => ({ account: account(), agentId, accessToken: 'enterprise-token', tokenType: 'Bearer', expiresAt: '2099-01-01T00:00:00Z' }),
      logout: async () => {},
      hasSkillContributionGrant: async () => allowed,
      getSkillContributions,
      exportSkillContributions
    } as unknown as EnterpriseHttpClient
  });
  cleanups.push(async () => { await server.close(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => server.inject({ method, url, headers: { authorization: 'Bearer secret' }, ...(payload === undefined ? {} : { payload }) });
  return { db, threads, runs, fake, readHistory, request, getSkillContributions, exportSkillContributions, setReady(value: boolean) { ready = value; }, setAllowed(value: boolean) { allowed = value; }, async switchAccount() {
    await request('POST', '/enterprise/logout', {});
    subjectId = 'account-2';
    expect((await request('POST', '/enterprise/login', { email: 'other@example.test', password: 'test-password' })).statusCode).toBe(200);
  } };
}

const conversationPath = '/enterprise/skill-contribution-conversations';

describe('贡献对话执行与访问边界', () => {
  it('无项目会话不依赖标题执行，并保留公开问题与独立执行提示', async () => {
    const context = await fixture();
    const creation = await context.request('POST', conversationPath, {});
    expect(creation.statusCode).toBe(201);
    const thread = creation.json().thread;
    expect(thread).toMatchObject({ projectId: null, workspaceMode: 'managed', sandbox: 'read-only' });
    context.db.prepare('UPDATE threads SET title = ? WHERE id = ?').run('贡献历史标题', thread.id);
    const latest = await context.request('GET', `${conversationPath}/latest`);
    expect(latest.statusCode).toBe(200);
    expect(latest.json().thread.id).toBe(thread.id);
    expect((await context.request('GET', '/enterprise/knowledge-conversations/latest')).statusCode).toBe(204);
    const prompt = '列出本月首次通过的 Skill';
    const started = await context.request('POST', `${conversationPath}/${thread.id}/runs`, { prompt, query: { report: 'first_approvals' } });
    expect(started.statusCode).toBe(202);
    const runId = started.json().id;
    await vi.waitFor(() => expect(context.runs.getRun(runId)?.status).toBe('succeeded'), { timeout: 5_000 });
    expect(context.runs.getRun(runId)?.publicPrompt).toBe(prompt);
    expect(context.fake.readPrompt()).toContain('[Clawee Skill 贡献查询]');
    expect(context.fake.readPrompt()).toContain('"report":"first_approvals"');
    expect(context.fake.readPrompt()).toContain(prompt);
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
    expect((await context.request('GET', '/runs')).json().runs).toEqual([]);
    expect((await context.request('GET', '/tasks')).json().tasks).toEqual([]);

    const repository = createRunRepository(context.db);
    const query = { report: 'first_approvals', start_date: '2026-10-01', end_date: '2026-10-13' };
    const descriptor = { type: 'skill_contributions_csv', query };
    const lastSeq = context.runs.getLastEventSeq(runId);
    repository.insertRunEvent({ id: 'export-use', runId, seq: lastSeq + 1, ts: new Date().toISOString(), normalizerVersion: 1,
      type: 'tool_use', payload: { type: 'tool_use', toolCallId: 'export', name: 'skill_contributions_export', input: {} } });
    repository.insertRunEvent({ id: 'export-result', runId, seq: lastSeq + 2, ts: new Date().toISOString(), normalizerVersion: 1,
      type: 'tool_result', payload: { type: 'tool_result', toolCallId: 'export', output: '', isError: false, response: { query, download: descriptor } } });
    const history = (await context.request('GET', `${conversationPath}/${thread.id}/history?limit=100`)).json();
    expect(history.items.filter((item: { type: string }) => item.type === 'user_message')).toEqual([
      expect.objectContaining({ text: prompt, runId })
    ]);
    expect(history.items).toContainEqual(expect.objectContaining({ type: 'tool_result', name: 'skill_contributions_export', runId,
      output: JSON.stringify({ query, download: descriptor }) }));
    expect(history.hasMore).toBe(true);
    expect(history.nextCursor).toBe('older-page');
    const olderHistory = (await context.request('GET', `${conversationPath}/${thread.id}/history?limit=100&before=older-page`)).json();
    expect(olderHistory.items).toEqual([expect.objectContaining({ type: 'user_message', text: prompt, runId })]);
    context.readHistory.mockResolvedValue({ items: [], hasMore: false, nextCursor: 'older-page' });
    const recovered = (await context.request('GET', `${conversationPath}/${thread.id}/history?limit=100`)).json();
    expect(recovered.items.filter((item: { type: string }) => item.type === 'user_message')).toEqual([
      expect.objectContaining({ text: prompt, runId })
    ]);

    context.setAllowed(false);
    expect((await context.request('GET', '/tasks')).json().tasks).toEqual([]);
    for (const suffix of ['', '/events', '/cancel', '/steer']) {
      expect((await context.request(suffix === '/cancel' || suffix === '/steer' ? 'POST' : 'GET', `/runs/${runId}${suffix}`)).statusCode).toBe(403);
    }
    expect((await context.request('GET', `${conversationPath}/${thread.id}/history`)).statusCode).toBe(403);
    expect((await context.request('GET', `/enterprise/knowledge-conversations/${thread.id}/history`)).statusCode).toBe(404);
    context.setAllowed(true);
    await context.switchAccount();
    expect((await context.request('GET', '/tasks')).json().tasks).toEqual([]);
    expect((await context.request('GET', `/runs/${runId}`)).statusCode).toBe(404);
    expect((await context.request('GET', `${conversationPath}/${thread.id}`)).statusCode).toBe(404);
    await context.request('POST', '/enterprise/logout', {});
    expect((await context.request('GET', '/tasks')).json().tasks).toEqual([]);
  });

  it('普通 API 隐藏所有企业会话并拒绝改名、归档、删除、绑定与运行', async () => {
    const context = await fixture();
    const project = (await context.request('POST', '/projects/default')).json().project;
    const contribution = (await context.request('POST', conversationPath, {})).json().thread;
    const knowledge = (await context.request('POST', '/enterprise/knowledge-conversations', { projectId: project.id })).json().thread;
    for (const thread of [contribution, knowledge]) {
      for (const [method, path, payload] of [
        ['GET', `/threads/${thread.id}`, undefined],
        ['GET', `/threads/${thread.id}/history`, undefined],
        ['GET', `/threads/${thread.id}/runs`, undefined],
        ['PATCH', `/threads/${thread.id}`, { title: '改名绕过', sandbox: 'danger-full-access' }],
        ['POST', `/threads/${thread.id}/archive`, undefined],
        ['DELETE', `/threads/${thread.id}`, undefined],
        ['POST', `/threads/${thread.id}/assign-project`, { projectId: project.id }],
        ['POST', '/runs', { threadId: thread.id, prompt: '普通执行' }]
      ] as const) {
        expect((await context.request(method, path, payload)).statusCode, `${method} ${path}`).toBe(404);
      }
      expect(context.threads.getThread(thread.id)).toMatchObject({ title: thread.title, projectId: thread.projectId, status: 'active', sandbox: 'read-only' });
    }
    for (const assignment of ['assigned', 'unassigned']) {
      const list = await context.request('GET', `/threads?purpose=conversation&assignment=${assignment}`);
      expect(list.statusCode).toBe(200);
      expect(list.json().threads).toEqual([]);
    }
    expect((await context.request('GET', '/runs')).json().runs).toEqual([]);
    expect((await context.request('GET', `/enterprise/knowledge-conversations/${knowledge.id}`)).statusCode).toBe(200);
    await context.switchAccount();
    expect((await context.request('GET', `/threads/${contribution.id}/history`)).statusCode).toBe(404);
  });

  it('无模型可读取贡献数据、CSV 与对话历史，仍验证权限且禁止执行 Run', async () => {
    const context = await fixture();
    const thread = (await context.request('POST', conversationPath, {})).json().thread;
    context.setReady(false);
    for (const endpoint of ['capability', 'summary', 'records', 'detail']) {
      expect((await context.request('GET', `/enterprise/skill-contributions/${endpoint}${endpoint === 'detail' ? '?skill_id=skill-1' : ''}`)).statusCode).toBe(200);
    }
    expect((await context.request('POST', '/enterprise/skill-contributions/export', {})).statusCode).toBe(200);
    for (const [path, payload] of [[`${conversationPath}/${thread.id}/runs`, { prompt: '查询' }], ['/runs', { threadId: thread.id, prompt: '查询' }]] as const) {
      expect((await context.request('POST', path, payload)).statusCode).toBe(428);
    }
    expect((await context.request('GET', `${conversationPath}/${thread.id}/runs`)).statusCode).toBe(200);
    expect((await context.request('GET', `${conversationPath}/${thread.id}/history`)).statusCode).toBe(200);
    expect(context.runs.listRuns()).toEqual([]);
    context.setAllowed(false);
    expect((await context.request('GET', '/enterprise/skill-contributions/capability')).json()).toEqual({ allowed: false });
    expect((await context.request('GET', '/enterprise/skill-contributions/records')).statusCode).toBe(403);
    expect((await context.request('POST', '/enterprise/skill-contributions/export', {})).statusCode).toBe(403);
    await context.request('POST', '/enterprise/logout', {});
    expect((await context.request('GET', '/enterprise/skill-contributions/records')).statusCode).toBe(401);
    expect((await context.request('POST', '/enterprise/skill-contributions/export', {})).statusCode).toBe(401);
  });
});
