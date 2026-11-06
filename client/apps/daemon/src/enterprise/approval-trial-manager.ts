import type { RuntimeErrorCode } from '@clawee/protocol';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { ProjectManager } from '../projects/types.js';
import {
  EnterpriseHttpError,
  type EnterpriseHttpClient
} from './http-client-2026-07-30.js';
import { extractEnterpriseSkillPackage } from './skill-package-2026-07-30.js';

const TRIAL_TTL_MS = 2 * 60 * 60 * 1000;
const SKILL_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type ApprovalTrial = {
  trialId: string;
  projectId: string;
  skillName: string;
  version: string;
  expiresAt: string;
};

export class ApprovalTrialError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'ApprovalTrialError';
  }
}

export type ApprovalTrialManager = {
  start(input: {
    accessToken: string;
    requestId: string;
    projectId: string;
  }): Promise<ApprovalTrial>;
};

type ApprovalDetailResponse = {
  data: {
    item: { kind: string; id: string; version_id?: string; business_status?: string };
    skill?: {
      skill: { name: string };
      versions: Array<{
        version_id: string;
        version: string;
        package_sha256?: string;
        local_approval?: { request_id?: string };
      }>;
    };
  };
};

export function createApprovalTrialManager(input: {
  dataDir: string;
  http: EnterpriseHttpClient;
  projects: ProjectManager;
}): ApprovalTrialManager {
  const active = new Map<string, { path: string; timer: NodeJS.Timeout }>();

  return {
    async start(request) {
      if (input.http.approvalRequest === undefined || input.http.downloadApprovalPackage === undefined) {
        throw new ApprovalTrialError('ENTERPRISE_SERVICE_UNAVAILABLE', 503, '试用服务暂不可用');
      }
      const project = input.projects.getProject(request.projectId);
      if (project === undefined) {
        throw new ApprovalTrialError('PROJECT_NOT_FOUND', 404, '试用项目不存在');
      }
      if (project.status !== 'active' || project.directoryState !== 'available') {
        throw new ApprovalTrialError('PROJECT_DIRECTORY_UNAVAILABLE', 409, '试用项目目录不可用');
      }

      const detail = await input.http.approvalRequest(
        request.accessToken,
        'GET',
        `/api/v1/app/approvals/skill/${encodeURIComponent(request.requestId)}`
      ) as ApprovalDetailResponse;
      const version = detail.data.skill?.versions.find(candidate =>
        candidate.version_id === detail.data.item.version_id
        && candidate.local_approval?.request_id === request.requestId
      );
      const skillName = detail.data.skill?.skill.name;
      if (
        detail.data.item.kind !== 'skill'
        || detail.data.item.id !== request.requestId
        || detail.data.item.business_status !== 'pending'
        || skillName === undefined
        || version === undefined
        || version.package_sha256 === undefined
        || !SKILL_ID_PATTERN.test(skillName)
        || !/^[a-f0-9]{64}$/.test(version.package_sha256)
      ) {
        throw new ApprovalTrialError('ENTERPRISE_SKILL_PACKAGE_INVALID', 422, '审核版本材料不可用于试用');
      }

      await mkdir(input.dataDir, { recursive: true, mode: 0o700 });
      const workDir = await mkdtemp(join(input.dataDir, 'approval-trial-'));
      const archivePath = join(workDir, 'package.zip');
      const extractionPath = join(workDir, 'extracted');
      const trialId = `clawee-approval-trial-${nanoid(10)}`;
      const projectRoot = resolve(project.canonicalCwd ?? project.cwd);
      const targetPath = join(projectRoot, '.agents', 'skills', trialId);
      let targetCreated = false;
      try {
        await input.http.downloadApprovalPackage({
          accessToken: request.accessToken,
          requestId: request.requestId,
          expectedSha256: version.package_sha256,
          destinationPath: archivePath
        });
        const extracted = await extractEnterpriseSkillPackage({
          archivePath,
          extractionPath,
          expectedName: skillName
        });
        await stat(projectRoot);
        await mkdir(join(projectRoot, '.agents', 'skills'), { recursive: true, mode: 0o700 });
        // Create the destination first so a failed recursive copy can be cleaned
        // up without ever touching a pre-existing directory.
        await mkdir(targetPath, { mode: 0o700 });
        targetCreated = true;
        await cp(extracted.sourcePath, targetPath, { recursive: true, force: false });
        const expiresAt = new Date(Date.now() + TRIAL_TTL_MS).toISOString();
        const timer = setTimeout(() => {
          void removeTrial(targetPath, trialId);
        }, TRIAL_TTL_MS);
        timer.unref?.();
        active.set(trialId, { path: targetPath, timer });
        return { trialId, projectId: project.id, skillName, version: version.version, expiresAt };
      } catch (error) {
        if (targetCreated) await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof ApprovalTrialError || error instanceof EnterpriseHttpError) throw error;
        const code = error instanceof Error && error.message.startsWith('ENTERPRISE_SKILL_PACKAGE_INVALID:')
          ? 'ENTERPRISE_SKILL_PACKAGE_INVALID'
          : 'ENTERPRISE_SKILL_INSTALL_FAILED';
        throw new ApprovalTrialError(code, code === 'ENTERPRISE_SKILL_PACKAGE_INVALID' ? 422 : 500, code === 'ENTERPRISE_SKILL_PACKAGE_INVALID' ? '审核版本材料不可用于试用' : '试用 Skill 写入项目失败');
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };

  async function removeTrial(path: string, trialId: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    const record = active.get(trialId);
    if (record?.path === path) active.delete(trialId);
  }
}
