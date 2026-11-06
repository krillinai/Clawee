import { z } from 'zod';
import type { AgentScheduleApiClient } from './schedule-tools.js';

export const SKILL_TOOL_SCOPES = [
  { name: 'clawee_skill_list_spaces', scope: 'skill:list_spaces' },
  { name: 'clawee_skill_upload', scope: 'skill:upload' }
] as const;
export type AgentSkillToolName = typeof SKILL_TOOL_SCOPES[number]['name'];
export const SKILL_UPLOAD_TIMEOUT_MS = 6 * 60_000;

export const skillUploadSchema = z.object({
  directory: z.string().trim().min(1),
  spaceId: z.string().trim().min(1),
  version: z.string().trim().min(1),
  changelog: z.string().trim().default('')
}).strict();

export function createSkillToolDefinitions(request: AgentScheduleApiClient['request']) {
  const listSchema = z.object({}).strict();
  return {
    clawee_skill_list_spaces: {
      description: '查询当前账号可上传 Skill 的技能空间。创建或试用 Skill 后，可询问用户是否上传。上传前展示空间名称、技能与版本，并等待用户明确确认目标空间及版本；即使只有一个空间也必须确认，不得默认选择。',
      inputSchema: listSchema,
      async execute(input: unknown) {
        listSchema.parse(input);
        return await request({ method: 'GET', path: '/internal/agent-tools/skills/spaces' }) as Record<string, unknown>;
      }
    },
    clawee_skill_upload: {
      description: '由客户端读取指定 Skill 目录、创建 ZIP 并上传到已确认的技能空间。必须先查询可写空间，展示技能、目标空间和版本，等待用户明确确认后再调用；一个空间也要确认。directory 是当前项目下的路径或当前 CODEX_HOME/skills 下的用户技能目录，根目录须含 SKILL.md。不传文件内容或凭据。上传不等于审核通过或发布；超时或结果未知时先在企业 Skills 核对，不得盲目重试。',
      inputSchema: skillUploadSchema,
      async execute(input: unknown) {
        return await request({ method: 'POST', path: '/internal/agent-tools/skills/upload', body: skillUploadSchema.parse(input), timeoutMs: SKILL_UPLOAD_TIMEOUT_MS }) as Record<string, unknown>;
      }
    }
  };
}
