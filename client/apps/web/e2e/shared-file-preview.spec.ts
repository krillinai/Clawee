import { expect, test } from './fixtures/runtime.js';
import { FakeEnterpriseDaemon } from './support/fake-enterprise-daemon-2026-07-30.js';
import { expectPdfPreviewLoaded, previewPdfFixture } from './support/shared-file-preview.js';

test.use({ channel: 'chromium' });

test('浏览器共享网盘可实际加载有效 PDF 并关闭预览', async ({ page, runtime }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '内置 PDF 查看器使用桌面浏览器验收');
  const fake = new FakeEnterpriseDaemon();
  fake.completeDingTalkLogin();
  await fake.attach(page);
  await page.route('**/.clawee/runtime/enterprise/gateway', route => route.fulfill({ json: { origin: 'https://enterprise.example', source: 'config', configPath: '/test/config.toml' } }));
  await page.route('**/.clawee/runtime/enterprise/platform-branding', route => route.fulfill({ json: { branding: null } }));
  await page.route('**/.clawee/runtime/enterprise/shared-files?limit=100', route => route.fulfill({ json: {
    files: [{ fileId: 'file-design', spaceId: 'space-design', spaceName: '企业共享', logicalPath: 'preview.pdf', fileName: 'preview.pdf', sizeBytes: previewPdfFixture().length, sha256: 'a'.repeat(64), contentType: 'application/pdf', revision: 1, updatedByUserId: 'test', updatedByAgentId: '', updatedAt: '2026-08-06T08:00:00Z' }],
    meta: { nextCursor: '', hasNext: false }, refreshedAt: '2026-08-06T08:00:00Z'
  } }));
  await page.route('**/.clawee/runtime/enterprise/shared-files/file-design/preview', route => route.fulfill({
    contentType: 'application/pdf', body: previewPdfFixture()
  }));
  await page.goto(runtime.origin);
  await page.getByRole('button', { name: '共享网盘', exact: true }).click();
  await page.getByRole('button', { name: '预览 preview.pdf', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '预览 preview.pdf', exact: true })).toBeVisible();
  await expectPdfPreviewLoaded(page);
  await testInfo.attach('pdf-preview', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: '关闭文件预览' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
