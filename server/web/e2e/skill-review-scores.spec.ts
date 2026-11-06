import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }];
for (const { viewport, withAI } of viewports.flatMap(viewport => [false, true].map(withAI => ({ viewport, withAI })))) {
  test(`技能审核数字单选评分 ${viewport.width}${withAI ? ' 含 AI 建议' : ''}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const submissions: unknown[] = [];
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === '/api/v1/auth/me') data = {
        account: { user_id: 'usr_test', email: 'test@example.com', name: '测试审核人', status: 'active' },
        admin_permissions: [permissions.skillRead], applications: { admin: true, frontend: true }
      };
      else if (path === '/api/v1/admin/skill-spaces') data = [{
        space_id: 'space_test', name: '审核测试空间', description: '',
        approvers: [{ user_id: 'usr_test', name: '测试审核人' }], actions: ['read'],
        member_count: 1, skill_count: 1, published_count: 0, created_by: 'usr_test', updated_by: 'usr_test',
        created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z'
      }];
      else if (path === '/api/v1/admin/skills') data = [{
        skill_id: 'skill_test', space_id: 'space_test', space_name: '审核测试空间',
        name: '评分测试技能', description: '', current_version_id: null,
        created_by: 'usr_writer', created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
        latest_version: {
          version_id: 'version_test', version: '1.0.0', approval_status: 'pending', uploaded_by_user_id: 'usr_writer',
          local_approval: { request_id: 'request_test', status: 'pending', total: 1, approved: 0,
            ...(withAI ? { ai_review: {
              status: 'completed', attempt_id: 'attempt_test', agent_id: 'agent_test', updated_at: '2026-10-10T00:00:00Z',
              review_skill_version: '1.0.0', review_skill_sha256: 'a'.repeat(64),
              report: {
                conclusion: 'recommend_approve', summary: '该技能面向发布说明整理场景，输入要求和输出结构清晰，具备跨项目复用价值。建议结合实际发布记录核对边界情况。',
                findings: [{ severity: 'warning', message: '建议补充空提交记录时的输出示例，帮助使用者理解无变更的处理方式。', path: `references/${'release-checklist-'.repeat(12)}example.md` }],
                suggested_scores: { scenario_value: 5, result_effectiveness: 4, ease_of_use: 3, reuse_value: 5 }
              }
            } } : {}),
            approvers: [{ user_id: 'usr_test', name: '测试审核人', status: 'pending', comment: '', decided_at: null }] }
        }
      }];
      else if (path === '/api/v1/admin/skills/versions/review') {
        submissions.push(route.request().postDataJSON());
        data = { version_id: 'version_test', skill_id: 'skill_test', version: '1.0.0', description: '', changelog: '', package_sha256: 'digest', source: null, created_at: '2026-10-10T00:00:00Z' };
      }
      await route.fulfill({ json: { data, meta: { page: 1, page_size: 20, total: 1 } } });
    });
    await page.goto('/admin/skills?space_id=space_test');
    await expect(page.getByRole('button', { name: '审批通过 评分测试技能' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '驳回 评分测试技能' })).toHaveCount(0);
    await page.getByRole('button', { name: '技能审核 评分测试技能' }).click();
    const dialog = page.getByRole('dialog', { name: '技能审核', exact: true });
    const confirm = dialog.getByRole('button', { name: '通过审核' });
    const reject = dialog.getByRole('button', { name: '驳回审核' });
    const scenario = dialog.getByRole('radiogroup', { name: '场景价值' });
    await expect(dialog.getByRole('radiogroup')).toHaveCount(4);
    await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(confirm).toBeDisabled();
    await expect(reject).toBeDisabled();
    await expect(dialog.getByLabel('审批意见')).toHaveValue('');
    const advice = dialog.getByRole('region', { name: 'AI 审核建议' });
    if (withAI) {
      await expect(advice.getByText('建议通过', { exact: true })).toBeVisible();
      await expect(dialog.getByText('AI 建议：5 / 5', { exact: true })).toHaveCount(2);
      await dialog.screenshot({ path: testInfo.outputPath(`skill-review-ai-${viewport.width}.png`) });
      const findings = advice.getByRole('button', { name: '查看审核关注项（1）' });
      await expect(findings).toHaveAttribute('aria-expanded', 'false');
      await findings.click();
      await expect(advice.getByText(/建议补充空提交记录/)).toBeVisible();
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await dialog.screenshot({ path: testInfo.outputPath(`skill-review-ai-expanded-${viewport.width}.png`) });
      await findings.click();
      expect(submissions).toEqual([]);
    } else {
      await expect(advice).toHaveCount(0);
    }
    await expect(dialog.getByRole('button', { name: '清空场景价值评分' })).toBeDisabled();
    await scenario.getByRole('radio', { name: '2 分' }).click();
    await page.keyboard.down('ArrowRight');
    await expect(scenario.getByRole('radio', { name: '3 分' })).toBeChecked();
    await expect(scenario.getByRole('radio', { name: '3 分' })).toBeFocused();
    await page.keyboard.up('ArrowRight');
    await page.keyboard.down('ArrowLeft');
    await expect(scenario.getByRole('radio', { name: '2 分' })).toBeChecked();
    await page.keyboard.up('ArrowLeft');
    await scenario.getByRole('radio', { name: '2 分' }).click();
    await expect(scenario.getByRole('radio', { name: '2 分' })).toBeChecked();
    for (const label of ['结果有效', '使用友好', '复用价值']) {
      await dialog.getByRole('radiogroup', { name: label }).getByRole('radio', { name: '4 分' }).click();
    }
    await expect(confirm).toBeEnabled();
    await dialog.getByRole('button', { name: '清空场景价值评分' }).click();
    await expect(scenario.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(confirm).toBeDisabled();
    await scenario.getByRole('radio', { name: '5 分' }).click();
    await expect(confirm).toBeEnabled();
    for (const group of await dialog.getByRole('radiogroup').all()) {
      expect(await group.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath(`skill-review-scores-${viewport.width}.png`) });
    await confirm.click();
    await expect(dialog).not.toBeVisible();
    expect(submissions).toEqual([{ skill_id: 'skill_test', version_id: 'version_test', request_id: 'request_test', decision: 'approved', comment: '',
      scores: { scenario_value: 5, result_effectiveness: 4, ease_of_use: 4, reuse_value: 4 } }]);

    await page.getByRole('button', { name: '技能审核 评分测试技能' }).click();
    await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(0);
    await scenario.getByRole('radio', { name: '2 分' }).click();
    await dialog.getByLabel('审批意见').fill('   ');
    await expect(reject).toBeDisabled();
    await dialog.getByLabel('审批意见').fill('  请补充输入示例  ');
    await expect(confirm).toBeDisabled();
    await expect(reject).toBeEnabled();
    await reject.scrollIntoViewIfNeeded();
    await expect(reject).toBeInViewport();
    await expect(confirm).toBeInViewport();
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await reject.click();
    await expect(dialog).not.toBeVisible();
    expect(submissions[1]).toEqual({ skill_id: 'skill_test', version_id: 'version_test', request_id: 'request_test', decision: 'rejected', comment: '请补充输入示例', scores: { scenario_value: 2 } });
  });
}
