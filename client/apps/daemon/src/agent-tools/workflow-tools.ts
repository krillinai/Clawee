import { z } from 'zod';
import type { AgentScheduleApiClient } from './schedule-tools.js';

export type AgentWorkflowToolName = 'clawee_workflow_upload_file' | 'clawee_workflow_read_file';
export const WORKFLOW_TOOL_SCOPES = [
  { name: 'clawee_workflow_upload_file', scope: 'workflow:upload' },
  { name: 'clawee_workflow_read_file', scope: 'workflow:read' }
] as const;

export function createWorkflowToolDefinitions(request: AgentScheduleApiClient['request']) {
  const uploadSchema = z.object({ path: z.string().min(1) }).strict();
  const readSchema = z.object({ fileId: z.string().min(1) }).strict();
  return {
    clawee_workflow_upload_file: {
      description: '登记当前工作流节点的本地待交付附件，不会上传；仅在用户确认完成节点后上传。path 必须是当前项目内的相对文件路径，不接受账户、空间或外部 URL。',
      inputSchema: uploadSchema,
      async execute(input: unknown) {
        return await request({ method: 'POST', path: '/internal/agent-tools/workflow/files/upload', body: uploadSchema.parse(input) }) as Record<string, unknown>;
      }
    },
    clawee_workflow_read_file: {
      description: '将当前工作流共享上下文中的文件下载到当前项目；校验正式提交的版本与摘要。',
      inputSchema: readSchema,
      async execute(input: unknown) {
        return await request({ method: 'POST', path: '/internal/agent-tools/workflow/files/read', body: readSchema.parse(input) }) as Record<string, unknown>;
      }
    }
  };
}
