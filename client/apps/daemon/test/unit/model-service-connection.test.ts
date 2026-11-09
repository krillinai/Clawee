import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkModelServiceConnection, MODEL_SERVICE_CHECK_TIMEOUT_MS } from '../../src/codex/model-service-connection.js';

const request = { baseUrl: 'https://model.example.test/custom/v1', model: 'model-1', apiKey: 'test-model-secret' };
const directEnv: NodeJS.ProcessEnv = {};
const encoder = new TextEncoder();

afterEach(() => {
  vi.useRealTimers();
});

describe('model service connection', () => {
  it('makes one minimal Responses request and closes the stream after the first text', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"OK"}\n\n'));
      },
      cancel
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const result = await checkModelServiceConnection({ request, fetchImpl, env: directEnv });
    expect(result).toMatchObject({ status: 'succeeded', responseReceived: true, headersReceived: true, stage: 'model_text', httpStatus: 200, durationMs: expect.any(Number), checkedAt: expect.any(String) });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://model.example.test/custom/v1/responses');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer test-model-secret', 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual({ model: 'model-1', input: [{ role: 'user', content: '请只回复 OK' }], stream: true, store: false });
    expect(init.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
  });

  it('handles split UTF-8, CRLF, comments, and multiline SSE data', async () => {
    const bytes = encoder.encode(': heartbeat\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"你好"}\r\n\r\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      }
    });
    const result = await checkModelServiceConnection({ request, fetchImpl: vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })), env: directEnv });
    expect(result.status).toBe('succeeded');
  });

  it.each([
    'data: [DONE]\n\n',
    'data: not-json\n\n',
    `data: ${'x'.repeat(70_000)}`
  ])('does not accept a stream without valid model text', async data => {
    const result = await checkModelServiceConnection({ request, fetchImpl: vi.fn().mockResolvedValue(streamResponse(data)), env: directEnv });
    expect(result).toMatchObject({ status: 'failed', responseReceived: false, httpStatus: 200, errorCode: 'MODEL_SERVICE_RESPONSE_INVALID' });
  });

  it.each([
    'data: {"type":"response.created"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"   "}\n\n'
  ])('reports a stream ending before valid text without claiming a network reset', async data => {
    const result = await checkModelServiceConnection({ request, fetchImpl: vi.fn().mockResolvedValue(streamResponse(data)), env: directEnv });
    expect(result).toMatchObject({ status: 'failed', headersReceived: true, responseReceived: false, stage: 'model_text', httpStatus: 200, errorCode: 'MODEL_SERVICE_STREAM_ENDED' });
    expect(result.transportCode).toBeUndefined();
  });

  it('rejects HTTP 200 HTML rather than treating connectivity as success', async () => {
    const result = await checkModelServiceConnection({ request, fetchImpl: vi.fn().mockResolvedValue(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })), env: directEnv });
    expect(result).toMatchObject({ status: 'failed', httpStatus: 200, errorCode: 'MODEL_SERVICE_RESPONSE_INVALID' });
  });

  it.each([
    [401, 'invalid_api_key', 'MODEL_SERVICE_AUTH_FAILED'],
    [403, 'permission_denied', 'MODEL_SERVICE_ACCESS_DENIED'],
    [404, 'model_not_found', 'MODEL_SERVICE_MODEL_UNAVAILABLE'],
    [400, 'model_not_supported', 'MODEL_SERVICE_MODEL_UNAVAILABLE'],
    [404, 'not_found', 'MODEL_SERVICE_RESPONSE_INVALID'],
    [405, 'method_not_allowed', 'MODEL_SERVICE_RESPONSE_INVALID'],
    [429, 'rate_limit_exceeded', 'MODEL_SERVICE_RATE_LIMITED'],
    [503, 'server_error', 'MODEL_SERVICE_UPSTREAM_FAILED']
  ])('classifies HTTP %s errors without leaking credentials', async (status, code, errorCode) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code, message: `Rejected ${request.apiKey}; Authorization: Bearer another-secret` } }), { status, headers: { 'Content-Type': 'application/json' } }));
    const result = await checkModelServiceConnection({ request, fetchImpl, env: directEnv });
    expect(result).toMatchObject({ status: 'failed', httpStatus: status, errorCode });
    expect(result.diagnostic).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
    expect(JSON.stringify(result)).not.toContain('another-secret');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('recognizes failures inside a successful HTTP stream', async () => {
    const response = streamResponse(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'model_not_found', message: `Unknown model, secret=${request.apiKey}` } } })}\n\n`);
    const result = await checkModelServiceConnection({ request, fetchImpl: vi.fn().mockResolvedValue(response), env: directEnv });
    expect(result).toMatchObject({ status: 'failed', httpStatus: 200, errorCode: 'MODEL_SERVICE_MODEL_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
  });

  it('reports network failure without exposing the raw exception or retrying', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`connection failed ${request.apiKey}`));
    const result = await checkModelServiceConnection({ request, fetchImpl, env: directEnv });
    expect(result).toMatchObject({ status: 'failed', headersReceived: false, responseReceived: false, stage: 'response_headers', errorCode: 'MODEL_SERVICE_NETWORK_FAILED', message: '模型接口连接失败，原因未知' });
    expect(result.suggestion).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['ENOTFOUND', 'MODEL_SERVICE_DNS_FAILED'],
    ['EAI_AGAIN', 'MODEL_SERVICE_DNS_FAILED'],
    ['ECONNREFUSED', 'MODEL_SERVICE_CONNECTION_REFUSED'],
    ['ECONNRESET', 'MODEL_SERVICE_CONNECTION_RESET'],
    ['EPIPE', 'MODEL_SERVICE_CONNECTION_RESET'],
    ['ENETUNREACH', 'MODEL_SERVICE_NETWORK_UNREACHABLE'],
    ['EHOSTUNREACH', 'MODEL_SERVICE_NETWORK_UNREACHABLE'],
    ['ETIMEDOUT', 'MODEL_SERVICE_CONNECTION_TIMEOUT'],
    ['UND_ERR_CONNECT_TIMEOUT', 'MODEL_SERVICE_CONNECTION_TIMEOUT'],
    ['UND_ERR_HEADERS_TIMEOUT', 'MODEL_SERVICE_CONNECTION_TIMEOUT'],
    ['CERT_HAS_EXPIRED', 'MODEL_SERVICE_TLS_FAILED'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'MODEL_SERVICE_TLS_FAILED'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'MODEL_SERVICE_TLS_FAILED'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'MODEL_SERVICE_TLS_FAILED']
  ])('classifies %s from fetch causes without returning raw errors', async (code, errorCode) => {
    const cause = Object.assign(new Error(`https://proxy.example/?key=${request.apiKey}`), { code });
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: new Error('wrapper', { cause }) }));
    const result = await checkModelServiceConnection({ request, fetchImpl, env: directEnv });
    expect(result).toMatchObject({ status: 'failed', headersReceived: false, stage: 'response_headers', errorCode, transportCode: code, suggestion: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
    expect(JSON.stringify(result)).not.toContain('proxy.example');
    expect(result.diagnostic).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not expose unknown transport codes or loop through cyclic causes', async () => {
    const cause = { code: request.apiKey, cause: undefined as unknown };
    cause.cause = cause;
    const result = await checkModelServiceConnection({ request, fetchImpl: vi.fn().mockRejectedValue(cause), env: directEnv });
    expect(result.errorCode).toBe('MODEL_SERVICE_NETWORK_FAILED');
    expect(result.transportCode).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
  });

  it('preserves the HTTP error when reading its body fails', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })); } });
    const result = await checkModelServiceConnection({ request, fetchImpl: vi.fn().mockResolvedValue(new Response(body, { status: 401 })), env: directEnv });
    expect(result).toMatchObject({ status: 'failed', headersReceived: true, stage: 'response_body', httpStatus: 401, errorCode: 'MODEL_SERVICE_AUTH_FAILED', transportCode: 'ECONNRESET' });
  });

  it.each([
    [401, 'MODEL_SERVICE_AUTH_FAILED'],
    [403, 'MODEL_SERVICE_ACCESS_DENIED'],
    [429, 'MODEL_SERVICE_RATE_LIMITED'],
    [503, 'MODEL_SERVICE_UPSTREAM_FAILED']
  ])('preserves HTTP %s when its body exceeds the deadline', async (status, errorCode) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      }
    }), { status })));
    const checking = checkModelServiceConnection({ request, fetchImpl, env: directEnv });
    await vi.advanceTimersByTimeAsync(MODEL_SERVICE_CHECK_TIMEOUT_MS);
    expect(await checking).toMatchObject({ status: 'failed', headersReceived: true, responseReceived: false, stage: 'response_body', httpStatus: status, errorCode, durationMs: 20_000 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['ECONNRESET', 'MODEL_SERVICE_CONNECTION_RESET'],
    ['UND_ERR_SOCKET', 'MODEL_SERVICE_STREAM_INTERRUPTED'],
    ['UND_ERR_BODY_TIMEOUT', 'MODEL_SERVICE_TEXT_TIMEOUT']
  ])('reports %s while reading model text', async (code, errorCode) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(Object.assign(new Error(`failed ${request.apiKey}`), { code })); } });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const result = await checkModelServiceConnection({ request, fetchImpl, env: directEnv });
    expect(result).toMatchObject({ status: 'failed', headersReceived: true, responseReceived: false, stage: 'model_text', httpStatus: 200, errorCode, transportCode: code });
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('classifies proxy authentication failures and keeps only proxy metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Proxy Authentication Required', {
      status: 407,
      headers: { 'Proxy-Authenticate': 'Basic realm="proxy"' }
    }));
    const result = await checkModelServiceConnection({
      request,
      fetchImpl,
      env: { HTTPS_PROXY: 'http://user:secret@proxy.example.test:8080' }
    });
    expect(result).toMatchObject({
      status: 'failed', errorCode: 'MODEL_SERVICE_PROXY_AUTH_REQUIRED',
      proxyErrorCode: 'PROXY_AUTH_REQUIRED', networkPath: 'http_proxy', proxyApplies: true,
      proxyStage: 'connect', retryable: false
    });
    expect(result.proxyEnvKeys).toEqual(['HTTPS_PROXY']);
    expect(JSON.stringify(result)).not.toContain('proxy.example.test');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('classifies proxy connect timeout and respects NO_PROXY', async () => {
    const cause = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause }));
    const throughProxy = await checkModelServiceConnection({
      request, fetchImpl, env: { HTTPS_PROXY: 'http://proxy.example.test:8080' }
    });
    expect(throughProxy).toMatchObject({
      errorCode: 'MODEL_SERVICE_PROXY_CONNECT_TIMEOUT', proxyErrorCode: 'PROXY_CONNECT_TIMEOUT',
      networkPath: 'http_proxy', proxyStage: 'connect', transportCode: 'ETIMEDOUT'
    });

    const direct = await checkModelServiceConnection({
      request, fetchImpl, env: { HTTPS_PROXY: 'http://proxy.example.test:8080', NO_PROXY: 'model.example.test' }
    });
    expect(direct).toMatchObject({ errorCode: 'MODEL_SERVICE_CONNECTION_TIMEOUT', networkPath: 'direct', proxyApplies: false });
    expect(direct.proxyErrorCode).toBeUndefined();
  });

  it('classifies a proxy interrupted streaming response', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
      }
    });
    const result = await checkModelServiceConnection({
      request,
      fetchImpl: vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })),
      env: { HTTPS_PROXY: 'http://proxy.example.test:8080' }
    });
    expect(result).toMatchObject({
      errorCode: 'MODEL_SERVICE_PROXY_STREAM_INTERRUPTED', proxyErrorCode: 'PROXY_STREAM_INTERRUPTED',
      networkPath: 'http_proxy', proxyStage: 'stream', transportCode: 'ECONNRESET'
    });
  });

  it('does not infer a connection reset from an unknown error after response headers', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(`unknown ${request.apiKey}`)); } });
    const result = await checkModelServiceConnection({ request, fetchImpl: vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })), env: directEnv });
    expect(result).toMatchObject({ status: 'failed', headersReceived: true, stage: 'model_text', errorCode: 'MODEL_SERVICE_NETWORK_FAILED', message: '读取模型响应失败，原因未知' });
    expect(result.transportCode).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(request.apiKey);
  });

  it.each(['headers', 'body'])('enforces the same 20-second deadline while waiting for %s', async stage => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      if (stage === 'headers') {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        }
      }), { headers: { 'Content-Type': 'text/event-stream' } }));
    });
    const checking = checkModelServiceConnection({ request, fetchImpl, env: directEnv });
    await vi.advanceTimersByTimeAsync(MODEL_SERVICE_CHECK_TIMEOUT_MS);
    expect(await checking).toMatchObject({
      status: 'failed', responseReceived: false, headersReceived: stage === 'body',
      stage: stage === 'headers' ? 'response_headers' : 'model_text',
      message: stage === 'headers' ? '等待接口响应超时' : '等待模型文本超时',
      errorCode: 'MODEL_SERVICE_CHECK_TIMEOUT', durationMs: 20_000
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function streamResponse(data: string): Response {
  return new Response(data, { headers: { 'Content-Type': 'text/event-stream' } });
}
