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
  it('registers three tools and returns the task identity immediately', async () => {
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
      'clawee_get_task_result'
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      properties: {
        project_id: { type: 'string' },
        project_name: { type: 'string' }
      }
    });
    expect(tools[0]?.description).toBe(
      '提交 Clawee 项目任务并立即返回任务 ID；随后使用查询工具获取状态和结果'
    );
    expect(result.structuredContent).toEqual({
      task_id: 'run_1',
      thread_id: 'thread_1',
      project_id: 'project_1',
      project_name: '测试项目',
      status: 'queued'
    });
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

});

async function connect(service: TaskMcpService) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = createTaskMcpServer({ service });
  client = new Client({ name: 'task-mcp-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}
