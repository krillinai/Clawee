export const AUTO_INCIDENT_POLICY_VERSION = 1;
export const INCIDENT_MAX_BYTES = 32 * 1024;
export const INCIDENT_LOG_MAX_BYTES = 256 * 1024;
export const incidentLayers = ['desktop_bootstrap', 'web_daemon', 'daemon_codex', 'codex_model'] as const;
export type IncidentLayer = typeof incidentLayers[number];
export type IncidentOutcome = 'ongoing' | 'recovered' | 'failed' | 'unknown';
export type IncidentEnvironment = {
  app_version?: string; daemon_version?: string; runtime_version?: string;
  electron_version?: string; build_sha?: string; platform?: string; arch?: string; os_version?: string;
  model?: string; endpoint_fingerprint?: string; protocol?: string; transport?: string;
  timeout_ms?: number; inactivity_timeout_ms?: number; spawn_timeout_ms?: number;
  retry_limit?: number; proxy_env_set?: boolean;
  network_path?: 'direct' | 'http_proxy' | 'system_proxy' | 'unknown';
  proxy_env_keys?: string[]; proxy_applies?: boolean;
  proxy_stage?: 'resolve' | 'connect' | 'tunnel' | 'response_headers' | 'response_body' | 'stream';
  proxy_error_code?: 'PROXY_AUTH_REQUIRED' | 'PROXY_CONNECT_FAILED' | 'PROXY_CONNECT_TIMEOUT' | 'PROXY_TUNNEL_FAILED' | 'PROXY_POLICY_DENIED' | 'PROXY_STREAM_INTERRUPTED';
  failure_origin?: 'client_proxy' | 'gateway' | 'model_upstream' | 'local_runtime' | 'unknown';
};
export type IncidentReporterIdentity = {
  enterprise_key: string; subject_id?: string; display_name?: string; agent_id?: string;
};
export type IncidentDiagnostics = {
  error_name?: string; error_message?: string; error_stack?: string; additional_details?: string; cause_code?: string;
  request_method?: string; request_path?: string; request_id?: string;
};
export type IncidentTimelineEntry = {
  at: string; event_type: IncidentObservation['event_type']; stage: string; error_code: string;
  duration_ms?: number; retry_count?: number;
};
export type IncidentObservation = {
  event_id: string;
  event_type: 'error' | 'recovered' | 'finished';
  source: 'desktop' | 'daemon' | 'web';
  layer: IncidentLayer;
  stage: string;
  error_code: string;
  scope_id?: string;
  run_id?: string;
  thread_id?: string;
  transport_code?: string;
  http_status?: number;
  exit_code?: number;
  exit_signal?: string;
  upstream_request_id?: string;
  retry_count?: number;
  duration_ms?: number;
  unresponsive_ms?: number;
  task_outcome?: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  environment?: IncidentEnvironment;
  diagnostics?: IncidentDiagnostics;
};
export type AutomaticIncident = Omit<IncidentObservation, 'event_id' | 'event_type' | 'environment'> & {
  schema_version: 1;
  policy_version: 1;
  incident_id: string;
  installation_id: string;
  app_session_id: string;
  revision: number;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  outcome: IncidentOutcome;
  message: string;
  first_message: string;
  first_diagnostics?: IncidentDiagnostics;
  environment: IncidentEnvironment;
  reporter?: IncidentReporterIdentity;
  timeline?: IncidentTimelineEntry[];
  logs_expected?: boolean;
};
export type IncidentPolicy = { enterprise_key: string; allowed: boolean; expires_at: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const sensitive = /(?:sk-|sk_|bearer|token|password|secret|api[_-]?key|credential|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|(?:AKIA|ASIA)[a-z0-9]{16}|AIza[a-z0-9_-]{35}|xox[baprs]-[a-z0-9-]{10,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)/i;
const environmentKeys = ['app_version', 'daemon_version', 'runtime_version', 'electron_version', 'build_sha', 'platform', 'arch', 'os_version', 'model', 'endpoint_fingerprint', 'protocol', 'transport', 'timeout_ms', 'inactivity_timeout_ms', 'spawn_timeout_ms', 'retry_limit', 'proxy_env_set', 'network_path', 'proxy_env_keys', 'proxy_applies', 'proxy_stage', 'proxy_error_code', 'failure_origin'];
const observationKeys = ['event_id', 'event_type', 'source', 'layer', 'stage', 'error_code', 'scope_id', 'run_id', 'thread_id', 'transport_code', 'http_status', 'exit_code', 'exit_signal', 'upstream_request_id', 'retry_count', 'duration_ms', 'unresponsive_ms', 'task_outcome', 'environment', 'diagnostics'];
export function safeIncidentIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && identifier.test(value) && !sensitive.test(value) ? value : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isIncidentReporterIdentity(value: unknown): value is IncidentReporterIdentity {
  return record(value) && Object.keys(value).every(key => ['enterprise_key', 'subject_id', 'display_name', 'agent_id'].includes(key))
    && typeof value.enterprise_key === 'string' && /^[a-f0-9]{64}$/.test(value.enterprise_key)
    && ((value.subject_id === undefined && value.display_name === undefined && value.agent_id !== undefined)
      || (safeIncidentIdentifier(value.subject_id) !== undefined
        && typeof value.display_name === 'string' && value.display_name.trim().length > 0 && new TextEncoder().encode(value.display_name).length <= 256 && !/[\x00-\x1f\x7f]/.test(value.display_name)))
    && (value.agent_id === undefined || safeIncidentIdentifier(value.agent_id) !== undefined);
}
export function isIncidentDiagnostics(value: unknown): value is IncidentDiagnostics {
  if (!record(value)) return false;
  const limits: Record<string, number> = { error_name: 128, error_message: 2048, error_stack: 4096, additional_details: 2048, cause_code: 128, request_method: 16, request_path: 512, request_id: 128 };
  return Object.entries(value).every(([key, field]) => key in limits && typeof field === 'string' && new TextEncoder().encode(field).length <= limits[key]!
    && (key !== 'request_method' || ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(field))
    && (key !== 'request_id' || safeIncidentIdentifier(field) !== undefined)
    && (key !== 'request_path' || (field.startsWith('/') && !field.startsWith('//') && !/[?#\r\n]/.test(field))));
}
export function incidentErrorDiagnostics(error: unknown): IncidentDiagnostics {
  if (!record(error)) return {};
  const result: IncidentDiagnostics = {};
  for (const [field, key, maximum] of [['error_name', 'name', 128], ['error_message', 'message', 2048], ['error_stack', 'stack', 4096]] as const) {
    if (typeof error[key] === 'string') result[field] = new TextDecoder().decode(new TextEncoder().encode(redactIncidentCredentials(error[key])).slice(0, maximum - 3));
  }
  if (record(error.cause) && typeof error.cause.code === 'string') result.cause_code = new TextDecoder().decode(new TextEncoder().encode(redactIncidentCredentials(error.cause.code)).slice(0, 125));
  if (typeof error.code === 'string' && error.code.startsWith('ENTERPRISE_') && record(error.details)) {
    const details = selectHttpFailureDetails(error.details);
    if (details.failureKind) {
      result.additional_details = diagnosticText([httpFailureMessage(details), details.causeChain].filter(Boolean).join('\n'), 2048);
      if (typeof details.causeCode === 'string') result.cause_code = details.causeCode;
      const requestId = safeIncidentIdentifier(details.requestId);
      if (requestId) result.request_id = requestId;
    }
  }
  return result;
}

function diagnosticText(value: string, maximum = 512): string {
  const text = redactIncidentCredentials(value.replace(/https?:\/\/[^\s<>"'；，（）]+/gi, url => {
    try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return '[URL]'; }
  }));
  return new TextDecoder().decode(new TextEncoder().encode(text).slice(0, maximum - 3));
}

function selectHttpFailureDetails(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['failureKind', 'stage', 'requestMethod', 'requestUrl', 'causeCode', 'causeMessage', 'causeChain', 'upstreamCode', 'requestId']) {
    if (typeof input[key] === 'string') result[key] = diagnosticText(input[key], key === 'causeChain' ? 1024 : 512);
  }
  for (const key of ['timeoutMs', 'durationMs', 'attempts', 'maxAttempts', 'statusCode', 'retryAfterMs']) {
    if (Number.isSafeInteger(input[key]) && Number(input[key]) >= 0) result[key] = input[key];
  }
  return result;
}

/** 仅提取传输元数据和有界原因链，不采集请求头、请求体或 URL 参数。 */
export function httpFailureDetails(error: unknown, context: Record<string, unknown>): Record<string, unknown> {
  const causes: Array<{ name?: string; code?: string; message?: string }> = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (!record(value) || seen.has(value) || causes.length >= 6) return;
    seen.add(value);
    causes.push({
      ...(typeof value.name === 'string' ? { name: diagnosticText(value.name, 64) } : {}),
      ...(typeof value.code === 'string' ? { code: diagnosticText(value.code, 128) } : {}),
      ...(typeof value.message === 'string' ? { message: value.name === 'SyntaxError' ? '响应不是有效 JSON' : diagnosticText(value.message, 256) } : {})
    });
    visit(value.cause);
    if (Array.isArray(value.errors)) for (const child of value.errors) visit(child);
  };
  visit(error);
  const cause = causes.find(item => item.code) ?? causes.find(item => item.name === 'TimeoutError' || item.name === 'AbortError') ?? causes.at(-1);
  const code = cause?.code ?? cause?.name;
  let failureKind = 'network';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') failureKind = 'dns';
  else if (code && /TIMEOUT|TIMEDOUT|TimeoutError/.test(code)) failureKind = 'timeout';
  else if (code && /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) failureKind = 'tls';
  else if (code === 'ECONNREFUSED') failureKind = 'connection';
  else if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') failureKind = 'connection_reset';
  else if (code === 'AbortError' || code === 'ABORT_ERR') failureKind = 'aborted';
  return selectHttpFailureDetails({
    failureKind, ...context,
    ...(code ? { causeCode: code } : {}),
    ...(cause?.message ? { causeMessage: cause.message } : {}),
    ...(causes.length ? { causeChain: causes.map(item => [item.name, item.code, item.message].filter(Boolean).join(': ')).join('\n') } : {})
  });
}

/** 供 API 错误和反馈中心复用同一份具体原因说明。 */
export function httpFailureMessage(input: Record<string, unknown>): string {
  const details = selectHttpFailureDetails(input);
  const labels: Record<string, string> = {
    dns: 'DNS 解析失败', connection: '连接被拒绝', tls: 'TLS 校验失败',
    timeout: details.causeCode === 'UND_ERR_CONNECT_TIMEOUT' ? '连接超时' : '请求超时',
    connection_reset: '连接被重置或中断', network: '网络请求失败', aborted: '请求被中止',
    response: 'Gateway 返回错误响应', decode: 'Gateway 响应解析失败'
  };
  const reason = labels[String(details.failureKind)];
  if (!reason) return '';
  return diagnosticText([
    `企业服务请求失败：${reason}${details.causeCode ? `（${details.causeCode}）` : ''}`,
    details.requestUrl ? `${details.requestMethod ?? 'GET'} ${details.requestUrl}` : undefined,
    details.stage ? `阶段 ${details.stage}` : undefined,
    details.statusCode ? `上游 HTTP ${details.statusCode}` : undefined,
    details.upstreamCode ? `上游错误码 ${details.upstreamCode}` : undefined,
    details.requestId ? `上游请求标识 ${details.requestId}` : undefined,
    details.durationMs === undefined ? undefined : `耗时 ${details.durationMs} ms`,
    details.timeoutMs === undefined ? undefined : `超时设置 ${details.timeoutMs} ms`,
    details.attempts === undefined ? undefined : `尝试 ${details.attempts}/${details.maxAttempts ?? details.attempts}`,
    details.causeMessage
  ].filter(Boolean).join('；'), 1800);
}
export function redactIncidentCredentials(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{4,}|clwcap_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED]')
    .replace(/((?:Set-)?Cookie:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/((?:["']?[\w-]*(?:token|password|passwd|api[_-]?key|secret|authorization|cookie)[\w-]*["']?)\s*[:=]\s*["']?)(?!\[REDACTED\])([^\s"',}\]]+)/gi, '$1[REDACTED]');
}
function isIncidentTimeline(value: unknown): value is IncidentTimelineEntry[] {
  return Array.isArray(value) && value.length <= 20 && value.every(entry => record(entry)
    && Object.keys(entry).every(key => ['at', 'event_type', 'stage', 'error_code', 'duration_ms', 'retry_count'].includes(key))
    && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)) && ['error', 'recovered', 'finished'].includes(String(entry.event_type))
    && safeIncidentIdentifier(entry.stage) !== undefined && safeIncidentIdentifier(entry.error_code) !== undefined
    && ['duration_ms', 'retry_count'].every(key => entry[key] === undefined || (Number.isSafeInteger(entry[key]) && Number(entry[key]) >= 0)));
}
export function isIncidentEnvironment(value: unknown): value is IncidentEnvironment {
  if (!record(value) || Object.keys(value).some(key => !environmentKeys.includes(key))) return false;
  return Object.entries(value).every(([key, field]) => {
    if (key === 'proxy_env_set' || key === 'proxy_applies') return typeof field === 'boolean';
    if (key === 'proxy_env_keys') return Array.isArray(field) && field.length <= 8 && field.every(item => typeof item === 'string' && /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(item));
    if (key.endsWith('_ms') || key === 'retry_limit') return Number.isSafeInteger(field) && Number(field) >= 0;
    if (key === 'endpoint_fingerprint') return typeof field === 'string' && /^[a-f0-9]{64}$/.test(field);
    return safeIncidentIdentifier(field) !== undefined;
  });
}
export function isIncidentObservation(value: unknown): value is IncidentObservation {
  if (!record(value) || Object.keys(value).some(key => !observationKeys.includes(key))) return false;
  if (typeof value.event_id !== 'string' || !uuid.test(value.event_id)
    || typeof value.event_type !== 'string' || !['error', 'recovered', 'finished'].includes(value.event_type)
    || typeof value.source !== 'string' || !['desktop', 'daemon', 'web'].includes(value.source)
    || !incidentLayers.includes(value.layer as IncidentLayer)
    || !safeIncidentIdentifier(value.stage) || !safeIncidentIdentifier(value.error_code)) return false;
  if (value.source === 'web' && (value.layer !== 'web_daemon' || !['connection', 'request', 'event_stream', 'browser'].includes(String(value.stage))
    || !['WEB_DISCONNECTED', 'WEB_REQUEST_FAILED', 'WEB_REQUEST_TIMEOUT', 'WEB_HTTP_FAILED', 'WEB_STREAM_ENDED', 'WEB_UNHANDLED_ERROR', 'WEB_UNHANDLED_REJECTION'].includes(String(value.error_code)))) return false;
  if (value.source === 'web' && value.stage === 'browser' && !['WEB_UNHANDLED_ERROR', 'WEB_UNHANDLED_REJECTION'].includes(String(value.error_code))) return false;
  if (value.source === 'web' && Object.keys(value).some(key => !['event_id', 'event_type', 'source', 'layer', 'stage', 'error_code', 'run_id', 'http_status', 'duration_ms', 'diagnostics'].includes(key))) return false;
  if (value.source === 'desktop' && value.layer !== 'desktop_bootstrap') return false;
  if (value.source === 'daemon' && !['daemon_codex', 'codex_model'].includes(String(value.layer))) return false;
  for (const key of ['scope_id', 'run_id', 'thread_id', 'transport_code', 'exit_signal', 'upstream_request_id']) {
    if (value[key] !== undefined && !safeIncidentIdentifier(value[key])) return false;
  }
  for (const key of ['retry_count', 'duration_ms', 'unresponsive_ms']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) return false;
  }
  if (value.http_status !== undefined && (!Number.isInteger(value.http_status) || Number(value.http_status) < 100 || Number(value.http_status) > 599)) return false;
  if (value.exit_code !== undefined && (!Number.isSafeInteger(value.exit_code) || Math.abs(Number(value.exit_code)) > 2147483647)) return false;
  if (value.task_outcome !== undefined && (typeof value.task_outcome !== 'string' || !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.task_outcome))) return false;
  return (value.environment === undefined || isIncidentEnvironment(value.environment)) && (value.diagnostics === undefined || isIncidentDiagnostics(value.diagnostics));
}
export function incidentMessage(input: Pick<IncidentObservation, 'error_code' | 'transport_code' | 'http_status'>): string {
  return [input.error_code, input.transport_code, input.http_status === undefined ? undefined : `HTTP ${input.http_status}`].filter(Boolean).join(' ');
}
export function isAutomaticIncident(value: unknown): value is AutomaticIncident {
  if (!record(value)) return false;
  const extra = ['schema_version', 'policy_version', 'incident_id', 'installation_id', 'app_session_id', 'revision', 'first_seen_at', 'last_seen_at', 'occurrence_count', 'outcome', 'message', 'first_message', 'first_diagnostics', 'reporter', 'timeline', 'logs_expected'];
  if (Object.keys(value).some(key => ![...observationKeys.filter(field => field !== 'event_id' && field !== 'event_type'), ...extra].includes(key))) return false;
  const observation = Object.fromEntries(Object.entries(value).filter(([key]) => observationKeys.includes(key)));
  if (value.source === 'web') delete observation.environment;
  if (!isIncidentObservation({ ...observation, event_id: value.incident_id, event_type: 'error' }) || !isIncidentEnvironment(value.environment)) return false;
  return value.schema_version === 1 && value.policy_version === 1
    && (value.reporter === undefined || isIncidentReporterIdentity(value.reporter))
    && (value.first_diagnostics === undefined || isIncidentDiagnostics(value.first_diagnostics))
    && (value.timeline === undefined || isIncidentTimeline(value.timeline))
    && (value.logs_expected === undefined || typeof value.logs_expected === 'boolean')
    && [value.incident_id, value.installation_id, value.app_session_id].every(field => typeof field === 'string' && uuid.test(field))
    && [value.revision, value.occurrence_count].every(field => Number.isSafeInteger(field) && Number(field) > 0)
    && typeof value.outcome === 'string' && ['ongoing', 'recovered', 'failed', 'unknown'].includes(value.outcome)
    && typeof value.first_seen_at === 'string' && Number.isFinite(Date.parse(value.first_seen_at))
    && typeof value.last_seen_at === 'string' && Date.parse(value.last_seen_at) >= Date.parse(String(value.first_seen_at))
    && value.message === incidentMessage(value as AutomaticIncident)
    && ((value.source === 'daemon' && value.layer === 'codex_model' && value.stage === 'response' && value.run_id) || value.first_message === value.message)
    && typeof value.first_message === 'string' && value.first_message.length > 0 && value.first_message.length <= 1024
    && /^[a-zA-Z0-9_.: -]+$/.test(value.first_message) && !sensitive.test(value.first_message)
    && new TextEncoder().encode(JSON.stringify(value)).length <= INCIDENT_MAX_BYTES;
}
