import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeFetch } from '../src/main/runtime-fetch.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('Node HTTP Runtime fetch', () => {
  it('forwards a buffered request and preserves an SSE response', async () => {
    const url = await listen((request, response) => {
      expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe('Bearer runtime-token');
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        expect(body).toBe('{"prompt":"hello"}');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: ready\n\n');
      });
    });

    const result = await runtimeFetch(`${url}/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer runtime-token' },
      body: '{"prompt":"hello"}'
    });

    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('text/event-stream');
    expect(await result.text()).toBe('data: ready\n\n');
  });

  it.each([
    ['204 response', 'DELETE', 204],
    ['205 response', 'GET', 205],
    ['304 response', 'GET', 304],
    ['HEAD response', 'HEAD', 200]
  ] as const)('%s has no response body', async (_label, method, status) => {
    const url = await listen((_request, response) => {
      response.writeHead(status);
      response.end();
    });

    const result = await runtimeFetch(`${url}/sessions/hello`, { method });

    expect(result.status).toBe(status);
    expect(result.body).toBeNull();
    expect(await result.text()).toBe('');
  });

  it('aborts a pending request and closes the Node socket', async () => {
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const url = await listen((request, response) => {
      closePromise = new Promise<void>(resolve => {
        request.once('close', () => {
          closed = true;
          resolve();
        });
      });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: waiting\n\n');
    });
    const controller = new AbortController();
    const result = await runtimeFetch(`${url}/events`, { signal: controller.signal });
    const reader = result.body!.getReader();
    await reader.read();
    controller.abort('closed by caller');
    await expect(reader.read()).rejects.toThrow('closed by caller');
    if (!closePromise) throw new Error('request close listener was not installed');
    await closePromise;
    expect(closed).toBe(true);
  });

  it('surfaces an upstream socket interruption through the response stream', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: partial\n\n');
      setImmediate(() => response.socket?.destroy(new Error('upstream disconnected')));
    });
    const result = await runtimeFetch(`${url}/events`);
    const reader = result.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow();
  });
});
