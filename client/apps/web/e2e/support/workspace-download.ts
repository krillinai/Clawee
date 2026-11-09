import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { previewPdfFixture } from './shared-file-preview.js';

export type WorkspaceDownloadArtifact = {
  path: string;
  label: string;
  kind: 'markdown' | 'text' | 'json' | 'binary' | 'image' | 'pdf';
  bytes: Buffer;
};

export type WorkspaceFileRequest = {
  method: string;
  origin: string;
  pathname: string;
  threadId: string | null;
  path: string | null;
  queryKeys: string[];
  hasBearer: boolean;
};

export function createWorkspaceDownloadArtifacts(): WorkspaceDownloadArtifact[] {
  return [
    {
      path: '成果 输出/任务 摘要.md',
      label: '打开 Markdown 成果',
      kind: 'markdown',
      bytes: Buffer.from('# 服务端成果摘要\r\n\r\n这是已保存的 Markdown 原文件。\r\n')
    },
    {
      path: '成果 输出/原始 文本.txt',
      label: '打开文本成果',
      kind: 'text',
      bytes: Buffer.from('\ufeff服务端文本原文件\r\n中文、空格与 CRLF 均应原样保留。\r\n')
    },
    {
      path: '成果 输出/数据 汇总.json',
      label: '打开 JSON 成果',
      kind: 'json',
      bytes: Buffer.from('{ "来源": "受控 Runtime", "数量": 2 }\r\n')
    },
    {
      path: '成果 输出/普通 数据.zip',
      label: '打开普通二进制成果',
      kind: 'binary',
      bytes: Buffer.from('UEsDBBQAAAgAAAAAPl1tgXdcGAAAABgAAAARAAAA57uT5p6cIOaVsOaNri5iaW4A/4ABDQrkuK3mlofljp/lp4vlrZfoioJQSwECFAMUAAAIAAAAAD5dbYF3XBgAAAAYAAAAEQAAAAAAAAAAAAAAgAEAAAAA57uT5p6cIOaVsOaNri5iaW5QSwUGAAAAAAEAAQA/AAAARwAAAAAA', 'base64')
    },
    {
      path: '成果 输出/预览 图片.png',
      label: '打开图片成果',
      kind: 'image',
      bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64')
    },
    {
      path: '成果 输出/预览 文档.pdf',
      label: '打开 PDF 成果',
      kind: 'pdf',
      bytes: previewPdfFixture()
    }
  ];
}

export function observeWorkspaceFileRequests(page: Page): WorkspaceFileRequest[] {
  const requests: WorkspaceFileRequest[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.includes('/workspace/files/')) return;
    requests.push({
      method: request.method(),
      origin: url.origin,
      pathname: url.pathname,
      threadId: url.searchParams.get('threadId'),
      path: url.searchParams.get('path'),
      queryKeys: [...url.searchParams.keys()].sort(),
      hasBearer: /^Bearer \S+$/.test(request.headers().authorization ?? '')
    });
  });
  return requests;
}

export async function expectWorkspaceDownload(input: {
  page: Page;
  threadId: string;
  workspace: string;
  artifact: Pick<WorkspaceDownloadArtifact, 'path' | 'bytes'>;
  saveDirectory: string;
  requireBearer?: boolean;
}): Promise<void> {
  const { page, artifact } = input;
  const sourcePath = resolve(input.workspace, artifact.path);
  const saveDirectory = resolve(input.saveDirectory);
  expect(saveDirectory).not.toBe(resolve(input.workspace));
  expect(saveDirectory.startsWith(`${resolve(input.workspace)}${sep}`)).toBe(false);
  mkdirSync(saveDirectory, { recursive: true });
  const button = page.getByRole('button', { name: '下载文件', exact: true });
  await expect(button).toBeEnabled();
  const completed = Promise.all([
    page.waitForEvent('download'),
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/workspace/files/download')
        && url.searchParams.get('threadId') === input.threadId
        && url.searchParams.get('path') === artifact.path;
    })
  ]);
  await button.click();
  const [download, response] = await completed;
  const request = response.request();
  const url = new URL(request.url());
  expect(request.method()).toBe('GET');
  expect(url.origin).toBe(new URL(page.url()).origin);
  expect([...url.searchParams.keys()].sort()).toEqual(['path', 'threadId']);
  expect(url.searchParams.get('path')).toBe(artifact.path);
  expect(url.searchParams.get('threadId')).toBe(input.threadId);
  if (input.requireBearer !== false) {
    expect(/^Bearer \S+$/.test(await request.headerValue('authorization') ?? '')).toBe(true);
  }
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/octet-stream');
  expect(response.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(download.url()).toMatch(/^blob:/);
  expect(download.suggestedFilename()).toBe(basename(artifact.path));
  const savedPath = join(saveDirectory, download.suggestedFilename());
  expect(savedPath).not.toBe(sourcePath);
  await download.saveAs(savedPath);
  expect(await download.failure()).toBeNull();
  const sourceBytes = readFileSync(sourcePath);
  const savedBytes = readFileSync(savedPath);
  expect(sourceBytes.equals(artifact.bytes), '受控服务工作区保留预期源文件字节').toBe(true);
  expect(savedBytes.equals(sourceBytes), '客户端下载副本与服务工作区原文件字节完全相同').toBe(true);
}
