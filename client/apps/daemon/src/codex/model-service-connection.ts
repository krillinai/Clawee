import type { CodexAvailabilityProbe, ConfigureModelServiceRequest } from '@clawee/protocol';
import { randomUUID } from 'node:crypto';
import { createParser } from 'eventsource-parser';
import { parseJsonLine } from '../events/parser.js';
import { redactText } from '../security/redaction.js';
import { classifyProxyFailure, describeProxyEnvironment, proxyErrorMessage, type ProxyEnvironmentSummary } from './network-diagnostics.js';

export const MODEL_SERVICE_CHECK_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export async function checkModelServiceConnection(input: {
  request: ConfigureModelServiceRequest;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexAvailabilityProbe> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const network = describeProxyEnvironment(input.request.baseUrl, input.env);
  const controller = new AbortController();
  let timedOut = false;
  let httpStatus: number | undefined;
  let proxyResponse = false;
  let stage: CodexAvailabilityProbe['stage'] = 'response_headers';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MODEL_SERVICE_CHECK_TIMEOUT_MS);
  const finish = (result: CodexAvailabilityProbe): CodexAvailabilityProbe => ({
    ...result,
    requestId,
    networkPath: result.networkPath ?? network.networkPath,
    proxyEnvKeys: result.proxyEnvKeys ?? network.proxyEnvKeys,
    proxyApplies: result.proxyApplies ?? network.proxyApplies,
    stage,
    headersReceived: httpStatus !== undefined,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString()
  });

  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.request.baseUrl}/responses`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'X-Request-ID': requestId,
        Authorization: `Bearer ${input.request.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        model: input.request.model,
        input: [{ role: 'user', content: '请只回复 OK' }],
        stream: true,
        store: false
      }),
      signal: controller.signal
    });
    httpStatus = response.status;
    proxyResponse = response.headers.has('proxy-authenticate') || response.headers.has('via');
    stage = 'response_body';
    reader = response.body?.getReader();
    if (!response.ok) {
      const error = reader === undefined ? undefined : await readErrorResponse(reader);
      return finish(upstreamFailure(httpStatus, error, input.request.apiKey, network, proxyResponse));
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || reader === undefined) {
      return finish(invalidResponse());
    }
    stage = 'model_text';

    let outcome: CodexAvailabilityProbe | undefined;
    const parser = createParser({
      maxBufferSize: MAX_RESPONSE_BYTES,
      onError(error) {
        if (error.type === 'max-buffer-size-exceeded') outcome ??= invalidResponse();
      },
      onEvent(event) {
        if (outcome !== undefined) return;
        if (event.data === '[DONE]') {
          outcome = invalidResponse();
          return;
        }
        const parsed = parseJsonLine(event.data);
        if (!parsed.ok || !isRecord(parsed.value)) {
          outcome = invalidResponse();
          return;
        }
        const value = parsed.value;
        if (value.type === 'response.output_text.delta' && typeof value.delta === 'string' && value.delta.trim().length > 0) {
          outcome = { status: 'succeeded', responseReceived: true };
        } else if (value.type === 'error' || value.type === 'response.failed' || value.type === 'response.incomplete') {
          outcome = upstreamFailure(httpStatus!, value, input.request.apiKey, network, proxyResponse);
        } else if (value.type === 'response.completed') {
          outcome = invalidResponse();
        }
      }
    });
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return finish(failure(
        'MODEL_SERVICE_STREAM_ENDED', '响应流在返回有效模型文本前结束',
        '请重试；持续出现时检查模型服务的流式响应，或结合任务日志排查。'
      ));
      parser.feed(decoder.decode(chunk.value, { stream: true }));
      if (outcome !== undefined) return finish(outcome);
    }
  } catch (error) {
    const networkResult = networkFailure(error, stage, network);
    if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) {
      return finish({
        ...upstreamFailure(httpStatus, undefined, input.request.apiKey, network, proxyResponse),
        ...(networkResult.transportCode === undefined ? {} : { transportCode: networkResult.transportCode })
      });
    }
    if (timedOut) {
      const proxy = classifyProxyFailure({
        transportCode: 'ETIMEDOUT', stage: proxyStage(stage), proxyApplies: network.proxyApplies
      });
      if (proxy !== undefined) return finish(proxyFailure(proxy.proxyErrorCode, network));
      return finish(failure('MODEL_SERVICE_CHECK_TIMEOUT', stage === 'model_text' ? '等待模型文本超时' : '等待接口响应超时',
          stage === 'model_text'
            ? '已收到响应头，但总计 20 秒内未收到有效模型文本；请重试或检查上游响应与代理转发。'
            : '总计 20 秒内未收到响应头；请检查 Base URL、网络或代理，也可能是上游响应缓慢。'));
    }
    return finish(networkResult);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader !== undefined) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

