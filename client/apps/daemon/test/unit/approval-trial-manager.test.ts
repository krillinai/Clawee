import type { ProjectResponse } from '@clawee/protocol';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import { createApprovalTrialManager } from '../../src/enterprise/approval-trial-manager.js';
import type { ProjectManager } from '../../src/projects/types.js';

const skillMarkdown = '---\nname: weekly-report\ndescription: 生成周报\n---\n\n请生成周报。\n';
const packageArchive = Buffer.from(zipSync({ 'SKILL.md': strToU8(skillMarkdown) }));
const packageSha256 = createHash('sha256').update(packageArchive).digest('hex');
const detail = {
  data: {
    item: { kind: 'skill', id: 'request-1', version_id: 'version-1', business_status: 'pending' },
    skill: {
      skill: { name: 'weekly-report' },
      versions: [{ version_id: 'version-1', version: '1.0.0', package_sha256: packageSha256, local_approval: { request_id: 'request-1' } }]
    }
  }
};

let root = '';

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('ApprovalTrialManager', () => {
  it('校验项目和审批版本后，把审核包写入项目临时 Skill 目录', async () => {
    root = await mkdtemp(join(tmpdir(), 'clawee-approval-trial-'));
    const projectRoot = join(root, 'project');
    await mkdir(projectRoot, { recursive: true });
    const downloadApprovalPackage = vi.fn(async ({ destinationPath }: { destinationPath: string }) => {
      await writeFile(destinationPath, packageArchive);
      return { bytes: packageArchive.length, sha256: packageSha256 };
    });
    const project = projectResponse(projectRoot);
    const manager = createApprovalTrialManager({
      dataDir: join(root, 'data'),
      http: {
        approvalRequest: vi.fn(async () => detail),
        downloadApprovalPackage
      } as unknown as EnterpriseHttpClient,
      projects: createProjectManager(project)
    });

    const result = await manager.start({ accessToken: 'token', requestId: 'request-1', projectId: 'project-1' });

    expect(result).toMatchObject({ projectId: 'project-1', skillName: 'weekly-report', version: '1.0.0' });
    expect(downloadApprovalPackage).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'token', requestId: 'request-1', expectedSha256: packageSha256
    }));
    const trialPath = join(projectRoot, '.agents', 'skills', result.trialId);
    expect(await readFile(join(trialPath, 'SKILL.md'), 'utf8')).toBe(skillMarkdown);
    expect(await readdir(join(root, 'data'))).toHaveLength(0);
  });

  it('项目不存在时直接拒绝，且不请求审批包', async () => {
    root = await mkdtemp(join(tmpdir(), 'clawee-approval-trial-'));
    const approvalRequest = vi.fn(async () => detail);
    const manager = createApprovalTrialManager({
      dataDir: join(root, 'data'),
      http: { approvalRequest, downloadApprovalPackage: vi.fn() } as unknown as EnterpriseHttpClient,
      projects: createProjectManager()
    });

    await expect(manager.start({ accessToken: 'token', requestId: 'request-1', projectId: 'missing' }))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    expect(approvalRequest).not.toHaveBeenCalled();
  });

  it('审批版本缺少包摘要或包内容无效时拒绝写入', async () => {
    root = await mkdtemp(join(tmpdir(), 'clawee-approval-trial-'));
    const project = projectResponse(join(root, 'project'));
    const approvalRequest = vi.fn(async () => ({
      data: { ...detail.data, skill: { ...detail.data.skill!, versions: [{ ...detail.data.skill!.versions[0]!, package_sha256: undefined }] } }
    }));
    const manager = createApprovalTrialManager({
      dataDir: join(root, 'data'),
      http: { approvalRequest, downloadApprovalPackage: vi.fn() } as unknown as EnterpriseHttpClient,
      projects: createProjectManager(project)
    });
    await expect(manager.start({ accessToken: 'token', requestId: 'request-1', projectId: 'project-1' }))
      .rejects.toMatchObject({ code: 'ENTERPRISE_SKILL_PACKAGE_INVALID', statusCode: 422 });

    const invalidManager = createApprovalTrialManager({
      dataDir: join(root, 'data-invalid'),
      http: {
        approvalRequest: vi.fn(async () => detail),
        downloadApprovalPackage: vi.fn(async ({ destinationPath }: { destinationPath: string }) => {
          await mkdir(join(root, 'unused'), { recursive: true });
          await writeFile(destinationPath, Buffer.from('not a zip'));
          return { bytes: 9, sha256: packageSha256 };
        })
      } as unknown as EnterpriseHttpClient,
      projects: createProjectManager(project)
    });
    await expect(invalidManager.start({ accessToken: 'token', requestId: 'request-1', projectId: 'project-1' }))
      .rejects.toMatchObject({ code: 'ENTERPRISE_SKILL_PACKAGE_INVALID', statusCode: 422 });
    expect(existsSync(join(project.canonicalCwd!, '.agents', 'skills'))).toBe(false);
  });

  it('已结束的审批不能通过试用接口下载', async () => {
    root = await mkdtemp(join(tmpdir(), 'clawee-approval-trial-'));
    const project = projectResponse(join(root, 'project'));
    await mkdir(project.cwd, { recursive: true });
    const manager = createApprovalTrialManager({
      dataDir: join(root, 'data'),
      http: {
        approvalRequest: vi.fn(async () => ({ data: { ...detail.data, item: { ...detail.data.item, business_status: 'approved' } } })),
        downloadApprovalPackage: vi.fn()
      } as unknown as EnterpriseHttpClient,
      projects: createProjectManager(project)
    });
    await expect(manager.start({ accessToken: 'token', requestId: 'request-1', projectId: 'project-1' }))
      .rejects.toMatchObject({ code: 'ENTERPRISE_SKILL_PACKAGE_INVALID', statusCode: 422 });
  });
});

function createProjectManager(project?: ProjectResponse): ProjectManager {
  return { getProject: vi.fn(id => id === project?.id ? project : undefined) } as unknown as ProjectManager;
}

function projectResponse(cwd: string): ProjectResponse {
  return {
    id: 'project-1', name: '测试项目', cwd, canonicalCwd: cwd, directoryState: 'available', profile: 'default',
    model: null, reasoning: null, sandbox: 'follow-global', status: 'active',
    createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', archivedAt: null
  };
}
