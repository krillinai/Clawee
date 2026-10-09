import { once } from 'node:events';
import { appendFileSync, closeSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeThread } from '../../src/threads/types.js';
import { createWorkspaceFileService } from '../../src/workspace-files/service.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    lstatSync: vi.fn(original.lstatSync),
    readFileSync: vi.fn(original.readFileSync),
    realpathSync: vi.fn(original.realpathSync)
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, createHash: vi.fn(original.createHash) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

let tempDir = '';
let thread: RuntimeThread;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-download-unit-'));
  thread = {
    id: 'thread_1',
    title: '下载测试',
    projectId: 'project_1',
    enterpriseSubjectId: null,
    origin: 'clawee_created',
    cwd: tempDir,
    canonicalCwd: realpathSync(tempDir),
    workspaceMode: 'external',
    profile: 'default',
    sandbox: 'read-only',
    status: 'archived',
    purpose: 'conversation',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z'
  };
  vi.clearAllMocks();
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('工作区下载流', () => {
  it.each([
    ['工作区解析', 'EACCES'],
    ['工作区解析', 'EPERM'],
    ['文件路径解析', 'EACCES'],
    ['文件路径解析', 'EPERM'],
    ['普通文件检查', 'EACCES'],
    ['普通文件检查', 'EPERM']
  ])('%s 的 %s 返回安全的权限错误', async (stage, code) => {
    const absolutePath = join(thread.canonicalCwd, 'report.txt');
    writeFileSync(absolutePath, 'saved');
    const error = Object.assign(new Error(`${code}: permission denied, '${absolutePath}'`), { code });
    if (stage === '普通文件检查') {
      vi.mocked(lstatSync).mockImplementationOnce(() => { throw error; });
    } else {
      if (stage === '文件路径解析') vi.mocked(realpathSync).mockReturnValueOnce(thread.canonicalCwd);
      vi.mocked(realpathSync).mockImplementationOnce(() => { throw error; });
    }

    await expect(createService().download({ threadId: thread.id, path: 'report.txt' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED', statusCode: 403, message: 'File is not readable.'
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('中间路径是普通文件时返回安全的文件不存在错误', async () => {
    writeFileSync(join(tempDir, 'report.txt'), 'saved');
    await expect(createService().download({ threadId: thread.id, path: 'report.txt/child.txt' })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND', statusCode: 404, message: 'File not found.'
    });
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['EACCES', 'PERMISSION_DENIED', 403, 'File is not readable.'],
    ['EPERM', 'PERMISSION_DENIED', 403, 'File is not readable.'],
    ['ENOTDIR', 'FILE_NOT_FOUND', 404, 'File not found.']
  ])('打开阶段的 %s 返回既有安全错误', async (code, expectedCode, statusCode, message) => {
    const absolutePath = join(thread.canonicalCwd, 'report.txt');
    writeFileSync(absolutePath, 'saved');
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error(`${code}: '${absolutePath}'`), { code }));
    await expect(createService().download({ threadId: thread.id, path: 'report.txt' })).rejects.toMatchObject({
      code: expectedCode, statusCode, message
    });
  });

  it('不同步读取全文件或计算摘要，并在流结束时关闭句柄', async () => {
    const bytes = Buffer.from([0, 128, 255, 13, 10]);
    writeFileSync(join(tempDir, 'report.docx'), bytes);
    const result = await createService().download({ threadId: thread.id, path: 'report.docx' });
    const handle = await vi.mocked(open).mock.results[0]!.value;
    const closed = once(result.stream, 'close');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(chunk as Buffer);
    await closed;

    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(result.name).toBe('report.docx');
    expect(result.size).toBe(bytes.length);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(createHash).not.toHaveBeenCalled();
    expect(handle.fd).toBe(-1);
  });

  it('超限在发送前拒绝，不读取内容且关闭已打开的句柄', async () => {
    const handle = openSync(join(tempDir, 'large.bin'), 'w');
    ftruncateSync(handle, 100 * 1024 * 1024 + 1);
    closeSync(handle);

    await expect(createService().download({ threadId: thread.id, path: 'large.bin' })).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE', statusCode: 422
    });
    const opened = await vi.mocked(open).mock.results[0]!.value;
    expect(opened.fd).toBe(-1);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(createHash).not.toHaveBeenCalled();
  });

  it('文件增长时仅传输已验证的大小', async () => {
    writeFileSync(join(tempDir, 'growing.txt'), 'saved');
    const result = await createService().download({ threadId: thread.id, path: 'growing.txt' });
    appendFileSync(join(tempDir, 'growing.txt'), 'extra');
    const chunks: Buffer[] = [];
    const closed = once(result.stream, 'close');
    for await (const chunk of result.stream) chunks.push(chunk as Buffer);
    await closed;
    expect(Buffer.concat(chunks).toString()).toBe('saved');
    expect(result.size).toBe(5);
  });

  it('空文件验证后增长仍返回空内容并关闭句柄', async () => {
    writeFileSync(join(tempDir, 'empty.txt'), '');
    const result = await createService().download({ threadId: thread.id, path: 'empty.txt' });
    const handle = await vi.mocked(open).mock.results[0]!.value;
    const closedBeforeReading = handle.fd === -1;
    appendFileSync(join(tempDir, 'empty.txt'), 'later');
    const chunks: Buffer[] = [];
    const closed = once(result.stream, 'close');
    for await (const chunk of result.stream) chunks.push(chunk as Buffer);
    await closed;

    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(0));
    expect(result.size).toBe(0);
    expect(closedBeforeReading).toBe(true);
    expect(handle.fd).toBe(-1);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(createHash).not.toHaveBeenCalled();
  });

  it('销毁未消费的流会关闭句柄', async () => {
    writeFileSync(join(tempDir, 'report.zip'), 'saved');
    const result = await createService().download({ threadId: thread.id, path: 'report.zip' });
    const handle = await vi.mocked(open).mock.results[0]!.value;
    const closed = once(result.stream, 'close');
    result.stream.destroy();
    await closed;
    expect(handle.fd).toBe(-1);
  });
});

function createService() {
  return createWorkspaceFileService({ getThread: (id) => id === thread.id ? thread : undefined });
}
