import { expect, test } from './fixtures/runtime.js';

test('SVG 成果显示图形，编辑后的草稿可预览且内含脚本不执行', async ({ page, runtime }) => {
  const fileName = '项目流程图.svg';
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="2180" viewBox="0 0 1600 2180" onload="alert('SVG onload')">
    <rect width="1600" height="2180" fill="#fff"/>
    <text x="80" y="120" fill="#334155">项目流程图</text>
    <script>alert('SVG script')</script>
  </svg>`;
  const dialogs: string[] = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  runtime.configureInvocations([{
    message: `已生成流程图：[打开流程图](${fileName})`,
    files: { [fileName]: source }
  }]);

  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('生成 SVG 流程图');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('link', { name: '打开流程图' }).click();

  const image = page.locator('.file-preview').getByRole('img', { name: fileName });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth === 1600 && element.naturalHeight === 2180
  ))).toBe(true);
  await expect(page.locator('.file-preview pre, .file-preview svg, .file-preview script')).toHaveCount(0);

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const draft = source.replace('项目流程图</text>', '更新后的流程图</text>');
  await page.getByRole('textbox', { name: `${fileName} 编辑器` }).fill(draft);
  await expect(page.locator('.dirty-indicator')).toBeVisible();
  await page.getByRole('button', { name: '预览', exact: true }).click();

  await expect(image).toHaveAttribute('src', `data:image/svg+xml;charset=utf-8,${encodeURIComponent(draft)}`);
  await expect.poll(() => image.evaluate(element => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);
  expect(dialogs).toEqual([]);
});
