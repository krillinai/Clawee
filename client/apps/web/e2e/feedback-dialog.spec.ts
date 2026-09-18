import type { FeedbackDraft } from '@clawee/protocol';
import { expect, test } from './fixtures/runtime.js';

for (const theme of ['light', 'dark']) {
  test(`反馈输入与提交回执在 ${theme} 主题下清晰显示`, async ({ page, runtime }, testInfo) => {
    const viewport = page.viewportSize()!;
    // 窄屏会话页隐藏反馈入口，先打开桌面弹窗再验证窗口缩窄。
    if (viewport.width < 768) await page.setViewportSize({ width: 1440, height: 900 });
    let description = '';
    let steps = '';
    let submitted = false;
    const draft = (): FeedbackDraft => ({
      local_feedback_id: '00000000-0000-0000-0000-000000000001',
      thread_id: runtime.ordinaryThreadId,
      description,
      state: submitted ? 'submitted' : 'awaiting_consent',
      origin: 'https://gateway.clawee.work',
      size_bytes: 81920,
      screenshots: [],
      retry_count: 0,
      expires_at: '2026-09-25T08:49:32Z',
      external_feedback_allowed: true,
      manifest_sha256: 'a'.repeat(64),
      manifest: {
        schema_version: 1,
        snapshot_at: '2026-09-18T08:49:32Z',
        thread_id: runtime.ordinaryThreadId,
        run_ids: [], runtime_thread_ids: [], watermarks: [],
        completeness: 'partial', redaction_policy_version: 1,
        artifacts: [], missing_items: ['desktop:unavailable'], warnings: []
      },
      ...(submitted ? { report_id: 'fb_test_receipt', centre_status: 'open' } : {})
    });
    await page.route('**/feedback/**', async route => {
      if (!['fetch', 'xhr'].includes(route.request().resourceType())) {
        await route.fallback();
        return;
      }
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/policy')) {
        await route.fulfill({ json: { external_feedback_allowed: true } });
        return;
      }
      if (path.endsWith('/drafts') && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        description = body.description;
        steps = body.reproduction_steps;
      }
      if (path.endsWith('/send')) submitted = true;
      await route.fulfill({ json: draft() });
    });
    await page.addInitScript(value => localStorage.setItem('clawee.preferences.colorMode', value), theme);
    await runtime.openApp(page);
    await page.goto(`${runtime.origin}/#/thread/${runtime.ordinaryThreadId}`);
    await page.getByRole('button', { name: '反馈当前会话问题' }).click();
    await page.setViewportSize(viewport);
    const dialog = page.getByRole('dialog');
    const problem = dialog.getByLabel('问题描述', { exact: true });
    const reproduction = dialog.getByLabel('复现步骤', { exact: true });
    await problem.fill('输入中文描述\n第二行内容');
    await reproduction.fill('第一步\n第二步');
    await reproduction.press('Enter');
    await reproduction.pressSequentially('abc');
    await expect(problem).toHaveValue('输入中文描述\n第二行内容');
    await expect(reproduction).toHaveValue('第一步\n第二步\nabc');
    await testInfo.attach('反馈输入框', { body: await dialog.screenshot({ path: testInfo.outputPath('feedback-input.png') }), contentType: 'image/png' });
    for (const field of [problem, reproduction]) {
      const layout = await field.evaluate(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const parent = element.parentElement!.getBoundingClientRect();
        return { radius: style.borderRadius, padding: parseFloat(style.paddingLeft),
          height: rect.height, fits: rect.left >= parent.left && rect.right <= parent.right + 1 };
      });
      expect(layout.radius).toBe('6px');
      expect(layout.padding).toBeGreaterThanOrEqual(10);
      expect(layout.height).toBeGreaterThanOrEqual(96);
      expect(layout.fits).toBe(true);
    }
    await dialog.getByRole('button', { name: '采集并预览' }).click();
    await dialog.getByRole('checkbox').first().check();
    await dialog.getByRole('checkbox').nth(1).check();
    await dialog.getByRole('button', { name: '确认发送' }).click();
    const receipt = dialog.getByRole('status');
    await expect(receipt).toContainText('反馈提交成功');
    await expect(receipt).toContainText('处理状态：待处理');
    await expect(receipt).toContainText('fb_test_receipt');
    await expect(dialog.getByRole('button', { name: '确认发送' })).toHaveCount(0);
    expect(description).toBe('输入中文描述\n第二行内容');
    expect(steps).toBe('第一步\n第二步\nabc');
    await testInfo.attach('反馈提交成功', { body: await dialog.screenshot({ path: testInfo.outputPath('feedback-submitted.png') }), contentType: 'image/png' });
    const receiptBox = await receipt.boundingBox();
    const dialogBox = await dialog.boundingBox();
    expect(receiptBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
    expect(receiptBox!.y + receiptBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}
