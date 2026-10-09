import { appendFileSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, ReadStream, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../helpers/build-server.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, realpathSync: vi.fn(original.realpathSync) };
});

let server: FastifyInstance;
let tempDir = '';
let workspace = '';
let origin = '';
let threadId = '';
let growEmptyFile = false;
let emptyFileGrew = false;
const headers = { authorization: 'Bearer secret' };
const unixIt = process.platform === 'win32' ? it.skip : it;
const downloadLimit = 100 * 1024 * 1024;

beforeEach(async () => {
  growEmptyFile = false;
  emptyFileGrew = false;
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-download-'));
  workspace = join(tempDir, 'workspace');
  mkdirSync(workspace);
  server = await buildServer({ token: 'secret', dataDir: join(tempDir, 'runtime') });
  server.addHook('onSend', async (request, _reply, payload) => {
    if (growEmptyFile && request.url.startsWith('/workspace/files/download?')) {
      appendFileSync(join(workspace, 'empty.txt'), 'later');
      emptyFileGrew = true;
      const chunks: Buffer[] = [];
      for await (const chunk of payload as ReadStream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(0));
      return Buffer.concat(chunks);
    }
    return payload;
  });
  origin = await server.listen({ host: '127.0.0.1', port: 0 });
  const projectResponse = await fetch(`${origin}/projects`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: workspace, name: '下载测试' })
  });
  expect(projectResponse.status).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const threadResponse = await fetch(`${origin}/threads`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, sandbox: 'read-only' })
  });
  expect(threadResponse.status).toBe(201);
  const { thread } = await threadResponse.json() as { thread: { id: string } };
  threadId = thread.id;
});

