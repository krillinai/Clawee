import { expect, test } from '@playwright/test';

test.use({ headless: true });

const instance = {
  id: 'instance-e2e', template_id: 'template-e2e', template_revision: 3, status: 'succeeded',
  started_by: 'usr_test', started_at: '2026-09-22T04:00:00Z', ended_at: '2026-09-22T04:05:00Z',
  nodes: [
    { node_id: 'agent-1', order: 0, type: 'agent', title: '整理内容', instruction: '整理输入主题', assignee_user_id: 'usr_test' },
    { node_id: 'approval-1', order: 1, type: 'approval', title: '人工审核', instruction: '确认整理结果', assignee_user_id: 'usr_test' }
  ],
  tasks: [
    { task_id: 'task-1', node_id: 'agent-1', status: 'completed', assignee_user_id: 'usr_test', input: { text: '测试主题' }, output: { text: '**整理完成**\n\n- 要点一\n- 要点二\n\n[来源](https://example.com)' }, handled_by: 'usr_test', completed_at: '2026-09-22T04:03:00Z' },
    { task_id: 'task-2', node_id: 'approval-1', status: 'completed', assignee_user_id: 'usr_test', input: { text: '整理完成' }, output: { text: '整理完成' }, decision: 'approve', comment: '通过验收', handled_by: 'usr_test', completed_at: '2026-09-22T04:05:00Z' }
  ]
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`工作流实例详情展示节点正文 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === '/api/v1/auth/me') data = { account: { user_id: 'usr_test', email: 'test@example.com', name: '测试管理员', status: 'active' }, admin_permissions: ['console:workflow:instance_read'], applications: { admin: true, frontend: true } };
      else if (path === '/api/v1/admin/workflow-instances') data = [instance];
      else if (path === '/api/v1/admin/workflow-instances/instance-e2e') data = instance;
      await route.fulfill({ json: { data, meta: { next_cursor: '', has_next: false } } });
    });
    await page.goto('/admin/workflow-instances');
    await page.getByRole('link', { name: '查看实例 instance-e2e 详情' }).click();
    await expect(page).toHaveURL(/\/admin\/workflow-instances\/instance-e2e$/);
    await expect(page.getByRole('heading', { name: '实例 instance-e2e' })).toBeVisible();
    await page.getByRole('button', { name: '展开节点“整理内容”的内容' }).click();
    await expect(page.getByText('测试主题')).toBeVisible();
    await expect(page.getByText('要点二')).toBeVisible();
    await expect(page.getByRole('link', { name: '来源' })).toHaveAttribute('href', 'https://example.com');
    await page.getByRole('button', { name: '展开节点“人工审核”的内容' }).click();
    await expect(page.getByText('审批：批准 · 通过验收')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workflow-instance-${viewport.width}.png`), fullPage: true });
  });
}
