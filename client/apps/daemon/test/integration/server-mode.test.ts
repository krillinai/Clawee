import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer } from '../helpers/build-server.js';
import {
  MCP_CHAIN_TIMEOUT_MS,
  MCP_TASK_MAX_EXECUTION_MS,
  MCP_TOOL_TIMEOUT_SEC
} from '../../src/task-mcp/constants.js';
import { createFakeCodex } from '../helpers/fake-codex.js';

let tempDir = '';
let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Server Mode', () => {
  it('refuses a server deployment without protected app-server execution', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-server-mode-'));

    await expect(buildServer({
      token: 'fixed-token',
      dataDir: join(tempDir, 'data'),
      serverDeployment: true,
      taskMcpEnabled: true
    })).rejects.toThrow('SERVER_MODE_APP_SERVER_REQUIRED');
  });

  it('serves runtime config, static assets, and frontend route fallback', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-server-mode-'));
    const webDistDir = join(tempDir, 'web');
    mkdirSync(join(webDistDir, 'assets'), { recursive: true });
    writeFileSync(join(webDistDir, 'index.html'), '<main>Clawee Server</main>');
    writeFileSync(join(webDistDir, 'assets', 'app.js'), 'globalThis.clawee = true;');
    writeFileSync(join(webDistDir, 'projects'), 'must not shadow the API route');
    server = await buildServer({
      token: 'fixed-token',
      dataDir: join(tempDir, 'data'),
      defaultProjectRoot: join(tempDir, 'projects'),
      webDistDir,
      taskMcpEnabled: true
    });

    const config = await server.inject({
      method: 'GET',
      url: '/.clawee/runtime-config'
    });
    const route = await server.inject({ method: 'GET', url: '/settings/models' });
    const root = await server.inject({ method: 'GET', url: '/' });
    const asset = await server.inject({ method: 'GET', url: '/assets/app.js' });
    const protectedApi = await server.inject({ method: 'GET', url: '/projects' });
    const unsupportedMcp = await server.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: 'Bearer fixed-token' }
    });

    expect(config.statusCode).toBe(200);
    expect(config.headers['cache-control']).toBe('no-store');
    expect(config.json()).toEqual({ baseUrl: '', token: 'fixed-token' });
    expect(route.body).toContain('Clawee Server');
    expect(root.body).toContain('Clawee Server');
    expect(asset.body).toBe('globalThis.clawee = true;');
    expect(protectedApi.statusCode).toBe(401);
    expect(unsupportedMcp.statusCode).toBe(405);
    expect(server.server.requestTimeout).toBe(MCP_CHAIN_TIMEOUT_MS);
    expect(MCP_TASK_MAX_EXECUTION_MS).toBe(7_200_000);
    expect(MCP_CHAIN_TIMEOUT_MS).toBe(7_500_000);
    expect(MCP_TOOL_TIMEOUT_SEC).toBe(7_500);
    expect(MCP_CHAIN_TIMEOUT_MS).toBeGreaterThan(MCP_TASK_MAX_EXECUTION_MS);
  });

  it('fails clearly when the Web build is missing', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-server-mode-'));
    await expect(buildServer({
      token: 'fixed-token',
      dataDir: join(tempDir, 'data'),
      webDistDir: join(tempDir, 'missing')
    })).rejects.toThrow('SERVER_MODE_WEB_DIST_MISSING');
  });

  it('exposes the authenticated stateless MCP endpoint without buffering headers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-server-mode-'));
    server = await buildServer({
      token: 'fixed-token',
      dataDir: join(tempDir, 'data'),
      defaultProjectRoot: join(tempDir, 'projects'),
      taskMcpEnabled: true
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const responseHeaders: Headers[] = [];
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: {
        headers: { Authorization: 'Bearer fixed-token' }
      },
      async fetch(url, init) {
        const response = await globalThis.fetch(url, init);
        responseHeaders.push(response.headers);
        return response;
      }
    });
    const mcpClient = new Client({ name: 'server-mode-test', version: '1.0.0' });
    try {
      await mcpClient.connect(transport);
      expect((await mcpClient.listTools()).tools.map(tool => tool.name)).toEqual([
        'clawee_submit_task',
        'clawee_get_task',
        'clawee_get_task_result'
      ]);
      expect(responseHeaders.length).toBeGreaterThan(0);
      for (const headers of responseHeaders) {
        expect(headers.get('cache-control')).toBe('no-cache, no-transform');
        expect(headers.get('x-accel-buffering')).toBe('no');
      }
    } finally {
      await mcpClient.close();
    }
  });

  it('submits and recovers a task through the real HTTP task service', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-server-mode-'));
    const fake = createFakeCodex(tempDir, {
      stdoutLines: [
        { type: 'thread.started', thread_id: 'codex-thread-mcp' },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: '远端任务完成' }
        },
        { type: 'turn.completed' }
      ],
      lineDelayMs: 100
    });
    server = await buildServer({
      token: 'fixed-token',
      dataDir: join(tempDir, 'data'),
      defaultProjectRoot: join(tempDir, 'projects'),
      codexBin: fake.bin,
      codexHome: join(tempDir, 'codex-home'),
      taskMcpEnabled: true
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const defaultProjectResponse = await fetch(new URL('/projects/default', address), {
      method: 'POST',
      headers: { Authorization: 'Bearer fixed-token' }
    });
    expect(defaultProjectResponse.status).toBe(200);
    const defaultProjectPayload = await defaultProjectResponse.json() as {
      project: { id: string; name: string };
    };
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: {
        headers: { Authorization: 'Bearer fixed-token' }
      }
    });
    const mcpClient = new Client({ name: 'server-mode-task-test', version: '1.0.0' });
    try {
      await mcpClient.connect(transport);
      const submitted = await mcpClient.callTool({
        name: 'clawee_submit_task',
        arguments: {
          prompt: '执行远端任务',
          project_name: defaultProjectPayload.project.name
        }
      });
      const result = submitted.structuredContent as {
        task_id: string;
        thread_id: string;
        project_id: string;
        project_name: string;
        status: string;
      } | undefined;
      if (result === undefined) {
        throw new Error(`Unexpected submit result: ${JSON.stringify(submitted)}`);
      }

      expect(result).toMatchObject({
        task_id: expect.stringMatching(/^run_/),
        thread_id: expect.stringMatching(/^thread_/),
        project_id: defaultProjectPayload.project.id,
        project_name: defaultProjectPayload.project.name,
        status: 'running'
      });

      let recovered: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await mcpClient.callTool({
          name: 'clawee_get_task_result',
          arguments: { task_id: result.task_id }
        });
        recovered = response.structuredContent as Record<string, unknown> | undefined;
        if (recovered?.ready === true) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(recovered).toMatchObject({
        ready: true,
        task_id: result.task_id,
        status: 'succeeded',
        result: '远端任务完成'
      });

      const task = await mcpClient.callTool({
        name: 'clawee_get_task',
        arguments: { task_id: result.task_id, after_seq: 0 }
      });
      expect(task.structuredContent).toMatchObject({
        task_id: result.task_id,
        thread_id: result.thread_id,
        status: 'succeeded',
        result_available: true
      });
    } finally {
      await mcpClient.close();
    }
  });
});
