import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskMcpServer } from '../../src/task-mcp/server.js';
import {
  TaskMcpServiceError,
  type TaskMcpService
} from '../../src/task-mcp/service.js';

let client: Client | undefined;
let server: ReturnType<typeof createTaskMcpServer> | undefined;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

describe('task MCP server', () => {
  it('registers task and health tools and returns the task identity immediately', async () => {
    const service = {
      async submit() {
        return {
          taskId: 'run_1',
          threadId: 'thread_1',
          projectId: 'project_1',
          projectName: '测试项目',
          status: 'queued' as const
        };
      }
    } as unknown as TaskMcpService;
    await connect(service);

    const result = await client!.callTool({
      name: 'clawee_submit_task',
      arguments: { prompt: '执行任务' }
    });

    const tools = (await client!.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual([
      'clawee_submit_task',
      'clawee_get_task',
      'clawee_get_task_result',
      'clawee_get_agent_health'
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      properties: {
        thread_id: { type: 'string' },
        project_id: { type: 'string' },
        project_name: { type: 'string' }
      }
    });
    expect(tools[0]?.description).toContain('复用原会话并返回新的 task_id');
    expect(result.structuredContent).toEqual({
      task_id: 'run_1',
      thread_id: 'thread_1',
      project_id: 'project_1',
      project_name: '测试项目',
      status: 'queued'
    });
  });

  it('提供只读健康查询，不提交任务或返回凭据', async () => {
    await connect({
      getHealth: () => ({ runtime: 'ready', model: 'configuration_required' })
    } as unknown as TaskMcpService);
    const result = await client!.callTool({ name: 'clawee_get_agent_health', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ runtime: 'ready', model: 'configuration_required' });
    const health = (await client!.listTools()).tools.find(tool => tool.name === 'clawee_get_agent_health');
    expect(health?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('accepts project_name and forwards both project selectors', async () => {
    let received: unknown;
    const service = {
      async submit(input: unknown) {
        received = input;
        throw new TaskMcpServiceError(
          'PROJECT_NAME_AMBIGUOUS',
          'Multiple active projects have this name; use project_id to select one',
          {
            candidates: [{
              project_id: 'project_1',
              project_name: '测试项目',
              cwd: '/workspace/test'
            }]
          }
        );
      }
    } as unknown as TaskMcpService;
    await connect(service);

    const result = await client!.callTool({
      name: 'clawee_submit_task',
      arguments: {
        prompt: '执行任务',
        project_id: 'project_1',
        project_name: '测试项目'
      }
    });

    expect(received).toEqual({
      prompt: '执行任务',
      projectId: 'project_1',
      projectName: '测试项目'
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(
      ((result.content as Array<{ type: string; text: string }>)[0]!).text
    )).toEqual({
      error: {
        code: 'PROJECT_NAME_AMBIGUOUS',
        message: 'Multiple active projects have this name; use project_id to select one',
        details: {
          candidates: [{
            project_id: 'project_1',
            project_name: '测试项目',
            cwd: '/workspace/test'
          }]
        }
      }
    });
  });

  it('returns a structured tool error for unknown tasks', async () => {
    const service = {
      getTask() {
        throw new TaskMcpServiceError('TASK_NOT_FOUND', 'Task not found');
      }
    } as unknown as TaskMcpService;
    await connect(service);

    const result = await client!.callTool({
      name: 'clawee_get_task',
      arguments: { task_id: 'missing' }
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'text',
      text: JSON.stringify({
        error: { code: 'TASK_NOT_FOUND', message: 'Task not found' }
      })
    });
  });

  it('将续聊会话与调用者身份传入服务，拒绝空会话 ID 和伪造身份参数', async () => {
    const received: unknown[] = [];
    await connect({
      async submit(input: unknown) {
        received.push(input);
        return {
          taskId: 'run_2', threadId: 'thread_1', projectId: 'project_1',
          projectName: '测试项目', status: 'queued'
        };
      }
    } as unknown as TaskMcpService, { userId: 'user_1', agentId: 'agent_1' });

    const result = await client!.callTool({
      name: 'clawee_submit_task', arguments: { prompt: '修改原图', thread_id: ' thread_1 ' }
    });
    expect(received).toEqual([expect.objectContaining({
      prompt: '修改原图', threadId: 'thread_1', initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
    })]);
    expect(result.structuredContent).toMatchObject({ task_id: 'run_2', thread_id: 'thread_1' });
    for (const args of [{ thread_id: ' ' }, { thread_id: 'thread_1', initiatorUserId: 'forged' }]) {
      const invalid = await client!.callTool({
        name: 'clawee_submit_task', arguments: { prompt: '修改原图', ...args }
      });
      expect(invalid.isError).toBe(true);
    }
    expect(received).toHaveLength(1);
  });

});

async function connect(service: TaskMcpService, caller?: { userId?: string; agentId?: string }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = createTaskMcpServer({ service, caller });
  client = new Client({ name: 'task-mcp-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}
