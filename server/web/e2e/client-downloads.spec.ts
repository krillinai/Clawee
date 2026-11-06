import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

for (const { viewport, dingtalkEnabled } of [{ width: 1440, height: 900 }, { width: 390, height: 844 }].flatMap(viewport => [false, true].map(dingtalkEnabled => ({ viewport, dingtalkEnabled })))) {
  test(`客户端版本策略启停 ${viewport.width} 钉钉启用 ${dingtalkEnabled}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const mutations: unknown[] = [];
    const packages = [{ platform: 'macos', arch: 'arm64', url: 'https://cdn.example.com/clawee/releases/v1.0.6/desktop/macos/arm64/Clawee-1.0.6-arm64-mac.zip', sha512: 'A'.repeat(86) + '==', size: 327262170 }];
    let snapshot = { enabled: false, revision: 0, update: null as unknown };
    await page.route('**/api/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let data: unknown = {};
      if (path === '/api/v1/auth/me') data = {
        account: { user_id: 'usr_admin', name: '测试管理员', email: 'admin@example.com', status: 'active' },
        dingtalk_enabled: dingtalkEnabled,
        admin_permissions: [permissions.clientDownloadsRead, permissions.clientDownloadsUpdate], applications: { admin: true, frontend: true }
      };
      else if (path === '/api/v1/admin/client-downloads') data = { gateway_url: 'https://gateway.example.com', catalog_url: 'https://cdn.example.com/clawee/catalog/stable/latest.json', version: 1, manifest_status: 'ok', manifest_version: '1.0.6', packages: [] };
      else if (path === '/api/v1/admin/client-downloads/update/versions') data = { versions: [{ version: '1.0.6', published_at: '2026-10-12T00:00:00Z' }] };
      else if (path === '/api/v1/admin/client-downloads/update/versions/1.0.6') data = { version: '1.0.6', packages, unavailable_platforms: ['windows/x64：缺少正式签名，不能自动安装'] };
      else if (path === '/api/v1/admin/client-downloads/update') {
        if (request.method() === 'PUT') {
          const input = request.postDataJSON();
          mutations.push(input);
          snapshot = { enabled: input.enabled, revision: snapshot.revision + 1, update: { kind: 'customer-desktop-update', gateway_url: 'https://gateway.example.com', version: input.version, notes: input.notes, packages, revision: snapshot.revision + 1, published_at: '2026-10-12T00:00:00Z', published_by: 'usr_admin' } };
        }
        data = snapshot;
      }
      await route.fulfill({ json: { data } });
    });
    await page.goto('/admin/client-downloads');
    await expect(page.getByRole('heading', { name: '客户端下载', exact: true })).toBeVisible();
    const accountInformation = page.getByRole('group', { name: '账户信息' });
    const quickActions = accountInformation.getByRole('group', { name: '快捷操作' });
    const downloadLink = quickActions.getByRole('link', { name: '下载客户端' });
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute('href', '/downloads');
    await expect(downloadLink).toHaveText('');
    await expect(quickActions.getByRole('radiogroup', { name: '界面主题' })).toBeVisible();
    const userCenterLink = accountInformation.getByRole('link', { name: '用户中心' });
    await expect(userCenterLink).toHaveAttribute('href', '/app/agents');
    const userCenterLabel = userCenterLink.locator('span');
    expect(await userCenterLabel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const accountBox = (await accountInformation.boundingBox())!;
    const userCenterBox = (await userCenterLink.boundingBox())!;
    const quickActionsBox = (await quickActions.boundingBox())!;
    expect(userCenterBox.x).toBeGreaterThan(accountBox.x);
    expect(userCenterBox.y + userCenterBox.height).toBeLessThan(accountBox.y + accountBox.height);
    expect(quickActionsBox.x + quickActionsBox.width).toBeLessThan(accountBox.x + accountBox.width);
    await expect(page.getByRole('button', { name: '绑定钉钉' })).toHaveCount(0);
    await accountInformation.getByRole('button', { name: '账户操作' }).click();
    await expect(page.getByRole('button', { name: '绑定钉钉' })).toHaveCount(dingtalkEnabled ? 1 : 0);
    await expect(page.getByText(/解绑/)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await accountInformation.screenshot({ path: testInfo.outputPath('admin-account-pane.png') });
    await page.getByRole('checkbox', { name: '启用客户更新' }).check();
    await page.getByRole('combobox', { name: '目标客户端版本' }).click();
    await page.getByRole('option', { name: '1.0.6', exact: true }).click();
    await expect(page.getByText('macos/arm64', { exact: true })).toBeVisible();
    await expect(page.getByText('windows/x64：缺少正式签名，不能自动安装')).toBeVisible();
    expect(mutations).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`client-update-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: '保存更新配置' }).click();
    const confirm = page.getByRole('dialog', { name: '确认启用客户更新' });
    await expect(confirm).toContainText('自动下载');
    await confirm.getByRole('button', { name: '确认保存' }).click();
    await expect(page.getByText('客户更新配置已保存。')).toBeVisible();
    expect(mutations).toEqual([{ enabled: true, version: '1.0.6', notes: '', expected_revision: 0 }]);
    await page.getByRole('checkbox', { name: '启用客户更新' }).uncheck();
    await page.getByRole('button', { name: '保存更新配置' }).click();
    await page.getByRole('dialog', { name: '确认停用客户更新' }).getByRole('button', { name: '确认保存' }).click();
    await expect(page.getByText('更新状态：已停用')).toBeVisible();
    expect(mutations).toEqual([{ enabled: true, version: '1.0.6', notes: '', expected_revision: 0 }, { enabled: false, version: '1.0.6', notes: '', expected_revision: 1 }]);
  });
}
