import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerTaskMcpRoutes } from '../../src/api/routes.task-mcp.js';
import type { TaskMcpService } from '../../src/task-mcp/service.js';

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('task MCP routes', () => {
  it('returns an accepted task without holding the HTTP request open', async () => {
    const service = {
      async submit() {
        return {
          taskId: 'run_1',
          threadId: 'thread_1',
          projectId: 'project_1',
          projectName: '测试项目',
          status: 'running' as const
        };
      },
      subscribe() {
        throw new Error('submit must not subscribe to task events');
      }
    } as unknown as TaskMcpService;
    const server = Fastify();
    await registerTaskMcpRoutes(server, { service });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    client = new Client({ name: 'shutdown-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)));

    try {
      const result = await client.callTool({
        name: 'clawee_submit_task',
        arguments: { prompt: '保持运行' }
      }, undefined, { timeout: 1_000 });
      expect(result.structuredContent).toEqual({
        task_id: 'run_1',
        thread_id: 'thread_1',
        project_id: 'project_1',
        project_name: '测试项目',
        status: 'running'
      });
    } finally {
      await client.close();
      client = undefined;
      await server.close();
    }
  });
});