async function readErrorResponse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) return undefined;
    text += decoder.decode(chunk.value, { stream: true });
  }
  const parsed = parseJsonLine(text + decoder.decode());
  return parsed.ok ? parsed.value : undefined;
}

function upstreamFailure(
  httpStatus: number,
  value: unknown,
  apiKey: string,
  network: ProxyEnvironmentSummary,
  proxyHeader: boolean
): CodexAvailabilityProbe {
  const payload = isRecord(value) ? value : {};
  const response = isRecord(payload.response) ? payload.response : payload;
  const error = isRecord(response.error) ? response.error : response;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  const proxy = classifyProxyFailure({
    status: httpStatus, text: message, stage: 'response_body', proxyApplies: network.proxyApplies, proxyHeader
  });
  if (proxy !== undefined) {
    const result = proxyFailure(proxy.proxyErrorCode, network);
    if (message.length > 0) result.diagnostic = redactText(message.split(apiKey).join('[REDACTED]')).slice(0, 1024);
    return result;
  }
  let result: CodexAvailabilityProbe;
  if (httpStatus === 401 || code === 'invalid_api_key') {
    result = failure('MODEL_SERVICE_AUTH_FAILED', 'API Key 无效或无权限', '请确认 API Key 有效且具有模型调用权限。');
  } else if (httpStatus === 403 || code === 'permission_denied') {
    result = failure('MODEL_SERVICE_ACCESS_DENIED', '模型服务拒绝访问，请检查密钥权限', '请确认密钥权限及模型服务的访问策略。');
  } else if (/model_(?:not_found|not_supported|not_available)|model_not_exist/i.test(code)
    || /model[^\n]*(?:not found|does not exist|not supported)/i.test(message)) {
    result = failure('MODEL_SERVICE_MODEL_UNAVAILABLE', '模型名称或访问权限异常', '请检查模型名称，以及当前密钥是否有权调用该模型。');
  } else if (httpStatus === 429 || code === 'rate_limit_exceeded') {
    result = failure('MODEL_SERVICE_RATE_LIMITED', '模型服务请求受限，请稍后重试', '请稍后重试，或检查模型服务的配额和限流设置。');
  } else if (httpStatus === 400 || httpStatus === 404 || httpStatus === 405 || httpStatus === 415 || httpStatus === 422) {
    result = invalidResponse();
  } else {
    result = failure('MODEL_SERVICE_UPSTREAM_FAILED', '模型服务返回错误，请稍后重试', '请稍后重试；持续失败时联系模型服务维护方。');
  }
  if (message.length > 0) {
    result.diagnostic = redactText(message.split(apiKey).join('[REDACTED]')).slice(0, 1024);
  }
  return result;
}

function invalidResponse(): CodexAvailabilityProbe {
  return failure('MODEL_SERVICE_RESPONSE_INVALID', '接口不兼容或未返回有效的 Responses 文本', '请检查 Base URL 和模型服务是否支持 Responses 流式文本响应。');
}

