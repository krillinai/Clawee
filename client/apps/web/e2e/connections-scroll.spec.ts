import { expect, test } from './fixtures/runtime.js';

test('连接器新增 MCP 展开高级配置后可滚动至保存按钮', async ({ page, runtime }, testInfo) => {
  if (testInfo.project.name === 'chromium-desktop') {
    await page.setViewportSize({ width: 1000, height: 750 });
  }
  await page.route('**/.clawee/runtime/codex/status', async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        capabilities: { ...status.capabilities, mcpAdd: true, mcpAddEnv: true }
      }
    });
  });
  await runtime.openApp(page);

  const openNavigation = page.getByRole('button', { name: '打开导航', exact: true });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole('button', { name: '连接器', exact: true }).click();
  await page.getByRole('button', { name: '新增 MCP', exact: true }).click();
  const editor = page.getByRole('form', { name: '新增 MCP', exact: true });
  await editor.getByText('高级配置', { exact: true }).click();
  for (let index = 0; index < 6; index += 1) {
    await editor.getByRole('button', { name: '添加变量', exact: true }).click();
  }

  const connections = page.locator('.connections-page');
  const dimensions = await connections.evaluate(element => ({
    height: element.clientHeight,
    availableHeight: element.parentElement!.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.availableHeight);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);

  await connections.evaluate(element => { element.scrollTop = 0; });
  const save = editor.getByRole('button', { name: '保存 MCP', exact: true });
  const pageBox = (await connections.boundingBox())!;
  const saveBox = (await save.boundingBox())!;
  await page.mouse.move(pageBox.x + pageBox.width / 2, pageBox.y + pageBox.height / 2);
  await page.mouse.wheel(0, saveBox.y + saveBox.height - pageBox.y - pageBox.height + 24);

  await expect.poll(() => connections.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(save).toBeInViewport();
  await expect(editor.getByRole('textbox', { name: '环境变量名 6', exact: true })).toBeInViewport();
  expect(await page.locator('.clawee-main-content').evaluate(element => element.scrollTop)).toBe(0);
});
