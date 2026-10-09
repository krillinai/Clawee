import { basename } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type RuntimeFixture } from './fixtures/runtime.js';
import { expectPdfPreviewLoaded } from './support/shared-file-preview.js';
import {
  createWorkspaceDownloadArtifacts,
  expectWorkspaceDownload,
  observeWorkspaceFileRequests,
  type WorkspaceDownloadArtifact
} from './support/workspace-download.js';

test.use({ channel: 'chromium', acceptDownloads: true });

test('服务工作区绝对路径成果可预览并下载原字节，浏览器不调用系统打开', async ({
  page,
  runtime
}, testInfo) => {
  test.setTimeout(120_000);
  const artifacts = createWorkspaceDownloadArtifacts();
  configureArtifacts(runtime, artifacts);
  const requests = observeWorkspaceFileRequests(page);
  await runtime.openApp(page);
  const threadId = await sendArtifactTask(page, '生成服务端预览与下载成果');

  for (const artifact of artifacts) {
    await test.step(`预览并下载 ${basename(artifact.path)}`, async () => {
      const link = page.getByRole('link', { name: artifact.label, exact: true });
      await expect(link).toBeVisible();
      expect(decodeURI(await link.getAttribute('href') ?? ''))
        .toBe(`${runtime.projectDir}/${artifact.path}`);
      await link.click();
      await expect(page.locator('.file-top-bar-title strong')).toHaveText(basename(artifact.path));
      const toolbar = page.locator('.file-top-bar');
      await expect(toolbar.getByRole('button', { name: '打开文件', exact: true })).toHaveCount(0);
      await expect(toolbar.getByRole('button', { name: /在系统中打开/ })).toHaveCount(0);

      if (artifact.kind === 'markdown') {
        await page.getByRole('button', { name: '预览', exact: true }).click();
        await expect(page.locator('.file-preview').getByRole('heading', { name: '服务端成果摘要' }))
          .toBeVisible();
      } else if (artifact.kind === 'text' || artifact.kind === 'json') {
        await page.getByRole('button', { name: '预览', exact: true }).click();
        await expect(page.locator('.file-preview')).toContainText(
          artifact.kind === 'text' ? '服务端文本原文件' : '受控 Runtime'
        );
      } else if (artifact.kind === 'binary') {
        await expect(page.getByText('暂不支持预览此文件', { exact: true })).toBeVisible();
        await expect(page.locator('.file-preview')).toHaveCount(0);
      } else if (artifact.kind === 'image') {
        const image = page.locator('.file-preview').getByRole('img', { name: basename(artifact.path) });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate(element => (
          element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
        ))).toBe(true);
      } else {
        await expect(page.getByTitle(`${basename(artifact.path)} PDF 预览`)).toBeVisible();
        if (testInfo.project.name === 'chromium-desktop') await expectPdfPreviewLoaded(page);
      }

      await expectWorkspaceDownload({
        page,
        threadId,
        workspace: runtime.projectDir,
        artifact,
        saveDirectory: testInfo.outputPath('客户端下载副本'),
        requireBearer: false
      });
      await page.getByRole('button', { name: '关闭文件工作区', exact: true }).click();
    });
  }

  expect(requests.filter(request => request.pathname.endsWith('/download'))).toHaveLength(artifacts.length);
  expect(requests.filter(request => request.pathname.endsWith('/download')).map(request => request.path))
    .toEqual(artifacts.map(artifact => artifact.path));
  expect(requests.filter(request => request.pathname.endsWith('/reveal'))).toEqual([]);
  expect(requests.filter(request => request.pathname.endsWith('/download')).every(request => (
    request.method === 'GET'
    && request.origin === runtime.origin
    && request.threadId === threadId
    && request.queryKeys.join(',') === 'path,threadId'
  ))).toBe(true);
});

