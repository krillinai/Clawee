import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AutomaticIncident } from '@clawee/protocol';
import { AutoIncidentReporter } from '../src/main/auto-incidents.js';
import { parseDaemonProcessMessage } from '../src/main/daemon-manager.js';

vi.mock('electron', () => ({ utilityProcess: {} }));
const directories: string[] = [];
const reporters: AutoIncidentReporter[] = [];
const origin = 'https://enterprise.example';
const enterpriseKey = createHash('sha256').update(origin).digest('hex');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T00:00:00Z')); });
afterEach(() => { for (const reporter of reporters.splice(0)) reporter.dispose(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture(path?: string, fetchImpl?: typeof fetch, collectLogs?: (incident: AutomaticIncident) => string) {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-diagnostics-')); directories.push(directory);
  path ??= join(directory, 'queue.json');
  const reporter = new AutoIncidentReporter({ path, enterpriseKey: () => enterpriseKey, gatewayOrigin: () => origin, environment: {}, logger: { warnRateLimited: vi.fn() }, fetchImpl, collectLogs });
  reporters.push(reporter);
  return { reporter, path, read: () => JSON.parse(readFileSync(path, 'utf8')) as { records: Array<{ snapshot: AutomaticIncident; logsAcknowledged?: boolean }> } };
}
const observe = () => ({ event_id: randomUUID(), event_type: 'error' as const, source: 'daemon' as const, layer: 'codex_model' as const, stage: 'response', error_code: 'RUNTIME_ERROR', run_id: 'run_1' });
it('登录前和员工快照过期后仍保留 Agent，重新登录不改写历史员工', () => {
  const view = fixture();
  const agent = { enterprise_key: enterpriseKey, agent_id: 'agent_1' };
  const employee = { ...agent, subject_id: 'user_zhang', display_name: '张三' };
  const message = { type: 'clawee_incident_identity', identity: agent };
  expect(parseDaemonProcessMessage(message)).toMatchObject(message);
  view.reporter.updateIdentity(agent);
  view.reporter.observe(observe());
  view.reporter.updateIdentity(employee, new Date(Date.now() + 60000).toISOString());
  view.reporter.observe(observe());
  vi.advanceTimersByTime(60001);
  view.reporter.observe(observe());
  expect(view.read().records.map(record => record.snapshot.reporter)).toEqual([agent, employee]);
  expect(view.read().records[0]!.snapshot.occurrence_count).toBe(2);
});
it('重启后沿用故障时员工及原始日志，不重新采集或按新账号重贴身份', async () => {
  const original = '{"content":"first failure on device A"}\n';
  const collect = vi.fn(() => original);
  const first = fixture(undefined, vi.fn(async () => { throw new Error('offline'); }), collect);
  first.reporter.updatePolicy({ enterprise_key: enterpriseKey, allowed: true, expires_at: new Date(Date.now() + 60000).toISOString() });
  first.reporter.updateIdentity({ enterprise_key: enterpriseKey, subject_id: 'user_zhang', display_name: '张三' }, new Date(Date.now() + 60000).toISOString());
  first.reporter.observe(observe()); first.reporter.dispose();
  const id = first.read().records[0]!.snapshot.incident_id;
  let uploaded = '';
  const fetchImpl = vi.fn(async (url, init) => {
    if (String(url).endsWith('/logs')) { uploaded = new TextDecoder().decode(init?.body as Uint8Array); return Response.json({ data: { received: true } }); }
    const snapshot = JSON.parse(String(init?.body)) as AutomaticIncident;
    return Response.json({ data: { incident_id: snapshot.incident_id, accepted_revision: snapshot.revision } });
  }) as typeof fetch;
  const restarted = fixture(first.path, fetchImpl, vi.fn(() => 'new logs must not replace old snapshot'));
  restarted.reporter.updateIdentity({ enterprise_key: enterpriseKey, subject_id: 'user_li', display_name: '李四' }, new Date(Date.now() + 60000).toISOString());
  await restarted.reporter.sendNext(); await restarted.reporter.sendNext();
  expect(uploaded).toBe(original); expect(collect).toHaveBeenCalledOnce();
  expect(restarted.read().records[0]).toMatchObject({ snapshot: { reporter: { display_name: '张三' }, outcome: 'unknown' }, logsAcknowledged: true });
  expect(existsSync(join(first.path, '..', 'incident-logs', `${id}.ndjson`))).toBe(false);
});
it('过期、无效或不属于当前企业的员工身份不参与归属', () => {
  const view = fixture();
  for (const context of [
    { identity: { enterprise_key: enterpriseKey, subject_id: 'user_1', display_name: '张三' }, expiresAt: new Date(Date.now() - 1).toISOString() },
    { identity: { enterprise_key: 'b'.repeat(64), subject_id: 'user_2', display_name: '李四' }, expiresAt: new Date(Date.now() + 60000).toISOString() }
  ]) {
    view.reporter.updateIdentity(context.identity, context.expiresAt); view.reporter.observe(observe());
  }
  expect(view.read().records.every(record => record.snapshot.reporter === undefined)).toBe(true);
});
it('旧通知版本不阻止采集，旧的关闭选择不再生效', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-incident-preference-')); directories.push(directory);
  const path = join(directory, 'queue.json');
  const state = { installationId: randomUUID(), enabled: true, notified: true, noticeVersion: 1, noticeOrigin: origin, routingVersion: 1, enterpriseKey, records: [] };
  writeFileSync(path, JSON.stringify(state));
  const view = fixture(path); view.reporter.observe(observe());
  expect(view.reporter.enabled).toBe(true); expect(view.read().records).toHaveLength(1);
  view.reporter.dispose();
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), enabled: false }));
  const restarted = fixture(path); restarted.reporter.observe(observe());
  expect(restarted.reporter.enabled).toBe(true); expect(restarted.read().records).toHaveLength(2);
});
it('账号同步消息不接受登录凭据，登出可清除身份', () => {
  const message = { type: 'clawee_incident_identity', identity: { enterprise_key: enterpriseKey, subject_id: 'user_zhang', display_name: '张三' }, expires_at: new Date(Date.now() + 60000).toISOString() };
  expect(parseDaemonProcessMessage(message)).toEqual(message);
  expect(parseDaemonProcessMessage({ ...message, access_token: 'private' })).toBeUndefined();
  expect(parseDaemonProcessMessage({ type: 'clawee_incident_identity', identity: null })).toMatchObject({ identity: null });
});
