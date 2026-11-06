import type { ProjectResponse } from '@clawee/protocol';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EnterpriseHttpClient,
  EnterpriseRemoteSharedFile
} from '../../src/enterprise/http-client-2026-07-30.js';
import {
  EnterpriseHttpError
} from '../../src/enterprise/http-client-2026-07-30.js';
import {
  createEnterpriseSharedDriveManager
} from '../../src/enterprise/shared-drive-manager-2026-08-06.js';
import type {
  EnterpriseSessionManager
} from '../../src/enterprise/session-manager-2026-07-30.js';
import type { ProjectManager } from '../../src/projects/types.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = '';
});

describe('enterprise shared drive manager', () => {
  it('并行取回新目录中的成果，复用相同内容并保留冲突文件', async () => {
    tempDir = createTempDirectory();
    const projectDir = join(tempDir, 'project');
    mkdirSync(projectDir);
    const content = Buffer.from('delivered result');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const artifacts = ['a.txt', 'b.txt'].map(fileName => ({ space_id: 'space_1', file_id: fileName, logical_path: `tasks/remote/${fileName}`, file_name: fileName, content_type: 'text/plain', revision: 1, sha256, size_bytes: content.length }));
    const downloadSharedFileContent = vi.fn(async input => {
      writeFileSync(input.destinationPath, content);
      return { bytes: content.length, sha256, revision: 1, contentType: 'text/plain' };
    });
    const manager = createManager({ project: projectResponse(projectDir), getSharedFileDetail: vi.fn(async (_token, fileId) => {
      const artifact = artifacts.find(file => file.file_id === fileId)!;
      return sharedFile({ fileId, logicalPath: artifact.logical_path, fileName: artifact.file_name, sizeBytes: content.length, sha256, revision: 1 });
    }), downloadSharedFileContent });
    await Promise.all(artifacts.map(expectedArtifact => manager.downloadToProject({ fileId: expectedArtifact.file_id, projectId: 'project_1', overwrite: false, expectedArtifact })));
    for (const artifact of artifacts) expect(readFileSync(join(projectDir, artifact.logical_path))).toEqual(content);
    const request = { fileId: artifacts[0]!.file_id, projectId: 'project_1', overwrite: false, expectedArtifact: artifacts[0]! };
    await expect(manager.downloadToProject(request)).resolves.toMatchObject({ overwritten: false, sha256 });
    expect(downloadSharedFileContent).toHaveBeenCalledTimes(2);
    const target = join(projectDir, artifacts[0]!.logical_path);
    writeFileSync(target, 'local change');
    await expect(manager.downloadToProject(request)).rejects.toMatchObject({ code: 'ENTERPRISE_SHARED_FILE_LOCAL_EXISTS' });
    expect(readFileSync(target, 'utf8')).toBe('local change');
  });

  it('stages explicitly delivered workflow attachments and cleans up on identity changes', async () => {
    tempDir = createTempDirectory();
    const content = Buffer.from('workflow attachment');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const artifact = { file_id: 'file_1', logical_path: 'instances/i/nodes/n/sub/attachments/report.txt', revision: 1, sha256 };
    let stagedPath = '';
    const uploadWorkflowFile = vi.fn(async input => {
      stagedPath = input.filePath;
      expect(readFileSync(stagedPath)).toEqual(content);
      expect(input).toMatchObject({ accessToken: 'enterprise-token', taskId: 'task_1', idempotencyKey: 'submission', fileName: 'report.txt', sizeBytes: content.length, sha256 });
      return artifact;
    });
    const manager = createManager({ uploadWorkflowFile });
    const request = { taskId: 'task_1', idempotencyKey: 'submission', fileName: 'report.txt', expectedSizeBytes: content.length, content: chunks(content), assertIdentity: vi.fn() };
    await expect(manager.uploadWorkflowFile!(request)).resolves.toEqual(artifact);
    expect(existsSync(stagedPath)).toBe(false);
    const changedIdentity = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('identity changed'); });
    await expect(manager.uploadWorkflowFile!({ ...request, content: chunks(content), assertIdentity: changedIdentity })).rejects.toThrow('identity changed');
    expect(uploadWorkflowFile).toHaveBeenCalledOnce();
  });

  it.each(['metadata', 'download', 'identity'] as const)('rejects workflow %s changes without replacing the local file', async change => {
    tempDir = createTempDirectory();
    const projectDir = join(tempDir, 'project');
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    const targetPath = join(projectDir, 'docs/design.md');
    writeFileSync(targetPath, 'local version');
    const content = Buffer.from('formal result');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const expectedArtifact = { file_id: 'file_1', logical_path: 'docs/design.md', revision: 3, sha256 };
    const downloadSharedFileContent = vi.fn(async input => {
      writeFileSync(input.destinationPath, content);
      return { bytes: content.length, sha256, revision: change === 'download' ? 4 : 3, contentType: 'text/markdown' };
    });
    const assertIdentity = vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => {
      if (change === 'identity') throw new Error('identity changed');
    });
    const manager = createManager({ project: projectResponse(projectDir), getSharedFileDetail: vi.fn(async () => sharedFile({ sha256, revision: change === 'metadata' ? 4 : 3 })), downloadSharedFileContent });
    await expect(manager.downloadToProject({ fileId: 'file_1', projectId: 'project_1', overwrite: true, expectedArtifact, assertIdentity })).rejects.toMatchObject({ code: change === 'identity' ? 'ENTERPRISE_SHARED_FILE_LOCAL_WRITE_FAILED' : 'ENTERPRISE_SHARED_FILE_REVISION_CONFLICT' });
    expect(readFileSync(targetPath, 'utf8')).toBe('local version');
    expect(downloadSharedFileContent).toHaveBeenCalledTimes(change === 'metadata' ? 0 : 1);
  });

  it('reads preview using the enterprise session without writing project files', async () => {
    tempDir = createTempDirectory();
    const content = Buffer.from('# design');
    const getSharedFilePreview = vi.fn(async () => ({ content, contentType: 'text/plain' }));
    const manager = createManager({ getSharedFilePreview });
    const signal = new AbortController().signal;
    await expect(manager.getFilePreview('file_1', signal)).resolves.toEqual({ content, contentType: 'text/plain' });
    expect(getSharedFilePreview).toHaveBeenCalledWith('enterprise-token', 'file_1', signal);
    expect(existsSync(join(tempDir, 'enterprise-shared-drive'))).toBe(false);
  });
  it('returns paginated spaces and files with refresh metadata', async () => {
    tempDir = createTempDirectory();
    const listSharedSpaces = vi.fn(async () => ({
      spaces: [sharedSpace()],
      meta: {
        nextCursor: 'space-next',
        hasNext: true,
        maxFileSizeBytes: 1024
      }
    }));
    const listSharedFiles = vi.fn(async () => ({
      files: [sharedFile()],
      meta: { nextCursor: 'file-next', hasNext: true }
    }));
    const manager = createManager({
      listSharedSpaces,
      listSharedFiles,
      now: () => new Date('2026-08-06T08:00:00.000Z')
    });

    await expect(manager.listSpaces({
      limit: 50,
      cursor: 'space-cursor'
    })).resolves.toEqual({
      spaces: [sharedSpace()],
      meta: {
        nextCursor: 'space-next',
        hasNext: true,
        maxFileSizeBytes: 1024
      },
      refreshedAt: '2026-08-06T08:00:00.000Z'
    });
    await expect(manager.listFiles({
      spaceId: ' space_1 ',
      query: ' design ',
      logicalPathPrefix: 'docs/',
      limit: 100,
      cursor: 'file-cursor'
    })).resolves.toEqual({
      files: [sharedFile()],
      meta: { nextCursor: 'file-next', hasNext: true },
      refreshedAt: '2026-08-06T08:00:00.000Z'
    });
    expect(listSharedSpaces).toHaveBeenCalledWith('enterprise-token', {
      limit: 50,
      cursor: 'space-cursor'
    });
    expect(listSharedFiles).toHaveBeenCalledWith({
      accessToken: 'enterprise-token',
      spaceId: 'space_1',
      query: 'design',
      logicalPathPrefix: 'docs/',
      limit: 100,
      cursor: 'file-cursor'
    });
  });

  it('stages upload bytes privately and forwards the computed digest once', async () => {
    tempDir = createTempDirectory();
    const content = Buffer.from('shared design');
    const sha256 = createHash('sha256').update(content).digest('hex');
    let stagedPath = '';
    const uploadSharedFileContent = vi.fn(async input => {
      stagedPath = input.filePath;
      expect(readFileSync(input.filePath)).toEqual(content);
      expect(input).toMatchObject({
        accessToken: 'enterprise-token',
        spaceId: 'space_1',
        logicalPath: 'docs/design.md',
        expectedRevision: 3,
        sizeBytes: content.byteLength,
        sha256,
        contentType: 'text/markdown'
      });
      return {
        fileId: 'file_1',
        spaceId: 'space_1',
        logicalPath: 'docs/design.md',
        fileName: 'design.md',
        sizeBytes: content.byteLength,
        sha256,
        contentType: 'text/markdown',
        revision: 4,
        created: false,
        updatedAt: '2026-08-06T08:01:00Z'
      };
    });
    const manager = createManager({ uploadSharedFileContent });

    await expect(manager.uploadFile({
      spaceId: 'space_1',
      logicalPath: 'docs/design.md',
      expectedRevision: 3,
      contentType: 'text/markdown',
      expectedSizeBytes: content.byteLength,
      content: chunks(content.subarray(0, 5), content.subarray(5))
    })).resolves.toMatchObject({
      fileId: 'file_1',
      revision: 4,
      created: false
    });
    expect(uploadSharedFileContent).toHaveBeenCalledOnce();
    expect(existsSync(stagedPath)).toBe(false);
  });

  it('reconciles an unknown create by exact path and digest without retrying upload', async () => {
    tempDir = createTempDirectory();
    const content = Buffer.from('new shared file');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const uploadSharedFileContent = vi.fn(async () => {
      throw new EnterpriseHttpError(
        'ENTERPRISE_SERVICE_UNAVAILABLE',
        'request'
      );
    });
    const listSharedFiles = vi.fn()
      .mockResolvedValueOnce({
        files: [
          sharedFile({
            fileId: 'file_prefix_only',
            logicalPath: 'docs/design.md.bak',
            sha256
          })
        ],
        meta: { nextCursor: 'page-2', hasNext: true }
      })
      .mockResolvedValueOnce({
        files: [
          sharedFile({
            logicalPath: 'docs/design.md',
            sha256,
            sizeBytes: content.byteLength
          })
        ],
        meta: { nextCursor: '', hasNext: false }
      });
    const manager = createManager({
      uploadSharedFileContent,
      listSharedFiles
    });

    await expect(manager.uploadFile({
      spaceId: 'space_1',
      logicalPath: 'docs/design.md',
      contentType: 'text/markdown',
      expectedSizeBytes: content.byteLength,
      content: chunks(content)
    })).resolves.toMatchObject({
      fileId: 'file_1',
      logicalPath: 'docs/design.md',
      sha256,
      created: true,
      reconciled: true
    });
    expect(uploadSharedFileContent).toHaveBeenCalledOnce();
    expect(listSharedFiles).toHaveBeenNthCalledWith(1, {
      accessToken: 'enterprise-token',
      spaceId: 'space_1',
      logicalPathPrefix: 'docs/design.md',
      limit: 100
    });
    expect(listSharedFiles).toHaveBeenNthCalledWith(2, {
      accessToken: 'enterprise-token',
      spaceId: 'space_1',
      logicalPathPrefix: 'docs/design.md',
      limit: 100,
      cursor: 'page-2'
    });
  });

  it.each(['digest', 'size'])('reports an existing remote path when unknown create reconciliation finds another %s', async mismatch => {
    tempDir = createTempDirectory();
    const content = Buffer.from('new shared file');
    const manager = createManager({
      uploadSharedFileContent: vi.fn(async () => {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'request'
        );
      }),
      listSharedFiles: vi.fn(async () => ({
        files: [
          sharedFile({
            logicalPath: 'docs/design.md',
            sha256: mismatch === 'digest' ? 'f'.repeat(64) : createHash('sha256').update(content).digest('hex'),
            sizeBytes: content.length + 1
          })
        ],
        meta: { nextCursor: '', hasNext: false }
      }))
    });

    await expect(manager.uploadFile({
      spaceId: 'space_1',
      logicalPath: 'docs/design.md',
      contentType: 'text/markdown',
      expectedSizeBytes: content.byteLength,
      content: chunks(content)
    })).rejects.toMatchObject({
      code: 'ENTERPRISE_SHARED_FILE_ALREADY_EXISTS',
      statusCode: 409
    });
  });

  it('requires explicit overwrite before replacing a project file', async () => {
    tempDir = createTempDirectory();
    const projectDir = join(tempDir, 'project');
    const targetPath = join(projectDir, 'docs', 'design.md');
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeFileSync(targetPath, 'local version');
    const content = Buffer.from('remote version');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const downloadSharedFileContent = vi.fn(async input => {
      writeFileSync(input.destinationPath, content);
      return {
        bytes: content.byteLength,
        sha256,
        revision: 3,
        contentType: 'text/markdown'
      };
    });
    const manager = createManager({
      project: projectResponse(projectDir),
      getSharedFileDetail: vi.fn(async () => sharedFile()),
      downloadSharedFileContent
    });

    await expect(manager.downloadToProject({
      fileId: 'file_1',
      projectId: 'project_1',
      overwrite: false
    })).rejects.toMatchObject({
      code: 'ENTERPRISE_SHARED_FILE_LOCAL_EXISTS',
      statusCode: 409,
      details: { relativePath: 'docs/design.md' }
    });
    expect(downloadSharedFileContent).not.toHaveBeenCalled();

    await expect(manager.downloadToProject({
      fileId: 'file_1',
      projectId: 'project_1',
      overwrite: true
    })).resolves.toEqual({
      fileId: 'file_1',
      projectId: 'project_1',
      relativePath: 'docs/design.md',
      sizeBytes: content.byteLength,
      sha256,
      revision: 3,
      overwritten: true
    });
    expect(readFileSync(targetPath)).toEqual(content);
  });

  it('rejects ignored and symlinked project paths before downloading bytes', async () => {
    tempDir = createTempDirectory();
    const projectDir = join(tempDir, 'project');
    const outsideDir = join(tempDir, 'outside');
    mkdirSync(projectDir);
    mkdirSync(outsideDir);
    symlinkSync(
      outsideDir,
      join(projectDir, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const downloadSharedFileContent = vi.fn();
    const getSharedFileDetail = vi.fn()
      .mockResolvedValueOnce(sharedFile({ logicalPath: '.git/config' }))
      .mockResolvedValueOnce(sharedFile({ logicalPath: 'linked/secret.txt' }));
    const manager = createManager({
      project: projectResponse(projectDir),
      getSharedFileDetail,
      downloadSharedFileContent
    });

    await expect(manager.downloadToProject({
      fileId: 'file_1',
      projectId: 'project_1',
      overwrite: false
    })).rejects.toMatchObject({ code: 'PATH_IGNORED', statusCode: 403 });
    await expect(manager.downloadToProject({
      fileId: 'file_1',
      projectId: 'project_1',
      overwrite: false
    })).rejects.toMatchObject({ code: 'PATH_ESCAPE', statusCode: 403 });
    expect(downloadSharedFileContent).not.toHaveBeenCalled();
  });
});

