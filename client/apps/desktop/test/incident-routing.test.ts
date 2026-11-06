import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AutomaticIncident, IncidentObservation } from '@clawee/protocol';
import { AutoIncidentReporter } from '../src/main/auto-incidents.js';

const reporters: AutoIncidentReporter[] = [];
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const reporter of reporters.splice(0)) reporter.dispose();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function receiver() {
  const events: Array<{ path: string; credential?: string; body: string }> = [];
  let enabled = true;
  let available = true;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/feedback/policy') {
      response.statusCode = available ? 200 : 503;
      response.end(JSON.stringify({ data: { enabled, policy_version: 1, expires_at: new Date(Date.now() + 60_000).toISOString() } })); return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    events.push({ path: request.url!, credential: request.headers.authorization, body });
    if (request.url?.endsWith('/logs')) response.end(JSON.stringify({ data: { received: true } }));
    else { const snapshot = JSON.parse(body) as AutomaticIncident; response.end(JSON.stringify({ data: { incident_id: snapshot.incident_id, accepted_revision: snapshot.revision } })); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_address');
  return { origin: `http://127.0.0.1:${address.port}`, events, setEnabled(value: boolean) { enabled = value; }, setAvailable(value: boolean) { available = value; } };
}
function fixture(target: { origin?: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-incident-routing-')); directories.push(directory);
  const path = join(directory, 'auto-incidents.json');
  const reporter = new AutoIncidentReporter({ path, environment: {}, gatewayOrigin: () => target.origin,
    enterpriseKey: () => target.origin ? createHash('sha256').update(target.origin).digest('hex') : 'unknown',
    logger: { warnRateLimited() {} }, collectLogs: () => '{"source":"desktop","content":"ECONNRESET"}\n' });
  reporters.push(reporter);
  const observation = (): IncidentObservation => ({ event_id: randomUUID(), event_type: 'error', source: 'desktop', layer: 'desktop_bootstrap', stage: 'starting_daemon', error_code: 'DAEMON_START_FAILED' });
  return { reporter, path, observation };
}

it('无需daemon或登录即可读取本部署策略，快照与日志发送到同一后台', async () => {
  const backend = await receiver(); const view = fixture({ origin: backend.origin });
  expect(view.reporter.enabled).toBe(true);
  view.reporter.observe(view.observation()); await view.reporter.sendNext();
  expect(backend.events).toHaveLength(0);
  await view.reporter.refreshPolicy(); await view.reporter.sendNext(); await view.reporter.sendNext();
  await expect.poll(() => backend.events.length).toBe(2);
  expect(backend.events[1]!.path).toBe(`${backend.events[0]!.path}/logs`);
  expect(backend.events[1]!.credential).toBe(backend.events[0]!.credential);
});

it('切换后台无需弹窗，旧快照和日志不会串发，新后台无法继承旧策略', async () => {
  const first = await receiver(); const second = await receiver(); const target = { origin: first.origin };
  const view = fixture(target);
  view.reporter.observe(view.observation());
  const oldId = JSON.parse(readFileSync(view.path, 'utf8')).records[0].snapshot.incident_id;
  target.origin = second.origin;
  await view.reporter.sendNext(); expect(second.events).toHaveLength(0);
  await view.reporter.refreshPolicy(); view.reporter.observe(view.observation()); await view.reporter.sendNext(); await view.reporter.sendNext();
  await expect.poll(() => second.events.length).toBe(2);
  expect(JSON.stringify(second.events)).not.toContain(oldId); expect(first.events).toHaveLength(0);
  const state = JSON.parse(readFileSync(view.path, 'utf8'));
  expect(state.records.find((record: { snapshot: { incident_id: string } }) => record.snapshot.incident_id === oldId).gatewayOrigin).toBe(first.origin);
});

it('后台不可达只留本地，关闭后不上传，没有Gateway也不回退维护中心', async () => {
  const backend = await receiver(); backend.setAvailable(false);
  const target = { origin: backend.origin }; const view = fixture(target);
  view.reporter.observe(view.observation());
  await view.reporter.refreshPolicy(); await view.reporter.sendNext(); expect(backend.events).toHaveLength(0);
  backend.setAvailable(true); backend.setEnabled(false);
  await view.reporter.refreshPolicy(); await view.reporter.sendNext(); expect(backend.events).toHaveLength(0);
  expect(JSON.parse(readFileSync(view.path, 'utf8')).records).toHaveLength(0);
  const missing = fixture({}); missing.reporter.observe(missing.observation());
  await missing.reporter.refreshPolicy(); await missing.reporter.sendNext();
  expect(JSON.parse(readFileSync(missing.path, 'utf8')).records).toHaveLength(0);
});

it('旧维护中心队列不迁移，原有关闭选择不再生效', () => {
  const view = fixture({ origin: 'https://customer.test' }); view.reporter.observe(view.observation()); view.reporter.dispose();
  const legacy = JSON.parse(readFileSync(view.path, 'utf8')); delete legacy.routingVersion;
  expect(legacy.records).toHaveLength(1); writeFileSync(view.path, JSON.stringify(legacy));
  const reporter = new AutoIncidentReporter({ path: view.path, environment: {}, gatewayOrigin: () => 'https://customer.test', enterpriseKey: () => 'key', logger: { warnRateLimited() {} } });
  reporters.push(reporter);
  expect(reporter.enabled).toBe(true);
  expect(JSON.parse(readFileSync(view.path, 'utf8')).records).toHaveLength(0);
  reporter.dispose();
  writeFileSync(view.path, JSON.stringify({ ...JSON.parse(readFileSync(view.path, 'utf8')), enabled: false }));
  const disabled = new AutoIncidentReporter({ path: view.path, environment: {}, gatewayOrigin: () => 'https://customer.test', enterpriseKey: () => 'key', logger: { warnRateLimited() {} } });
  reporters.push(disabled); expect(disabled.enabled).toBe(true);
});
