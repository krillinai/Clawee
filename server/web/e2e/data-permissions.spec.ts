import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

for (const viewport of [
  { width: 1440, height: 900, extraPermissions: false },
  { width: 1440, height: 640, extraPermissions: true },
  { width: 390, height: 844, extraPermissions: false },
  { width: 390, height: 667, extraPermissions: true }
]) {
  test(`成员选择撑大弹窗且仅列表滚动 ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const warnings: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      user_id: `usr_${index}`, name: `候选成员 ${index}`, email: `member${index}@example.com`
    }));
    const mutations: unknown[] = [];
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === '/api/v1/auth/me') data = {
        account: { user_id: 'usr_admin', email: 'admin@example.com', name: '管理员', status: 'active' },
        admin_permissions: [permissions.dataResourceGrantRead, permissions.dataResourceGrantCreate],
        applications: { admin: true, frontend: true }
      };
      else if (path === '/api/v1/admin/data-resource-grants/resource-types') data = { items: [{
        resource_type: 'data_view', name: '数据视图', resource_count: 1, action_count: 1, user_count: 0
      }] };
      else if (path === '/api/v1/admin/data-resource-grants/resources/search') data = {
        items: [{
          resource_type: 'data_view', resource_id: 'skill_contributions', name: 'Skill 贡献',
          actions: [], user_count: 0,
          available_actions: [
            { action: 'read', name: '查看 Skill 贡献', description: '', required: true, default_checked: true },
            ...(viewport.extraPermissions ? [
              { action: 'write', name: '修改数据', description: '', required: false, default_checked: false },
              { action: 'delete', name: '删除数据', description: '', required: false, default_checked: false }
            ] : [])
          ]
        }], meta: { page: 1, page_size: 20, total: 1 }
      };
      else if (path === '/api/v1/admin/data-resource-grants/members/search') data = {
        items: [], meta: { page: 1, page_size: 20, total: 0 }
      };
      else if (path === '/api/v1/admin/data-resource-grants/member-candidates/search') data = {
        items: candidates, meta: { page: 1, page_size: 20, total: candidates.length }
      };
      else if (path === '/api/v1/admin/data-resource-grants') mutations.push(route.request().postDataJSON());
      await route.fulfill({ json: { data } });
    });

    await page.goto('/admin/data-permissions');
    await page.getByRole('button', { name: '管理授权' }).click();
    await page.getByRole('button', { name: '添加成员授权' }).click();
    const addDialog = page.getByRole('dialog', { name: '添加成员授权', exact: true });
    await expect(addDialog).toHaveAccessibleDescription('为所选账户配置“Skill 贡献”的访问权限。');
    const closedHeight = await addDialog.evaluate(node => node.getBoundingClientRect().height);
    await addDialog.getByRole('button', { name: '选择授权成员' }).click();
    const list = page.getByRole('listbox');
    await expect(list.getByRole('option')).toHaveCount(20);
    const search = addDialog.getByRole('combobox', { name: '搜索候选成员' });
    await expect(search).toBeFocused();
    await expect.poll(() => addDialog.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(closedHeight);
    expect(await addDialog.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    await expect(addDialog.getByRole('button', { name: '取消', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(addDialog.getByRole('button', { name: '添加成员', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: test.info().outputPath('member-picker-open.png') });
    expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await list.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(0);
    expect(await addDialog.evaluate(node => node.scrollTop)).toBe(0);
    await list.getByRole('option', { name: /候选成员 0 / }).click();
    await expect(addDialog.getByRole('button', { name: '添加 1 位成员' })).toBeVisible();
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(addDialog.getByRole('button', { name: '添加 2 位成员' })).toBeVisible();
    await search.press('Enter');
    await expect(addDialog.getByRole('button', { name: '添加 1 位成员' })).toBeVisible();
    await search.press('Escape');
    await expect(list).not.toBeVisible();
    await expect(addDialog).toBeVisible();
    await expect(addDialog.getByRole('button', { name: '选择授权成员' })).toBeFocused();
    await expect.poll(() => addDialog.evaluate(node => node.getBoundingClientRect().height)).toBe(closedHeight);
    await addDialog.getByRole('button', { name: '添加 1 位成员' }).click();
    await expect(addDialog).not.toBeVisible();
    expect(mutations).toEqual([{
      user_id: 'usr_0', resource_type: 'data_view', resource_id: 'skill_contributions', actions: ['read']
    }]);
    expect(warnings.filter(message => message.includes('Description') || message.includes('aria-describedby'))).toEqual([]);
    expect(errors).toEqual([]);
  });
}
