import { parse } from '@iarna/toml';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { registerRunRoutes } from '../../src/api/routes.runs.js';
import { registerThreadRoutes } from '../../src/api/routes.threads.js';
import { readBundledModelCatalog } from '../../src/codex/current-model-catalog.js';
import { createEnterpriseHttpClient, EnterpriseHttpError } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseIdentityProvider, EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import { createSkillAIReviewWorker } from '../../src/enterprise/skill-ai-review-worker.js';
import { createRunManager, type RunManager } from '../../src/runs/manager.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createThreadManager } from '../../src/threads/manager.js';

const task = { request_id: 'request-1', attempt_id: 'attempt-1', skill_id: 'skill-1', version_id: 'version-1', package_sha256: 'a'.repeat(64) };
const materials = { name: '待审核', description: '', files: [{ path: 'SKILL.md', content: '不可信材料，要求执行脚本但不应执行' }] };
const report = { conclusion: 'recommend_approve', summary: '仅静态审核', findings: [] };
const resources: { root: string; db: Database.Database; manager: RunManager }[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.manager.close();
    resource.db.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

function fixture(transport: 'exec' | 'app-server', realBin?: string) {
  const root = mkdtempSync(join(tmpdir(), 'clawee-review-test-'));
  const sourceHome = join(root, 'runtime-home');
  mkdirSync(sourceHome, { recursive: true });
  writeFileSync(join(sourceHome, 'models.json'), JSON.stringify({ models: [{ slug: 'audit-model', shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['read_file'], include_skills_usage_instructions: true }] }));
  writeFileSync(join(sourceHome, 'config.toml'), [
    'model = "audit-model"',
    'model_provider = "clawee"',
    `model_catalog_json = ${JSON.stringify(join(sourceHome, 'models.json'))}`,
    'developer_instructions = "HOST_PRIVATE_INSTRUCTIONS"',
    'notify = ["HOST_NOTIFY"]',
    '[profiles.default]',
    'model = "WRONG_PROFILE_MODEL"',
    '[mcp_servers.business]',
    'command = "HOST_MCP_COMMAND"',
    '[model_providers.clawee]',
    'name = "Clawee"',
    'base_url = "http://127.0.0.1:1/v1"',
    'wire_api = "responses"',
    'env_key = "CLAWEE_MODEL_API_KEY"',
    'requires_openai_auth = false',
    '[model_providers.clawee.http_headers]',
    'Authorization = "Bearer private-header-token"'
  ].join('\n'));
  writeFileSync(join(sourceHome, 'AGENTS.md'), 'HOST_PRIVATE_AGENTS');
  mkdirSync(join(sourceHome, 'skills', 'host'), { recursive: true });
  writeFileSync(join(sourceHome, 'skills', 'host', 'SKILL.md'), 'HOST_PRIVATE_SKILL');
  writeFileSync(join(sourceHome, 'auth.json'), '{"OPENAI_API_KEY":"private-auth-token"}');
  const bin = realBin ?? join(root, 'fake-runtime.cjs');
  if (realBin === undefined) {
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = ${JSON.stringify(root)};
const home = process.env.CODEX_HOME;
const catalog=fs.existsSync(path.join(home,'review-models.json'))?path.join(home,'review-models.json'):path.join(home,'model-catalogs','review-models.json');
fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify({args:process.argv.slice(2),home,cwd:process.cwd(),env:process.env,config:fs.readFileSync(path.join(home,'config.toml'),'utf8'),catalog:fs.readFileSync(catalog,'utf8')}));
const report = ${JSON.stringify(JSON.stringify(report))};
if (!process.argv.includes('app-server')) {
  const prompt=fs.readFileSync(0,'utf8');fs.writeFileSync(path.join(root,'prompt.txt'),prompt);
  for (const event of [{type:'thread.started',thread_id:'review-thread'},{type:'item.completed',item:{id:'answer',type:'agent_message',text:report}},{type:'turn.completed'}]) console.log(JSON.stringify(event));
} else {
  const send = value => console.log(JSON.stringify(value));
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const message=JSON.parse(line);fs.appendFileSync(path.join(root,'requests.ndjson'),line+'\\n');
    if(message.method==='initialize') send({id:message.id,result:{userAgent:'fake'}});
    else if(message.method==='thread/start') send({id:message.id,result:{thread:{id:'review-thread'}}});
    else if(message.method==='turn/start') {
      send({id:message.id,result:{turn:{id:'turn-1'}}});
      send({method:'turn/started',params:{threadId:'review-thread',turn:{id:'turn-1'}}});
      send({method:'item/completed',params:{threadId:'review-thread',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:report}}});
      send({method:'turn/completed',params:{threadId:'review-thread',turn:{id:'turn-1',status:'completed'}}});
    } else if(message.id!==undefined) send({id:message.id,result:{}});
  });
}
`);
    chmodSync(bin, 0o755);
  }
  const db = openRuntimeDatabase(join(root, 'app.sqlite'));
  const threads = createThreadManager({ db, dataDir: root });
  const inject = vi.fn();
  const persistentStart = vi.fn();
  const registerRun = vi.fn();
  const beforeWritable = vi.fn(async () => {});
  const manager = createRunManager({
    db, dataDir: root, codexBin: bin, codexHome: sourceHome, threadAccess: threads,
    runtimeTransport: transport,
    env: { CLAWEE_MODEL_API_KEY: 'private-model-token', CLAWEE_AGENT_CAPABILITY_TOKEN: 'business-capability-token', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' },
    onBeforeCodexWritableRequest: beforeWritable,
    agentToolInjector: { prepare: inject },
    persistentAppServerExecutor: { start: persistentStart, close: async () => {} } as unknown as NonNullable<Parameters<typeof createRunManager>[0]['persistentAppServerExecutor']>,
    activityReporter: { registerRun, enqueue: vi.fn(), close: async () => {} } as unknown as NonNullable<Parameters<typeof createRunManager>[0]['activityReporter']>
  });
  resources.push({ root, db, manager });
  return { root, db, threads, sourceHome, manager, inject, persistentStart, registerRun, beforeWritable };
}

describe('审核HTTP raw契约和RunManager集成', () => {
  it.each(['exec', 'app-server'] as const)('%s审核会话持久化展示事件，拒绝继续对话、恢复和修改', async transport => {
    const test = fixture(transport);
    const context = { requestId: 'request-1', attemptId: 'attempt-2', skillName: '测试 Skill', versionId: 'version-1', version: '1.0.0', attemptNumber: 2,
      reviewSkillVersion: 'hub-2.0', reviewSkillSHA256: 'a'.repeat(64), approvalURL: 'https://enterprise.example/app/approvals/skill/request-1' };
    const run = await test.manager.createAndRun({ executionPolicy: 'skill-ai-review', skillReview: context, prompt: '仅本轮材料', cwd: '', profile: 'default', sandbox: 'read-only' });
    const storedRun = test.manager.getRun(run.id)!;
    expect(storedRun.threadId).toBeDefined();
    const threadId = storedRun.threadId!;
    expect(test.threads.getPublicThread(threadId)).toMatchObject({ purpose: 'skill_review', sandbox: 'read-only', projectId: null, codexThreadId: null, skillReview: context });
    expect(test.threads.repairCodexThreadBindings()).toEqual({ repairedThreadIds: [], unresolvedThreadIds: [] });
    expect(createThreadManager({ db: test.db, dataDir: test.root }).getPublicThread(threadId)?.skillReview).toEqual(context);
    const server = Fastify();
    await registerThreadRoutes(server, test.threads, test.manager);
    await registerRunRoutes(server, test.manager, { threadManager: test.threads });
    try {
      const list = await server.inject({ method: 'GET', url: '/threads?purpose=skill_review' });
      expect(list.statusCode).toBe(200);
      expect(list.json().threads).toEqual([expect.objectContaining({ id: threadId, skillReview: context, title: expect.stringContaining('第 2 次') })]);
      const history = await server.inject({ method: 'GET', url: `/threads/${threadId}/history?limit=50` });
      expect(history.statusCode).toBe(200);
      expect(history.json().items).toContainEqual(expect.objectContaining({ type: 'assistant_message', text: JSON.stringify(report) }));
      for (const resumeMode of ['auto', 'new_thread', 'resume_thread']) {
        const denied = await server.inject({ method: 'POST', url: '/runs', payload: { threadId, prompt: '继续执行', resumeMode } });
        expect(denied.statusCode).toBe(409);
        expect(denied.json().error.code).toBe('THREAD_READ_ONLY');
      }
      const changed = await server.inject({ method: 'PATCH', url: `/threads/${threadId}`, payload: { sandbox: 'danger-full-access' } });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error.code).toBe('THREAD_READ_ONLY');
      for (const [method, url] of [
        ['POST', `/threads/${threadId}/archive`], ['DELETE', `/threads/${threadId}`],
        ['POST', `/runs/${run.id}/cancel`], ['POST', `/runs/${run.id}/steer`]
      ] as const) {
        const denied = await server.inject({ method, url });
        expect(denied.statusCode).toBe(409);
        expect(denied.json().error.code).toBe('THREAD_READ_ONLY');
      }
      expect(() => test.manager.startRun({ threadId, prompt: '直接调用' })).toThrow('只读');
      expect(test.inject).not.toHaveBeenCalled();
      expect(test.registerRun).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each(['exec', 'app-server'] as const)('%s领取到回写全链路隔离、正常模型配置和JSON报告', async transport => {
    const test = fixture(transport);
    const requests: { method: string; path: string; body?: unknown; authorization: string | null }[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({ method: init!.method!, path, body: typeof init!.body === 'string' ? JSON.parse(init!.body) : undefined, authorization: new Headers(init!.headers).get('Authorization') });
      if (path.endsWith('/skill-ai-review-rule')) return Response.json({ data: { text: '---\nname: skill-review\ndescription: Hub审核规则\n---\n仅静态分析，输出JSON。', version: 'hub-2.0' } });
      if (path.endsWith('/claim')) return Response.json({ data: { ...task, materials } });
      if (path.endsWith('/result')) return Response.json({ data: { status: 'completed' } });
      return Response.json({ data: { tasks: [task] } });
    });
    const http = createEnterpriseHttpClient({ origin: 'https://enterprise.example', fetch: fetchMock });
    const session = {
      getSnapshot: () => ({ status: 'signed_in', account: { subjectId: 'user-1' }, agentId: 'agent-1' }),
      requireIdentity: async () => ({ subjectId: 'user-1', agentId: 'agent-1', accessToken: 'enterprise-token' })
    } as unknown as EnterpriseSessionManager & EnterpriseIdentityProvider;
    const worker = createSkillAIReviewWorker({ enabled: true, sessionManager: session, httpClient: http, runManager: test.manager });
    try {
      await worker.tick();
      expect(requests.map(request => request.path)).toEqual(['/api/v1/app/skill-ai-review-tasks', '/api/v1/app/skill-ai-review-rule', '/api/v1/app/skill-ai-review-tasks/request-1/claim', '/api/v1/app/skill-ai-review-tasks/request-1/result']);
      expect(requests[2]!.body).toEqual({ attempt_id: task.attempt_id, review_skill_version: 'hub-2.0', review_skill_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(requests[3]!.body).toEqual({ attempt_id: task.attempt_id, package_sha256: task.package_sha256, report });
      expect(requests.every(request => request.authorization === 'Bearer enterprise-token')).toBe(true);
      const capture = JSON.parse(readFileSync(join(test.root, 'capture.json'), 'utf8')) as { args: string[]; home: string; cwd: string; env: Record<string, string>; config: string; catalog: string };
      expect(capture.home).not.toBe(test.sourceHome);
      expect(capture.cwd).not.toBe(test.root);
      expect(capture.env.HOME).not.toBe(process.env.HOME);
      expect(capture.env.CLAWEE_MODEL_API_KEY).toBe('private-model-token');
      expect(capture.env.CLAWEE_AGENT_CAPABILITY_TOKEN).toBeUndefined();
      expect(capture.args).not.toContain('--profile');
      expect(capture.args).not.toContain('-p');
      expect(capture.args).not.toContain('resume');
      expect(capture.args).toContain('shell_tool');
      expect(capture.args).toContain('unified_exec');
      expect(capture.args).toContain('mcp_servers={}');
      expect(capture.args).toContain('plugins={}');
      expect(capture.args.includes('--ignore-user-config')).toBe(transport === 'exec');
      const config = parse(capture.config);
      expect(config.model).toBe('audit-model');
      expect(config.model_provider).toBe('clawee');
      expect(config.profiles).toBeUndefined();
      expect(capture.args).toContain('project_doc_max_bytes=0');
      expect(JSON.parse(capture.catalog).models[0]).toMatchObject({ shell_type: 'disabled', apply_patch_tool_type: null, experimental_supported_tools: [], include_skills_usage_instructions: false });
      expect(JSON.stringify(capture.args)).not.toContain('private-header-token');
      expect(capture.config).not.toContain('HOST_');
      expect(existsSync(capture.home)).toBe(false);
      expect(existsSync(capture.cwd)).toBe(false);
      const logs = ['meta.json', 'diagnostics.json', 'events.ndjson', 'stderr.redacted.log', 'raw.redacted.ndjson']
        .map(name => readFileSync(join(test.root, 'runs', test.manager.listRuns()[0]!.id, name), 'utf8')).join('\n');
      expect(logs).not.toMatch(/private-model-token|private-header-token|enterprise-token|private-auth-token|business-capability-token/);
      expect(test.inject).not.toHaveBeenCalled();
      expect(test.persistentStart).not.toHaveBeenCalled();
      expect(test.registerRun).not.toHaveBeenCalled();
      expect(test.beforeWritable).toHaveBeenCalledTimes(1);
      if (transport === 'app-server') {
        const frames = readFileSync(join(test.root, 'requests.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const start = frames.find(frame => frame.method === 'thread/start');
        expect(start.params).toMatchObject({ sandbox: 'read-only', developerInstructions: '' });
        expect(frames.some(frame => frame.method === 'thread/resume')).toBe(false);
        expect(JSON.stringify(frames)).not.toMatch(/HOST_|business|private-/);
      } else {
        expect(readFileSync(join(test.root, 'prompt.txt'), 'utf8')).not.toMatch(/HOST_|private-/);
      }
    } finally { await worker.close(); }
  });

  it('claim原子409不startRun，raw错误envelope维持HTTP状态', async () => {
    const http = createEnterpriseHttpClient({ origin: 'https://enterprise.example', fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'conflict', message: '不可重复领取' } }, { status: 409 })) });
    await expect(http.claimSkillAIReviewTask!('token', 'request-1', 'attempt-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('拒绝多一层task、camelCase和无data包装的领取响应', async () => {
    for (const body of [{ data: { task: { ...task, materials } } }, { data: { requestId: 'request-1', materials } }, { ...task, materials }]) {
      const http = createEnterpriseHttpClient({ origin: 'https://enterprise.example', fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)) });
      await expect(http.claimSkillAIReviewTask!('token', 'request-1', 'attempt-1')).rejects.toBeInstanceOf(EnterpriseHttpError);
    }
  });

  it('公共/runs不能授予内部策略，普通请求仍保持原行为', async () => {
    const server = Fastify();
    const startRun = vi.fn(() => ({ id: 'ordinary-run', status: 'running', submissionMode: 'enqueue' }));
    await registerRunRoutes(server, { startRun } as unknown as RunManager);
    try {
      const denied = await server.inject({ method: 'POST', url: '/runs', payload: { prompt: 'test', executionPolicy: 'skill-ai-review' } });
      expect(denied.statusCode).toBe(400);
      expect(startRun).not.toHaveBeenCalled();
      const allowed = await server.inject({ method: 'POST', url: '/runs', payload: { prompt: 'test' } });
      expect(allowed.statusCode).toBe(202);
      expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'workspace-write', profile: 'default' }));
    } finally { await server.close(); }
  });

  it('内部策略拒绝用户thread/恢复/附件，强制read-only并限制超时', async () => {
    const test = fixture('exec');
    const base = { executionPolicy: 'skill-ai-review' as const, prompt: '静态材料', cwd: test.root, profile: 'user-profile', sandbox: 'danger-full-access' as const };
    expect(() => test.manager.startRun({ ...base, threadId: 'user-thread' })).toThrow('独立材料');
    expect(() => test.manager.startRun({ ...base, codexThreadId: 'user-runtime-thread' })).toThrow('独立材料');
    expect(() => test.manager.startRun({ ...base, resumeMode: 'new_thread' })).toThrow('独立材料');
    expect(() => test.manager.startRun({ ...base, imagePaths: ['user.png'] })).toThrow('独立材料');
    const run = await test.manager.createAndRun({ ...base, timeoutMs: 30 * 60 * 1000 });
    expect(test.manager.getRun(run.id)).toMatchObject({ status: 'succeeded', sandbox: 'read-only', timeoutMs: 12 * 60 * 1000 });
    expect(test.manager.getRun(run.id)!.cwd).not.toBe(test.root);
    expect(readdirSync(test.sourceHome)).toContain('skills');
  });

  it.each(['exec', 'app-server'] as const)('%s隔离配置不完整时失败关闭且不泄露原配置', async transport => {
    const test = fixture(transport);
    const source = readFileSync(join(test.sourceHome, 'config.toml'), 'utf8');
    writeFileSync(join(test.sourceHome, 'config.toml'), source.replace('env_key = "CLAWEE_MODEL_API_KEY"', 'env_key = "private-invalid-token"'));
    const run = await test.manager.createAndRun({ executionPolicy: 'skill-ai-review', prompt: '材料', cwd: '', profile: 'default', sandbox: 'read-only' });
    expect(run.status).toBe('failed');
    expect(existsSync(join(test.root, 'capture.json'))).toBe(false);
    expect(existsSync(test.manager.getRun(run.id)!.cwd)).toBe(false);
    expect(JSON.stringify(test.manager.getRun(run.id))).not.toContain('private-invalid-token');
  });

  it.each(['exec', 'app-server'] as const)('%s模型准备期间取消不能随后启动Runtime', async transport => {
    const test = fixture(transport);
    let release!: () => void;
    test.beforeWritable.mockReturnValue(new Promise<void>(resolveReady => { release = resolveReady; }));
    const run = test.manager.startRun({ executionPolicy: 'skill-ai-review', prompt: '材料', cwd: '', profile: 'default', sandbox: 'read-only' });
    test.manager.cancelRun(run.id);
    release();
    await test.manager.close();
    expect(existsSync(join(test.root, 'capture.json'))).toBe(false);
    expect(existsSync(test.manager.getRun(run.id)!.cwd)).toBe(false);
  });
});

const realBin = resolve('../desktop/.pack/codex-runtime/bin/codex');

describe('真实内嵌Runtime工具隔离', () => {
  it.skipIf(!existsSync(realBin)).each(['exec', 'app-server'] as const)('%s实际模型请求tools为空且无宿主指令', async transport => {
    const test = fixture(transport, realBin);
    const captured: Record<string, unknown>[] = [];
    const marker = join(test.root, 'shell-must-not-run');
    const modelServer = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        captured.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const output = captured.length === 1 ? [{ type: 'function_call', id: 'call-1', call_id: 'call-1', name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${JSON.stringify(marker)}` }) }] : [];
        for (const item of output) {
          response.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`);
          response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`);
        }
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'response-1', output, usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`);
      });
    });
    await new Promise<void>(resolveReady => modelServer.listen(0, '127.0.0.1', resolveReady));
    try {
      const address = modelServer.address() as { port: number };
      const catalog = readBundledModelCatalog(realBin);
      const template = catalog.models[0]!;
      writeFileSync(join(test.sourceHome, 'models.json'), JSON.stringify({ models: [{ ...template, slug: 'audit-model', visibility: 'list', supported_in_api: true }] }));
      const source = readFileSync(join(test.sourceHome, 'config.toml'), 'utf8');
      writeFileSync(join(test.sourceHome, 'config.toml'), source.replace('http://127.0.0.1:1/v1', `http://127.0.0.1:${address.port}/v1`));
      const run = test.manager.startRun({ executionPolicy: 'skill-ai-review', prompt: '只审核本轮材料', cwd: '', profile: 'default', sandbox: 'read-only', timeoutMs: 20_000 });
      try {
        await expect.poll(() => captured.length, { timeout: 15_000 }).toBeGreaterThan(0);
      } catch {
        const stderr = readFileSync(join(test.root, 'runs', run.id, 'stderr.redacted.log'), 'utf8');
        throw new Error(`模型请求未到达：${JSON.stringify(test.manager.getRun(run.id))}；${stderr}`);
      }
      const payload = captured[0]!;
      expect(payload.model).toBe('audit-model');
      expect(payload.tools ?? []).toEqual([]);
      const additionalTools = (payload.input as { type: string; tools?: unknown[] }[]).filter(item => item.type === 'additional_tools');
      expect(additionalTools.length).toBeGreaterThan(0);
      expect(additionalTools.every(item => Array.isArray(item.tools) && item.tools.length === 0)).toBe(true);
      expect(JSON.stringify(payload)).not.toMatch(/HOST_PRIVATE|HOST_MCP|HOST_NOTIFY|WRONG_PROFILE_MODEL|enterprise_assistant|private-(?:model|header|auth)-token/);
      await expect.poll(() => captured.length, { timeout: 5_000 }).toBeGreaterThan(1);
      expect(existsSync(marker)).toBe(false);
      const toolOutputs = (captured[1]!.input as { type: string; output?: string }[]).filter(item => item.type === 'function_call_output');
      expect(toolOutputs).toEqual(expect.arrayContaining([expect.objectContaining({ output: 'unsupported call: exec_command' })]));
      test.manager.cancelRun(run.id);
      await test.manager.close();
    } finally {
      modelServer.closeAllConnections();
      await new Promise<void>(resolveClosed => modelServer.close(() => resolveClosed()));
    }
  }, 25_000);
});