const transportFailures = [
  {
    codes: ['ENOTFOUND', 'EAI_AGAIN'], errorCode: 'MODEL_SERVICE_DNS_FAILED',
    message: '模型接口域名解析失败', suggestion: '请检查 Base URL 的域名及当前 DNS；临时解析失败可稍后重试。'
  },
  {
    codes: ['ECONNREFUSED'], errorCode: 'MODEL_SERVICE_CONNECTION_REFUSED',
    message: '模型接口连接被拒绝', suggestion: '请检查 Base URL 的端口、服务是否启动，以及代理或访问策略。'
  },
  {
    codes: ['ECONNRESET', 'EPIPE'], errorCode: 'MODEL_SERVICE_CONNECTION_RESET',
    message: '模型接口连接中断', suggestion: '连接被重置或写入中断；请重试，持续出现时检查上游与代理转发。'
  },
  {
    codes: ['ENETUNREACH', 'EHOSTUNREACH'], errorCode: 'MODEL_SERVICE_NETWORK_UNREACHABLE',
    message: '模型接口网络不可达', suggestion: '请检查当前网络、VPN 或代理，以及目标地址的访问策略。'
  },
  {
    codes: ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'], errorCode: 'MODEL_SERVICE_CONNECTION_TIMEOUT',
    message: '模型接口请求超时', suggestion: '请检查 Base URL、网络或代理；也可能是上游响应缓慢，请稍后重试。'
  },
  {
    codes: ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_REVOKED'],
    errorCode: 'MODEL_SERVICE_TLS_FAILED', message: '模型接口证书校验失败',
    suggestion: '请检查系统时间、Base URL 与企业证书配置；不要关闭证书校验。'
  },
  {
    codes: ['UND_ERR_BODY_TIMEOUT'], errorCode: 'MODEL_SERVICE_TEXT_TIMEOUT',
    message: '等待模型文本超时', suggestion: '已收到响应头，但读取响应超时；请重试或检查上游响应与代理转发。'
  }
];

function networkFailure(
  error: unknown,
  stage: CodexAvailabilityProbe['stage'],
  network: ProxyEnvironmentSummary
): CodexAvailabilityProbe {
  let cause = error;
  for (let depth = 0; depth < 5 && isRecord(cause); depth += 1) {
    const code = cause.code;
    const proxy = classifyProxyFailure({
      transportCode: typeof code === 'string' ? code : undefined,
      text: typeof cause.message === 'string' ? cause.message : undefined,
      stage: proxyStage(stage),
      proxyApplies: network.proxyApplies
    });
    if (proxy !== undefined) return proxyFailure(proxy.proxyErrorCode, network, typeof code === 'string' ? code : undefined);
    const classified = transportFailures.find(entry => entry.codes.some(known => known === code));
    if (classified !== undefined) {
      return { ...failure(classified.errorCode, classified.message, classified.suggestion), transportCode: String(code) };
    }
    if (code === 'UND_ERR_SOCKET') {
      return {
        ...failure(stage === 'model_text' ? 'MODEL_SERVICE_STREAM_INTERRUPTED' : 'MODEL_SERVICE_NETWORK_FAILED',
          stage === 'model_text' ? '模型响应流连接中断' : '模型接口连接失败，原因未知',
          '请重试；持续出现时检查上游、网络与代理转发。'),
        transportCode: code
      };
    }
    cause = cause.cause;
  }
  return failure('MODEL_SERVICE_NETWORK_FAILED',
    stage === 'response_headers' ? '模型接口连接失败，原因未知' : '读取模型响应失败，原因未知',
    '请检查 Base URL、网络或代理，并结合任务日志排查；当前证据不足以确定原因。');
}

function proxyFailure(
  code: NonNullable<ReturnType<typeof classifyProxyFailure>>['proxyErrorCode'],
  network: ProxyEnvironmentSummary,
  transportCode?: string
): CodexAvailabilityProbe {
  const copy = proxyErrorMessage(code);
  return {
    ...failure(`MODEL_SERVICE_${code}`, copy.message, copy.suggestion),
    proxyErrorCode: code,
    failureOrigin: 'client_proxy',
    retryable: copy.retryable,
    proxyStage: code === 'PROXY_STREAM_INTERRUPTED' ? 'stream' : code === 'PROXY_TUNNEL_FAILED' ? 'tunnel' : 'connect',
    ...(transportCode === undefined ? {} : { transportCode }),
    networkPath: network.networkPath,
    proxyEnvKeys: network.proxyEnvKeys,
    proxyApplies: network.proxyApplies
  };
}

function proxyStage(stage: CodexAvailabilityProbe['stage']): 'response_headers' | 'response_body' | 'stream' {
  return stage === 'model_text' ? 'stream' : stage ?? 'response_headers';
}

function failure(errorCode: string, message: string, suggestion?: string): CodexAvailabilityProbe {
  return { status: 'failed', responseReceived: false, errorCode, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
