import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { SharedDriveArtifact, SharedDriveTransferError, SharedDriveUploadItem } from '@clawee/protocol';
import { constants, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { ZodError } from 'zod';
import type { ThreadManager } from '../threads/types.js';
import type { EnterpriseSessionManager } from '../enterprise/session-manager-2026-07-30.js';
import type { EnterpriseSharedDriveManager } from '../enterprise/shared-drive-manager-2026-08-06.js';
import { createSharedDriveRepository } from '../storage/shared-drive.js';
import { assertRegularFile, resolveSafeExisting, validateRelativePath } from '../workspace-files/paths.js';
import { mimeFor } from '../workspace-files/mime.js';
import { AgentCapabilityTokenError, type AgentCapabilityTokenStore } from './capability-token.js';
import { readBearerToken } from './internal-routes.js';
import { driveUploadSchema, driveDownloadSchema } from './drive-tools.js';

type DriveRun = { id: string; thread_id: string; public_status: string; initiator_user_id: string | null; canonical_cwd: string };
type AgentDriveRouteInput = {
  db: Database.Database;
  capabilities: AgentCapabilityTokenStore;
  threads: Pick<ThreadManager, 'getThread'>;
  session: EnterpriseSessionManager;
  drive: EnterpriseSharedDriveManager;
  serverDeployment: boolean;
};

export type AgentDriveUploader = ReturnType<typeof createAgentDriveUploader>;

export function createAgentDriveUploader(input: Omit<AgentDriveRouteInput, 'capabilities'>) {
  const repository = createSharedDriveRepository(input.db);
  const getRun = input.db.prepare<[string], DriveRun>('SELECT id,thread_id,public_status,initiator_user_id,canonical_cwd FROM runs WHERE id=?');
  function context(runId: string, threadId?: string) {
    const run = getRun.get(runId);
    const thread = run && input.threads.getThread(run.thread_id);
    if (!run || !thread || (threadId && thread.id !== threadId) || thread.status !== 'active' || thread.purpose === 'skill_review' || thread.canonicalCwd !== run.canonical_cwd || !thread.projectId) throw new Error('DRIVE_CONTEXT_UNAVAILABLE');
    const session = input.session.getSnapshot();
    if (session.status !== 'signed_in' || !session.account?.subjectId) throw new Error('ENTERPRISE_UNAUTHORIZED');
    const identity = JSON.stringify([session.account.subjectId, session.agentId]);
    const assertIdentity = () => {
      const current = input.session.getSnapshot();
      if (current.status !== 'signed_in' || JSON.stringify([current.account?.subjectId, current.agentId]) !== identity) throw new Error('ENTERPRISE_UNAUTHORIZED');
      const latest = input.threads.getThread(thread.id);
      if (latest?.status !== 'active' || latest.canonicalCwd !== run.canonical_cwd) throw new Error('DRIVE_CONTEXT_UNAVAILABLE');
    };
    return { run, thread, assertIdentity };
  }

  async function upload(
    runId: string,
    paths: string[],
    options: { spaceId?: string; allowTerminal?: boolean; authorize?(): void } = {}
  ) {
    const ctx = context(runId);
    const allowedStatus = options.allowTerminal
      ? ['running', 'succeeded', 'failed', 'canceled'].includes(ctx.run.public_status)
      : ctx.run.public_status === 'running';
    if (!allowedStatus) throw new Error('DRIVE_CONTEXT_UNAVAILABLE');
    const items: SharedDriveUploadItem[] = paths.map(path => ({
      path,
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      logicalPath: `tasks/${runId}/${path}`,
      status: 'pending'
    }));
    repository.merge(runId, state => {
      for (const item of items) {
        const index = state.uploads.findIndex(old => old.path === item.path && old.spaceId === options.spaceId);
        if (index < 0) state.uploads.push(item);
        else state.uploads[index] = { ...item, artifact: state.uploads[index]!.artifact };
      }
    });
    for (const item of items) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        if (input.serverDeployment && !ctx.run.initiator_user_id?.trim()) throw { code: 'DRIVE_INITIATOR_MISSING' };
        const path = validateRelativePath(item.path, false);
        const root = realpathSync(ctx.thread.cwd);
        if (root !== ctx.thread.canonicalCwd) throw new Error('PATH_ESCAPE');
        const absolute = resolveSafeExisting(root, path);
        assertRegularFile(absolute);
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stats = await handle.stat();
        if (!stats.isFile() || resolveSafeExisting(root, path) !== absolute) throw new Error('PATH_ESCAPE');
        const result = await input.drive.uploadFile({
          ...(options.spaceId ? { spaceId: options.spaceId } : {}),
          ...(input.serverDeployment ? { forUserId: ctx.run.initiator_user_id! } : {}),
          logicalPath: item.logicalPath,
          contentType: mimeFor(path),
          expectedSizeBytes: stats.size,
          content: handle.createReadStream({ autoClose: false }),
          assertIdentity() { ctx.assertIdentity(); options.authorize?.(); }
        });
        item.status = 'uploaded';
        item.logicalPath = result.logicalPath;
        item.artifact = {
          space_id: result.spaceId,
          file_id: result.fileId,
          logical_path: result.logicalPath,
          file_name: result.fileName,
          content_type: result.contentType,
          size_bytes: result.sizeBytes,
          revision: result.revision,
          sha256: result.sha256
        };
      } catch (cause) {
        item.status = 'failed';
        item.error = transferError(basename(item.path), cause);
      } finally {
        await handle?.close().catch(() => undefined);
      }
      repository.merge(runId, state => {
        const index = state.uploads.findIndex(old => old.path === item.path && old.spaceId === options.spaceId);
        if (index >= 0) state.uploads[index] = { ...item, artifact: item.artifact ?? state.uploads[index]!.artifact };
      });
    }
    return {
      files: items.flatMap(item => item.artifact ? [item.artifact] : []),
      errors: items.flatMap(item => item.error ? [item.error] : [])
    };
  }

  return { repository, upload, context };
}

