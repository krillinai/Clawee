import { expect, test } from './fixtures/runtime.js';
import { readFileSync } from 'node:fs';
import { createDocx, createPptx, createXlsx } from '../../daemon/test/helpers/office-fixtures.js';
import { expectWorkspaceDownload } from './support/workspace-download.js';

test.use({ channel: 'chromium', acceptDownloads: true });

test('Office 成果在共享文件面板只读预览，并可下载原文件', async ({ page, runtime }, testInfo) => {
  test.setTimeout(120_000);
  const files = [
    { path: '成果/中文 报告.docx', label: '核对 Word', bytes: createDocx('需要核对的中文正文') },
    { path: '成果/数据.xlsx', label: '核对 Excel', bytes: await createXlsx() },
    { path: '成果/演示.pptx', label: '核对 PPT', bytes: createPptx() },
    ...(['doc', 'xls', 'ppt'] as const).map(format => ({ path: `成果/旧版 核对.${format}`, label: `核对旧版 ${format}`,
      bytes: readFileSync(new URL(`../../daemon/test/fixtures/legacy-office/simple.${format}`, import.meta.url)) }))
  ];
  runtime.configureInvocations([{
    message: files.map(file => {
      const root = runtime.projectDir.replace(/\\/g, '/');
      const linkRoot = process.platform === 'win32' ? `/${root.toLowerCase()}` : root;
      return `[${file.label}](<${linkRoot}/${file.path}>)`;
    }).join('\n\n'),
    files: Object.fromEntries(files.map(file => [file.path, { base64: file.bytes.toString('base64') }]))
  }]);
  const writes: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/workspace/files/') && request.method() !== 'GET') writes.push(request.url());
  });
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('生成六种 Office 核对成果');
  const started = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const run = await (await started).json() as { threadId: string };

  for (const [index, file] of files.entries()) {
    await page.getByRole('link', { name: file.label, exact: true }).click();
    const preview = page.getByLabel('Office 只读内容预览');
    if (index === 0) {
      await expect(preview.getByText('需要核对的中文正文', { exact: true })).toBeVisible();
      await expect(preview.getByRole('table')).toContainText('Demo');
    } else if (index === 1) {
      await expect(preview.getByRole('table', { name: '工作表 Summary' })).toBeVisible();
      await expect(preview.getByRole('cell', { name: /无缓存结果/ })).toBeVisible();
      await expect(preview.getByText('Sales', { exact: true })).toHaveAttribute('colspan', '2');
      await preview.getByRole('button', { name: 'Details', exact: true }).click();
      await expect(preview.getByRole('table', { name: '工作表 Details' })).toContainText('Detail text');
    } else if (index === 2) {
      await expect(preview.getByRole('article', { name: '第 1 页' })).toContainText('First displayed slide');
      await preview.getByText('演讲备注', { exact: true }).click();
      await expect(preview.getByText('Speaker note for first slide', { exact: true })).toBeVisible();
    } else if (index === 3) {
      await expect(preview.getByText('This is a simple file created with Word 97-SR2.', { exact: true })).toBeVisible();
    } else if (index === 4) {
      await expect(preview.getByText('replaceMe', { exact: true })).toBeVisible();
      await expect(preview.getByText(/原始单元格坐标、公式、隐藏状态和合并信息未展示/)).toBeVisible();
      await preview.getByRole('button', { name: 'Sheet2', exact: true }).click();
      await expect(preview.getByRole('region', { name: '工作表 Sheet2' })).toContainText('无可展示的文字或表格内容');
    } else {
      await expect(preview.getByRole('article', { name: '第 1 页' })).toContainText('This is a test title');
      await expect(preview.getByRole('article', { name: '第 2 页' })).toContainText('This is page two');
      await expect(preview.getByText(/演讲备注未展示/)).toBeVisible();
    }
    await expect(page.locator('.file-top-bar').getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
    await expect(page.locator('.file-top-bar').getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`office-${index}.png`) });
    await expectWorkspaceDownload({ page, threadId: run.threadId, workspace: runtime.projectDir, artifact: file,
      saveDirectory: testInfo.outputPath('下载副本'), requireBearer: false });
    await page.getByRole('button', { name: '关闭文件工作区', exact: true }).click();
  }
  expect(writes).toEqual([]);
});
