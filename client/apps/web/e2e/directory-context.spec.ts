import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from './fixtures/runtime.js';

test('输入框引用文件夹，发送和重新打开会话后保留路径且项目目录不变', async ({ page, runtime }, testInfo) => {
  const directory = join(dirname(runtime.projectDir), '客户资料 文件夹名称很长时应保持输入框布局稳定');
  mkdirSync(directory);
  await page.addInitScript(({ directory }) => {
    const success = { ok: true as const };
    Object.defineProperty(window, 'claweeDesktop', {
      configurable: true,
      value: {
        kind: 'desktop', platform: 'win32',
        readConnectionConfig: async () => ({ baseUrl: '/.clawee/runtime' }),
        subscribeConnectionConfig: () => () => undefined,
        restartRuntime: async () => success,
        reloadWorkspace: async () => success,
        workspaceReady: () => undefined,
        readDesktopPreferences: async () => ({ closeBehavior: 'hide' as const }),
        updateDesktopPreferences: async () => ({ closeBehavior: 'hide' as const }),
        selectProjectDirectory: async () => null,
        selectContextDirectory: async () => directory,
        resolveDroppedFilePath: () => null,
        openExternal: async () => undefined,
        revealPath: async () => success,
        notify: async () => undefined,
        configureBackgroundNotifications: async () => success,
        subscribeNavigation: () => () => undefined
      }
    });
  }, { directory });
  await runtime.openApp(page);
  await page.getByRole('button', { name: /选择访问权限/ }).click();
  await page.getByRole('menuitemradio', { name: /请求批准/ }).click();
  await expect(page.getByRole('button', { name: '选择访问权限 请求批准', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '添加上下文', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '添加文件夹', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '添加文件夹', exact: true }).click();
  await expect(page.getByTitle(directory, { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '输入任务' }).fill('总结文件夹中的客户资料');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const chip = await page.locator('.composer-attachment-directory').boundingBox();
  const remove = await page.getByRole('button', { name: /移除文件夹/ }).boundingBox();
  expect(remove!.y).toBeGreaterThanOrEqual(chip!.y);
  expect(remove!.y + remove!.height).toBeLessThanOrEqual(chip!.y + chip!.height);
  await page.screenshot({ path: testInfo.outputPath('directory-context.png'), fullPage: true });

  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/runs'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON().prompt).toContain(JSON.stringify([directory], null, 2));
  const run = await response.json() as { id: string; threadId: string };
  await runtime.waitForRunStatus(run.id, 'succeeded');
  await expect(page.getByRole('button', { name: /移除文件夹/ })).toHaveCount(0);
  const { thread } = await runtime.api<{ thread: { cwd: string; sandbox: string } }>('GET', `/threads/${run.threadId}`);
  expect(thread.cwd).toBe(runtime.projectDir);
  expect(thread.sandbox).toBe('workspace-write');

  await page.reload();
  await expect(page.getByText('参考文件夹（本机路径）：', { exact: false })).toBeVisible();
});
