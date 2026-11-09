import { redactIncidentCredentials, safeIncidentIdentifier, type IncidentDiagnostics, type ModelResponseError } from '@clawee/protocol';
import { redactText } from '../security/redaction.js';
import { classifyProxyFailure, describeProxyEnvironment, proxyErrorMessage } from './network-diagnostics.js';

const runtimeErrorKinds = new Set(['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'activeTurnNotSteerable', 'sandboxError', 'other']);
const transportPattern = /\b(?:ERR_NETWORK_IO_SUSPENDED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|ERR_TLS_CERT_ALTNAME_INVALID)\b/;
const technicalPattern = /\b(?:ERR_NETWORK_IO_SUSPENDED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|CERT_[A-Z_]+|[A-Z_]*SELF_SIGNED_CERT[A-Z_]*|UNABLE_TO_[A-Z_]+|ERR_TLS_[A-Z_]+|unexpected status(?: code)?[:\s]+[1-5]\d{2}|HTTP(?:\/\d(?:\.\d)?)?[ :]+[1-5]\d{2}|stream disconnected before completion|connection (?:reset|refused|timed out|closed)|certificate (?:verify failed|has expired)|invalid peer certificate|UnknownIssuer|dns error|failed to lookup address information|name or service not known|No such host is known|forcibly closed by the remote host|os error 10054|operation timed out|request (?:timed out|timeout)|Reconnecting\.\.\.(?:\s*\d+\/\d+)?|retry limit exceeded|retry exhausted|(?:request[_ -]?id|x-request-id)[:=\s]+[A-Za-z0-9_.:-]{1,128})(?![A-Za-z0-9_])/gi;
const bodyMarker = /\b(?:response[ _-]?body|request[ _-]?body|prompt|messages|tool[_ -]?(?:input|output))["']?\s*[:=]/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function technicalDetails(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = redactIncidentCredentials(value.slice(0, 16_384).split(bodyMarker)[0]!)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[URL]');
  return [...text.matchAll(technicalPattern)].slice(0, 12).map(match => match[0]).join('; ').slice(0, 1024) || undefined;
}

function runtimeErrorText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return redactIncidentCredentials(redactText(value.slice(0, 16_384).split(bodyMarker)[0]!))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim().slice(0, 4096) || undefined;
}

function unsupportedReasoningEffort(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 16_384) return false;
  try {
    const response: unknown = JSON.parse(value);
    const error = record(response) && record(response.error) ? response.error : response;
    return record(error) && error.type === 'invalid_request_error'
      && error.code === 'unsupported_value' && error.param === 'reasoning.effort';
  } catch { return false; }
}

