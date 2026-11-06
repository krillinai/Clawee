import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const count of [0, 3]) {
    test(`受限账号总览紧凑布局 ${viewport.width} / ${count} 项技能`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const requests: string[] = [];
      const now = '2026-10-12T00:00:00Z';
      await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        let data: unknown = {};
        if (path === '/api/v1/auth/me') data = {
          account: { user_id: 'usr_reader', name: '受限账号', email: 'reader@example.com', status: 'active' },
          admin_permissions: [permissions.skillRead], applications: { admin: true, frontend: true }
        };
        else if (path === '/api/v1/admin/status') data = { features: {} };
        else if (path === '/api/v1/admin/skills') data = {
          items: Array.from({ length: count }, (_, index) => ({
            skill_id: `skill_${index}`, name: `日报生成 ${index}`, description: '',
            current_version_id: `version_${index}`, created_by: 'admin', created_at: now, updated_at: now
          }))
        };
        await route.fulfill({ json: { data } });
      });

      await page.goto('/admin');
      const resources = page.getByRole('region', { name: '企业资源状态' });
      await expect(resources.getByText(`${count} 个已发布`)).toBeVisible();
      await expect(resources.getByText('技能', { exact: true })).toHaveCount(1);
      await expect(resources.getByRole('img', { name: /纳管资源分布/ })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: '总览分区导航' })).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 2, name: '企业资源', exact: true })).toBeVisible();
      await expect(resources.getByRole('link', { name: '查看', exact: true })).toHaveAttribute('href', '/admin/skills');
      expect((await resources.boundingBox())!.height).toBeLessThan(220);
      expect(await resources.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`overview-${viewport.width}-${count}.png`), fullPage: true });

      await page.getByRole('button', { name: '刷新数据' }).click();
      await expect.poll(() => requests.filter(path => path === '/api/v1/admin/skills').length).toBe(2);
      expect([...new Set(requests.filter(path => path.startsWith('/api/v1/admin/')))].sort()).toEqual([
        '/api/v1/admin/skills', '/api/v1/admin/status'
      ]);
    });
  }
}
