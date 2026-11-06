import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TaskMcpServiceError,
  type TaskMcpService
} from './service.js';

const submitTaskInput = z.object({
  prompt: z.string().trim().min(1),
  thread_id: z.string().trim().min(1).optional()
    .describe('继续修改原任务时，传入同一服务端 Agent 先前返回的 thread_id；独立任务省略'),
  project_id: z.string().trim().min(1).optional()
    .describe('Clawee 项目 ID'),
  project_name: z.string().trim().min(1).optional()
    .describe('Clawee 项目名称；与活动项目精确匹配')
}).strict();

const getTaskInput = z.object({
  task_id: z.string().trim().min(1),
  after_seq: z.number().int().nonnegative().optional()
}).strict();

const getTaskResultInput = z.object({
  task_id: z.string().trim().min(1)
}).strict();

export function createTaskMcpServer(input: {
  service: TaskMcpService;
  caller?: { userId?: string; agentId?: string };
}): McpServer {
  const server = new McpServer({
    name: 'clawee-task-service',
    version: '0.1.0'
  });

  server.registerTool('clawee_submit_task', {
    description: '提交 Clawee 项目任务并立即返回任务 ID；继续修改原任务时携带先前返回的 thread_id，复用原会话并返回新的 task_id；独立任务省略 thread_id。随后使用查询工具获取本轮状态和结果；续聊失败不得自动新建会话',
    inputSchema: submitTaskInput
  }, async args => {
    try {
      const accepted = await input.service.submit({
        prompt: args.prompt,
        ...(args.thread_id === undefined ? {} : { threadId: args.thread_id }),
        projectId: args.project_id,
        projectName: args.project_name,
        ...(input.caller?.userId === undefined ? {} : { initiatorUserId: input.caller.userId }),
        ...(input.caller?.agentId === undefined ? {} : { initiatorAgentId: input.caller.agentId })
      });
      return jsonToolResult({
        task_id: accepted.taskId,
        thread_id: accepted.threadId,
        project_id: accepted.projectId,
        project_name: accepted.projectName,
        status: accepted.status
      });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('clawee_get_task', {
    description: '查询 Clawee 任务状态和持久化事件',
    inputSchema: getTaskInput
  }, async args => {
    try {
      const result = input.service.getTask(args.task_id, args.after_seq ?? 0);
      return jsonToolResult(result);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('clawee_get_task_result', {
    description: '查询 Clawee 任务终态结果',
    inputSchema: getTaskResultInput
  }, async args => {
    try {
      const result = await input.service.getTaskResult(args.task_id);
      return jsonToolResult(result);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('clawee_get_agent_health', {
    description: '只读检查服务端 Agent 的 Runtime 和模型配置准备状态；不调用模型，不执行任务',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => jsonToolResult(input.service.getHealth()));

  return server;
}

function jsonToolResult(result: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result
  };
}

function toolError(error: unknown) {
  const payload = error instanceof TaskMcpServiceError
    ? {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      }
    : { error: { code: 'TASK_SERVICE_ERROR', message: 'Clawee task service failed' } };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }]
  };
}
