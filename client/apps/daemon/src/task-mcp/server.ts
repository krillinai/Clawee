import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TaskMcpServiceError,
  type TaskMcpService
} from './service.js';

const submitTaskInput = z.object({
  prompt: z.string().trim().min(1),
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
}): McpServer {
  const server = new McpServer({
    name: 'clawee-task-service',
    version: '0.1.0'
  });

  server.registerTool('clawee_submit_task', {
    description: '提交 Clawee 项目任务并立即返回任务 ID；随后使用查询工具获取状态和结果',
    inputSchema: submitTaskInput
  }, async args => {
    try {
      const accepted = await input.service.submit({
        prompt: args.prompt,
        projectId: args.project_id,
        projectName: args.project_name
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
      const result = input.service.getTaskResult(args.task_id);
      return jsonToolResult(result);
    } catch (error) {
      return toolError(error);
    }
  });

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
