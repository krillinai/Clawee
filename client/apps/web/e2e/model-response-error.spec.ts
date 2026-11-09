import { expect, test } from './fixtures/runtime.js';

test('Codex 底层异常直接展示来源和脱敏原文，刷新后仍可查看', async ({ page, runtime }, testInfo) => {
  runtime.configureInvocations([{ turnStatus: 'failed', turnError: {
    message: 'Response protection failed: could not validate the response', codexErrorInfo: 'other',
    additionalDetails: 'Unsupported response event; api_key="private-key"; response body: private business text'
  } }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('验证 Codex 底层异常');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const error = page.locator('.model-response-diagnostic');
  await expect(error.getByText('异常来源：Codex Runtime（模型执行层）')).toBeVisible();
  await expect(error.getByText('Response protection failed: could not validate the response')).toBeVisible();
  await expect(error.locator('pre').filter({ hasText: 'Unsupported response event' })).toBeVisible();
  await expect(error).not.toContainText('private-key');
  await expect(error).not.toContainText('private business text');
  const runId = (await error.locator('.model-response-reference span').innerText()).replace('排查编号：', '');
  const run = await runtime.waitForRunStatus(runId, 'failed');
  await testInfo.attach('codex-error-history.json', { body: JSON.stringify(await runtime.api('GET', `/threads/${run.threadId}/history`), null, 2), contentType: 'application/json' });
  await page.reload();
  await expect(error.getByText('异常来源：Codex Runtime（模型执行层）')).toBeVisible();
  await expect(error.getByText('Response protection failed: could not validate the response')).toBeVisible();
  await expect(page.getByText('正在思考', { exact: true })).toHaveCount(0);
  await expect(page.getByText('未知原因', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('codex-response-protection.png'), fullPage: true });
});

test('模型连续重试合并、恢复和最终失败在桌面及窄屏保持可读', async ({ page, runtime }, testInfo) => {
  const errors = [1, 2, 3].map(attempt => ({ message: `Reconnecting... ${attempt}/5`,
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
    additionalDetails: 'HTTP 503; request_id: req_model_e2e; response body: private business text' }));
  runtime.configureInvocations([
    { responseErrors: errors, responseDelayMs: 5000, message: '连接恢复后的模型回答' },
    { responseErrors: errors, responseDelayMs: 5000, turnStatus: 'failed',
      turnError: { message: 'retry limit exceeded', codexErrorInfo: 'responseTooManyFailedAttempts' } }
  ]);
  await runtime.openApp(page);
  const input = page.getByRole('textbox', { name: '输入任务' });
  await input.fill('验证重连恢复');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const first = page.locator('.model-response-diagnostic').first();
  await expect(first).toContainText('模型接口暂不可用（HTTP 503），正在重试（3/5）');
  await expect(page.locator('.model-response-diagnostic')).toHaveCount(1);
  await first.getByText('技术详情').click();
  await expect(first).toContainText('req_model_e2e');
  await expect(first).not.toContainText('private business text');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('model-retrying.png'), fullPage: true });
  await first.getByText('技术详情').click();
  await expect(first).toContainText('模型响应已恢复，任务继续执行');
  await expect(page.getByText('连接恢复后的模型回答', { exact: true })).toBeVisible();
  await input.fill('验证重试耗尽');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const latest = page.locator('.model-response-diagnostic').last();
  await expect(latest).toContainText('正在重试');
  await expect(latest).toContainText('多次重试后仍未恢复，本次任务失败');
  await expect(latest).toContainText('最后已知原因：模型接口暂不可用（HTTP 503）');
  await latest.getByText('技术详情').click();
  await expect(latest.getByRole('button', { name: '复制排查编号' })).toBeVisible();
  await expect(latest).not.toContainText('正在重试');
  await expect(latest).not.toContainText('异常已上报');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('model-failed.png'), fullPage: true });
});
