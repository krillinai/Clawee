import { expect, test } from '@playwright/test';

test.use({ headless: true });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`管理后台反馈截图遮盖与明确授权 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let submissions = 0; let submittedBody = '';
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === '/api/v1/auth/me') data = { account: { user_id: 'usr_test', email: 'test@example.com', name: '测试管理员', status: 'active' }, admin_permissions: ['console:feedback:read'], applications: { admin: true, frontend: true } };
      else if (path === '/api/v1/admin/feedback/reports') data = [];
      else if (path === '/api/v1/admin/feedback/collection-policy') data = { external_feedback_allowed: true };
      else if (path === '/api/v1/admin/feedback/collect') { submissions++; submittedBody = route.request().postData() ?? ''; data = { report_id: 'fb_test0001', display_number: 'FB-E2E', upload_state: 'ready', security_state: 'normal' }; }
      await route.fulfill({ json: { data, meta: { has_next: false } } });
    });
    await page.goto('/admin/feedback');
    await page.getByRole('button', { name: '提交异常反馈' }).click();
    await page.getByLabel('问题描述（必填）').fill('列表加载异常 password=private123');
    const bitmap = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
      const context = canvas.getContext('2d')!; context.fillStyle = '#ffffff'; context.fillRect(0, 0, 200, 100);
      context.fillStyle = '#ff0000'; context.fillRect(20, 20, 80, 40);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    await page.getByLabel('截图', { exact: true }).setInputFiles({ name: 'private-customer.png', mimeType: 'image/png', buffer: Buffer.from(bitmap, 'base64') });
    await page.getByRole('button', { name: '遮盖截图 1' }).click();
    const canvas = page.getByLabel('截图遮盖画布');
    await expect(page.getByRole('button', { name: '保存遮盖' })).toBeEnabled();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.1);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.75); await page.mouse.up();
    expect(await canvas.evaluate(node => [...(node as HTMLCanvasElement).getContext('2d')!.getImageData(50, 35, 1, 1).data])).toEqual([0, 0, 0, 255]);
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
        original.call(this, blob => { (window as unknown as { finishMaskSave: () => void }).finishMaskSave = () => callback(blob); }, type, quality);
      };
    });
    await page.getByRole('button', { name: '保存遮盖' }).click();
    await expect(page.getByRole('button', { name: '保存遮盖' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '取消遮盖' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '重置遮盖' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '准备反馈' })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { finishMaskSave: () => void }).finishMaskSave)).toBe('function');
    await page.evaluate(() => (window as unknown as { finishMaskSave: () => void }).finishMaskSave());
    await expect(page.getByLabel('截图遮盖')).toHaveCount(0);
    const savedPixel = await page.getByAltText('截图 1').evaluate(async node => {
      const image = node as HTMLImageElement; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      return { mask: [...context.getImageData(50, 35, 1, 1).data], outside: [...context.getImageData(150, 90, 1, 1).data] };
    });
    expect(savedPixel).toEqual({ mask: [0, 0, 0, 255], outside: [255, 255, 255, 255] });
    await page.getByRole('button', { name: '准备反馈' }).click();
    await expect(page.getByText(/本地材料约 .* KiB/)).toBeVisible();
    await expect(page.getByRole('button', { name: '发送反馈' })).toBeDisabled();
    expect(submissions).toBe(0);
    await page.getByLabel('确认可以发送上述资料和截图给软件维护方').check();
    await page.getByLabel('确认按部分资料发送，不包含桌面、会话及服务器日志').check();
    const dialog = page.getByRole('dialog');
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`feedback-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: '发送反馈' }).click();
    await expect(page.getByRole('status')).toContainText('FB-E2E');
    expect(submissions).toBe(1); expect(submittedBody).not.toContain('private123'); expect(submittedBody).not.toContain('private-customer.png');
  });
}