function createManager(
  overrides: Partial<EnterpriseHttpClient> & {
    now?: () => Date;
    project?: ProjectResponse;
  } = {}
) {
  const { now, project, ...httpOverrides } = overrides;
  return createEnterpriseSharedDriveManager({
    dataDir: tempDir,
    sessionManager: createSessionManager(),
    httpClient: createHttpClient(httpOverrides),
    projectManager: createProjectManager(project),
    ...(now === undefined ? {} : { now })
  });
}

function createSessionManager(): EnterpriseSessionManager {
  return {
    startRestore: vi.fn(),
    getSnapshot: vi.fn(() => ({
      status: 'signed_in' as const,
      account: {
        subjectId: 'acct_01JZ8W6A2M4S',
        email: 'member@example.com',
        name: 'Member'
      },
      transportSecurity: 'secure_https' as const
    })),
    refresh: vi.fn(),
    renew: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    requireAccessToken: vi.fn(async () => 'enterprise-token'),
    invalidateUnauthorized: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
}

function createHttpClient(
  overrides: Partial<EnterpriseHttpClient> = {}
): EnterpriseHttpClient {
  return {
    register: vi.fn(),
    login: vi.fn(),
    getMe: vi.fn(),
    logout: vi.fn(),
    revealAccountMcpToken: vi.fn(),
    getMcpCatalog: vi.fn(),
    listKnowledgeBases: vi.fn(async () => ({
      knowledgeBases: [],
      meta: { nextCursor: '', hasNext: false }
    })),
    listKnowledgeDocuments: vi.fn(async () => ({
      documents: [],
      meta: { nextCursor: '', hasNext: false }
    })),
    uploadKnowledgeDocument: vi.fn(),
    listSharedSpaces: vi.fn(async () => ({
      spaces: [sharedSpace()],
      meta: {
        nextCursor: '',
        hasNext: false,
        maxFileSizeBytes: 1024 * 1024 * 1024
      }
    })),
    listSharedFiles: vi.fn(async () => ({
      files: [sharedFile()],
      meta: { nextCursor: '', hasNext: false }
    })),
    getSharedFileDetail: vi.fn(async () => sharedFile()),
    downloadSharedFileContent: vi.fn(),
    uploadSharedFileContent: vi.fn(),
    listSkills: vi.fn(async () => []),
    listSkillSpaces: vi.fn(),
    uploadSkillVersion: vi.fn(),
    getSkillDetail: vi.fn(),
    downloadSkillPackage: vi.fn(),
    ...overrides
  };
}

function createProjectManager(project?: ProjectResponse): ProjectManager {
  return {
    getProject: vi.fn(id => (
      id === project?.id ? project : undefined
    ))
  } as unknown as ProjectManager;
}

function projectResponse(cwd: string): ProjectResponse {
  return {
    id: 'project_1',
    name: '当前项目',
    cwd,
    canonicalCwd: realpathSync(cwd),
    directoryState: 'available',
    profile: 'default',
    model: null,
    reasoning: null,
    sandbox: 'follow-global',
    status: 'active',
    createdAt: '2026-08-06T07:00:00.000Z',
    updatedAt: '2026-08-06T07:00:00.000Z',
    archivedAt: null
  };
}

function sharedSpace() {
  return {
    spaceId: 'space_1',
    name: '设计资料',
    description: '团队设计文件',
    updatedAt: '2026-08-06T07:30:00Z',
    permissions: { read: true, write: false }
  };
}

function sharedFile(
  overrides: Partial<EnterpriseRemoteSharedFile> = {}
): EnterpriseRemoteSharedFile {
  return {
    fileId: 'file_1',
    spaceId: 'space_1',
    spaceName: '设计资料',
    logicalPath: 'docs/design.md',
    fileName: 'design.md',
    sizeBytes: 13,
    sha256: 'a'.repeat(64),
    contentType: 'text/markdown',
    revision: 3,
    updatedByUserId: 'usr_1',
    updatedByAgentId: 'agent_1',
    updatedAt: '2026-08-06T07:45:00Z',
    ...overrides
  };
}

async function* chunks(
  ...values: Uint8Array[]
): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

function createTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'clawee-shared-drive-manager-'));
}
