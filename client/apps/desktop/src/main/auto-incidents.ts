import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  resolveFeedbackOrigin, INCIDENT_LOG_MAX_BYTES, incidentMessage, isAutomaticIncident, isIncidentObservation, isIncidentReporterIdentity, httpFailureDetails,
  type AutomaticIncident, type FeedbackPolicy, type IncidentEnvironment, type IncidentObservation, type IncidentPolicy, type IncidentReporterIdentity
} from '@clawee/protocol';
import type { DesktopLogger } from './logger.js';
import { redactValue } from './redaction.js';

type QueuedIncident = {
  gatewayOrigin: string;
  snapshot: AutomaticIncident; credential: string; acknowledged: number;
  createdAt: number; nextAttempt: number; lastAttempt: number; failures: number; stopped?: boolean;
  logsSHA256?: string; logsAcknowledged?: boolean; logsStopped?: boolean; logsNextAttempt?: number; logsFailures?: number;
};
type Persisted = {
  installationId: string; enabled: boolean; routingVersion?: number; enterpriseKey?: string; policy?: IncidentPolicy; records: QueuedIncident[];
};
const retention = 7 * 24 * 60 * 60 * 1000;
const backoff = [30_000, 120_000, 600_000, 1_800_000];

export class AutoIncidentReporter {
  readonly sessionId = randomUUID();
  private state: Persisted = { installationId: randomUUID(), enabled: true, records: [] };
  private seen = new Set<string>();
  private sending = false;
  private paused = false;
  private disposed = false;
  private timer?: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  private request?: AbortController;
  private policyRequest?: AbortController;
  private policyTimer?: NodeJS.Timeout;
  private gatewayOrigin?: string;
  private identity?: { value: IncidentReporterIdentity; expiresAt: number };
  constructor(private readonly input: {
    path: string; environment: IncidentEnvironment; enterpriseKey: () => string; gatewayOrigin: () => string | undefined;
    logger: Pick<DesktopLogger, 'warnRateLimited'>; fetchImpl?: typeof fetch; now?: () => number;
    collectLogs?: (incident: AutomaticIncident) => string;
  }) {
    this.load();
    this.synchronizeEnterprise();
    if (this.prohibited()) this.clearCurrentRecords();
    this.removeOrphanLogs();
    for (const record of this.state.records) {
      if (record.snapshot.outcome === 'ongoing') {
        record.snapshot.outcome = 'unknown'; record.snapshot.revision++;
        if (record.failures === 0) record.nextAttempt = 0;
      }
    }
    this.prune(); this.persist();
  }
  get enabled() { return this.state.enabled; }
  updatePolicy(policy: IncidentPolicy) {
    this.synchronizeEnterprise();
    if (policy.enterprise_key !== this.state.enterpriseKey || !Number.isFinite(Date.parse(policy.expires_at))) return;
    this.state.policy = policy;
    if (!policy.allowed) { this.request?.abort(); this.clearCurrentRecords(); this.seen.clear(); }
    this.persist(); this.schedule();
  }
  updateIdentity(value: unknown, expiresAt?: string) {
    if (!isIncidentReporterIdentity(value) || value.enterprise_key !== this.input.enterpriseKey()) { this.identity = undefined; return; }
    this.identity = value.subject_id && expiresAt && Date.parse(expiresAt) > this.now()
      ? { value: structuredClone(value), expiresAt: Date.parse(expiresAt) }
      : value.agent_id ? { value: { enterprise_key: value.enterprise_key, agent_id: value.agent_id }, expiresAt: Infinity } : undefined;
  }
  updateEnvironment(environment: IncidentEnvironment) { Object.assign(this.input.environment, environment); }
  start() {
    if (this.disposed || this.policyTimer) return;
    void this.refreshPolicy();
    this.policyTimer = setInterval(() => { void this.refreshPolicy(); }, 60_000);
    this.policyTimer.unref?.();
  }
  async refreshPolicy() {
    this.synchronizeEnterprise();
    if (this.disposed || !this.state.enabled || !this.gatewayOrigin || this.policyRequest) return;
    if (this.disposed || !this.state.enabled || !this.gatewayOrigin) return;
    const origin = this.gatewayOrigin;
    const enterpriseKey = this.input.enterpriseKey();
    const controller = new AbortController(); this.policyRequest = controller;
    const startedAt = this.now();
    const context = () => ({ requestMethod: 'GET', requestUrl: `${origin}/api/v1/feedback/policy`, timeoutMs: 5000, durationMs: Math.max(0, this.now() - startedAt) });
    const timeout = setTimeout(() => controller.abort(new DOMException('反馈策略请求超过 5000 ms', 'TimeoutError')), 5000);
    try {
      const response = await (this.input.fetchImpl ?? fetch)(`${origin}/api/v1/feedback/policy`, { redirect: 'error', credentials: 'omit', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        this.warn('暂时无法读取当前后台反馈策略', httpFailureDetails(undefined, { ...context(), failureKind: 'response', stage: 'response', statusCode: response.status, requestId: response.headers.get('X-Request-ID') }));
        return;
      }
      const { data } = await response.json() as { data?: FeedbackPolicy };
      this.synchronizeEnterprise();
      if (controller.signal.aborted || this.disposed || this.gatewayOrigin !== origin || !data || typeof data.enabled !== 'boolean' || data.policy_version !== 1 || !Number.isFinite(Date.parse(data.expires_at))) return;
      this.updatePolicy({ enterprise_key: enterpriseKey, allowed: data.enabled, expires_at: new Date(Math.min(Date.parse(data.expires_at), this.now() + 3_600_000)).toISOString() });
    } catch (error) {
      this.warn('暂时无法读取当前后台反馈策略', httpFailureDetails(controller.signal.aborted ? controller.signal.reason : error,
        { ...context(), stage: error instanceof SyntaxError ? 'decode' : 'request', ...(error instanceof SyntaxError ? { failureKind: 'decode' } : {}) }));
    }
    finally { clearTimeout(timeout); if (this.policyRequest === controller) this.policyRequest = undefined; }
  }
  observe(value: unknown): void {
    this.synchronizeEnterprise();
    if (this.disposed || !this.gatewayOrigin || !this.state.enabled || this.prohibited() || !isIncidentObservation(value) || this.seen.has(value.event_id)) return;
    this.seen.add(value.event_id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    this.prune();
    if (value.diagnostics) value = { ...value, diagnostics: redactValue(value.diagnostics) } as IncidentObservation;
    if (!isIncidentObservation(value)) return;
    const now = this.now();
    const current = this.identity?.value.enterprise_key === this.input.enterpriseKey() ? this.identity : undefined;
    const identity = current && current.expiresAt > now ? current.value
      : current?.value.agent_id ? { enterprise_key: current.value.enterprise_key, agent_id: current.value.agent_id } : undefined;
    const scope = value.run_id ?? value.scope_id ?? 'connection';
    const matches = this.state.records.filter(record => record.gatewayOrigin === this.gatewayOrigin && record.snapshot.app_session_id === this.sessionId
      && record.snapshot.reporter?.subject_id === identity?.subject_id && record.snapshot.reporter?.enterprise_key === identity?.enterprise_key && record.snapshot.reporter?.agent_id === identity?.agent_id
      && (record.snapshot.run_id ?? record.snapshot.scope_id ?? 'connection') === scope && record.snapshot.layer === value.layer
      && (value.event_type !== 'recovered' || value.source !== 'web' || record.snapshot.stage === value.stage));
    if (value.event_type !== 'error') {
      let changed = false;
      for (const record of matches) {
        const snapshot = record.snapshot;
        if (value.event_type === 'recovered' && snapshot.outcome === 'recovered') continue;
        changed = true;
        if (value.event_type === 'recovered') snapshot.outcome = 'recovered';
        else {
          snapshot.task_outcome = value.task_outcome;
          if (value.task_outcome === 'failed') snapshot.outcome = 'failed';
          else if (snapshot.outcome !== 'recovered') snapshot.outcome = 'unknown';
        }
        snapshot.revision++;
        this.appendTimeline(snapshot, value, now);
        if (record.failures === 0) record.nextAttempt = 0;
      }
      if (!changed) return;
    } else {
      const modelResponse = value.layer === 'codex_model' && value.stage === 'response' && Boolean(value.run_id);
      let record = matches.find(item => modelResponse ? item.snapshot.stage === 'response'
        : item.snapshot.error_code === value.error_code && item.snapshot.http_status === value.http_status && item.snapshot.transport_code === value.transport_code
          && item.snapshot.diagnostics?.request_method === value.diagnostics?.request_method && item.snapshot.diagnostics?.request_path === value.diagnostics?.request_path);
      const { event_id: _eventId, event_type: _eventType, environment, ...facts } = value;
      const message = incidentMessage(value);
      if (!record) {
        record = { gatewayOrigin: this.gatewayOrigin, snapshot: {
          ...facts, schema_version: 1, policy_version: 1, incident_id: randomUUID(),
          installation_id: this.state.installationId, app_session_id: this.sessionId,
          revision: 1, first_seen_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
          occurrence_count: 1, outcome: 'ongoing', message, first_message: message,
          ...(value.diagnostics ? { first_diagnostics: structuredClone(value.diagnostics) } : {}),
          environment: { ...this.input.environment, ...environment }, ...(identity ? { reporter: structuredClone(identity) } : {})
        }, credential: randomBytes(32).toString('hex'), acknowledged: 0, createdAt: now, nextAttempt: 0, lastAttempt: 0, failures: 0 };
        if (!isAutomaticIncident(record.snapshot)) return;
        this.appendTimeline(record.snapshot, value, now);
        this.captureLogs(record);
        this.state.records.push(record);
      } else {
        const retries = modelResponse ? value.retry_count ?? record.snapshot.retry_count
          : (record.snapshot.retry_count ?? 0) + (value.retry_count ?? 0);
        if (modelResponse) {
          delete record.snapshot.http_status; delete record.snapshot.transport_code;
          delete record.snapshot.upstream_request_id; delete record.snapshot.diagnostics;
        }
        Object.assign(record.snapshot, facts, { message, environment: { ...record.snapshot.environment, ...environment }, last_seen_at: new Date(now).toISOString(), outcome: 'ongoing' });
        if (retries) record.snapshot.retry_count = retries;
        record.snapshot.revision++; record.snapshot.occurrence_count++;
        this.appendTimeline(record.snapshot, value, now);
        record.nextAttempt = Math.max(record.nextAttempt, record.lastAttempt + 60_000);
      }
    }
    this.prune(); this.persist(); this.schedule();
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timer); clearTimeout(this.expiryTimer); clearInterval(this.policyTimer); this.request?.abort(); this.policyRequest?.abort();
  }
  private now() { return this.input.now?.() ?? Date.now(); }
  private appendTimeline(snapshot: AutomaticIncident, observation: IncidentObservation, now: number) {
    snapshot.timeline = [...(snapshot.timeline ?? []), { at: new Date(now).toISOString(), event_type: observation.event_type, stage: observation.stage, error_code: observation.error_code,
      ...(observation.duration_ms === undefined ? {} : { duration_ms: observation.duration_ms }), ...(observation.retry_count === undefined ? {} : { retry_count: observation.retry_count }) }].slice(-20);
  }
  private logPath(id: string) { return join(dirname(this.input.path), 'incident-logs', `${id}.ndjson`); }
  private captureLogs(record: QueuedIncident) {
    if (!this.input.collectLogs) return;
    try {
      const data = this.input.collectLogs(structuredClone(record.snapshot));
      if (!data || Buffer.byteLength(data) > INCIDENT_LOG_MAX_BYTES) throw new Error('invalid_logs');
      mkdirSync(dirname(this.logPath(record.snapshot.incident_id)), { recursive: true, mode: 0o700 });
      writeFileSync(this.logPath(record.snapshot.incident_id), data, { mode: 0o600, flag: 'wx' });
      record.logsSHA256 = createHash('sha256').update(data).digest('hex');
      record.snapshot.logs_expected = true;
    } catch { record.snapshot.logs_expected = false; this.warn('自动异常原始日志采集未完成'); }
  }
  private removeLogs(id: string) { try { rmSync(this.logPath(id), { force: true }); } catch { } }
  private clearCurrentRecords() {
    this.state.records = this.state.records.filter(record => {
      if (record.gatewayOrigin !== this.gatewayOrigin) return true;
      this.removeLogs(record.snapshot.incident_id); return false;
    });
  }
  private removeOrphanLogs() {
    try {
      const retained = new Set(this.state.records.filter(record => !record.logsAcknowledged).map(record => `${record.snapshot.incident_id}.ndjson`));
      for (const name of readdirSync(dirname(this.logPath('unused')))) {
        if (/^[a-f0-9-]{36}\.ndjson$/i.test(name) && !retained.has(name)) this.removeLogs(name.slice(0, -7));
      }
    } catch { }
  }
  private synchronizeEnterprise() {
    const key = this.input.enterpriseKey();
    const origin = resolveFeedbackOrigin(this.input.gatewayOrigin());
    if (this.gatewayOrigin !== origin) {
      this.request?.abort(); this.policyRequest?.abort(); this.gatewayOrigin = origin; this.paused = false;
      this.identity = undefined; this.seen.clear();
    }
    if (key === 'unknown') return;
    if (this.state.enterpriseKey !== undefined && this.state.enterpriseKey !== key) {
      this.request?.abort(); this.identity = undefined; this.state.policy = undefined; this.seen.clear();
    }
    this.state.enterpriseKey = key;
  }
  private prohibited() {
    const key = this.input.enterpriseKey();
    return key !== '' && (key === 'unknown' || this.state.policy?.enterprise_key === key) && this.state.policy?.allowed === false;
  }
  private maySend() {
    if (this.disposed || this.paused || !this.gatewayOrigin || !this.state.enabled || this.prohibited()) return false;
    const key = this.input.enterpriseKey();
    return key !== 'unknown' && this.state.policy?.enterprise_key === key && this.state.policy.allowed && Date.parse(this.state.policy.expires_at) > this.now();
  }
  private prune() {
    const previous = this.state.records;
    const before = previous.length;
    this.state.records = this.state.records.filter(record => this.now() - record.createdAt < retention);
    while (this.state.records.length > 100) {
      const completed = this.state.records.findIndex(record => record.acknowledged >= record.snapshot.revision && record.snapshot.outcome !== 'ongoing' && (!record.logsSHA256 || record.logsAcknowledged));
      this.state.records.splice(completed < 0 ? 0 : completed, 1);
    }
    if (before !== this.state.records.length) {
      for (const record of previous) if (!this.state.records.includes(record)) this.removeLogs(record.snapshot.incident_id);
      this.warn('自动异常队列已清理', { removed: before - this.state.records.length });
      this.persist();
    }
    this.scheduleExpiry();
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    if (this.disposed || !this.state.records.length) return;
    const expires = Math.min(...this.state.records.map(record => record.createdAt + retention));
    this.expiryTimer = setTimeout(() => { this.prune(); this.schedule(); }, Math.max(0, expires - this.now()));
    this.expiryTimer.unref?.();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.scheduleExpiry();
    if (this.sending || !this.maySend()) return;
    const pending = this.state.records.filter(record => record.gatewayOrigin === this.gatewayOrigin && !record.stopped && (record.snapshot.revision > record.acknowledged || (record.logsSHA256 && !record.logsAcknowledged && !record.logsStopped)));
    if (!pending.length) return;
    const next = Math.min(...pending.map(record => Math.min(record.snapshot.revision > record.acknowledged ? record.nextAttempt : Infinity,
      record.snapshot.revision <= record.acknowledged && record.logsSHA256 && !record.logsAcknowledged && !record.logsStopped ? record.logsNextAttempt ?? 0 : Infinity)));
    this.timer = setTimeout(() => { void this.sendNext(); }, Math.min(2_147_483_647, Math.max(0, next - this.now())));
    this.timer.unref?.();
  }
  async sendNext(): Promise<void> {
    this.synchronizeEnterprise();
    this.prune();
    if (this.sending || !this.maySend()) return;
    const record = this.state.records.find(item => item.gatewayOrigin === this.gatewayOrigin && !item.stopped && item.snapshot.revision > item.acknowledged && item.nextAttempt <= this.now())
      ?? this.state.records.find(item => item.gatewayOrigin === this.gatewayOrigin && !item.stopped && item.snapshot.revision <= item.acknowledged && item.logsSHA256 && !item.logsAcknowledged && !item.logsStopped && (item.logsNextAttempt ?? 0) <= this.now());
    if (!record) { this.schedule(); return; }
    this.sending = true;
    const sendingLogs = record.snapshot.revision <= record.acknowledged;
    const snapshot = structuredClone(record.snapshot);
    const controller = new AbortController(); this.request = controller;
    const timeout = setTimeout(() => controller.abort(), sendingLogs ? 15000 : 5000);
    if (!sendingLogs) record.lastAttempt = this.now();
    try {
      if (!isAutomaticIncident(snapshot)) { record.stopped = true; return; }
      if (sendingLogs) { await this.sendLogs(record, controller.signal); return; }
      const response = await (this.input.fetchImpl ?? fetch)(`${record.gatewayOrigin}/api/v1/feedback/incidents/${snapshot.incident_id}`, {
        method: 'PUT', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${record.credential}` }, body: JSON.stringify(snapshot)
      });
      this.synchronizeEnterprise();
      if (!this.maySend() || record.gatewayOrigin !== this.gatewayOrigin || !this.state.records.includes(record)) return;
      if (response.ok) {
        const envelope = await response.json() as { data?: { incident_id?: string; accepted_revision?: number } };
        const accepted = envelope.data?.accepted_revision;
        if (envelope.data?.incident_id !== snapshot.incident_id || !Number.isSafeInteger(accepted) || accepted! < snapshot.revision) throw new Error('invalid_receipt');
        record.acknowledged = Math.max(record.acknowledged, Math.min(accepted!, snapshot.revision));
        record.failures = 0;
        if (record.snapshot.revision > snapshot.revision && record.snapshot.outcome === 'ongoing') record.nextAttempt = Math.max(record.nextAttempt, record.lastAttempt + 60_000);
      } else if (response.status === 404 || response.status === 405) {
        this.paused = true;
      } else if ((response.status >= 400 && response.status < 500 && response.status !== 429) || (response.status >= 300 && response.status < 400)) {
        record.stopped = true;
      } else {
        const after = response.headers.get('Retry-After');
        const delay = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - this.now()) : 0;
        this.retry(record, Number.isFinite(delay) ? Math.max(0, delay) : 0);
      }
    } catch {
      if (this.state.records.includes(record)) {
        if (sendingLogs) this.retryLogs(record); else this.retry(record, 0);
      }
      this.warn('自动异常上传暂未完成');
    } finally {
      clearTimeout(timeout); this.request = undefined; this.sending = false; this.persist(); this.schedule();
    }
  }
  private async sendLogs(record: QueuedIncident, signal: AbortSignal) {
    let data: Buffer;
    try {
      data = readFileSync(this.logPath(record.snapshot.incident_id));
      if (data.length > INCIDENT_LOG_MAX_BYTES || createHash('sha256').update(data).digest('hex') !== record.logsSHA256) throw new Error('invalid_logs');
    } catch { record.logsStopped = true; this.warn('自动异常原始日志文件缺失或损坏'); return; }
    const response = await (this.input.fetchImpl ?? fetch)(`${record.gatewayOrigin}/api/v1/feedback/incidents/${record.snapshot.incident_id}/logs`, {
      method: 'PUT', redirect: 'error', signal, headers: { 'Content-Type': 'application/x-ndjson', Authorization: `Bearer ${record.credential}`, 'X-Content-SHA256': record.logsSHA256! }, body: new Uint8Array(data)
    });
    this.synchronizeEnterprise();
    if (!this.maySend() || record.gatewayOrigin !== this.gatewayOrigin || !this.state.records.includes(record)) return;
    if (response.ok) {
      const envelope = await response.json() as { data?: { received?: boolean } };
      if (envelope.data?.received !== true) throw new Error('invalid_logs_receipt');
      record.logsAcknowledged = true; this.removeLogs(record.snapshot.incident_id);
    } else if ((response.status >= 400 && response.status < 500 && response.status !== 429) || (response.status >= 300 && response.status < 400)) {
      record.logsStopped = true; this.warn('自动异常原始日志上传被拒绝', { status: response.status });
    } else {
      const after = response.headers.get('Retry-After');
      const delay = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - this.now()) : 0;
      this.retryLogs(record, Number.isFinite(delay) ? Math.max(0, delay) : 0);
    }
  }
  private retryLogs(record: QueuedIncident, retryAfter = 0) {
    const failures = record.logsFailures ?? 0;
    record.logsNextAttempt = this.now() + Math.min(retention, Math.max(backoff[Math.min(failures, backoff.length - 1)]!, retryAfter));
    record.logsFailures = failures + 1;
  }
  private retry(record: QueuedIncident, retryAfter: number) {
    record.nextAttempt = this.now() + Math.min(retention, Math.max(backoff[Math.min(record.failures++, backoff.length - 1)]!, retryAfter));
  }
  private warn(message: string, details?: Record<string, unknown>) {
    this.input.logger.warnRateLimited('auto-incidents', message, details ?? {}, 60_000);
  }
  private persist() {
    try {
      mkdirSync(dirname(this.input.path), { recursive: true });
      const temporary = `${this.input.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...this.state, routingVersion: 2 }), { mode: 0o600 }); chmodSync(temporary, 0o600);
      renameSync(temporary, this.input.path);
    } catch { this.warn('自动异常队列无法持久化'); }
  }
  private load() {
    try {
      const text = readFileSync(this.input.path, 'utf8'); if (Buffer.byteLength(text) > 4 * 1024 * 1024) return;
      const data = JSON.parse(text) as Persisted;
      if (!/^[a-f0-9-]{36}$/i.test(data.installationId) || typeof data.enabled !== 'boolean' || !Array.isArray(data.records)) return;
      this.state = { installationId: data.installationId, enabled: true, enterpriseKey: data.enterpriseKey, records: [] };
      if (data.routingVersion !== 2) return;
      if (data.policy && typeof data.policy.enterprise_key === 'string' && typeof data.policy.allowed === 'boolean' && Number.isFinite(Date.parse(data.policy.expires_at))) this.state.policy = data.policy;
      this.state.records = data.records.filter(record => Boolean(record.gatewayOrigin) && resolveFeedbackOrigin(record.gatewayOrigin) === record.gatewayOrigin && isAutomaticIncident(record.snapshot) && /^[a-f0-9]{64}$/.test(record.credential)
        && [record.acknowledged, record.createdAt, record.nextAttempt, record.lastAttempt, record.failures].every(value => Number.isSafeInteger(value) && value >= 0)
        && (record.logsSHA256 === undefined || /^[a-f0-9]{64}$/.test(record.logsSHA256))
        && [record.logsNextAttempt, record.logsFailures].every(value => value === undefined || (Number.isSafeInteger(value) && value >= 0))
        && [record.logsAcknowledged, record.logsStopped].every(value => value === undefined || typeof value === 'boolean')).slice(-100);
    } catch { }
  }
}