test('未保存 Markdown 草稿不自动保存，下载仍是服务工作区原文件', async ({
  page,
  runtime
}, testInfo) => {
  const artifact = createWorkspaceDownloadArtifacts().find(file => file.kind === 'markdown')!;
  configureArtifacts(runtime, [artifact]);
  const requests = observeWorkspaceFileRequests(page);
  await runtime.openApp(page);
  const threadId = await sendArtifactTask(page, '生成可编辑 Markdown 成果');
  await page.getByRole('link', { name: artifact.label, exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const draft = '# 未保存的客户端草稿\n不能作为下载内容。';
  await page.getByRole('textbox', { name: `${artifact.path} 编辑器`, exact: true }).fill(draft);
  await expect(page.locator('.dirty-indicator')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '下载文件', exact: true }))
    .toHaveAttribute('title', /已保存|原文件|草稿/);

  await expectWorkspaceDownload({
    page,
    threadId,
    workspace: runtime.projectDir,
    artifact,
    saveDirectory: testInfo.outputPath('客户端下载副本'),
    requireBearer: false
  });

  await expect(page.getByRole('textbox', { name: `${artifact.path} 编辑器`, exact: true }))
    .toContainText('未保存的客户端草稿');
  await expect(page.getByRole('textbox', { name: `${artifact.path} 编辑器`, exact: true }))
    .toContainText('不能作为下载内容。');
  await expect(page.locator('.dirty-indicator')).toBeVisible();
  expect(requests.filter(request => request.pathname.endsWith('/content') && request.method !== 'GET'))
    .toEqual([]);
  expect(requests.filter(request => request.pathname.endsWith('/reveal'))).toEqual([]);
  expect(requests.filter(request => request.pathname.endsWith('/download'))).toHaveLength(1);
});

test('超过文本预览上限但低于固定 100 MiB 下载上限的成果仍可下载', async ({
  page,
  runtime
}, testInfo) => {
  const bytes = Buffer.alloc(3 * 1024 * 1024, 'a');
  bytes.set(Buffer.from('超过文本预览上限的源文件\r\n'));
  const artifact: WorkspaceDownloadArtifact = {
    path: '成果 输出/大文本 原文件.txt',
    label: '打开大文本成果',
    kind: 'text',
    bytes
  };
  expect(bytes.length).toBeLessThan(100 * 1024 * 1024);
  configureArtifacts(runtime, [artifact]);
  const requests = observeWorkspaceFileRequests(page);
  await runtime.openApp(page);
  const threadId = await sendArtifactTask(page, '生成大文本下载成果');
  await page.getByRole('link', { name: artifact.label, exact: true }).click();
  await expect(page.getByText('暂不支持预览此文件', { exact: true })).toBeVisible();

  await expectWorkspaceDownload({
    page,
    threadId,
    workspace: runtime.projectDir,
    artifact,
    saveDirectory: testInfo.outputPath('客户端下载副本'),
    requireBearer: false
  });

  expect(requests.filter(request => request.pathname.endsWith('/content'))).toEqual([]);
  expect(requests.filter(request => request.pathname.endsWith('/reveal'))).toEqual([]);
  expect(requests.filter(request => request.pathname.endsWith('/download'))).toHaveLength(1);
});

async function sendArtifactTask(page: Page, prompt: string): Promise<string> {
  await page.getByRole('textbox', { name: '输入任务' }).fill(prompt);
  const started = page.waitForResponse(response => (
    new URL(response.url()).pathname.endsWith('/runs')
    && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const response = await started;
  expect(response.status()).toBe(202);
  const run = await response.json() as { threadId: string };
  expect(run.threadId).toEqual(expect.any(String));
  expect(run.threadId.length).toBeGreaterThan(0);
  return run.threadId;
}

function configureArtifacts(runtime: RuntimeFixture, artifacts: WorkspaceDownloadArtifact[]): void {
  runtime.configureInvocations([{
    message: artifacts.map(artifact => (
      `[${artifact.label}](${runtime.projectDir}/${artifact.path})`
    )).join('\n\n'),
    files: Object.fromEntries(artifacts.map(artifact => [
      artifact.path,
      { base64: artifact.bytes.toString('base64') }
    ]))
  }]);
}
