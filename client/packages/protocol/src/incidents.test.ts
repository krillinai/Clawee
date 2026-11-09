import { describe, expect, it } from 'vitest';
import { httpFailureDetails, httpFailureMessage, incidentErrorDiagnostics, isIncidentObservation, isAutomaticIncident, isIncidentReporterIdentity, safeIncidentIdentifier } from './incidents.js';

const observation = { event_id: '11111111-1111-4111-8111-111111111111', event_type: 'error', source: 'web', layer: 'web_daemon', stage: 'request', error_code: 'WEB_REQUEST_FAILED' };
describe('自动异常白名单协议', () => {
  it('未登录时允许独立 Agent 身份，员工姓名和账号必须成对出现', () => {
    const agent = { enterprise_key: 'a'.repeat(64), agent_id: 'agent_1' };
    expect(isIncidentReporterIdentity(agent)).toBe(true);
    expect(isIncidentReporterIdentity({ enterprise_key: agent.enterprise_key })).toBe(false);
    expect(isIncidentReporterIdentity({ ...agent, subject_id: 'user_1' })).toBe(false);
    expect(isIncidentReporterIdentity({ ...agent, display_name: '张三' })).toBe(false);
    expect(isIncidentReporterIdentity({ ...agent, access_token: 'private' })).toBe(false);
  });
  it.each([
    ['ENOTFOUND', 'dns', 'DNS 解析失败'],
    ['ECONNREFUSED', 'connection', '连接被拒绝'],
    ['CERT_HAS_EXPIRED', 'tls', 'TLS 校验失败'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout', '连接超时'],
    ['ECONNRESET', 'connection_reset', '连接被重置']
  ])('保留网络错误 %s 的分类、底层原因和请求上下文', (code, kind, message) => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error(`${code} gateway.test`), { code }) });
    const details = httpFailureDetails(error, { requestMethod: 'GET', requestUrl: 'https://alice:private@gateway.test/api/v1/auth/me?email=private@example.com#fragment', timeoutMs: 15000, durationMs: 20250, attempts: 2, maxAttempts: 2 });
    expect(details).toMatchObject({ failureKind: kind, causeCode: code, requestMethod: 'GET', requestUrl: 'https://gateway.test/api/v1/auth/me', timeoutMs: 15000, durationMs: 20250, attempts: 2, maxAttempts: 2 });
    expect(httpFailureMessage(details)).toContain(message);
    const diagnostics = incidentErrorDiagnostics({ name: 'ApiClientError', message: httpFailureMessage(details), code: 'ENTERPRISE_SERVICE_UNAVAILABLE', details });
    expect(diagnostics.cause_code).toBe(code);
    expect(diagnostics.additional_details).toContain('20250');
    expect(diagnostics.additional_details).toContain('2/2');
    expect(isIncidentObservation({ ...observation, diagnostics })).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('private');
    expect(JSON.stringify(details)).not.toContain('fragment');
  });
  it('保留 AggregateError 的各个连接原因，识别真正超时并过滤凭据和查询内容', () => {
    const error = new TypeError('fetch failed', { cause: new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ENETUNREACH ::1:443 Bearer private-value https://host/path?customer=private'), { code: 'ENETUNREACH' })
    ]) });
    const details = httpFailureDetails(error, { requestMethod: 'GET', requestUrl: 'https://gateway.test/api', timeoutMs: 50 });
    expect(details.causeChain).toContain('ECONNREFUSED');
    expect(details.causeChain).toContain('ENETUNREACH');
    expect(JSON.stringify(details)).not.toContain('private');
    expect(httpFailureDetails(new DOMException('timed out', 'TimeoutError'), { requestMethod: 'GET', requestUrl: 'https://gateway.test/api', timeoutMs: 50 })).toMatchObject({ failureKind: 'timeout', causeCode: 'TimeoutError' });
  });
  it('API 诊断只采集传输白名单，保留上游请求标识并限制中文长度', () => {
    const diagnostics = incidentErrorDiagnostics({ code: 'ENTERPRISE_SERVICE_UNAVAILABLE', details: { failureKind: 'response', requestMethod: 'GET', requestUrl: 'https://gateway.test/api?customer=private', stage: 'response', statusCode: 503, upstreamCode: 'upstream_unavailable', requestId: 'req_gateway', upstreamMessage: `稍后重试${'详情'.repeat(2000)} Bearer private-value`, body: 'private request', accessToken: 'private' } });
    expect(diagnostics.request_id).toBe('req_gateway');
    expect(diagnostics.additional_details).toContain('503');
    expect(diagnostics.additional_details).toContain('upstream_unavailable');
    expect(JSON.stringify(diagnostics)).not.toContain('private');
    expect(isIncidentObservation({ ...observation, diagnostics })).toBe(true);
  });
  it('允许有界技术诊断与中文员工姓名，但拒绝请求参数和伪造自由字段', () => {
    expect(isIncidentReporterIdentity({ enterprise_key: 'a'.repeat(64), subject_id: 'user_1', display_name: '张三' })).toBe(true);
    expect(isIncidentReporterIdentity({ enterprise_key: 'a'.repeat(64), subject_id: 'user_1', display_name: '张三', access_token: 'private' })).toBe(false);
    expect(isIncidentObservation({ ...observation, diagnostics: { error_message: 'fetch failed', request_method: 'GET', request_path: '/runs/run_1' } })).toBe(true);
    expect(isIncidentObservation({ ...observation, diagnostics: { request_path: '/runs?token=private' } })).toBe(false);
    expect(isIncidentObservation({ ...observation, diagnostics: { error_message: 'x'.repeat(2049) } })).toBe(false);
    expect(isIncidentObservation({ ...observation, diagnostics: { body: 'business' } })).toBe(false);
    expect(isIncidentObservation({ ...observation, diagnostics: { additional_details: 'HTTP 503; ECONNRESET' } })).toBe(true);
    expect(isIncidentObservation({ ...observation, diagnostics: { additional_details: 'x'.repeat(2049) } })).toBe(false);
  });
  it('保留错误上下文和 cause，截断多字节文案并过滤明确凭据', () => {
    const error = new Error(`连接失败 ${'详情'.repeat(1500)} Bearer private-value`, { cause: { code: 'ECONNRESET' } });
    const diagnostics = incidentErrorDiagnostics(error);
    expect(new TextEncoder().encode(diagnostics.error_message).length).toBeLessThanOrEqual(2048);
    expect(diagnostics.cause_code).toBe('ECONNRESET');
    expect(JSON.stringify(diagnostics)).not.toContain('private-value');
    expect(incidentErrorDiagnostics(new Error('fetch https://alice:private@host/path sk-private'))).toMatchObject({ error_message: 'fetch https://[REDACTED]@host/path [REDACTED]' });
  });
  it('Web只能传连接摘要，不能注入模型配置和自由字段', () => {
    expect(isIncidentObservation(observation)).toBe(true);
    expect(isIncidentObservation({ ...observation, environment: { model: 'business-body' } })).toBe(false);
    expect(isIncidentObservation({ ...observation, params: { api_key: 'private' } })).toBe(false);
    expect(isIncidentObservation({ ...observation, layer: 'codex_model' })).toBe(false);
  });
  it('完整Web快照由主进程补环境，不能携带源事件字段', () => {
    const { event_id: eventId, event_type: _type, ...facts } = observation;
    const snapshot = { ...facts, incident_id: eventId, installation_id: eventId, app_session_id: eventId, schema_version: 1, policy_version: 1, revision: 1, first_seen_at: '2026-10-15T00:00:00.000Z', last_seen_at: '2026-10-15T00:00:00.000Z', occurrence_count: 1, outcome: 'ongoing', message: 'WEB_REQUEST_FAILED', first_message: 'WEB_REQUEST_FAILED', environment: { app_version: '0.1.8' } };
    expect(isAutomaticIncident(snapshot)).toBe(true);
    expect(isAutomaticIncident({ ...snapshot, event_id: eventId })).toBe(false);
    expect(isAutomaticIncident({ ...snapshot, message: 'business body' })).toBe(false);
    expect(isAutomaticIncident({ ...snapshot, first_diagnostics: { additional_details: 'HTTP 503' } })).toBe(true);
    expect(isAutomaticIncident({ ...snapshot, first_diagnostics: { body: 'business' } })).toBe(false);
    expect(isAutomaticIncident({ ...snapshot, first_diagnostics: { additional_details: 'x'.repeat(2049) } })).toBe(false);
  });
  it.each([
    `ghp_${'A'.repeat(36)}`, `gho_${'B'.repeat(36)}`, `github_pat_${'C'.repeat(60)}`,
    `AKIA${'D'.repeat(16)}`, `ASIA${'E'.repeat(16)}`, `AIza${'F'.repeat(35)}`,
    `xoxb-${'1'.repeat(24)}`, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl'
  ])('技术字段拒绝凭证格式 %#', credential => {
    const daemon = { ...observation, source: 'daemon', layer: 'codex_model', stage: 'response', error_code: 'responseStreamDisconnected' };
    const { event_id: eventId, event_type: _type, ...facts } = daemon;
    const snapshot = { ...facts, incident_id: eventId, installation_id: eventId, app_session_id: eventId, schema_version: 1, policy_version: 1, revision: 1, first_seen_at: '2026-10-15T00:00:00.000Z', last_seen_at: '2026-10-15T00:00:00.000Z', occurrence_count: 1, outcome: 'ongoing', message: facts.error_code, first_message: facts.error_code, environment: {} };
    expect(safeIncidentIdentifier(credential)).toBeUndefined();
    for (const field of ['scope_id', 'run_id', 'thread_id', 'transport_code', 'exit_signal', 'upstream_request_id']) {
      expect(isIncidentObservation({ ...daemon, [field]: credential })).toBe(false);
      expect(isAutomaticIncident({ ...snapshot, [field]: credential })).toBe(false);
    }
    for (const field of ['app_version', 'daemon_version', 'runtime_version', 'electron_version', 'build_sha', 'platform', 'arch', 'model', 'protocol', 'transport']) {
      expect(isIncidentObservation({ ...daemon, environment: { [field]: credential } })).toBe(false);
      expect(isAutomaticIncident({ ...snapshot, environment: { [field]: credential } })).toBe(false);
    }
  });
  it('保留正常技术标识和版本', () => {
    for (const value of ['req_1234567890abcdef', 'ECONNRESET', 'gpt-5.3-codex', '0.146.0', 'a'.repeat(40)]) {
      expect(safeIncidentIdentifier(value)).toBe(value);
    }
  });
});
