import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

type RuntimeFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

/**
 * 通过 Node HTTP 访问本地 daemon，避免 Electron Chromium 网络栈在长连接
 * 响应流上产生 ERR_NETWORK_IO_SUSPENDED。
 */
export const runtimeFetch: RuntimeFetch = (input, init = {}) => {
  const url = new URL(input.toString());
  if (url.protocol !== 'http:') {
    return Promise.reject(new Error('Runtime proxy requires HTTP'));
  }

  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  const body = runtimeRequestBody(init.body);
  if (body !== undefined && !headers.has('content-length')) {
    headers.set('content-length', String(body.byteLength));
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    let request: ClientRequest | undefined;
    const signal = init.signal;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      const reason = signal?.reason;
      const error = reason instanceof Error
        ? reason
        : new Error(typeof reason === 'string' ? reason : 'Runtime request aborted');
      request?.destroy(error);
      response?.destroy(error);
      fail(error);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    request = httpRequest(url, {
      method,
      headers: Object.fromEntries(headers.entries())
    }, incoming => {
      response = incoming;
      const status = incoming.statusCode ?? 0;
      if (init.redirect === 'error' && status >= 300 && status < 400) {
        incoming.resume();
        request?.destroy();
        fail(new Error(`Runtime proxy refused redirect (${status})`));
        return;
      }

      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else {
          responseHeaders.set(name, value);
        }
      }
      // Keep the AbortSignal attached while an SSE/streaming response is open, then
      // release it when Node tells us the response has ended or been closed.
      incoming.once('end', cleanup);
      incoming.once('close', cleanup);
      incoming.once('error', cleanup);
      try {
        const body = method === 'HEAD' || [204, 205, 304].includes(status)
          ? null
          : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (body === null) incoming.resume();
        const result = new Response(body, {
          status,
          statusText: incoming.statusMessage ?? '',
          headers: responseHeaders
        });
        settled = true;
        resolve(result);
      } catch (error) {
        fail(error);
      }
    });

    request.on('error', fail);
    if (body !== undefined) request.write(body);
    request.end();
  });
};

function runtimeRequestBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError('Runtime proxy request body must be a buffered body');
}
