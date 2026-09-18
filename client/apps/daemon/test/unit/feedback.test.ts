import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { FeedbackService } from '../../src/feedback/service.js';
import { redactFeedback } from '../../src/feedback/redactor.js';
import { boundedLines, collectFeedback } from '../../src/feedback/collector.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'clawee-feedback-'))); const db = openRuntimeDatabase(join(dir, 'app.sqlite'));
  db.prepare(`INSERT INTO threads(id,cwd,canonical_cwd,workspace_mode,profile,sandbox,status) VALUES('thread_test','/test','/test','project','test','read-only','active')`).run();
  cleanup.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }); }); return { dir, db };
}
describe('会话反馈', () => {
  function addRun(db: ReturnType<typeof openRuntimeDatabase>, id: string, prompt = '用户输入') {
    db.prepare(`INSERT INTO runs(id,thread_id,public_prompt,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version) VALUES(?,'thread_test',?,'failed','failed','user','test','/test','/test','project','read-only','test','test','/runtime',1)`).run(id, prompt);
    db.prepare('INSERT INTO run_events(id,run_id,seq,type,payload_json) VALUES(?,?,1,?,?)').run(`event_${id}`, id, 'status', '{}');
  }
  it('超限保存可导出的失败清单，不发送、不导出凭证', async () => {
    const { dir, db } = await fixture();
    for (let i = 0; i < 260; i++) addRun(db, `run_quota_${i}`);
    let requests = 0;
    const service = new FeedbackService({ db, dataDir: dir, environment: () => ({ app_version: 'test' }), policy: async () => ({ allowed: true }), fetchImpl: async () => { requests++; throw new Error('must not send'); } });
    cleanup.unshift(async () => service.close());
    const draft = await service.create({ thread_id: 'thread_test', description: '超限', occurred_at: new Date().toISOString() });
    await service.collect(draft.local_feedback_id);
    await expect.poll(async () => (await service.get(draft.local_feedback_id)).state, { timeout: 5000 }).toBe('failed');
    const failed = await service.get(draft.local_feedback_id);
    expect(failed.error_code).toBe('FEEDBACK_QUOTA_EXCEEDED');
    const manifest = await service.export(draft.local_feedback_id);
    expect(manifest.completeness).toBe('partial');
    expect(manifest.missing_items).toContain('collection:quota_exceeded');
    expect(manifest.artifacts.length).toBeGreaterThan(0);
    expect(failed.size_bytes).toBe(manifest.artifacts.reduce((n, a) => n + a.size_bytes, 0));
    for (const artifact of manifest.artifacts) expect((await readFile(join(dir, 'feedback', draft.local_feedback_id, artifact.artifact_id))).length).toBe(artifact.size_bytes);
    await expect(service.artifact(draft.local_feedback_id, 'credentials.json')).rejects.toThrow('FEEDBACK_NOT_FOUND');
    await expect(service.send(draft.local_feedback_id, { confirmed: true, manifest_sha256: failed.manifest_sha256 ?? '', accept_partial: true })).rejects.toThrow('FEEDBACK_CONSENT_REQUIRED');
    await expect(service.retry(draft.local_feedback_id)).rejects.toThrow('FEEDBACK_RETRY_NOT_ALLOWED');
    expect(requests).toBe(0);
  });
  it('失败和取消 Run 的公开输入进入会话材料，同文输入不去重', async () => {
    const { dir, db } = await fixture(); addRun(db, 'run_prompt_1'); addRun(db, 'run_prompt_2');
    db.prepare("UPDATE runs SET public_status='canceled' WHERE id='run_prompt_2'").run();
    const directory = join(dir, 'snapshot');
    const manifest = await collectFeedback({ db, dataDir: dir, directory, threadId: 'thread_test', environment: {}, signal: new AbortController().signal });
    const artifacts = manifest.artifacts.filter(a => a.source === 'run_prompts');
    const text = (await Promise.all(artifacts.map(a => readFile(join(directory, a.artifact_id), 'utf8')))).join('');
    const records = text.trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.run_id)).toEqual(['run_prompt_1', 'run_prompt_2']);
    expect(records.map(record => record.item.text)).toEqual(['用户输入', '用户输入']);
  });
  it('日志写入失败和截断进入明确缺失项及 watermark', async () => {
    const { dir, db } = await fixture(); addRun(db, 'run_logs');
    await mkdir(join(dir, 'runs', 'run_logs'), { recursive: true });
    await writeFile(join(dir, 'runs', 'run_logs', 'diagnostics.json'), JSON.stringify({ logWriter: { failureCount: 1, backpressureRejects: 2 } }, null, 2));
    const manifest = await collectFeedback({ db, dataDir: dir, directory: join(dir, 'snapshot'), threadId: 'thread_test', environment: {}, signal: new AbortController().signal });
    expect(manifest.missing_items).toContain('run:run_logs:log_write_failed');
    expect(manifest.missing_items).toContain('run:run_logs:log_backpressure_rejected');
    expect(manifest.watermarks.find(w => w.run_id === 'run_logs' && w.source === 'diagnostics.json')).toMatchObject({ source_truncated: true });
  });
  it('本地进度和同轮上传复用策略，每轮重新检查禁用', async () => {
    const { dir, db } = await fixture(); let checks = 0; let allowed = true;
    const service = new FeedbackService({ db, dataDir: dir, environment: () => ({ app_version: 'test' }), policy: async (refresh: boolean) => { if (refresh) checks++; return { allowed }; } });
    cleanup.unshift(async () => service.close());
    const draft = await service.create({ thread_id: 'thread_test', description: '策略', occurred_at: new Date().toISOString() });
    const before = checks; await service.get(draft.local_feedback_id); await service.get(draft.local_feedback_id); expect(checks).toBe(before);
    allowed = false; expect(await service.allowed()).toBe(false);
    expect((await service.get(draft.local_feedback_id)).external_feedback_allowed).toBe(false);
    await expect(service.collect(draft.local_feedback_id)).rejects.toThrow('FEEDBACK_POLICY_DISABLED');
  });
  it('上传期间本地策略禁用立即暂停，恢复后续传且不增加策略联网次数', async () => {
    const { dir, db } = await fixture(); let allowed = true; let checks = 0; let puts = 0; let submits = 0;
    const received: string[] = [];
    const progress = () => ({ report_id: 'fb_test0001', received_artifact_ids: received, upload_token: 'feedback-only-upload', upload_expires_at: new Date(Date.now() + 60000).toISOString(), recovery_expires_at: new Date(Date.now() + 86400000).toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), upload_state: 'uploading' });
    const service = new FeedbackService({ db, dataDir: dir, environment: () => ({ app_version: 'test' }), policy: async (refresh: boolean) => { if (refresh) checks++; return { allowed }; }, fetchImpl: async (url, input) => {
      const path = new URL(String(url)).pathname;
      if (input?.method === 'PUT') { puts++; received.push(path.split('/').at(-1)!); if (puts === 1) allowed = false; return Response.json({ data: { received: true } }); }
      if (path.endsWith('/submit')) { submits++; return Response.json({ data: progress() }); }
      if (path.endsWith('/status')) return Response.json({ data: { processing_status: 'open' } });
      return Response.json({ data: progress() });
    } });
    cleanup.unshift(async () => service.close());
    const draft = await service.create({ thread_id: 'thread_test', description: '策略更新', occurred_at: new Date().toISOString() });
    await service.collect(draft.local_feedback_id);
    await expect.poll(async () => (await service.get(draft.local_feedback_id)).state).toBe('awaiting_consent');
    const ready = await service.get(draft.local_feedback_id);
    expect(ready.manifest!.artifacts.length).toBeGreaterThan(1);
    await service.send(draft.local_feedback_id, { confirmed: true, manifest_sha256: ready.manifest_sha256!, accept_partial: true });
    const before = checks;
    await (service as unknown as { work(): Promise<void> }).work();
    expect(puts).toBe(1); expect(submits).toBe(0); expect(checks).toBe(before + 1);
    expect(await service.get(draft.local_feedback_id)).toMatchObject({ state: 'uploading', retry_count: 0, external_feedback_allowed: false });
    allowed = true;
    expect(await service.allowed(false)).toBe(false);
    await (service as unknown as { work(): Promise<void> }).work();
    expect(await service.get(draft.local_feedback_id)).toMatchObject({ state: 'submitted', retry_count: 0 });
    expect(puts).toBe(ready.manifest!.artifacts.length); expect(submits).toBe(1); expect(checks).toBe(before + 2);
  });
  it('日志超大单行在读取阶段拒绝，分块UTF8不丢字', async () => {
    async function* chunks() { const data = Buffer.from('正文\n下一行'); yield data.subarray(0, 2); yield data.subarray(2); }
    const lines = []; for await (const line of boundedLines(chunks(), new AbortController().signal)) lines.push(line); expect(lines).toEqual(['正文', '下一行']);
    async function* huge() { for (let i = 0; i < 17; i++) yield Buffer.alloc(1024 * 1024, 65); }
    await expect(async () => { for await (const _line of boundedLines(huge(), new AbortController().signal)) { /* 超限应在生成完整行前失败。 */ } }).rejects.toThrow('FEEDBACK_SOURCE_LINE_TOO_LARGE');
  });
  for (const mode of ['create_lost', 'submit_lost', 'submit_expired'] as const) it(`可靠上传：${mode} 与重启续传`, async () => {
    const { dir, db } = await fixture(); let first = true; let submitted = false; let creationBody: string | undefined; let creations = 0; let submits = 0; let recoveries = 0; const received = new Set<string>();
    const progress = () => ({ report_id: 'fb_test0001', received_artifact_ids: [...received], upload_token: 'feedback-only-upload', upload_expires_at: new Date(Date.now() + 60000).toISOString(), recovery_expires_at: new Date(Date.now() + 86400000).toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), upload_state: submitted ? 'ready' : 'uploading' });
    const fetchImpl: typeof fetch = async (url, input) => {
      expect(String(url)).toMatch(/^https:\/\/gateway\.clawee\.work\/api\/v1\/feedback\//); expect(input?.credentials).toBe('omit'); expect(input?.redirect).toBe('error');
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/status')) return Response.json({ data: { processing_status: 'open' } });
      if (path.endsWith('/reports')) { creations++; if (creationBody) expect(input?.body).toBe(creationBody); else creationBody = String(input?.body); if (mode === 'create_lost' && first) { first = false; throw new Error('response lost'); } return Response.json({ data: progress() }); }
      if (path.endsWith('/upload-credentials')) { recoveries++; return Response.json({ data: progress() }); }
      if (input?.method === 'PUT') { const aid = path.split('/').at(-1)!; expect(received.has(aid)).toBe(false); received.add(aid); return Response.json({ data: { received: true } }); }
      if (path.endsWith('/submit')) { submits++; if (mode === 'submit_expired' && first) { first = false; return new Response('', { status: 401 }); } submitted = true; if (mode === 'submit_lost' && first) { first = false; throw new Error('response lost'); } return Response.json({ data: progress() }); }
      throw new Error('unexpected request');
    };
    const options = { db, dataDir: dir, environment: () => ({ app_version: 'test' }), policy: async () => ({ allowed: true }), fetchImpl };
    let service = new FeedbackService(options); cleanup.unshift(async () => service.close());
    const d = await service.create({ thread_id: 'thread_test', description: '问题', occurred_at: new Date().toISOString() }); await service.collect(d.local_feedback_id); await expect.poll(async () => (await service.get(d.local_feedback_id)).state).toBe('awaiting_consent');
    const ready = await service.get(d.local_feedback_id); await service.send(d.local_feedback_id, { confirmed: true, manifest_sha256: ready.manifest_sha256!, accept_partial: true });
    await (service as unknown as { work(): Promise<void> }).work(); service.close();
    if (mode !== 'submit_expired') {
      const row = db.prepare('SELECT draft_json FROM feedback_queue').get() as { draft_json: string }; const stored = JSON.parse(row.draft_json); stored.next_retry_at = undefined; db.prepare('UPDATE feedback_queue SET draft_json=?').run(JSON.stringify(stored));
      service = new FeedbackService(options); await (service as unknown as { work(): Promise<void> }).work();
    }
    expect((await service.get(d.local_feedback_id)).state).toBe('submitted'); expect(received.size).toBe(ready.manifest!.artifacts.length); expect(creations).toBe(mode === 'create_lost' ? 2 : 1); expect(submits).toBe(mode === 'submit_expired' ? 2 : 1); if (mode !== 'create_lost') expect(recoveries).toBe(1);
  });
  it('策略检查等待期间取消，不发送旧队列副本', async () => {
    const { dir, db } = await fixture(); let block = false; let release!: () => void; let started!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); const checking = new Promise<void>(resolve => { started = resolve; }); let requests = 0;
    const service = new FeedbackService({ db, dataDir: dir, environment: () => ({ app_version: 'test' }), policy: async () => { if (block) { started(); await pending; } return { allowed: true }; }, fetchImpl: async () => { requests++; throw new Error('must not send'); } }); cleanup.unshift(async () => service.close());
    const d = await service.create({ thread_id: 'thread_test', description: '问题', occurred_at: new Date().toISOString() }); await service.collect(d.local_feedback_id); await expect.poll(async () => (await service.get(d.local_feedback_id)).state).toBe('awaiting_consent'); const ready = await service.get(d.local_feedback_id); await service.send(d.local_feedback_id, { confirmed: true, manifest_sha256: ready.manifest_sha256!, accept_partial: true }); block = true;
    const work = (service as unknown as { work(): Promise<void> }).work(); await checking; await service.cancel(d.local_feedback_id); release(); await work; expect(requests).toBe(0); expect((await service.get(d.local_feedback_id)).state).toBe('cancelled');
  });
  it('保留 prompt 正文，遮盖秘密和路径', () => { expect(redactFeedback({ prompt: '正文 sk-testsecretvalue', api_key: 'private', path: '/test/a.ts' }, ['/test'])).toEqual({ prompt: '正文 [REDACTED]', api_key: '[REDACTED]', path: '[PATH_1]/a.ts' }); expect(redactFeedback('"token": "private_value"')).toBe('"token": "[REDACTED]"'); });
  it('草稿和采集不联网，禁用策略拒绝采集发送', async () => { const { dir, db } = await fixture(); let network = 0; let allowed = true; const service = new FeedbackService({ db, dataDir: dir, environment: () => ({ app_version: 'test' }), policy: async () => ({ allowed }), fetchImpl: async () => { network++; throw new Error('offline'); } }); cleanup.unshift(async () => service.close()); const d = await service.create({ thread_id: 'thread_test', description: '问题', occurred_at: new Date().toISOString() }); await service.collect(d.local_feedback_id); await expect.poll(async () => (await service.get(d.local_feedback_id)).state).toBe('awaiting_consent'); expect(network).toBe(0); const ready = await service.get(d.local_feedback_id); expect(ready.manifest?.completeness).toBe('partial'); const row = db.prepare('SELECT draft_json FROM feedback_queue').get() as { draft_json: string }; expect(row.draft_json).not.toContain('recovery_token'); const secrets = JSON.parse(await readFile(join(dir, 'feedback', d.local_feedback_id, 'credentials.json'), 'utf8')); expect(Buffer.from(secrets.recovery_token, 'base64url')).toHaveLength(32); allowed = false; await expect(service.send(d.local_feedback_id, { confirmed: true, manifest_sha256: ready.manifest_sha256!, accept_partial: true })).rejects.toThrow('FEEDBACK_POLICY_DISABLED'); });
  it('固定事件边界，超过 50 条仍完整遍历，保留相同真实事件', async () => { const { dir, db } = await fixture(); db.prepare(`INSERT INTO runs(id,thread_id,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version) VALUES('run_test','thread_test','succeeded','done','user','test','/test','/test','project','read-only','test','test','/runtime',1)`).run(); for (let seq = 1; seq <= 600; seq++) db.prepare('INSERT INTO run_events(id,run_id,seq,type,payload_json) VALUES(?,?,?,?,?)').run(`event_${seq}`, 'run_test', seq, 'tool_result', '{"output":"same"}'); const m = await collectFeedback({ db, dataDir: dir, directory: join(dir, 'snapshot'), threadId: 'thread_test', environment: { app_version: 'test' }, signal: new AbortController().signal }); const events = m.artifacts.filter(a => a.source === 'run_events:run_test'); expect(events.reduce((n, a) => n + a.record_count, 0)).toBe(600); expect(m.watermarks[0]).toMatchObject({ max_event_seq: 600, expected_count: 600, exported_count: 600 }); });
  it('取消阻止队列继续发送且允许本地回执读取', async () => { const { dir, db } = await fixture(); const service = new FeedbackService({ db, dataDir: dir, environment: () => ({ app_version: 'test' }), policy: async () => ({ allowed: true }) }); cleanup.unshift(async () => service.close()); const d = await service.create({ thread_id: 'thread_test', description: '问题', occurred_at: new Date().toISOString() }); await service.cancel(d.local_feedback_id); expect((await service.get(d.local_feedback_id)).state).toBe('cancelled'); await expect(service.collect(d.local_feedback_id)).rejects.toThrow('FEEDBACK_SNAPSHOT_FROZEN'); });
});
