import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProtocolHandler } from '../src/main/protocol-handler.js';
import type { runtimeFetch } from '../src/main/runtime-fetch.js';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), fetch: vi.fn() }));
vi.mock('electron', () => ({ protocol: { handle: mocks.handle } }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function runtimeHandler(fetchRuntime: typeof runtimeFetch = mocks.fetch) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), warnRateLimited: vi.fn(), flush: vi.fn() };
  await installProtocolHandler({
    webRoot: '/unused', bootstrapRoot: '/unused',
    getConnection: () => ({ address: 'http://127.0.0.1:1234', token: 'local-token' }),
    logger,
    runtimeFetch: fetchRuntime
  });
  return { handle: mocks.handle.mock.calls[0]![1] as (request: Request) => Promise<Response>, logger };
}

describe('桌面 Runtime 网络传输', () => {
  it('Node fetch 存在 setTypeOfService 故障时仍通过 Chromium 转发请求', async () => {
    mocks.fetch.mockResolvedValue(new Response('result', { status: 201 }));
    const { handle } = await runtimeHandler();
    const request = new Request('clawee-app://app/.clawee/runtime/runs?wait=1', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer renderer-token' },
      body: '{"prompt":"test"}'
    });

    const response = await handle(request);

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('result');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(String(mocks.fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:1234/runs?wait=1');
    const options = mocks.fetch.mock.calls[0]![1] as RequestInit;
    expect(options.method).toBe('POST');
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer local-token');
    expect(new TextDecoder().decode(options.body as ArrayBuffer)).toBe('{"prompt":"test"}');
  });

  it('保留流式响应并在下游取消时终止上游网络请求和读取', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: ready\n\n')); },
      cancel
    }), { headers: { 'Content-Type': 'text/event-stream', 'Transfer-Encoding': 'chunked' } }));
    const { handle } = await runtimeHandler();

    const request = new Request('clawee-app://app/.clawee/runtime/events');
    const response = await handle(request);
    const reader = response.body!.getReader();

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.has('transfer-encoding')).toBe(false);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: ready\n\n');
    await reader.cancel('closed');
    expect(cancel).toHaveBeenCalledWith('closed');
    const options = mocks.fetch.mock.calls[0]![1] as RequestInit;
    expect(options.signal?.aborted).toBe(true);
    expect(options.signal?.reason).toBe('closed');
    expect(request.signal.aborted).toBe(false);
  });

  it('等待上游数据时取消响应不会重复关闭流或记录错误', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const { handle, logger } = await runtimeHandler();
    const response = await handle(new Request('clawee-app://app/.clawee/runtime/events'));
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await Promise.resolve();

    await reader.cancel('closed');

    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('closed');
    expect((mocks.fetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('继续传递原始请求的取消信号', async () => {
    const controller = new AbortController();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream()));
    const { handle } = await runtimeHandler();
    const response = await handle(new Request('clawee-app://app/.clawee/runtime/events', {
      signal: controller.signal
    }));

    controller.abort('request closed');

    const options = mocks.fetch.mock.calls[0]![1] as RequestInit;
    expect(options.signal?.aborted).toBe(true);
    expect(options.signal?.reason).toBe('request closed');
    await response.body!.cancel();
  });

  it('上游流读取失败时仍向下游传递错误并记录日志', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; }
    })));
    const { handle, logger } = await runtimeHandler();
    const response = await handle(new Request('clawee-app://app/.clawee/runtime/events'));
    const pendingRead = response.body!.getReader().read();

    upstream.error(new Error('upstream disconnected'));

    await expect(pendingRead).rejects.toThrow('upstream disconnected');
    expect(logger.warn).toHaveBeenCalledWith('Runtime proxy response stream failed', expect.objectContaining({
      errorMessage: 'upstream disconnected',
      bytesForwarded: 0,
      chunkCount: 0,
      transport: 'node_http'
    }));
  });

  it('将网络失败转换为 502，不向界面暴露内部错误', async () => {
    mocks.fetch.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    const { handle, logger } = await runtimeHandler();

    const response = await handle(new Request('clawee-app://app/.clawee/runtime/healthz'));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'RUNTIME_PROXY_FAILED', message: 'Runtime request failed' } });
    expect(logger.warn).toHaveBeenCalled();
  });
});
