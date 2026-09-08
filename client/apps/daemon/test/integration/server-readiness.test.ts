import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../helpers/build-server.js';
import {
  assertRequiredTaskTools,
  checkServerReadiness
} from '../../src/server-mode/readiness.js';

let tempDir = '';
let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Server readiness', () => {
  it('checks health, Web, Runtime API, MCP tools, and Runtime status', async () => {
    const address = await startServer();

    await expect(checkServerReadiness({
      address,
      token: 'readiness-token'
    })).resolves.toEqual({
      health: 'ok',
      web: 'ok',
      runtimeApi: 'ok',
      mcp: 'ok',
      codexRuntime: 'ok'
    });
  });

  it('reports a stable code when Runtime config disagrees', async () => {
    const address = await startServer();

    await expect(checkServerReadiness({
      address,
      token: 'wrong-token'
    })).rejects.toThrow('SERVER_RUNTIME_CONFIG_CHECK_FAILED');
  });

  it('reports a stable code when the authenticated Runtime API rejects access', async () => {
    const fetch: typeof globalThis.fetch = async input => {
      const url = input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/') {
        return new Response('<!doctype html>', {
          headers: { 'content-type': 'text/html' }
        });
      }
      if (url.pathname === '/.clawee/runtime-config') {
        return Response.json({ baseUrl: '', token: 'readiness-token' });
      }
      if (url.pathname === '/projects') return new Response(null, { status: 401 });
      return new Response(null, { status: 200 });
    };

    const check = checkServerReadiness({
      address: 'http://127.0.0.1:19860',
      token: 'readiness-token',
      fetch
    });

    await expect(check).rejects.toThrow('SERVER_RUNTIME_API_CHECK_FAILED');
    await expect(check).rejects.not.toThrow('readiness-token');
  });

  it('reports MCP initialization failure and allows the port to be rebound after close', async () => {
    const address = await startServer({ taskMcpEnabled: false });

    await expect(checkServerReadiness({
      address,
      token: 'readiness-token'
    })).rejects.toThrow('SERVER_MCP_INITIALIZE_FAILED');

    await server?.close();
    server = undefined;
    await expectPortBindable(address);
  });

  it('requires exactly the three task MCP tools', () => {
    expect(() => assertRequiredTaskTools([
      'clawee_submit_task',
      'clawee_get_task'
    ])).toThrow('SERVER_MCP_TOOLS_CHECK_FAILED');
    expect(() => assertRequiredTaskTools([
      'clawee_submit_task',
      'clawee_get_task',
      'clawee_get_task_result',
      'unexpected_tool'
    ])).toThrow('SERVER_MCP_TOOLS_CHECK_FAILED');
  });
});

async function startServer(options: {
  taskMcpEnabled?: boolean;
} = {}): Promise<string> {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-readiness-'));
  const webDistDir = join(tempDir, 'web');
  mkdirSync(webDistDir, { recursive: true });
  writeFileSync(join(webDistDir, 'index.html'), '<!doctype html><title>Clawee</title>');
  server = await buildServer({
    token: 'readiness-token',
    dataDir: join(tempDir, 'data'),
    defaultProjectRoot: join(tempDir, 'projects'),
    webDistDir,
    taskMcpEnabled: options.taskMcpEnabled ?? true
  });
  return server.listen({ host: '127.0.0.1', port: 0 });
}

function expectPortBindable(address: string): Promise<void> {
  const port = Number(new URL(address).port);
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      probe.close(error => error === undefined ? resolvePromise() : reject(error));
    });
  });
}
