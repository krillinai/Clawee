import { ENTERPRISE_SHARED_FILE_TRANSFER_TIMEOUT_MS } from '../enterprise/config-2026-07-30.js';
import { z } from 'zod';
import type { AgentScheduleApiClient } from './schedule-tools.js';

export const DRIVE_TOOL_SCOPES = [
  { name: 'clawee_drive_upload', scope: 'drive:upload' },
  { name: 'clawee_drive_download', scope: 'drive:download' }
] as const;
export type AgentDriveToolName = typeof DRIVE_TOOL_SCOPES[number]['name'];
export const sharedDriveArtifactSchema = z.object({
  space_id: z.string().min(1).max(512), file_id: z.string().min(1).max(512),
  logical_path: z.string().min(1).max(512), file_name: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255), size_bytes: z.number().int().nonnegative().safe(),
  revision: z.number().int().positive().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const driveUploadSchema = z.object({ paths: z.array(z.string().min(1)).min(1), spaceId: z.string().min(1).max(512).optional() }).strict();
export const driveDownloadSchema = z.object({ files: z.array(sharedDriveArtifactSchema).min(1) }).strict();

export function createDriveToolDefinitions(request: AgentScheduleApiClient['request']) {
  return {
    clawee_drive_upload: {
      description: '上传当前项目中的最终成果。paths 为项目内相对路径；默认省略 spaceId，自动上传到当前员工或远程任务发起员工的个人网盘。返回真实成功回执与逐文件错误。不得传用户身份、凭据、外部 URL 或文件内容。',
      inputSchema: driveUploadSchema,
      async execute(input: unknown) {
        const body = driveUploadSchema.parse(input);
        return await request({ method: 'POST', path: '/internal/agent-tools/drive/upload', body, timeoutMs: (2 * ENTERPRISE_SHARED_FILE_TRANSFER_TIMEOUT_MS + 30_000) * body.paths.length }) as Record<string, unknown>;
      }
    },
    clawee_drive_download: {
      description: '将远程任务返回的 files 清单下载到当前项目。校验每项空间、版本、大小和摘要；已有相同内容复用，不同内容报冲突并保留本地文件。使用返回的本地相对路径向用户交付。',
      inputSchema: driveDownloadSchema,
      async execute(input: unknown) {
        const body = driveDownloadSchema.parse(input);
        return await request({ method: 'POST', path: '/internal/agent-tools/drive/download', body, timeoutMs: (ENTERPRISE_SHARED_FILE_TRANSFER_TIMEOUT_MS + 30_000) * body.files.length }) as Record<string, unknown>;
      }
    }
  };
}