export async function registerAgentDriveRoutes(server: FastifyInstance, input: AgentDriveRouteInput) {
  const uploader = createAgentDriveUploader(input);
  const { repository, context } = uploader;
  async function download(runId: string, files: SharedDriveArtifact[], threadId?: string, authorize?: () => void) {
    const ctx = context(runId, threadId);
    if (ctx.thread.sandbox === 'read-only') throw new Error('DRIVE_CONTEXT_UNAVAILABLE');
    repository.merge(runId, state => {
      for (const artifact of files) {
        const key = artifactKey(artifact);
        const previous = state.downloads.find(item => artifactKey(item.artifact) === key);
        if (previous) { previous.status = 'pending'; delete previous.error; }
        else state.downloads.push({ artifact, status: 'pending' });
      }
    });
    for (const artifact of files) {
      try {
        const result = await input.drive.downloadToProject({ fileId: artifact.file_id, projectId: ctx.thread.projectId!, overwrite: false, expectedArtifact: artifact, assertIdentity() { ctx.assertIdentity(); authorize?.(); } });
        repository.merge(runId, state => {
          const item = state.downloads.find(item => artifactKey(item.artifact) === artifactKey(artifact))!;
          item.status = 'downloaded'; item.relativePath = result.relativePath; delete item.error;
        });
      } catch (cause) {
        repository.merge(runId, state => {
          const item = state.downloads.find(item => artifactKey(item.artifact) === artifactKey(artifact))!;
          if (item.status === 'downloaded') return;
          item.status = 'failed'; item.error = transferError(artifact.file_name, cause);
        });
      }
    }
    return { downloads: repository.read(runId).downloads };
  }
  for (const operation of ['upload', 'download'] as const) {
    server.post<{ Body: unknown }>(`/internal/agent-tools/drive/${operation}`, async (request, reply) => {
      try {
        const token = readBearerToken(request.headers.authorization);
        const grant = input.capabilities.authorize(token, { scope: `drive:${operation}` });
        const authorize = () => { input.capabilities.authorize(token, { scope: `drive:${operation}`, runId: grant.runId, threadId: grant.threadId }); };
        const ctx = context(grant.runId, grant.threadId);
        if (ctx.run.public_status !== 'running') throw new Error('DRIVE_CONTEXT_UNAVAILABLE');
        if (operation === 'download') return await download(grant.runId, driveDownloadSchema.parse(request.body).files, grant.threadId, authorize);
        const args = driveUploadSchema.parse(request.body);
        return await uploader.upload(grant.runId, args.paths, { spaceId: args.spaceId, authorize });
      } catch (cause) {
        const code = cause instanceof AgentCapabilityTokenError ? cause.code : cause instanceof ZodError ? 'DRIVE_INPUT_INVALID' : cause instanceof Error && ['DRIVE_INITIATOR_MISSING', 'DRIVE_CONTEXT_UNAVAILABLE', 'ENTERPRISE_UNAUTHORIZED'].includes(cause.message) ? cause.message : 'DRIVE_UNAVAILABLE';
        return reply.code(cause instanceof AgentCapabilityTokenError ? cause.statusCode : 400).send({ error: { code, message: code === 'DRIVE_INITIATOR_MISSING' ? '远程任务缺失发起员工身份，无法上传。' : '网盘操作不可用，请检查登录状态、运行和文件参数。' } });
      }
    });
  }
  server.post<{ Params: { id: string } }>('/runs/:id/shared-drive/download', async (request, reply) => {
    try {
      if (input.serverDeployment) throw new Error('DRIVE_CONTEXT_UNAVAILABLE');
      const files = repository.read(request.params.id).downloads.filter(item => item.status !== 'downloaded').map(item => item.artifact);
      return await download(request.params.id, files);
    } catch { return reply.code(409).send({ error: { code: 'DRIVE_DOWNLOAD_FAILED', message: '无法重试下载，请检查登录状态与项目目录。' } }); }
  });
}
function artifactKey(file: SharedDriveArtifact) { return JSON.stringify([file.space_id, file.file_id, file.revision, file.sha256]); }
function transferError(fileName: string, cause: unknown): SharedDriveTransferError {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'DRIVE_TRANSFER_FAILED';
  return { file_name: fileName, code, message: code === 'DRIVE_INITIATOR_MISSING' ? '远程任务缺失发起员工身份，无法上传。' : code === 'ENTERPRISE_SHARED_FILE_LOCAL_EXISTS' ? '本地文件内容不同，已保留本地文件。' : '文件传输失败，请检查文件、登录状态和网盘权限后重试。' };
}
