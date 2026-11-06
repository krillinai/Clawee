import { stat, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { protocol } from 'electron';
import type { DaemonConnection } from '../shared/types.js';
import type { DesktopLogger } from './logger.js';
import { runtimeFetch as defaultRuntimeFetch } from './runtime-fetch.js';
import {
  RuntimeProxyError,
  createRuntimeProxyHeaders,
  createRuntimeProxyTarget,
  isRuntimeRequestUrl,
  readBoundedRequestBody
} from './runtime-proxy.js';

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'clawee-app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        allowServiceWorkers: false,
        bypassCSP: false
      }
    }
  ]);
}

export async function installProtocolHandler(input: {
  webRoot: string;
  bootstrapRoot: string;
  getConnection(): DaemonConnection | undefined;
  logger: DesktopLogger;
  runtimeFetch?: typeof defaultRuntimeFetch;
}): Promise<void> {
  await protocol.handle('clawee-app', async request => {
    const url = new URL(request.url);
    if (isRuntimeRequestUrl(url)) {
      return await proxyRuntimeRequest(
        request,
        url,
        input.getConnection(),
        input.logger,
        input.runtimeFetch ?? defaultRuntimeFetch
      );
    }
    if (url.hostname === 'app') {
      return await staticResponse(input.webRoot, url.pathname, true);
    }
    if (url.hostname === 'bootstrap') {
      return await staticResponse(input.bootstrapRoot, url.pathname, false);
    }
    return new Response('Not found', { status: 404 });
  });
}

async function proxyRuntimeRequest(
  request: Request,
  url: URL,
  connection: DaemonConnection | undefined,
  logger: DesktopLogger,
  fetchRuntime: typeof defaultRuntimeFetch
): Promise<Response> {
  const requestId = `rtp_${randomUUID()}`;
  const startedAt = Date.now();
  if (connection === undefined) {
    logger.warn('Runtime proxy request rejected', {
      requestId,
      method: request.method,
      path: url.pathname,
      reason: 'connection_unavailable'
    });
    return jsonError(503, 'RUNTIME_UNAVAILABLE', 'Clawee Runtime is not ready');
  }
  try {
    const target = createRuntimeProxyTarget(url, connection.address);
    const headers = createRuntimeProxyHeaders(request.headers, connection.token);
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await readBoundedRequestBody(request);
    const upstreamAbort = new AbortController();
    const upstream = await fetchRuntime(target, {
      method: request.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.any([request.signal, upstreamAbort.signal])
    });
    return relayRuntimeResponse(
      upstream,
      logger,
      {
        requestId,
        method: request.method,
        path: url.pathname,
        startedAt,
        transport: 'node_http'
      },
      reason => upstreamAbort.abort(reason)
    );
  } catch (error) {
    if (error instanceof RuntimeProxyError) {
      return jsonError(error.status, error.code, error.message);
    }
    logger.warn('Runtime proxy request failed', {
      requestId,
      method: request.method,
      path: url.pathname,
      durationMs: Date.now() - startedAt,
      transport: 'node_http',
      ...runtimeErrorDetails(error)
    });
    return jsonError(502, 'RUNTIME_PROXY_FAILED', 'Runtime request failed');
  }
}

type RuntimeResponseLogContext = {
  requestId: string;
  method: string;
  path: string;
  startedAt: number;
  transport: string;
};

function relayRuntimeResponse(
  upstream: Response,
  logger: DesktopLogger,
  context: RuntimeResponseLogContext,
  abortUpstream: (reason: unknown) => void
): Response {
  const headers = new Headers(upstream.headers);
  for (const name of [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ]) {
    headers.delete(name);
  }
  const source = upstream.body;
  if (source === null) {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  }
  const reader = source.getReader();
  let canceled = false;
  let released = false;
  let bytesForwarded = 0;
  let chunkCount = 0;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (canceled) return;
        if (result.done) {
          release();
          controller.close();
          logger.info('Runtime proxy response stream completed', {
            requestId: context.requestId,
            method: context.method,
            path: context.path,
            status: upstream.status,
            contentType: upstream.headers.get('content-type'),
            bytesForwarded,
            chunkCount,
            durationMs: Date.now() - context.startedAt,
            transport: context.transport
          });
          return;
        }
        bytesForwarded += result.value.byteLength;
        chunkCount += 1;
        controller.enqueue(result.value);
      } catch (error) {
        if (canceled) return;
        abortUpstream(error);
        release();
        logger.warn('Runtime proxy response stream failed', {
          requestId: context.requestId,
          method: context.method,
          path: context.path,
          status: upstream.status,
          contentType: upstream.headers.get('content-type'),
          bytesForwarded,
          chunkCount,
          durationMs: Date.now() - context.startedAt,
          transport: context.transport,
          ...runtimeErrorDetails(error)
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      canceled = true;
      // Chromium 的响应流取消不会自动关闭上游 SSE 连接，须同时中止网络请求。
      abortUpstream(reason);
      await reader.cancel(reason).catch(() => undefined);
      release();
      logger.info('Runtime proxy response stream canceled', {
        requestId: context.requestId,
        method: context.method,
        path: context.path,
        status: upstream.status,
        bytesForwarded,
        chunkCount,
        durationMs: Date.now() - context.startedAt,
        transport: context.transport,
        cancelReason: normalizeErrorMessage(reason)
      });
    }
  });
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

function runtimeErrorDetails(error: unknown): Record<string, unknown> {
  const value = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const message = normalizeErrorMessage(value?.message ?? error);
  const cause = value?.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof value?.code === 'string'
    ? value.code
    : typeof cause?.code === 'string'
      ? cause.code
      : message.match(/\bERR_[A-Z0-9_]+\b/)?.[0];
  return {
    errorName: typeof value?.name === 'string' ? value.name : 'Error',
    ...(code === undefined ? {} : { errorCode: code }),
    errorMessage: message.slice(0, 1024),
    ...(typeof cause?.message === 'string' ? { causeMessage: cause.message.slice(0, 1024) } : {})
  };
}

function normalizeErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export async function staticResponse(
  root: string,
  pathname: string,
  spaFallback: boolean
): Promise<Response> {
  let path: string;
  try {
    path = resolveStaticPath(root, pathname);
  } catch {
    return new Response('Forbidden', { status: 403 });
  }
  if (!await isFile(path)) {
    if (!spaFallback || !shouldUseSpaFallback(pathname)) {
      return new Response('Not found', { status: 404 });
    }
    path = resolve(root, 'index.html');
    if (!await isFile(path)) return new Response('Not found', { status: 404 });
  }
  const headers = new Headers({
    'Content-Type': contentType(path),
    'Cache-Control': extname(path) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  if (extname(path) === '.html') {
    headers.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        // Cited sites' favicons load from the site itself (https only, no referrer).
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' blob:",
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
        "object-src blob:",
        "frame-src 'self' blob:",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'"
      ].join('; ')
    );
  }
  return new Response(await readFile(path), { status: 200, headers });
}

function resolveStaticPath(root: string, pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' || decoded.length === 0
    ? 'index.html'
    : decoded.replace(/^\/+/, '');
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, relative);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error('Path escapes static root');
  }
  return candidate;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

function shouldUseSpaFallback(pathname: string): boolean {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded === '/'
      || decoded.endsWith('/')
      || extname(decoded) === '';
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
