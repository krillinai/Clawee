import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`角色名称展示与免编码创建 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const roleNames = ['系统管理员', '基础平台与自动化研发组默认角色'];
    const now = '2026-10-12T02:00:00+08:00';
    const roles = [{
      role_id: 'role_admin', code: 'admin', name: '系统管理员', is_system: true,
      permission_codes: [permissions.rbacManage], created_at: now, updated_at: now
    }];
    let creations = 0;
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === '/api/v1/auth/me') data = {
        account: { user_id: 'usr_admin', name: '测试管理员', email: 'admin@example.com', status: 'active' },
        admin_roles: ['admin', 'rose_dept_test'], admin_role_names: roleNames,
        admin_permissions: [permissions.rbacManage], applications: { admin: true, frontend: true }
      };
      else if (path === '/api/v1/admin/status') data = { features: { rbac: true } };
      else if (path === '/api/v1/admin/rbac/permissions') data = [{
        code: permissions.rbacRead, module: 'rbac', action: 'read', name: '角色查看', description: '查看角色'
      }];
      else if (path === '/api/v1/admin/rbac/roles') {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toEqual({ name: '安全审计员', permission_codes: [] });
          const created = {
            role_id: 'role_created', code: 'role_generated', name: '安全审计员', is_system: false,
            permission_codes: [], created_at: now, updated_at: now
          };
          roles.push(created);
          creations++;
          data = created;
        } else data = roles;
      }
      await route.fulfill({ status: route.request().method() === 'POST' ? 201 : 200, json: { data } });
    });
    await page.goto('/admin/rbac/roles');
    const account = page.getByRole('group', { name: '账户信息' });
    const badge = account.getByTitle(roleNames.join('、'));
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(roleNames.join('、'));
    await expect(account.getByText('admin', { exact: true })).toHaveCount(0);
    const nameBounds = (await account.getByRole('button', { name: '测试管理员' }).boundingBox())!;
    const badgeBounds = (await badge.boundingBox())!;
    expect(nameBounds.width).toBeGreaterThanOrEqual(40);
    expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(badgeBounds.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`role-names-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: '创建角色' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('角色编码')).toHaveCount(0);
    await dialog.getByLabel('角色名称').fill('安全审计员');
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`role-create-${viewport.width}.png`) });
    await dialog.getByRole('button', { name: '保存角色' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('安全审计员', { exact: true })).toBeVisible();
    expect(creations).toBe(1);
  });
}
