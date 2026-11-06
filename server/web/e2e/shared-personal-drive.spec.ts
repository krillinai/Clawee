import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });
const space = { space_id: 'space_personal', name: '员工网盘', description: '', personal_owner_user_id: 'employee', personal_owner_name: '张三', personal_owner_email: 'zhang@example.com', member_count: 1, file_count: 1, size_bytes: 6, updated_at: '2026-10-29T00:00:00Z' };
const file = { file_id: 'file_report', space_id: space.space_id, logical_path: 'tasks/run/report.txt', file_name: 'report.txt', size_bytes: 6, content_type: 'text/plain', revision: 1, updated_by_user_id: 'server', updated_by_user_name: '服务端', updated_at: space.updated_at };

for (const contentAllowed of [true, false]) {
  test(`员工筛选与文件内容门禁 ${contentAllowed ? '有内容权限' : '仅元数据权限'}`, async ({ page }) => {
    const queries: URLSearchParams[] = [];
    let previewRequests = 0;
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url());
      let data: unknown = {};
      if (url.pathname === '/api/v1/auth/me') data = {
        account: { user_id: 'admin', email: 'admin@example.com', name: '管理员', status: 'active' },
        admin_permissions: [permissions.sharedFilesRead, permissions.accountRead, permissions.sharedFilesMemberCreate, ...(contentAllowed ? [permissions.sharedFilesDownload] : [])],
        applications: { admin: true, frontend: true }
      };
      else if (url.pathname === '/api/v1/admin/accounts') data = [{ user_id: 'employee', name: '张三', email: 'zhang@example.com', status: 'active' }];
      else if (url.pathname === '/api/v1/admin/shared-spaces') {
        queries.push(url.searchParams);
        return route.fulfill({ json: { data: [space], meta: { has_next: false, next_cursor: '' } } });
      }
      else if (url.pathname === '/api/v1/admin/shared-spaces/detail') data = space;
      else if (url.pathname === '/api/v1/admin/shared-files') return route.fulfill({ json: { data: [file], meta: { has_next: false, next_cursor: '' } } });
      else if (url.pathname === '/api/v1/admin/shared-files/content') {
        if (url.searchParams.get('preview') === '1') {
          previewRequests++;
          return route.fulfill({ contentType: 'text/plain', body: '交付报告内容' });
        }
        return route.fulfill({ contentType: 'text/plain', headers: { 'content-disposition': 'attachment; filename="report.txt"' }, body: 'report' });
      }
      await route.fulfill({ json: { data } });
    });
    await page.goto('/admin/shared-files');
    await expect(page.getByText('张三', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '管理员工网盘成员授权' })).toHaveCount(0);
    await page.getByLabel('所属员工', { exact: true }).selectOption('employee');
    await expect.poll(() => queries.at(-1)?.get('personal_owner_user_id')).toBe('employee');
    await page.getByRole('link', { name: '管理员工网盘文件' }).click();
    await expect(page.getByText('report.txt', { exact: true })).toBeVisible();
    if (contentAllowed) {
      await page.getByRole('button', { name: '预览文件 report.txt' }).click();
      await expect(page.getByText('交付报告内容')).toBeVisible();
      await page.keyboard.press('Escape');
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '下载文件 report.txt' }).click()]);
      expect(download.suggestedFilename()).toBe('report.txt');
      expect(previewRequests).toBeGreaterThan(0);
    } else {
      await expect(page.getByRole('button', { name: '预览文件 report.txt' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: '下载文件 report.txt' })).toHaveCount(0);
      expect(previewRequests).toBe(0);
    }
    await page.getByRole('link', { name: '返回网盘' }).click();
    await expect(page).toHaveURL(/personal_owner_user_id=employee/);
    await expect(page.getByLabel('所属员工', { exact: true })).toHaveValue('employee');
  });
}
