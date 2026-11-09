import type { EnterpriseWorkflowInstance, EnterpriseWorkflowTask } from '@clawee/protocol';
import { test, expect } from './fixtures/workflow-runtime.js';
import { workflowAccount, workflowTemplate } from './support/workflow-gateway.js';

test('工作流 Markdown 预览、原文切换与历史查看保留吸底审批栏', async ({ page, runtime }, testInfo) => {
  const markdown = '# 新闻推荐\n\n推荐 **本周产品动态**。\n\n'
    + Array.from({ length: 12 }, (_, index) => `## 新闻 ${index + 1}\n\n- 模型发布与产品更新\n- 核对来源后发布\n\n`).join('')
    + '| 产品 | 说明 |\n| --- | --- |\n| 便携款 | ' + '连续长文本'.repeat(30) + ' |\n\n'
    + '```json\n{"title":"' + '连续代码'.repeat(40) + '"}\n```';
  const approval: EnterpriseWorkflowTask = {
    task_id: 'preview-approval', instance_id: 'preview-instance', node_id: workflowTemplate.nodes[1]!.node_id,
    type: 'approval', status: 'pending', instruction: '审核新闻推荐',
    input: { text: markdown }, assignee_user_ids: [workflowAccount.account_id]
  };
  const detail: EnterpriseWorkflowInstance = {
    id: approval.instance_id, template_id: workflowTemplate.id, status: 'running',
    current_node_id: approval.node_id, started_at: '2026-10-14T00:00:00Z', nodes: workflowTemplate.nodes,
    instance_path_prefix: 'instances/preview-instance/',
    tasks: [{
      ...approval, task_id: 'preview-agent', node_id: workflowTemplate.nodes[0]!.node_id,
      type: 'agent', status: 'completed', input: { text: '整理新闻' }, output: { text: markdown },
      artifacts: [{ file_id: 'preview-file', file_name: 'result.md', logical_path: 'instances/preview-instance/nodes/agent/result.md', revision: 1, sha256: 'a'.repeat(64) }]
    }, approval], user_names: { [workflowAccount.account_id]: workflowAccount.name }
  };
  let mutations = 0;
  await page.route(/\/enterprise\/workflow-(tasks|instances)(\/|\?)/, async route => {
    if (route.request().method() !== 'GET') { mutations++; await route.fallback(); return; }
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith(`/workflow-instances/${detail.id}`) ? { data: detail }
      : { data: path.endsWith('/workflow-tasks') ? [approval] : [detail], meta: { next_cursor: '', has_next: false } };
    await route.fulfill({ json });
  });
  await runtime.openApp(page);
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
  }
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await page.getByRole('button', { name: /审批 · 审核新闻推荐/ }).click();
  const node = page.getByRole('region', { name: '节点详情', exact: true });
  const dock = page.locator('footer[aria-label="当前审批"]');
  await expect(node.getByRole('heading', { name: '新闻推荐', exact: true })).toBeVisible();
  await dock.getByRole('textbox', { name: '审批意见', exact: true }).fill('内容已核对');
  const dockPosition = await dock.boundingBox();
  expect(dockPosition).not.toBeNull();
  await page.getByText('正式结果文件', { exact: true }).click();
  await page.getByText('目录详情', { exact: true }).click();
  await expect(page.getByText('result.md · 版本 1', { exact: true })).toBeVisible();
  await node.getByRole('table').scrollIntoViewIfNeeded();
  await expect(node.getByRole('table')).toBeVisible();
  await expect(dock.getByRole('button', { name: '批准', exact: true })).toBeInViewport();
  expect((await dock.boundingBox())?.y).toBeCloseTo(dockPosition!.y, 0);
  await expect(node.locator('.md-code')).toHaveText('{"title":"' + '连续代码'.repeat(40) + '"}');
  await node.getByRole('group', { name: '待审批内容显示方式' }).getByRole('button', { name: '原文', exact: true }).click();
  expect(await node.locator('.workflow-data > pre').textContent()).toBe(markdown);
  await node.getByRole('group', { name: '待审批内容显示方式' }).getByRole('button', { name: '预览', exact: true }).click();
  await page.getByRole('button', { name: /查看节点：生成待审核材料/ }).click();
  await expect(node.getByRole('heading', { name: '新闻推荐', exact: true })).toBeVisible();
  await node.getByRole('group', { name: '输出显示方式' }).getByRole('button', { name: '原文', exact: true }).click();
  expect(await node.locator('.workflow-data > pre').last().textContent()).toBe(markdown);
  await node.getByRole('group', { name: '输出显示方式' }).getByRole('button', { name: '预览', exact: true }).click();
  await node.getByRole('table').scrollIntoViewIfNeeded();
  await expect(dock.getByRole('textbox', { name: '审批意见', exact: true })).toHaveValue('内容已核对');
  await expect(dock.getByRole('button', { name: '批准', exact: true })).toBeInViewport();
  expect((await dock.boundingBox())?.y).toBeCloseTo(dockPosition!.y, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workflow-preview.png') });
  await page.getByRole('button', { name: '返回当前节点', exact: true }).click();
  await expect(node.getByRole('group', { name: '待审批内容显示方式' }).getByRole('button', { name: '预览', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('workflow-approval.png') });
  expect(mutations).toBe(0);
  expect(runtime.readInvocationCount()).toBe(0);
});
