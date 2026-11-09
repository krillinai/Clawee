import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, RuntimeClient } from './client.js';

describe('RuntimeClient', () => {
  const originalBridge = window.claweeDesktop;
  afterEach(() => { window.claweeDesktop = originalBridge; vi.useRealTimers(); });

  it('排除用户取消，但保留真正超时及其耗时', async () => {
    vi.useFakeTimers();
    const reportIncident = vi.fn(async (_observation: { event_type: string }) => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 125);
      throw controller.signal.reason;
    });
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl });
    controller.abort();
    await expect(client.get('/runs', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(reportIncident).not.toHaveBeenCalled();
    const timeout = AbortSignal.abort(new DOMException('private timeout', 'TimeoutError'));
    fetchImpl.mockImplementation(async () => { vi.setSystemTime(Date.now() + 300); throw timeout.reason; });
    await expect(client.get('/runs', { signal: timeout })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'WEB_REQUEST_TIMEOUT', duration_ms: 300 }));
  });

  it('读取正文失败不发送恢复，保留技术原因但不发送明确凭据', async () => {
    const reportIncident = vi.fn(async (_observation: { event_type: string }) => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    let mode = 'network';
    const fetchImpl = vi.fn(async () => {
      if (mode === 'network') throw new TypeError('connection reset Bearer private-token');
      if (mode === 'body') return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('response stream ended')); } }));
      return new Response('{}');
    });
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl });
    await expect(client.get('/runs')).rejects.toThrow('connection reset');
    mode = 'body';
    await expect(client.get('/runs')).rejects.toThrow('response stream ended');
    expect(reportIncident.mock.calls.map(([observation]) => observation.event_type)).toEqual(['error', 'error']);
    mode = 'ok';
    await client.get('/healthz');
    expect(reportIncident).toHaveBeenCalledTimes(2);
    await client.get('/runs');
    expect(reportIncident).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'recovered' }));
    expect(JSON.stringify(reportIncident.mock.calls)).not.toContain('private-token');
    expect(JSON.stringify(reportIncident.mock.calls)).toContain('response stream ended');
  });

  it('记录失败接口的方法和路径，不带查询参数', async () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl: vi.fn(async () => new Response('{}', { status: 503, headers: { 'X-Request-ID': 'req_123' } })) });
    await expect(client.get('/runs/run_1?api_key=private')).rejects.toBeInstanceOf(ApiClientError);
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ diagnostics: expect.objectContaining({ request_method: 'GET', request_path: '/runs/run_1', request_id: 'req_123' }) }));
    expect(JSON.stringify(reportIncident.mock.calls)).not.toContain('api_key');
  });

  it('企业网络原因完整上报，保留上游请求标识；相同接口成功后才发送恢复', async () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    let failed = true;
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl: async () => failed ? Response.json({ error: {
      code: 'ENTERPRISE_SERVICE_UNAVAILABLE', message: '企业服务请求失败：DNS 解析失败（ENOTFOUND）',
      details: { failureKind: 'dns', causeCode: 'ENOTFOUND', causeMessage: 'getaddrinfo ENOTFOUND gateway.test', stage: 'request', requestMethod: 'GET', requestUrl: 'https://gateway.test/api/v1/auth/me?customer=private', timeoutMs: 15000, durationMs: 20250, attempts: 2, maxAttempts: 2, requestId: 'req_gateway', body: 'private' }
    } }, { status: 503, headers: { 'X-Request-ID': 'req_local' } }) : Response.json({ status: 'signed_in' }) });
    await expect(client.post('/enterprise/session/refresh')).rejects.toMatchObject({ code: 'ENTERPRISE_SERVICE_UNAVAILABLE' });
    expect(reportIncident).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'error', http_status: 503, diagnostics: expect.objectContaining({
      error_message: '企业服务请求失败：DNS 解析失败（ENOTFOUND）', cause_code: 'ENOTFOUND', request_method: 'POST', request_path: '/enterprise/session/refresh', request_id: 'req_gateway', additional_details: expect.stringContaining('2/2')
    }) }));
    expect(JSON.stringify(reportIncident.mock.calls)).not.toContain('private');
    failed = false;
    await client.get('/healthz');
    expect(reportIncident).toHaveBeenCalledTimes(1);
    await client.post('/enterprise/session/refresh');
    expect(reportIncident).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'recovered' }));
  });

  it('dispose后未完成请求不再报告，但不改变请求结果', async () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    let rejectFetch!: (error: Error) => void;
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl: () => new Promise((_resolve, reject) => { rejectFetch = reject; }) });
    const request = client.get('/runs');
    client.disposeIncidentObservation();
    rejectFetch(new TypeError('closed'));
    await expect(request).rejects.toThrow('closed');
    expect(reportIncident).not.toHaveBeenCalled();
  });
  it('HTTP 200的业务错误不伪造为HTTP 500技术异常', async () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl: async () => Response.json({ error: { code: 'BUSINESS_REJECTED', message: 'private business detail' } }) });
    await expect(client.get('/runs')).rejects.toMatchObject({ code: 'BUSINESS_REJECTED', status: 500 });
    expect(reportIncident).not.toHaveBeenCalled();
  });
  it('rawGet sends authorization header for authenticated requests', async () => {
    const fetchMock = vi.fn(async () => new Response('plain text', {
      status: 200,
      headers: { 'content-type': 'text/plain' }
    }));
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:60855', token: 'tok', fetchImpl: fetchMock });

    const response = await client.rawGet('/workspace/files/blob?threadId=t1&path=img.png');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:60855/workspace/files/blob?threadId=t1&path=img.png',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' })
      })
    );
  });

  it('sends authorization header for authenticated requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ codexVersion: 'test' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:60855', token: 'tok', fetchImpl: fetchMock });

    await client.get('/codex/status');

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:60855/codex/status', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer tok' })
    }));
  });

  it('does not send authorization header for healthz', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:60855', token: 'tok', fetchImpl: fetchMock });

    await client.get('/healthz');

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:60855/healthz', expect.objectContaining({
      headers: expect.not.objectContaining({ Authorization: expect.any(String) })
    }));
  });

  it('passes AbortSignal to fetch for cancelable requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({
      baseUrl: 'http://127.0.0.1:60855',
      token: 'tok',
      fetchImpl: fetchMock
    });
    const controller = new AbortController();

    await client.get('/threads/thread_1/history', {
      signal: controller.signal
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:60855/threads/thread_1/history',
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it('throws ApiClientError for Runtime error responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' }
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:60855', token: 'bad', fetchImpl: fetchMock });

    await expect(client.get('/runs')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401
    });
  });

  it('throws ApiClientError for successful responses containing an error envelope', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'ENTERPRISE_PROTOCOL_ERROR',
        message: 'Enterprise knowledge operation failed'
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({
      baseUrl: 'http://127.0.0.1:60855',
      token: 'tok',
      fetchImpl: fetchMock
    });

    await expect(client.get('/enterprise/knowledge-bases')).rejects.toMatchObject({
      code: 'ENTERPRISE_PROTOCOL_ERROR',
      status: 500
    });
  });

  it('preserves Fastify top-level error details', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      statusCode: 500,
      code: '-32600',
      error: 'Internal Server Error',
      message: 'thread not loaded: codex-thread-persisted'
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({
      baseUrl: 'http://127.0.0.1:60855',
      token: 'tok',
      fetchImpl: fetchMock
    });

    await expect(client.get('/enterprise/knowledge-conversations/thread/history'))
      .rejects.toMatchObject({
        status: 500,
        code: '-32600',
        message: 'thread not loaded: codex-thread-persisted'
      });
  });

  it('throws ApiClientError for non-JSON error responses', async () => {
    const fetchMock = vi.fn(async () => new Response('Internal Server Error', {
      status: 500,
      headers: { 'content-type': 'text/plain' }
    }));
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:60855', token: 'tok', fetchImpl: fetchMock });

    const request = client.get('/runs');

    await expect(request).rejects.toBeInstanceOf(ApiClientError);
    await expect(request).rejects.toMatchObject({
      status: 500,
      code: 'HTTP_ERROR'
    });
  });

  it('rawRequest throws ApiClientError for Runtime error responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' }
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:60855', token: 'bad', fetchImpl: fetchMock });

    await expect(client.rawRequest('/runs', { method: 'GET' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401
    });
  });

  it('request sends JSON body through rawRequest-compatible fetch behavior', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:60855', token: 'tok', fetchImpl: fetchMock });

    await client.post('/workspace/files/content', { path: 'a.txt', content: 'hello' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:60855/workspace/files/content',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ path: 'a.txt', content: 'hello' })
      })
    );
  });

  it('postBinary sends authenticated bytes without JSON serialization', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    }));
    const client = new RuntimeClient({
      baseUrl: 'http://127.0.0.1:60855',
      token: 'tok',
      fetchImpl: fetchMock
    });
    const payload = new Blob(['hello'], { type: 'text/plain' });

    await client.postBinary('/attachments?draftId=draft-1', payload);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:60855/attachments?draftId=draft-1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'Content-Type': 'application/octet-stream'
        }),
        body: payload
      })
    );
  });

  it('leaves multipart boundaries to fetch when posting FormData', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    const client = new RuntimeClient({ baseUrl: 'http://127.0.0.1:60855', token: 'tok', fetchImpl: fetchMock });
    const body = new FormData();
    body.append('version', '1');
    await client.postBinary('/enterprise/skills/versions', body);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:60855/enterprise/skills/versions', expect.objectContaining({ body, headers: { Authorization: 'Bearer tok' } }));
  });
});
