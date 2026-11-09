import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const { canEnterAdmin, dingtalkEnabled } of [true, false].flatMap(canEnterAdmin => [false, true].map(dingtalkEnabled => ({ canEnterAdmin, dingtalkEnabled })))) {
    test(`用户端下载图标 ${viewport.width} 后台权限 ${canEnterAdmin} 钉钉启用 ${dingtalkEnabled}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        let data: unknown = {};
        if (path === '/api/v1/auth/me') data = {
          account: { user_id: 'usr_test', name: '测试用户', email: 'test@example.com', status: 'active' },
          dingtalk_enabled: dingtalkEnabled,
          admin_permissions: canEnterAdmin ? [permissions.accountRead] : [],
          applications: { admin: canEnterAdmin, frontend: true }
        };
        else if (path === '/api/v1/app/agents') data = { items: [] };
        else if (path === '/api/v1/app/data-views') data = [];
        else if (path === '/api/v1/app/mcp/catalog') data = { upstreams: [] };
        await route.fulfill({ json: { data } });
      });
      await page.goto('/app/agents');
      const accountInformation = page.getByRole('group', { name: '账户信息' });
      const quickActions = accountInformation.getByRole('group', { name: '快捷操作' });
      const downloadLink = quickActions.getByRole('link', { name: '下载客户端' });
      await expect(downloadLink).toBeVisible();
      await expect(downloadLink).toHaveAttribute('href', '/downloads');
      await expect(downloadLink).toHaveText('');
      await expect(page.getByRole('link', { name: '下载客户端' })).toHaveCount(1);
      const themeSwitcher = quickActions.getByRole('radiogroup', { name: '界面主题' });
      await expect(themeSwitcher).toBeVisible();
      const downloadBox = (await downloadLink.boundingBox())!;
      const themeBox = (await themeSwitcher.boundingBox())!;
      await expect(accountInformation).toBeVisible();
      const accountBox = (await accountInformation.boundingBox())!;
      expect(downloadBox.x).toBeGreaterThan(accountBox.x);
      expect(downloadBox.y + downloadBox.height).toBeLessThan(accountBox.y + accountBox.height);
      expect(themeBox.x + themeBox.width).toBeLessThan(accountBox.x + accountBox.width);
      await expect(page.getByRole('button', { name: '绑定钉钉' })).toHaveCount(0);
      expect(downloadBox.x + downloadBox.width).toBeLessThanOrEqual(themeBox.x);
      expect(Math.abs(downloadBox.y + downloadBox.height / 2 - themeBox.y - themeBox.height / 2)).toBeLessThan(1);
      const adminLink = accountInformation.getByRole('link', { name: '管理后台' });
      if (canEnterAdmin) {
        await expect(adminLink).toBeVisible();
        const adminBox = (await adminLink.boundingBox())!;
        expect(adminBox.x).toBeGreaterThan(accountBox.x);
        expect(adminBox.y + adminBox.height).toBeLessThan(accountBox.y + accountBox.height);
        expect(await adminLink.locator('span').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      } else {
        await expect(adminLink).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await accountInformation.getByRole('button', { name: '账户操作' }).click();
      await expect(page.getByRole('button', { name: '绑定钉钉' })).toHaveCount(dingtalkEnabled ? 1 : 0);
      await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
      await expect(page.getByText(/解绑/)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: '绑定钉钉' })).toHaveCount(0);
      await page.locator('aside').screenshot({ path: testInfo.outputPath('app-sidebar.png') });
      await downloadLink.hover();
      await expect(page.getByRole('tooltip', { name: '下载客户端' })).toBeVisible();
      await downloadLink.click();
      await expect(page).toHaveURL(/\/downloads$/);
    });
  }
}
