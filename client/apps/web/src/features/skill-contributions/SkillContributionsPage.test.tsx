import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SkillContributionRecord, SkillContributionResponse } from '@clawee/protocol';
import { RuntimeClient, ApiClientError } from '../../runtime/client.js';
import type { createEnterpriseService } from '../../services/enterprise-service-2026-07-30.js';
import { SkillContributionsPage } from './SkillContributionsPage.js';

vi.mock('./ContributionConversation.js', () => ({ ContributionConversation: () => <section aria-label="贡献对话">对话</section> }));

const record: SkillContributionRecord = {
  id: 'fact-1', employee_id: 'employee-1', employee_name: '同名员工', skill_id: 'skill-1', skill_name: '月报', version_id: 'version-1', version: '1', space_id: 'space-1', source: 'app_upload', approval_id: 'approval-1', occurred_at: '2026-10-12T08:00:00Z', status: 'approved', scoring_standard_version: 'manual-v1', scores: { scenario_value: 4, result_effectiveness: 4, ease_of_use: 4, reuse_value: 4, total: 16 }, approvers: [], entity_available: true, history_status: 'covered'
};
const response: SkillContributionResponse = {
  query: {}, timezone: 'Asia/Shanghai', generated_at: '2026-10-13T08:00:00Z', coverage: { first_approvals_from: '2026-10-01T00:00:00Z', uploads_from: null, notice: '历史覆盖有限' }, items: [record], total: 101
};

function fixture(failSummary = false) {
  const getSkillContributions = vi.fn(async (endpoint: string) => {
    if (endpoint === 'summary') {
      if (failSummary) throw new Error('不可用');
      return { ...response, summary: { uploads: 101, first_approvals: 2, contributors: 1, scored_count: 2, average_score: 16 } };
    }
    return response;
  });
  const service = { getSkillContributions, exportSkillContributions: vi.fn() } as unknown as ReturnType<typeof createEnterpriseService>;
  const onDenied = vi.fn();
  const onBack = vi.fn();
  render(<SkillContributionsPage service={service} client={new RuntimeClient({ baseUrl: 'http://localhost:9999' })} connection={{ baseUrl: 'http://localhost:9999' }} subscribe={async () => undefined} modelReady={false} onDenied={onDenied} onBack={onBack} />);
  return { service, getSkillContributions, onDenied, onBack };
}

describe('Skill 贡献面板', () => {
  it('标题栏保留刷新并可返回工作台', async () => {
    const { onBack } = fixture();
    await screen.findByText('月报');
    expect(screen.getByLabelText('刷新')).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '返回工作台' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
  it('概览来自全量，状态和分页不会改变概览条件', async () => {
    const { getSkillContributions } = fixture();
    await screen.findByText('101');
    fireEvent.change(screen.getByLabelText('最低总分'), { target: { value: '16' } });
    await waitFor(() => expect(getSkillContributions).toHaveBeenLastCalledWith('records', expect.objectContaining({ min_total_score: 16 })));
    expect(getSkillContributions.mock.calls.filter(([endpoint]) => endpoint === 'summary')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('下一页'));
    await waitFor(() => expect(getSkillContributions).toHaveBeenLastCalledWith('records', expect.objectContaining({ page: 2 })));
    expect(getSkillContributions.mock.calls.filter(([endpoint]) => endpoint === 'summary')).toHaveLength(1);
  });
  it('模型不可用仍保留筛选、详情和直接导出', async () => {
    const { getSkillContributions } = fixture();
    await screen.findByText('月报');
    expect(screen.getByRole('button', { name: '导出 CSV' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '月报' }));
    await waitFor(() => expect(getSkillContributions).toHaveBeenLastCalledWith('detail', { version_id: 'version-1' }));
    expect(screen.getByRole('dialog', { name: '审核详情' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('概览异常不能展示为零或未评分', async () => {
    fixture(true);
    await screen.findByText('概览加载失败');
    expect(screen.queryByText('未评分')).not.toBeInTheDocument();
  });
  it('权限撤销后通知上层清理页面', async () => {
    const { service, onDenied } = fixture();
    await screen.findByText('月报');
    vi.mocked(service.getSkillContributions).mockRejectedValue(new ApiClientError({ status: 403, code: 'ENTERPRISE_DATA_VIEW_FORBIDDEN', message: '禁止' }));
    fireEvent.click(screen.getByLabelText('刷新'));
    await waitFor(() => expect(onDenied).toHaveBeenCalled());
  });
});
