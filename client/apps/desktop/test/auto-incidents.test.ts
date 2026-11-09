import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { incidentErrorDiagnostics, type AutomaticIncident, type IncidentObservation } from '@clawee/protocol';
import { AutoIncidentReporter } from '../src/main/auto-incidents.js';
import { IncidentBootstrapMonitor } from '../src/main/incident-bootstrap-monitor.js';
import { parseDaemonProcessMessage } from '../src/main/daemon-manager.js';

vi.mock('electron', () => ({ utilityProcess: {} }));
const directories: string[] = [];
const reporters: AutoIncidentReporter[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T00:00:00Z')); });
afterEach(() => { for (const reporter of reporters.splice(0)) reporter.dispose(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture(input: { enterprise?: string; origin?: string; path?: string; fetchImpl?: typeof fetch; collectLogs?: (incident: AutomaticIncident) => string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-incidents-')); directories.push(directory);
  const path = input.path ?? join(directory, 'auto-incidents.json');
  const snapshots: AutomaticIncident[] = [];
  const fetchImpl = input.fetchImpl ?? vi.fn(async (_url, init) => {
    const snapshot = JSON.parse(String(init?.body)) as AutomaticIncident; snapshots.push(snapshot);
    return Response.json({ data: { incident_id: snapshot.incident_id, accepted_revision: snapshot.revision } });
  });
  const logger = { warnRateLimited: vi.fn() };
  const reporter = new AutoIncidentReporter({ path, environment: { app_version: '0.1.8' }, enterpriseKey: () => input.enterprise ?? '', gatewayOrigin: () => input.origin ?? 'https://gateway.test', logger, fetchImpl, collectLogs: input.collectLogs });
  reporters.push(reporter);
  if (input.enterprise === undefined) reporter.updatePolicy({ enterprise_key: '', allowed: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  const stored = () => JSON.parse(readFileSync(path, 'utf8')) as { records: Array<{ snapshot: AutomaticIncident; acknowledged: number; stopped?: boolean; nextAttempt: number }> };
  return { reporter, path, snapshots, stored, fetchImpl, logger };
}
function observation(patch: Partial<IncidentObservation> = {}): IncidentObservation {
  return { event_id: randomUUID(), event_type: 'error', source: 'daemon', layer: 'codex_model', stage: 'response', error_code: 'responseStreamDisconnected', run_id: 'run_1', retry_count: 1, ...patch };
}
describe('自动异常唯一队列', () => {
  it('反馈策略获取失败记录具体网络原因，超时有明确名称', async () => {
    const view = fixture({ fetchImpl: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND gateway.test Bearer private-value'), { code: 'ENOTFOUND' }) }); } });
    await view.reporter.refreshPolicy();
    expect(view.logger.warnRateLimited).toHaveBeenCalledWith('auto-incidents', '暂时无法读取当前后台反馈策略', expect.objectContaining({ causeCode: 'ENOTFOUND', failureKind: 'dns', requestUrl: 'https://gateway.test/api/v1/feedback/policy', timeoutMs: 5000 }), 60000);
    expect(JSON.stringify(view.logger.warnRateLimited.mock.calls)).not.toContain('private-value');
    const timeout = fixture({ fetchImpl: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); }) });
    const request = timeout.reporter.refreshPolicy();
    await vi.advanceTimersByTimeAsync(5000);
    await request;
    expect(timeout.logger.warnRateLimited).toHaveBeenCalledWith('auto-incidents', '暂时无法读取当前后台反馈策略', expect.objectContaining({ failureKind: 'timeout', causeCode: 'TimeoutError', timeoutMs: 5000, durationMs: 5000 }), 60000);
  });
  it('企业失败的具体原因随首次及最近快照上报，恢复修订保留诊断', async () => {
    const view = fixture();
    const diagnostics = incidentErrorDiagnostics({ name: 'ApiClientError', code: 'ENTERPRISE_SERVICE_UNAVAILABLE', message: '企业服务请求失败：连接超时（UND_ERR_CONNECT_TIMEOUT）', details: {
      failureKind: 'timeout', causeCode: 'UND_ERR_CONNECT_TIMEOUT', requestMethod: 'GET', requestUrl: 'https://gateway.test/api/v1/auth/me', stage: 'request', timeoutMs: 15000, durationMs: 20250, attempts: 2, maxAttempts: 2
    } });
    const error: IncidentObservation = { event_id: randomUUID(), event_type: 'error', source: 'web', layer: 'web_daemon', stage: 'request', error_code: 'WEB_HTTP_FAILED', http_status: 503, diagnostics };
    view.reporter.observe(error);
    await view.reporter.sendNext();
    expect(view.snapshots[0]).toMatchObject({ outcome: 'ongoing', diagnostics, first_diagnostics: diagnostics });
    expect(view.snapshots[0]!.diagnostics!.additional_details).toContain('2/2');
    view.reporter.observe({ event_id: randomUUID(), event_type: 'recovered', source: 'web', layer: 'web_daemon', stage: 'request', error_code: 'WEB_REQUEST_FAILED' });
    await view.reporter.sendNext();
    expect(view.snapshots.at(-1)).toMatchObject({ outcome: 'recovered', diagnostics, first_diagnostics: diagnostics });
    expect(view.snapshots.at(-1)!.timeline?.at(-1)?.event_type).toBe('recovered');
  });
  it('collects and uploads incidents after a previously disabled installation restarts', async () => {
    const first = fixture();
    const state = JSON.parse(readFileSync(first.path, 'utf8'));
    first.reporter.dispose();
    writeFileSync(first.path, JSON.stringify({ ...state, enabled: false }));
    const restarted = fixture({ path: first.path });
    restarted.reporter.observe(observation({ layer: 'daemon_codex', error_code: 'CODEX_STREAM_ERROR' }));
    await restarted.reporter.sendNext();
    expect(restarted.reporter.enabled).toBe(true);
    expect(restarted.snapshots).toHaveLength(1);
    expect(restarted.stored().records[0]?.acknowledged).toBeGreaterThan(0);
  });
  it('手动模型检测异常通过IPC校验并复用反馈接口上传，不与任务故障合并', async () => {
    const view = fixture();
    view.reporter.observe(observation());
    const manual = observation({ run_id: undefined, retry_count: undefined,
      scope_id: `model-check:${'a'.repeat(64)}`, stage: 'model_check.response_headers',
      error_code: 'MODEL_SERVICE_DNS_FAILED', transport_code: 'ENOTFOUND', duration_ms: 42,
      environment: { protocol: 'responses', transport: 'fetch', endpoint_fingerprint: 'b'.repeat(64) },
      diagnostics: { error_name: 'ManualModelCheck', error_message: '手动模型检测失败；响应头：未收到；有效模型文本：未收到', request_method: 'POST', request_path: '/runtime/model-service/check' }
    });
    const parsed = parseDaemonProcessMessage({ data: { type: 'clawee_incident', observation: manual } });
    expect(parsed?.type).toBe('clawee_incident');
    if (parsed?.type !== 'clawee_incident') throw new Error('missing_model_check_incident');
    view.reporter.observe(parsed.observation);
    view.reporter.observe({ ...parsed.observation, event_id: randomUUID() });
    await view.reporter.sendNext();
    await view.reporter.sendNext();
    expect(view.snapshots).toHaveLength(2);
    const sent = view.snapshots.find(snapshot => snapshot.stage === 'model_check.response_headers')!;
    expect(sent).toMatchObject({ scope_id: manual.scope_id, occurrence_count: 2, error_code: 'MODEL_SERVICE_DNS_FAILED', transport_code: 'ENOTFOUND', duration_ms: 42 });
    expect(sent.run_id).toBeUndefined();
    expect(view.fetchImpl).toHaveBeenCalledWith(`https://gateway.test/api/v1/feedback/incidents/${sent.incident_id}`, expect.objectContaining({ method: 'PUT', redirect: 'error' }));
  });
  it('按发生时员工分组，切换账号和退出不会改写历史归属，时间线有界', () => {
    const key = 'a'.repeat(64); const view = fixture({ enterprise: key });
    const first = { enterprise_key: key, subject_id: 'user_zhang', display_name: '张三', agent_id: 'agent_1' };
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    view.reporter.updateIdentity(first, expiresAt);
    for (let index = 0; index < 25; index++) view.reporter.observe(observation());
    view.reporter.updateIdentity({ ...first, subject_id: 'user_li', display_name: '李四' }, expiresAt);
    view.reporter.observe(observation());
    view.reporter.updateIdentity(undefined); view.reporter.observe(observation());
    const snapshots = view.stored().records.map(record => record.snapshot);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({ reporter: first, occurrence_count: 25 });
    expect(snapshots[0]!.timeline).toHaveLength(20);
    expect(snapshots[1]!.reporter?.display_name).toBe('李四');
    expect(snapshots[2]!.reporter).toBeUndefined();
  });
  it('日志独立重试且不阻塞恢复快照，未上传的本地日志保持待传', async () => {
    const data = '{"source":"desktop","content":"ECONNRESET"}\n';
    const collectLogs = vi.fn(() => data);
    let failLogs = true;
    const snapshots: AutomaticIncident[] = [];
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).endsWith('/logs')) return failLogs ? new Response(null, { status: 503 }) : Response.json({ data: { received: true } });
      const snapshot = JSON.parse(String(init?.body)) as AutomaticIncident; snapshots.push(snapshot);
      return Response.json({ data: { incident_id: snapshot.incident_id, accepted_revision: snapshot.revision } });
    }) as typeof fetch;
    const view = fixture({ collectLogs, fetchImpl }); view.reporter.observe(observation());
    const id = view.stored().records[0]!.snapshot.incident_id;
    const logPath = join(view.path, '..', 'incident-logs', `${id}.ndjson`);
    if (process.platform !== 'win32') expect(statSync(logPath).mode & 0o777).toBe(0o600);
    await view.reporter.sendNext(); await view.reporter.sendNext();
    expect(snapshots).toHaveLength(1);
    view.reporter.observe(observation({ event_type: 'recovered' })); await view.reporter.sendNext();
    expect(snapshots.at(-1)?.outcome).toBe('recovered');
    expect(collectLogs).toHaveBeenCalledTimes(1);
    failLogs = false; await vi.advanceTimersByTimeAsync(30000);
    expect(existsSync(logPath)).toBe(false);
    view.reporter.observe(observation({ run_id: 'run_2' }));
    const pendingId = view.stored().records[1]!.snapshot.incident_id;
    const pendingPath = join(view.path, '..', 'incident-logs', `${pendingId}.ndjson`);
    expect(existsSync(pendingPath)).toBe(true);
    view.reporter.dispose(); expect(existsSync(pendingPath)).toBe(true);
  });
  it('诊断保留错误原因和调用位置，但不把凭据写入队列', () => {
    const view = fixture();
    view.reporter.observe(observation({ diagnostics: { error_message: 'connect failed https://alice:password123@host/path Bearer abc.def.ghi', error_stack: 'at /Users/zhang/app.ts:42' } }));
    const serialized = readFileSync(view.path, 'utf8');
    expect(serialized).toContain('/Users/zhang/app.ts:42');
    expect(serialized).not.toContain('password123'); expect(serialized).not.toContain('abc.def.ghi');
  });
  it('三次重连合并，源事件去重，恢复立即更新同一记录', async () => {
    const view = fixture(); const first = observation();
    view.reporter.observe(first); view.reporter.observe(first); await view.reporter.sendNext();
    expect(view.snapshots).toHaveLength(1);
    view.reporter.observe(observation({ retry_count: 2 })); view.reporter.observe(observation({ retry_count: 3 })); await view.reporter.sendNext();
    expect(view.snapshots).toHaveLength(1);
    view.reporter.observe(observation({ event_type: 'recovered' })); await view.reporter.sendNext();
    expect(view.snapshots).toHaveLength(2);
    expect(view.snapshots[1]).toMatchObject({ incident_id: view.snapshots[0]!.incident_id, occurrence_count: 3, retry_count: 3, outcome: 'recovered' });
    // Windows 使用 ACL，stat 不反映 POSIX 权限位。
    if (process.platform !== 'win32') {
      expect(statSync(view.path).mode & 0o777).toBe(0o600);
    }
  });
  it('Web连接恢复只更新连接阶段，不覆盖尚未恢复的请求故障', () => {
    const view = fixture();
    view.reporter.observe({ event_id: randomUUID(), event_type: 'error', source: 'web', layer: 'web_daemon', stage: 'request', error_code: 'WEB_REQUEST_FAILED' });
    view.reporter.observe({ event_id: randomUUID(), event_type: 'error', source: 'web', layer: 'web_daemon', stage: 'connection', error_code: 'WEB_DISCONNECTED' });
    view.reporter.observe({ event_id: randomUUID(), event_type: 'recovered', source: 'web', layer: 'web_daemon', stage: 'connection', error_code: 'WEB_DISCONNECTED' });
    const records = view.stored().records.map(record => record.snapshot);
    expect(records.find(record => record.stage === 'request')?.outcome).toBe('ongoing');
    expect(records.find(record => record.stage === 'connection')?.outcome).toBe('recovered');
  });
  it('旧响应只确认已发送版本，不吞掉并发恢复', async () => {
    let resolve!: (response: Response) => void;
    let sent!: AutomaticIncident;
    const fetchImpl = vi.fn((_url, init) => { sent = JSON.parse(String(init?.body)) as AutomaticIncident; return new Promise<Response>(done => { resolve = done; }); }) as typeof fetch;
    const view = fixture({ fetchImpl }); view.reporter.observe(observation());
    const sending = view.reporter.sendNext();
    view.reporter.observe(observation({ event_type: 'recovered' }));
    resolve(Response.json({ data: { incident_id: sent.incident_id, accepted_revision: sent.revision } })); await sending;
    expect(view.stored().records[0]).toMatchObject({ acknowledged: 1, snapshot: { revision: 2, outcome: 'recovered' } });
  });
  it('未知或过期企业策略只保存在本地，禁止策略重启后仍生效', async () => {
    const key = 'a'.repeat(64); const view = fixture({ enterprise: key });
    view.reporter.observe(observation()); await view.reporter.sendNext(); expect(view.fetchImpl).not.toHaveBeenCalled();
    view.reporter.updatePolicy({ enterprise_key: key, allowed: true, expires_at: new Date(Date.now() - 1).toISOString() });
    await view.reporter.sendNext(); expect(view.fetchImpl).not.toHaveBeenCalled();
    view.reporter.updatePolicy({ enterprise_key: key, allowed: false, expires_at: new Date(Date.now() + 60000).toISOString() });
    expect(view.stored().records).toHaveLength(0); view.reporter.dispose();
    const restarted = fixture({ enterprise: key, path: view.path }); restarted.reporter.observe(observation());
    await restarted.reporter.sendNext(); expect(restarted.stored().records).toHaveLength(0); expect(restarted.fetchImpl).not.toHaveBeenCalled();
  });
  it('有效允许策略补传并继续采集', async () => {
    const key = 'a'.repeat(64); const view = fixture({ enterprise: key }); view.reporter.observe(observation());
    view.reporter.updatePolicy({ enterprise_key: key, allowed: true, expires_at: new Date(Date.now() + 60000).toISOString() });
    await view.reporter.sendNext(); expect(view.snapshots).toHaveLength(1);
    view.reporter.observe(observation()); await view.reporter.sendNext();
    expect(view.stored().records).toHaveLength(1); expect(view.snapshots).toHaveLength(1);
  });
  it('重启补传并标记未知，不伪造恢复', async () => {
    const view = fixture({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }) });
    view.reporter.observe(observation()); await view.reporter.sendNext(); view.reporter.dispose();
    const restarted = fixture({ path: view.path });
    await restarted.reporter.sendNext(); expect(restarted.snapshots).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(restarted.snapshots[0]).toMatchObject({ outcome: 'unknown', revision: 2 });
  });
  it('企业配置无效时保留最近禁止策略，不降级为标准客户端', async () => {
    const key = 'a'.repeat(64); const view = fixture({ enterprise: key });
    view.reporter.updatePolicy({ enterprise_key: key, allowed: false, expires_at: new Date(Date.now() + 60000).toISOString() });
    view.reporter.dispose();
    const restarted = fixture({ enterprise: 'unknown', path: view.path });
    restarted.reporter.observe(observation()); await restarted.reporter.sendNext();
    expect(restarted.stored().records).toHaveLength(0);
    expect(restarted.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(view.path, 'utf8')).policy.allowed).toBe(false);
  });
  it('配置暂时未知时仍接收已绑定企业的新禁止策略', async () => {
    const key = 'a'.repeat(64); const input = { enterprise: key }; const view = fixture(input);
    view.reporter.updatePolicy({ enterprise_key: key, allowed: true, expires_at: new Date(Date.now() + 60000).toISOString() });
    view.reporter.observe(observation()); input.enterprise = 'unknown';
    view.reporter.updatePolicy({ enterprise_key: key, allowed: false, expires_at: new Date(Date.now() + 60000).toISOString() });
    input.enterprise = key; await view.reporter.sendNext();
    expect(view.stored().records).toHaveLength(0); expect(view.fetchImpl).not.toHaveBeenCalled();
    view.reporter.observe(observation()); expect(view.stored().records).toHaveLength(0);
  });
  it.each(['recovered', 'finished'] as const)('429后%s立即落盘但不能绕过Retry-After', async event_type => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '300' } }));
    const view = fixture({ fetchImpl }); view.reporter.observe(observation()); await view.reporter.sendNext();
    view.reporter.observe(observation({ event_type, ...(event_type === 'finished' ? { task_outcome: 'failed' as const } : {}) }));
    expect(view.stored().records[0]?.snapshot.revision).toBe(2);
    await view.reporter.sendNext(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299999); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('重启保留服务端的最早重试期限', async () => {
    const view = fixture({ fetchImpl: vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '300' } })) });
    view.reporter.observe(observation()); await view.reporter.sendNext(); view.reporter.dispose();
    const restarted = fixture({ path: view.path }); await restarted.reporter.sendNext();
    expect(restarted.snapshots).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300000); expect(restarted.snapshots).toHaveLength(1);
  });
  it.each(['unknown', 'expired', 'acknowledged'])('%s策略或已确认记录静默七天后也删除磁盘数据', async mode => {
    const key = 'a'.repeat(64);
    const view = fixture({ enterprise: mode === 'acknowledged' ? '' : key });
    if (mode === 'expired') view.reporter.updatePolicy({ enterprise_key: key, allowed: true, expires_at: new Date(Date.now() - 1).toISOString() });
    view.reporter.observe(observation());
    if (mode === 'acknowledged') await view.reporter.sendNext();
    expect(view.stored().records).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    expect(view.stored().records).toHaveLength(0);
  });
  it('清理七天数据，队列最多100条，非任务检测的HTTP分类不混并', () => {
    const view = fixture({ enterprise: 'a'.repeat(64) });
    view.reporter.observe(observation({ stage: 'model_check.response_headers', http_status: 503 })); view.reporter.observe(observation({ stage: 'model_check.response_headers', transport_code: 'ETIMEDOUT' }));
    expect(view.stored().records).toHaveLength(2);
    for (let index = 0; index < 105; index++) view.reporter.observe(observation({ run_id: `run_${index + 10}` }));
    expect(view.stored().records).toHaveLength(100);
    vi.setSystemTime(Date.now() + 7 * 86400000 + 1); view.reporter.observe(observation({ run_id: 'new_run' }));
    expect(view.stored().records).toHaveLength(1);
  });
  it('同一任务保留首次和最近原因，分类变化及重试耗尽仍更新同一记录', async () => {
    const collectLogs = vi.fn(() => '{"content":"first log"}\n');
    const view = fixture({ collectLogs });
    const firstDiagnostics = { error_message: 'Reconnecting... 1/5', additional_details: 'HTTP 503; request_id: req_first', request_id: 'req_first' };
    view.reporter.observe(observation({ http_status: 503, upstream_request_id: 'req_first', diagnostics: firstDiagnostics }));
    await view.reporter.sendNext();
    const id = view.snapshots[0]!.incident_id;
    view.reporter.observe(observation({ transport_code: 'ECONNRESET', retry_count: 2, diagnostics: { error_message: 'Reconnecting... 2/5', cause_code: 'ECONNRESET' } }));
    view.reporter.observe(observation({ error_code: 'responseTooManyFailedAttempts', retry_count: undefined, diagnostics: { error_message: 'retry limit exceeded' } }));
    view.reporter.observe(observation({ event_type: 'finished', task_outcome: 'failed', retry_count: undefined }));
    await view.reporter.sendNext();
    expect(view.stored().records).toHaveLength(1);
    expect(view.snapshots.at(-1)).toMatchObject({ incident_id: id, first_message: 'responseStreamDisconnected HTTP 503', first_diagnostics: firstDiagnostics,
      error_code: 'responseTooManyFailedAttempts', message: 'responseTooManyFailedAttempts', occurrence_count: 3, retry_count: 2,
      diagnostics: { error_message: 'retry limit exceeded' }, outcome: 'failed', task_outcome: 'failed' });
    expect(view.snapshots.at(-1)?.http_status).toBeUndefined();
    expect(view.snapshots.at(-1)?.transport_code).toBeUndefined();
    expect(view.snapshots.at(-1)?.upstream_request_id).toBeUndefined();
    expect(collectLogs).toHaveBeenCalledTimes(1);
  });
  it('重复错误和无次数通知不补造重试次数，终态失败更新恢复后的记录', () => {
    const view = fixture();
    view.reporter.observe(observation({ retry_count: 3 }));
    view.reporter.observe(observation({ retry_count: 3 }));
    view.reporter.observe(observation({ retry_count: undefined }));
    expect(view.stored().records[0]!.snapshot.retry_count).toBe(3);
    view.reporter.observe(observation({ event_type: 'recovered', retry_count: undefined }));
    view.reporter.observe(observation({ event_type: 'finished', task_outcome: 'failed', retry_count: undefined }));
    expect(view.stored().records[0]!.snapshot).toMatchObject({ outcome: 'failed', task_outcome: 'failed' });
  });
  it('拒绝自由文本、密钥URL、路径和未知字段', () => {
    const view = fixture();
    for (const patch of [{ message: 'business body sk-private' }, { transport_code: '/Users/private/file' }, { upstream_request_id: 'https://user:pass@host?key=123' }]) view.reporter.observe({ ...observation(), ...patch });
    expect(view.stored().records).toHaveLength(0);
    const text = readFileSync(view.path, 'utf8'); expect(text).not.toContain('business body'); expect(text).not.toContain('/Users/');
  });
  it.each([400, 401, 403, 409, 413])('%i停止单条发送', async status => {
    const view = fixture({ fetchImpl: vi.fn(async () => new Response(null, { status })) }); view.reporter.observe(observation()); await view.reporter.sendNext();
    expect(view.stored().records[0]?.stopped).toBe(true);
  });
  it('404在本应用会话暂停，429遵循Retry-After且串行发送', async () => {
    const view = fixture({ fetchImpl: vi.fn(async () => new Response(null, { status: 404 })) }); view.reporter.observe(observation()); await view.reporter.sendNext();
    view.reporter.observe(observation({ run_id: 'run_2' })); await view.reporter.sendNext(); expect(view.fetchImpl).toHaveBeenCalledTimes(1);
    const limited = fixture({ fetchImpl: vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '300' } })) });
    limited.reporter.observe(observation()); await limited.reporter.sendNext();
    expect(limited.stored().records[0]?.nextAttempt).toBe(Date.now() + 300000);
  });
  it('上传五秒超时且按30秒、2分钟、10分钟、30分钟退避', async () => {
    const timed = fixture({ fetchImpl: vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as typeof fetch });
    timed.reporter.observe(observation()); const sending = timed.reporter.sendNext();
    await vi.advanceTimersByTimeAsync(4999);
    expect(timed.stored().records[0]?.nextAttempt).toBe(0);
    await vi.advanceTimersByTimeAsync(1); await sending;
    expect(timed.stored().records[0]?.nextAttempt).toBe(Date.now() + 30000);
    const failed = fixture({ fetchImpl: vi.fn(async () => new Response(null, { status: 503 })) });
    failed.reporter.observe(observation());
    for (const delay of [30000, 120000, 600000, 1800000, 1800000]) {
      await failed.reporter.sendNext();
      expect(failed.stored().records[0]?.nextAttempt).toBe(Date.now() + delay);
      vi.setSystemTime(Date.now() + delay);
    }
  });
  it('上传在途时禁止策略立即中止且清空，不被迟到响应重建', async () => {
    const key = 'a'.repeat(64); let signal: AbortSignal | undefined; let resolve!: (response: Response) => void;
    const view = fixture({ enterprise: key, fetchImpl: vi.fn((_url, init) => {
      signal = init?.signal ?? undefined; return new Promise<Response>(done => { resolve = done; });
    }) as typeof fetch });
    view.reporter.updatePolicy({ enterprise_key: key, allowed: true, expires_at: new Date(Date.now() + 60000).toISOString() });
    view.reporter.observe(observation()); const sending = view.reporter.sendNext();
    view.reporter.updatePolicy({ enterprise_key: key, allowed: false, expires_at: new Date(Date.now() + 60000).toISOString() });
    expect(signal?.aborted).toBe(true); expect(view.stored().records).toHaveLength(0);
    resolve(new Response(null, { status: 503 })); await sending;
    expect(view.stored().records).toHaveLength(0);
  });
});
describe('未登录启动观测', () => {
  it('60秒仅观测最后阶段，后续就绪更新恢复；迁移和主动停止不上报', async () => {
    const observe = vi.fn(); const monitor = new IncidentBootstrapMonitor({ observe });
    const state = { phase: 'migrating_data' as const, attempt: 0, startedAt: '', updatedAt: '' };
    monitor.update(state); await vi.advanceTimersByTimeAsync(60001); expect(observe).not.toHaveBeenCalled();
    monitor.update({ ...state, attempt: 1, phase: 'resolving_codex' }); await vi.advanceTimersByTimeAsync(59999); expect(observe).not.toHaveBeenCalled();
    monitor.update({ ...state, attempt: 1, phase: 'probing_codex' }); await vi.advanceTimersByTimeAsync(1);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'probing_codex', error_code: 'RUNTIME_STARTUP_STALLED' }));
    monitor.update({ ...state, attempt: 1, phase: 'ready' }); expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'recovered' }));
    monitor.stop(); monitor.exit({ code: 1, reason: 'unexpected' }); expect(observe).toHaveBeenCalledTimes(2);
  });
  it('daemon完全启动失败无需Run或Thread即可上传', async () => {
    const view = fixture(); const monitor = new IncidentBootstrapMonitor(view.reporter);
    monitor.update({ phase: 'failed', attempt: 1, startedAt: '', updatedAt: '', error: { code: 'DAEMON_START_FAILED', message: '/Users/private/key sk-private' } });
    await view.reporter.sendNext(); expect(view.snapshots[0]).toMatchObject({ source: 'desktop', layer: 'desktop_bootstrap', outcome: 'failed' });
    expect(view.snapshots[0]?.run_id).toBeUndefined();
    expect(view.snapshots[0]?.diagnostics?.error_message).toBe('/Users/private/key [REDACTED]');
    expect(JSON.stringify(view.snapshots)).not.toContain('sk-private'); monitor.stop();
  });
  it('进程消息拒绝未知事件和额外字段', () => {
    const event = observation(); expect(parseDaemonProcessMessage({ data: { type: 'clawee_incident', observation: event } })).toEqual({ type: 'clawee_incident', observation: event });
    expect(parseDaemonProcessMessage({ type: 'clawee_incident', observation: { ...event, params: { api_key: 'secret' } } })).toBeUndefined();
  });
});
