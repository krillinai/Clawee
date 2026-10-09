import { describe, expect, it, vi, afterEach } from 'vitest';
import type {
  WorkspaceDirectoryResponse,
  WorkspaceFileContentResponse,
  WorkspaceFileMeta,
  WorkspaceFileRevealResponse,
  WorkspaceFileSaveResponse
} from '@clawee/protocol';
import { RuntimeClient } from '../runtime/client.js';
import { createWorkspaceFileService } from './workspace-file-service.js';

const meta: WorkspaceFileMeta = {
  path: 'docs/readme.md',
  name: 'readme.md',
  type: 'file',
  kind: 'markdown',
  mime: 'text/markdown',
  size: 12,
  mtimeMs: 1,
  versionToken: 'v1',
  previewable: false,
  editable: true,
  readonly: false
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WorkspaceFileService', () => {
  it('下载普通文件时沿用 Bearer 鉴权，URL 不含 Token，返回原字节和安全文件名', async () => {
    const bytes = new Uint8Array([0, 255, 128, 42]);
    const fetchImpl = vi.fn(async () => new Response(bytes));
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:download');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    const service = createWorkspaceFileService(new RuntimeClient({
      baseUrl: 'http://runtime.test', token: 'runtime-secret', fetchImpl
    }));

    const result = await service.download('thread-1', '成果/中文 报告.zip');

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://runtime.test/workspace/files/download?threadId=thread-1&path=%E6%88%90%E6%9E%9C%2F%E4%B8%AD%E6%96%87+%E6%8A%A5%E5%91%8A.zip',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer runtime-secret' } })
    );
    expect(result).toEqual({ objectUrl: 'blob:download', fileName: '中文 报告.zip' });
    const downloadedBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(createObjectURL.mock.calls[0]![0]);
    });
    expect(new Uint8Array(downloadedBytes)).toEqual(bytes);
  });

  it('下载文件名不带目录和控制字符，也不采用响应头中的路径', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:download') });
    const service = createWorkspaceFileService(createClient({
      rawGet: vi.fn(async () => new Response('source', {
        headers: { 'content-disposition': 'attachment; filename="../../outside.txt"' }
      }))
    }));

    expect(await service.download('thread-1', '成果/报告\u0000:".txt')).toEqual({
      objectUrl: 'blob:download', fileName: '报告___.txt'
    });
  });

  it.each([401, 403, 404, 413])('下载 HTTP %s 时不创建 Blob URL', async (status) => {
    const createObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    const service = createWorkspaceFileService(new RuntimeClient({
      baseUrl: 'http://runtime.test', token: 'runtime-secret',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: { code: 'DOWNLOAD_FAILED', message: '无法下载文件' } }), { status }))
    }));

    await expect(service.download('thread-1', '报告.txt')).rejects.toMatchObject({ status, message: '无法下载文件' });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('listDirectory calls GET /workspace/files/directory', async () => {
    const getMock = vi.fn(async (_path: string) => ({
      threadId: 'thread-1',
      rootName: 'workspace',
      rootPathLabel: '/tmp/workspace',
      path: 'docs',
      truncated: false,
      warnings: [],
      nodes: []
    } satisfies WorkspaceDirectoryResponse));
    const get: ClientOverrides['get'] = (path) => getMock(path);
    const service = createWorkspaceFileService(createClient({ get }));

    await service.listDirectory('thread-1', 'docs');

    expect(getMock).toHaveBeenCalledWith('/workspace/files/directory?threadId=thread-1&path=docs');
  });

  it('openText calls GET /workspace/files/content', async () => {
    const getMock = vi.fn(async (_path: string) => ({
      meta,
      content: '# hi',
      encoding: 'utf8'
    } satisfies WorkspaceFileContentResponse));
    const get: ClientOverrides['get'] = (path) => getMock(path);
    const service = createWorkspaceFileService(createClient({ get }));

    await service.openText('thread-1', 'docs/readme.md');

    expect(getMock).toHaveBeenCalledWith('/workspace/files/content?threadId=thread-1&path=docs%2Freadme.md');
  });

  it('getMeta calls GET /workspace/files/meta', async () => {
    const getMock = vi.fn(async (_path: string) => meta);
    const get: ClientOverrides['get'] = (path) => getMock(path);
    const service = createWorkspaceFileService(createClient({ get }));

    const result = await service.getMeta('thread-1', 'docs/readme.md');

    expect(getMock).toHaveBeenCalledWith('/workspace/files/meta?threadId=thread-1&path=docs%2Freadme.md');
    expect(result).toEqual(meta);
  });

  it('saveText calls POST /workspace/files/content', async () => {
    const postMock = vi.fn(async (_path: string, _body?: unknown) => ({
      meta,
      saved: true
    } satisfies WorkspaceFileSaveResponse));
    const post: ClientOverrides['post'] = (path, body) => postMock(path, body);
    const service = createWorkspaceFileService(createClient({ post }));

    await service.saveText({
      threadId: 'thread-1',
      path: 'docs/readme.md',
      content: '# next',
      baseVersionToken: 'v1'
    });

    expect(postMock).toHaveBeenCalledWith('/workspace/files/content', {
      threadId: 'thread-1',
      path: 'docs/readme.md',
      content: '# next',
      baseVersionToken: 'v1'
    });
  });

  it('reveal calls POST /workspace/files/reveal', async () => {
    const postMock = vi.fn(async (_path: string, _body?: unknown) => ({ ok: true } satisfies WorkspaceFileRevealResponse));
    const post: ClientOverrides['post'] = (path, body) => postMock(path, body);
    const service = createWorkspaceFileService(createClient({ post }));

    await service.reveal({ threadId: 'thread-1', path: 'docs/readme.md', mode: 'file' });

    expect(postMock).toHaveBeenCalledWith('/workspace/files/reveal', {
      threadId: 'thread-1',
      path: 'docs/readme.md',
      mode: 'file'
    });
  });

  it('openBlob uses rawGet with authorization fetch semantics and creates object URL', async () => {
    const blob = new Blob(['image-bytes'], { type: 'image/png' });
    const rawGet = vi.fn(async () => new Response(blob, {
      status: 200,
      headers: { 'content-type': 'image/png' }
    }));
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL: vi.fn()
    });
    const service = createWorkspaceFileService(createClient({ rawGet }));

    const result = await service.openBlob('thread-1', 'images/demo.png');
    const expectedSize = (await new Response(blob).blob()).size;

    expect(rawGet).toHaveBeenCalledWith('/workspace/files/blob?threadId=thread-1&path=images%2Fdemo.png');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      objectUrl: 'blob:mock-url',
      mime: 'image/png',
      size: expectedSize
    });
  });

  it('revokeBlob releases object URL', () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(),
      revokeObjectURL
    });
    const service = createWorkspaceFileService(createClient({}));

    service.revokeBlob('blob:mock-url');

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

type ClientOverrides = {
  get?: (path: string) => Promise<unknown>;
  post?: (path: string, body?: unknown) => Promise<unknown>;
  rawGet?: (path: string) => Promise<Response>;
};

function createClient(overrides: ClientOverrides): RuntimeClient {
  return {
    get<T>(path: string): Promise<T> {
      if (overrides.get === undefined) throw new Error(`Unexpected get: ${path}`);
      return overrides.get(path) as Promise<T>;
    },
    post<T>(path: string, body?: unknown): Promise<T> {
      if (overrides.post === undefined) throw new Error(`Unexpected post: ${path}`);
      return overrides.post(path, body) as Promise<T>;
    },
    rawGet(path: string): Promise<Response> {
      if (overrides.rawGet === undefined) throw new Error(`Unexpected rawGet: ${path}`);
      return overrides.rawGet(path);
    }
  } as RuntimeClient;
}
