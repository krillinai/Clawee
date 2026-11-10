import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

const space = { space_id: 'space_workflow', name: '工作流结果', description: '', member_count: 1, file_count: 1, size_bytes: 64, created_by: 'system', created_at: '2026-10-29T00:00:00Z', updated_by: 'system', updated_at: '2026-10-29T00:00:00Z' };
const longLogicalPath = 'instances/45659b68-6104-4ddd-9229-abf39b4e8734/nodes/9a190062d62116ef3bdf08c177e751f11/d091c91fe267d4b0b4d011ae1cd85027d96714b88b6d5f19591a8a/result.json';
const file = { file_id: 'file_result', space_id: space.space_id, logical_path: longLogicalPath, file_name: 'result.json', size_bytes: 64, content_type: 'application/json', revision: 1, updated_by_user_id: 'server', updated_by_user_name: '服务端', updated_at: '2026-10-29T00:00:00Z' };

test('删除确认弹窗中的超长逻辑路径不会撑出弹窗', async ({ page }) => {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    let data: unknown = {};
    if (url.pathname === '/api/v1/auth/me') data = {
      account: { user_id: 'admin', email: 'admin@example.com', name: '管理员', status: 'active' },
      admin_permissions: [permissions.sharedFilesRead, permissions.sharedFilesDelete],
      applications: { admin: true, frontend: true }
    };
    else if (url.pathname === '/api/v1/admin/shared-spaces/detail') data = space;
    else if (url.pathname === '/api/v1/admin/shared-files') return route.fulfill({ json: { data: [file], meta: { has_next: false, next_cursor: '' } } });
    await route.fulfill({ json: { data } });
  });

  await page.goto('/admin/shared-files/detail?space_id=space_workflow');
  await expect(page.getByRole('button', { name: '删除文件 result.json' })).toBeVisible();
  await page.getByRole('button', { name: '删除文件 result.json' }).click();

  const dialog = page.getByRole('dialog', { name: '删除文件' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/将永久删除文件/)).toBeVisible();

  const [dialogBox, descriptionBox, confirmBox] = await Promise.all([
    dialog.boundingBox(),
    dialog.getByText(/将永久删除文件/).boundingBox(),
    dialog.getByRole('button', { name: '永久删除' }).boundingBox()
  ]);
  expect(dialogBox).not.toBeNull();
  expect(descriptionBox).not.toBeNull();
  expect(confirmBox).not.toBeNull();
  if (!dialogBox || !descriptionBox || !confirmBox) throw new Error('弹窗元素缺少布局信息');

  expect(descriptionBox.x).toBeGreaterThanOrEqual(dialogBox.x);
  expect(descriptionBox.x + descriptionBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
  expect(confirmBox.x + confirmBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
});