afterEach(async () => {
  await server?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('工作区原文件下载真实 HTTP', () => {
  it('超长单段文件名沿用鉴权并返回不含服务器路径的 PATH_INVALID', async () => {
    const path = 'a'.repeat(300);
    expect((await fetch(downloadUrl(path))).status).toBe(401);
    const response = await fetch(downloadUrl(path), { headers });
    const body = await response.text();
    expect(response.status).toBe(400);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(body).not.toContain(workspace);
    expect(body).not.toContain(tempDir);
    expect(body).not.toMatch(/\/(?:private\/)?(?:var|tmp|Users|home)\/|[A-Za-z]:[\\/]/);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'PATH_INVALID', message: 'File path is too long.' } });
  });

  it('普通子目录相对路径仍可下载原始文件', async () => {
    mkdirSync(join(workspace, 'results'));
    writeFileSync(join(workspace, 'results/report.txt'), 'saved report');
    const response = await fetch(downloadUrl('results/report.txt'), { headers });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('saved report');
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength('saved report')));
  });

  it.each(['EACCES', 'EPERM'])('路径解析 %s 的真实 HTTP 响应沿用鉴权且不泄露绝对路径', async (code) => {
    const absolutePath = join(workspace, 'report.txt');
    writeFileSync(absolutePath, 'saved');
    vi.mocked(realpathSync).mockClear();
    vi.mocked(realpathSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`${code}: permission denied, '${absolutePath}'`), { code });
    });
    expect((await fetch(downloadUrl('report.txt'))).status).toBe(401);
    expect(vi.mocked(realpathSync)).not.toHaveBeenCalled();
    await expectDownloadError('report.txt', 403, 'PERMISSION_DENIED');
  });

  it('中间路径是文件时真实 HTTP 返回 404 且不泄露绝对路径', async () => {
    writeFileSync(join(workspace, 'report.txt'), 'saved');
    await expectDownloadError('report.txt/child.txt', 404, 'FILE_NOT_FOUND');
  });

  it('空文件在发送前增长仍保持真实 HTTP 空 body 与 Content-Length 一致', async () => {
    const absolutePath = join(workspace, 'empty.txt');
    writeFileSync(absolutePath, '');
    growEmptyFile = true;
    const response = await fetch(downloadUrl('empty.txt'), { headers });
    const body = Buffer.from(await response.arrayBuffer());
    expect(emptyFileGrew).toBe(true);
    expect(response.status).toBe(200);
    expect(body).toEqual(Buffer.alloc(0));
    expect(response.headers.get('content-length')).toBe(String(body.length));
  });

  it('沿用 Bearer 鉴权，下载中文文件名与原始二进制字节', async () => {
    const path = '成果 "报告" !\'()% 空格.docx';
    const bytes = Buffer.from([0, 1, 128, 255, 13, 10, 65]);
    writeFileSync(join(workspace, path), bytes);
    const url = downloadUrl(path);

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(`${url}&token=secret`)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const response = await fetch(url, { headers });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="[^"\r\n/\\]+"; filename\*=UTF-8''/);
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? '')).toBe(path);
    expect(disposition).not.toContain(workspace);
  });

  it('保留文本与 Blob 预览限制，下载不支持预览的普通成果及空文件', async () => {
    const files = [
      ['README.md', Buffer.from('# 成果\n')],
      ['note.txt', Buffer.from('文本\n')],
      ['data.json', Buffer.from('{"value":1}')],
      ['report.pdf', Buffer.from('%PDF-1.7\n')],
      ['pixel.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ['report.xlsx', Buffer.from([80, 75, 3, 4, 255])],
      ['archive.zip', Buffer.from([80, 75, 3, 4])],
      ['unknown.custom', Buffer.from([255, 0, 128])],
      ['empty.txt', Buffer.alloc(0)]
    ] as const;
    for (const [path, bytes] of files) {
      writeFileSync(join(workspace, path), bytes);
      const response = await fetch(downloadUrl(path), { headers });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    for (const path of ['README.md', 'report.xlsx']) {
      await expectFileError(`/workspace/files/blob?${new URLSearchParams({ threadId, path })}`, 422, 'UNSUPPORTED_FILE_TYPE');
    }
    for (const path of ['pixel.png', 'report.pdf']) {
      const response = await fetch(`${origin}/workspace/files/blob?${new URLSearchParams({ threadId, path })}`, { headers });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
  });

  it('read-only 与 archived 会话仍可下载已保存文件', async () => {
    writeFileSync(join(workspace, 'saved.txt'), '已保存');
    const active = await fetch(downloadUrl('saved.txt'), { headers });
    expect(active.status).toBe(200);
    expect(await active.text()).toBe('已保存');
    const archive = await fetch(`${origin}/threads/${threadId}/archive`, { method: 'POST', headers });
    expect(archive.status).toBe(200);
    await archive.json();
    const archived = await fetch(downloadUrl('saved.txt'), { headers });
    expect(archived.status).toBe(200);
    expect(await archived.text()).toBe('已保存');
  });

  it('同名工作区文件存在时真实 HTTP 拒绝 UNC 与单反斜杠根路径', async () => {
    mkdirSync(join(workspace, 'server'));
    writeFileSync(join(workspace, 'server', 'share.txt'), 'saved');
    writeFileSync(join(workspace, 'share.txt'), 'saved');
    for (const path of [String.raw`\\server\share.txt`, String.raw`\server\share.txt`, String.raw`\share.txt`]) {
      await expectDownloadError(path, 400, 'PATH_INVALID');
      for (const endpoint of ['meta', 'content', 'blob']) {
        await expectFileError(`/workspace/files/${endpoint}?${new URLSearchParams({ threadId, path })}`, 400, 'PATH_INVALID');
      }
      const response = await fetch(`${origin}/workspace/files/content`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, path, content: 'changed', baseVersionToken: 'stale', overwriteConflict: true })
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'PATH_INVALID' } });
    }
    for (const path of ['server/share.txt', String.raw`server\share.txt`]) {
      const response = await fetch(downloadUrl(path), { headers });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('saved');
    }
  });

  it('非法路径、未知会话、缺失文件和目录使用现有错误且不泄露工作区', async () => {
    mkdirSync(join(workspace, 'folder'));
    writeFileSync(join(workspace, 'gone.txt'), '已删除');
    rmSync(join(workspace, 'gone.txt'));
    const cases = [
      ['', 400, 'PATH_INVALID'],
      [join(workspace, 'file.txt'), 400, 'PATH_INVALID'],
      ['C:\\work\\file.txt', 400, 'PATH_INVALID'],
      ['../file.txt', 400, 'PATH_INVALID'],
      ['folder/../file.txt', 400, 'PATH_INVALID'],
      ['folder\\..\\file.txt', 400, 'PATH_INVALID'],
      ['nul\0.txt', 400, 'PATH_INVALID'],
      ['.git/config', 400, 'PATH_IGNORED'],
      ['gone.txt', 404, 'FILE_NOT_FOUND'],
      ['folder', 422, 'UNSUPPORTED_FILE_TYPE']
    ] as const;
    for (const [path, status, code] of cases) {
      await expectDownloadError(path, status, code);
    }
    const unknown = await fetch(downloadUrl('file.txt', 'unknown'), { headers });
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe('THREAD_NOT_FOUND');
    await expectFileError('/workspace/files/download?path=file.txt', 400, 'VALIDATION_FAILED');
    await expectFileError(`/workspace/files/download?threadId=${threadId}`, 400, 'VALIDATION_FAILED');
    rmSync(workspace, { recursive: true });
    await expectDownloadError('file.txt', 404, 'WORKSPACE_NOT_FOUND');
  });

  unixIt('拒绝敏感文件及其别名、忽略目录别名、越界链接和非普通文件', async () => {
    writeFileSync(join(workspace, '.env'), 'TOKEN=secret');
    writeFileSync(join(workspace, 'id_rsa'), 'private');
    writeFileSync(join(workspace, 'server.key'), 'private');
    symlinkSync(join(workspace, '.env'), join(workspace, 'report.txt'));
    symlinkSync(join(workspace, 'server.key'), join(workspace, 'report.png'));
    mkdirSync(join(workspace, '.git'));
    writeFileSync(join(workspace, '.git', 'config'), 'private');
    symlinkSync(join(workspace, '.git', 'config'), join(workspace, 'config.txt'));
    symlinkSync(join(workspace, '.git'), join(workspace, 'config-dir'));
    const outside = join(tempDir, 'outside.txt');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(workspace, 'escape.txt'));
    execFileSync('mkfifo', [join(workspace, 'pipe.txt')]);
    for (const path of ['.env', 'id_rsa', 'server.key', 'report.txt', 'report.png']) {
      await expectDownloadError(path, 403, 'PERMISSION_DENIED');
    }
    for (const path of ['config.txt', 'config-dir/config']) {
      await expectDownloadError(path, 400, 'PATH_IGNORED');
    }
    await expectDownloadError('escape.txt', 403, 'PATH_ESCAPE');
    await expectDownloadError('pipe.txt', 422, 'UNSUPPORTED_FILE_TYPE');
    for (const endpoint of ['meta', 'content', 'blob']) {
      await expectFileError(`/workspace/files/${endpoint}?${new URLSearchParams({ threadId, path: 'report.png' })}`, 403, 'PERMISSION_DENIED');
      await expectFileError(`/workspace/files/${endpoint}?${new URLSearchParams({ threadId, path: 'config.txt' })}`, 400, 'PATH_IGNORED');
    }
    writeFileSync(join(workspace, '.env.example'), 'TOKEN=');
    symlinkSync(join(workspace, '.env.example'), join(workspace, 'example.txt'));
    const safe = await fetch(downloadUrl('example.txt'), { headers });
    expect(safe.status).toBe(200);
    expect(await safe.text()).toBe('TOKEN=');
  });

  unixIt('仅用最后一段文件名并清理响应头控制字符', async () => {
    mkdirSync(join(workspace, 'nested'));
    const name = '报告\r\nX-Injected: yes.txt';
    writeFileSync(join(workspace, 'nested', name), 'safe');
    const response = await fetch(downloadUrl(`nested/${name}`), { headers });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('safe');
    expect(response.headers.get('x-injected')).toBeNull();
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).not.toContain('nested');
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? '')).toBe('报告__X-Injected: yes.txt');
  });

  it('超过预览限制仍可下载，100 MiB 边界可流式读取，超限返回 422', async () => {
    createSparseFile('large.txt', 3 * 1024 * 1024);
    await expectFileError(`/workspace/files/content?${new URLSearchParams({ threadId, path: 'large.txt' })}`, 422, 'FILE_TOO_LARGE');
    for (const [path, size] of [['large.txt', 3 * 1024 * 1024], ['limit.bin', downloadLimit]] as const) {
      createSparseFile(path, size);
      const response = await fetch(downloadUrl(path), { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe(String(size));
      const reader = response.body!.getReader();
      let received = 0;
      let first = -1;
      let last = -1;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (received === 0) first = chunk.value[0] ?? -1;
        received += chunk.value.length;
        last = chunk.value[chunk.value.length - 1] ?? -1;
      }
      expect(received).toBe(size);
      expect(first).toBe(65);
      expect(last).toBe(90);
    }
    createSparseFile('over.bin', downloadLimit + 1);
    const response = await fetch(downloadUrl('over.bin'), { headers });
    expect(response.status).toBe(422);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE', details: { limit: downloadLimit } } });
  });

  it('客户端中断真实 HTTP 下载后销毁并关闭服务端文件流', async () => {
    createSparseFile('cancel.bin', downloadLimit);
    const destroy = vi.spyOn(ReadStream.prototype, 'destroy');
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        get(downloadUrl('cancel.bin'), { headers, agent: false }, (response) => {
          response.once('data', () => {
            response.destroy();
            resolve(response.statusCode);
          });
          response.once('error', reject);
        }).once('error', reject);
      });
      expect(status).toBe(200);
      await expect.poll(() => destroy.mock.contexts.some((stream) =>
        stream instanceof ReadStream && stream.bytesRead > 0 && stream.bytesRead < downloadLimit && stream.closed
      )).toBe(true);
    } finally {
      destroy.mockRestore();
    }
  });
});

function downloadUrl(path: string, id = threadId): string {
  return `${origin}/workspace/files/download?${new URLSearchParams({ threadId: id, path })}`;
}

async function expectDownloadError(path: string, status: number, code: string): Promise<void> {
  await expectFileError(downloadUrl(path).slice(origin.length), status, code);
}

async function expectFileError(path: string, status: number, code: string): Promise<void> {
  const response = await fetch(`${origin}${path}`, { headers });
  expect(response.status).toBe(status);
  expect(response.headers.get('content-disposition')).toBeNull();
  const body = await response.text();
  expect(body).not.toContain(workspace);
  expect(body).not.toContain(tempDir);
  expect(body).not.toMatch(/\/(?:private\/)?(?:var|tmp|Users|home)\/|[A-Za-z]:[\\/]/);
  expect(JSON.parse(body)).toMatchObject({ error: { code } });
}

function createSparseFile(path: string, size: number): void {
  const handle = openSync(join(workspace, path), 'w');
  try {
    ftruncateSync(handle, size);
    writeSync(handle, Buffer.from('A'), 0, 1, 0);
    writeSync(handle, Buffer.from('Z'), 0, 1, size - 1);
  } finally {
    closeSync(handle);
  }
}
