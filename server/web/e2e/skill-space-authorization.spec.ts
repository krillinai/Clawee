import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`技能空间账户与角色授权 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const mutations: Array<{ method: string; body: Record<string, unknown> }> = [];
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = [];
      let meta = { page: 1, page_size: 20, total: 1 };
      if (path === '/api/v1/auth/me') data = {
        account: { user_id: 'usr_test', email: 'test@example.com', name: '测试管理员', status: 'active' },
        admin_permissions: [permissions.skillRead, permissions.skillSpaceMemberCreate, permissions.skillSpaceMemberUpdate, permissions.skillSpaceMemberDelete, permissions.dataResourceGrantRead, permissions.dataResourceGrantCreate, permissions.dataResourceGrantUpdate, permissions.dataResourceGrantDelete],
        applications: { admin: true, frontend: true }
      };
      else if (path === '/api/v1/admin/skill-spaces') data = [{
        space_id: 'space_dev', name: '研发技能', description: '研发团队技能', approvers: [], member_count: 7,
        skill_count: 3, published_count: 2, created_by: 'usr_test', updated_by: 'usr_test',
        created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-10T00:00:00Z'
      }];
      else if (path === '/api/v1/admin/skill-spaces/account-grants') data = [{
        user_id: 'usr_1', name: '张三', email: 'zhang@example.com', account_status: 'active',
        actions: ['read'], joined_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-10T00:00:00Z'
      }];
      else if (path === '/api/v1/admin/data-resource-grants/role-members/search') data = [{ role_id: 'readers', name: '查看组', actions: ['read'], granted: true, updated_at: '2026-10-10T00:00:00Z' }];
      else if (path === '/api/v1/admin/data-resource-grants/role-candidates/search') data = [{ role_id: 'writers', name: '编写组' }];
      else if (path === '/api/v1/admin/data-resource-grants' || path === '/api/v1/admin/data-resource-grants/remove') {
        mutations.push({ method: route.request().method(), body: route.request().postDataJSON() });
        data = {};
      } else { data = {}; meta = { ...meta, total: 0 }; }
      await route.fulfill({ json: { data, meta } });
    });
    await page.goto('/admin/skills');
    await page.getByRole('button', { name: '管理研发技能空间授权' }).click();
    const drawer = page.getByRole('dialog', { name: '研发技能' });
    await expect(drawer.getByText('直接授权 1 位账户')).toBeVisible();
    await expect(drawer.getByText('有效授权 7 人')).toBeVisible();
    await drawer.getByRole('tab', { name: '角色授权' }).click();
    await expect(drawer.getByText('查看组', { exact: true })).toBeVisible();
    await expect(drawer.getByText('授权角色 1 个')).toBeVisible();
    expect(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`skill-space-roles-${viewport.width}.png`), fullPage: true });
    await drawer.getByRole('button', { name: '添加角色授权' }).click();
    const addDialog = page.getByRole('dialog', { name: '添加角色授权' });
    await addDialog.getByRole('button', { name: '选择授权角色' }).click();
    await page.getByRole('option', { name: /编写组/ }).click();
    await addDialog.getByRole('button', { name: '添加 1 个角色' }).click();
    await expect(addDialog).not.toBeVisible();
    await drawer.getByRole('button', { name: '编辑查看组角色授权' }).click();
    const editDialog = page.getByRole('dialog', { name: '编辑角色授权' });
    await editDialog.getByRole('checkbox', { name: '上传技能' }).check();
    await editDialog.getByRole('button', { name: '保存' }).click();
    await expect(editDialog).not.toBeVisible();
    await drawer.getByRole('button', { name: '删除查看组角色授权' }).click();
    const confirm = page.getByRole('dialog', { name: '删除角色授权' });
    await expect(confirm.getByText(/其他直接或角色授权来源仍然保留/)).toBeVisible();
    await confirm.getByRole('button', { name: '确认删除' }).click();
    await expect(confirm).not.toBeVisible();
    expect(mutations).toEqual([
      { method: 'POST', body: { role_id: 'writers', resource_type: 'skill_space', resource_id: 'space_dev', actions: ['read', 'write'] } },
      { method: 'PUT', body: { role_id: 'readers', resource_type: 'skill_space', resource_id: 'space_dev', actions: ['read', 'write'] } },
      { method: 'POST', body: { role_id: 'readers', resource_type: 'skill_space', resource_id: 'space_dev' } }
    ]);
    await drawer.getByRole('tab', { name: '账户授权' }).click();
    await expect(drawer.getByText('zhang@example.com')).toBeVisible();
  });
}
