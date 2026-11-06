import type { EnterpriseApprovalDetail, EnterpriseApprovalItem } from '@clawee/protocol';
import { test, expect } from './fixtures/workflow-runtime.js';

test('审批中心在宽窄窗口完成 Skill 审核并保留列表筛选', async ({ page, runtime }, testInfo) => {
  const item: EnterpriseApprovalItem = {
    kind: 'skill', id: 'review-controlled', type: 'skill', title: '日报整理', version_id: 'version-controlled', version: '1.0',
    business_status: 'pending', my_status: 'pending', can_process: true, created_at: '2026-10-27T00:00:00Z'
  };
  const detail: EnterpriseApprovalDetail = { item, skill: {
    skill: { name: item.title, description: '日报整理' }, versions: [{
      version_id: item.version_id!, version: '1.0', description: '按模板整理日报', changelog: '补充使用说明',
      local_approval: { request_id: item.id, status: 'pending', total: 2, approved: 0, approvers: [],
        ai_review: { attempt_id: 'attempt-controlled', status: 'completed', report: { conclusion: 'recommend_approve', summary: '材料完整，可人工审核', findings: [] } } }
    }]
  } };
  const submissions: unknown[] = [];
  const markdown = '# 日报使用说明\n\n' + Array.from({ length: 20 }, (_, index) => `## 步骤 ${index + 1}\n\n核对数据后生成日报。\n\n`).join('');
  await page.route(/\/enterprise\/approvals(?:\/|\?|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      submissions.push(request.postDataJSON()); item.my_status = 'approved'; item.can_process = false;
      detail.skill!.versions[0]!.local_approval!.approved = 1;
      await route.fulfill({ json: { data: {} } }); return;
    }
    const json = url.pathname.endsWith('/files') ? { items: [{ path: 'SKILL.md', size: markdown.length }] }
      : url.pathname.endsWith('/file') ? { data: { path: 'SKILL.md', size: markdown.length, content: markdown } }
      : url.pathname.endsWith(`/skill/${item.id}`) ? { data: detail }
      : { data: url.searchParams.get('view') === 'todo' && !item.can_process ? [] : [item], meta: { has_next: false, next_cursor: '' } };
    await route.fulfill({ json });
  });
  await runtime.openApp(page);
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '审批中心', exact: true }).click();
  await expect(page).toHaveURL(/#\/approvals$/);
  await page.getByRole('combobox', { name: '类型', exact: true }).selectOption('skill');
  await page.getByRole('region', { name: '审批列表' }).getByRole('button', { name: /日报整理/ }).click();
  await expect(page.getByRole('heading', { name: '日报使用说明' })).toBeVisible();
  if (testInfo.project.name.includes('mobile')) {
    await expect(page.getByRole('region', { name: '审批列表' })).toBeHidden();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '类型', exact: true })).toHaveValue('skill');
    await page.getByRole('region', { name: '审批列表' }).getByRole('button', { name: /日报整理/ }).click();
  }
  await page.getByRole('button', { name: '通过', exact: true }).click();
  for (const label of ['场景价值', '结果有效', '使用友好', '复用价值']) await page.getByRole('combobox', { name: label, exact: true }).selectOption('4');
  await page.getByRole('textbox', { name: '审批意见', exact: true }).fill('内容已核对');
  await page.getByRole('button', { name: '确认通过', exact: true }).click();
  await expect(page.getByText('我已通过，仍待其他审核人处理', { exact: true })).toBeVisible();
  expect(submissions).toEqual([{ decision: 'approved', comment: '内容已核对', scores: { scenario_value: 4, result_effectiveness: 4, ease_of_use: 4, reuse_value: 4 } }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('approval-center.png') });
  expect(runtime.readInvocationCount()).toBe(0);
});
