import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { collectFeedback } from '../../src/feedback/collector.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'clawee-light-feedback-'));
  const db = openRuntimeDatabase(join(directory, 'runtime.sqlite'));
  cleanup.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.prepare("INSERT INTO threads(id,cwd,canonical_cwd,workspace_mode,profile,sandbox,status) VALUES('thread_test','/secret/customer','/secret/customer','project','test','read-only','active')").run();
  db.prepare("INSERT INTO runs(id,thread_id,public_prompt,public_status,internal_status,created_by,profile,cwd,canonical_cwd,workspace_mode,sandbox,codex_version,codex_bin,codex_home,normalizer_version,error_message) VALUES('run_test','thread_test','BUSINESS_SECRET','failed','failed','user','test','/secret/customer','/secret/customer','project','read-only','test','test','/secret/home',1,'BUSINESS_SECRET')").run();
  return { directory, db };
}
it('默认轻量采集不读取或导出会话、工具输出、附件、历史日志及任意环境字段', async () => {
  const { directory, db } = await fixture();
  for (let seq = 1; seq <= 600; seq++) db.prepare('INSERT INTO run_events(id,run_id,seq,type,payload_json) VALUES(?,?,?,?,?)').run(`event_${seq}`, 'run_test', seq, 'tool_result', '{"output":"BUSINESS_SECRET"}');
  db.prepare('INSERT INTO feedback_diagnostics(thread_id,record_json,created_at) VALUES(?,?,?)').run('thread_test', '{"error_code":"browser_error","message":"BUSINESS_SECRET"}', new Date().toISOString());
  const manifest = await collectFeedback({ db, dataDir: directory, directory, threadId: 'thread_test', environment: { app_version: '1.0.0', token: 'BUSINESS_SECRET', model: 'BUSINESS_SECRET' }, native: { environment: { electron_version: '43.1.1' }, records: ['BUSINESS_SECRET'], warnings: ['BUSINESS_SECRET'] }, signal: new AbortController().signal });
  expect(manifest).toMatchObject({ collection_scope: 'basic', completeness: 'complete', missing_items: [], runtime_thread_ids: [], run_ids: [] });
  expect(manifest.artifacts).toHaveLength(1);
  expect(manifest.artifacts[0]!.kind).toBe('diagnostics');
  const text = await readFile(join(directory, manifest.artifacts[0]!.artifact_id), 'utf8');
  expect(text).toContain('43.1.1');
  expect(text).not.toContain('BUSINESS_SECRET');
  expect(text).not.toContain('/secret');
  expect(text).not.toContain('browser_error');
  expect(Buffer.byteLength(text)).toBeLessThan(4096);
});
it('附加诊断仅保留最近十分钟最近运行的至多200条白名单记录', async () => {
  const { directory, db } = await fixture();
  const insert = db.prepare('INSERT INTO feedback_diagnostics(thread_id,record_json,created_at) VALUES(?,?,?)');
  insert.run('thread_test', '{"source":"web","error_code":"network_failed"}', new Date(Date.now() - 11 * 60000).toISOString());
  insert.run('thread_test', '{"source":"daemon","run_id":"run_old","error_code":"http_failed"}', new Date().toISOString());
  for (let i = 0; i < 250; i++) insert.run('thread_test', '{"source":"web","error_code":"browser_error","status":500,"route":"/secret/customer","message":"BUSINESS_SECRET","request_id":"BUSINESS_SECRET"}', new Date().toISOString());
  const manifest = await collectFeedback({ db, dataDir: directory, directory, threadId: 'thread_test', environment: {}, includeDiagnostics: true, signal: new AbortController().signal });
  expect(manifest).toMatchObject({ collection_scope: 'diagnostics', completeness: 'complete', missing_items: [] });
  const text = await readFile(join(directory, manifest.artifacts[0]!.artifact_id), 'utf8');
  const records = text.trim().split('\n').map(line => JSON.parse(line));
  expect(records).toHaveLength(201);
  expect(text).not.toContain('BUSINESS_SECRET');
  expect(text).not.toContain('/secret');
  expect(text).not.toContain('network_failed');
  expect(text).not.toContain('http_failed');
  expect(text.match(/browser_error/g)).toHaveLength(200);
});
