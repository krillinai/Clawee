import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTaskMcpRoutes } from '../../src/api/routes.task-mcp.js';
import type { TaskMcpService } from '../../src/task-mcp/service.js';

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('task MCP routes', () => {
  it('仅从请求头读取可选的发起身份，不通过工具参数传入', async () => {
    const submit = vi.fn(async () => ({
      taskId: 'run_1', threadId: 'thread_1', projectId: 'project_1',
      projectName: '测试项目', status: 'queued' as const
    }));
    const service = { submit } as unknown as TaskMcpService;
    const server = Fastify();
    await registerTaskMcpRoutes(server, { service });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    client = new Client({ name: 'caller-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { 'X-Claw-User-ID': 'user_1', 'X-Claw-Agent-ID': 'agent_1' } }
      }));
      await client.callTool({ name: 'clawee_submit_task', arguments: { prompt: '执行任务' } });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        prompt: '执行任务', initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
      }));
      await client.callTool({
        name: 'clawee_submit_task', arguments: { prompt: '修改原图', thread_id: 'thread_1' }
      });
      expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
        prompt: '修改原图', threadId: 'thread_1', initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
      }));
      const invalid = await client.callTool({
        name: 'clawee_submit_task', arguments: { prompt: '执行任务', user_id: 'forged' }
      });
      expect(invalid.isError).toBe(true);
      expect(submit).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      client = undefined;
      await server.close();
    }
  });

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