export function describeRuntimeResponseError(params: Record<string, unknown>): ModelResponseError {
  const error = record(params.error) ? params.error : params;
  const info = error.codexErrorInfo;
  const kind = typeof info === 'string' ? info : record(info) ? Object.keys(info)[0] : undefined;
  const baseErrorCode = unsupportedReasoningEffort(error.message) || unsupportedReasoningEffort(error.additionalDetails)
    ? 'MODEL_REASONING_EFFORT_UNSUPPORTED'
    : error.code === 'ERR_NETWORK_IO_SUSPENDED' || (record(error.cause) && error.cause.code === 'ERR_NETWORK_IO_SUSPENDED')
      ? 'RUNTIME_NETWORK_IO_SUSPENDED'
    : kind && runtimeErrorKinds.has(kind) ? kind : 'RUNTIME_ERROR';
  const facts = kind && record(info) && record(info[kind]) ? info[kind] : {};
  const diagnostics: IncidentDiagnostics = {};
  const runtimeMessage = runtimeErrorText(error.message ?? params.message);
  const runtimeDetails = runtimeErrorText(error.additionalDetails ?? params.additionalDetails);
  const message = technicalDetails(error.message ?? params.message);
  if (message) diagnostics.error_message = message;
  const additionalDetails = technicalDetails(error.additionalDetails ?? params.additionalDetails);
  if (additionalDetails) diagnostics.additional_details = additionalDetails;
  const text = [diagnostics.error_message, additionalDetails].filter(Boolean).join('\n');
  const status = facts.httpStatusCode;
  const httpStatus = Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? Number(status)
    : Number(text.match(/\b(?:unexpected status(?: code)?|HTTP(?:\/\d(?:\.\d)?)?)[:\s]+([1-5]\d{2})\b/i)?.[1]) || undefined;
  const transportCode = safeIncidentIdentifier(facts.transportCode)
    ?? (record(error.cause) ? safeIncidentIdentifier(error.cause.code) : undefined)
    ?? safeIncidentIdentifier(error.code) ?? text.match(transportPattern)?.[0];
  const requestId = safeIncidentIdentifier(facts.requestId) ?? safeIncidentIdentifier(error.requestId)
    ?? safeIncidentIdentifier(text.match(/\b(?:request[_ -]?id|x-request-id)[:=\s]+([A-Za-z0-9_.:-]{1,128})/i)?.[1]);
  if (transportCode) diagnostics.cause_code = transportCode;
  if (requestId) diagnostics.request_id = requestId;
  const progress = message?.match(/Reconnecting\.\.\.\s*(\d+)\/(\d+)/i);
  const attempt = Number(progress?.[1]);
  const limit = Number(progress?.[2]);
  const validProgress = Number.isSafeInteger(attempt) && attempt > 0 && Number.isSafeInteger(limit) && limit >= attempt && limit <= 1000;
  const retrying = params.willRetry === true || (params.willRetry !== false && validProgress);
  const proxy = classifyProxyFailure({
    status: httpStatus,
    transportCode,
    text: [text, runtimeMessage, runtimeDetails].filter(Boolean).join('\n'),
    stage: baseErrorCode === 'responseStreamDisconnected' || baseErrorCode === 'responseStreamConnectionFailed' || /stream disconnected/i.test(text) ? 'stream' : 'response_headers',
    proxyApplies: describeProxyEnvironment(undefined).proxyApplies
  });
  const proxyCopy = proxy === undefined ? undefined : proxyErrorMessage(proxy.proxyErrorCode);
  const errorCode = proxy === undefined ? baseErrorCode : `MODEL_SERVICE_${proxy.proxyErrorCode}`;
  let reason: string;
  let suggestion = '请联系管理员，按排查编号核对模型接口日志';
  if (proxyCopy !== undefined) {
    reason = proxyCopy.message;
    suggestion = proxyCopy.suggestion;
  } else if (errorCode === 'MODEL_REASONING_EFFORT_UNSUPPORTED') {
    reason = '模型不支持当前推理强度'; suggestion = '请切换到模型支持的推理强度后重试';
  } else if (httpStatus === 401 || (!httpStatus && errorCode === 'unauthorized')) {
    reason = '模型接口认证失败'; suggestion = '请检查 API Key 是否有效';
  } else if (httpStatus === 403) {
    reason = '模型接口拒绝访问'; suggestion = '请检查 API Key 和模型访问权限';
  } else if (httpStatus === 429 || (!httpStatus && errorCode === 'rateLimitExceeded')) {
    reason = '模型接口返回限流'; suggestion = '请稍后重试，或联系管理员检查限额';
  } else if ((httpStatus && httpStatus >= 500) || (!httpStatus && ['serverOverloaded', 'internalServerError'].includes(errorCode))) {
    reason = '模型接口暂不可用'; suggestion = '请稍后重试，持续失败时联系管理员检查模型接口';
  } else if (httpStatus && httpStatus >= 400) {
    reason = '模型接口返回请求错误'; suggestion = '请联系管理员检查模型名称、接口配置和请求兼容性';
  } else if ((transportCode && /CERT|TLS|ISSUER/.test(transportCode)) || /invalid peer certificate|UnknownIssuer|certificate (?:verify failed|has expired)/i.test(text)) {
    reason = '模型连接证书校验失败'; suggestion = '请联系管理员检查证书和系统时间，不要关闭证书校验';
  } else if (transportCode === 'ENOTFOUND' || transportCode === 'EAI_AGAIN' || /dns error|failed to lookup address information|name or service not known|No such host is known/i.test(text)) {
    reason = '模型接口域名解析失败'; suggestion = '请检查模型接口地址和 DNS 配置';
  } else if (transportCode === 'ECONNREFUSED' || /connection refused/i.test(text)) {
    reason = '模型连接被拒绝'; suggestion = '请联系管理员检查模型接口或代理服务是否可用';
  } else if (transportCode === 'ETIMEDOUT' || /\b(?:request timed out|request timeout|connection timed out|operation timed out)\b/i.test(text)) {
    reason = '模型连接超时'; suggestion = '请检查网络、代理及模型接口状态，暂无法确定超时环节';
  } else if (transportCode === 'ERR_NETWORK_IO_SUSPENDED') {
    reason = 'Runtime 链路被系统挂起，中断了响应流'; suggestion = '请重试；若持续出现，请检查桌面端 Runtime 代理、系统休眠和本地网络状态';
  } else if (transportCode === 'ECONNRESET' || transportCode === 'EPIPE' || /\b(?:connection reset|forcibly closed by the remote host|os error 10054)\b/i.test(text)) {
    reason = '模型连接被重置，暂无法确定断开方';
  } else if (errorCode === 'responseStreamDisconnected' || /stream disconnected before completion/i.test(text)) {
    reason = '模型响应连接中断，具体原因未返回';
  } else if (errorCode === 'responseTooManyFailedAttempts') {
    reason = '模型请求重试次数已耗尽，具体原因未返回';
  } else if (['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded'].includes(errorCode)) {
    reason = errorCode === 'contextWindowExceeded' ? '模型上下文超出上限' : '模型使用额度已达上限';
    suggestion = errorCode === 'contextWindowExceeded' ? '请新建会话后重试' : '请联系管理员检查模型额度';
  } else {
    reason = ['httpConnectionFailed', 'responseStreamConnectionFailed'].includes(errorCode)
      ? '模型接口连接失败，具体原因未返回' : runtimeMessage || runtimeDetails ? 'Codex Runtime 返回错误' : 'Runtime 请求失败，具体原因未明确';
  }
  if (httpStatus) reason += `（HTTP ${httpStatus}）`;
  return { errorCode, reason, suggestion, retrying, diagnostics,
    ...(runtimeMessage ? { runtimeMessage } : {}), ...(runtimeDetails ? { runtimeDetails } : {}),
    ...(httpStatus ? { httpStatus } : {}), ...(transportCode ? { transportCode } : {}), ...(requestId ? { requestId } : {}),
    ...(proxy === undefined ? {} : {
      proxyErrorCode: proxy.proxyErrorCode,
      networkPath: describeProxyEnvironment(undefined).networkPath,
      proxyStage: proxy.proxyErrorCode === 'PROXY_STREAM_INTERRUPTED' ? 'stream' : proxy.proxyErrorCode === 'PROXY_TUNNEL_FAILED' ? 'tunnel' : 'connect'
    }),
    ...(validProgress ? { retryAttempt: attempt, retryLimit: limit } : {}) };
}
