import type { EnterpriseApprovalDetail, EnterpriseApprovalItem } from '@clawee/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../runtime/client.js';
import type { EnterpriseApprovalService } from '../../services/enterprise-approval-service.js';
import { EnterpriseApprovalsPage } from './EnterpriseApprovalsPage.js';

const item: EnterpriseApprovalItem = { kind: 'skill', id: 'review-1', type: 'skill', title: '日报 Skill', version_id: 'version-1', version: '1.0', my_status: 'pending', business_status: 'pending', can_process: true, created_at: '2026-10-27T00:00:00Z' };
const detail: EnterpriseApprovalDetail = {
  item,
  skill: { skill: { name: '日报 Skill', description: '' }, versions: [{ version_id: 'version-1', version: '1.0', description: '生成日报', changelog: '补充示例', local_approval: {
    request_id: 'review-1', status: 'pending', total: 2, approved: 0,
    ai_review: { status: 'completed', attempt_id: 'attempt-1', report: { conclusion: 'recommend_approve', summary: '审核内容完整', findings: [] } },
    approvers: [{ user_id: 'a', name: '张三', status: 'pending', comment: '', decided_at: null }]
  }, package_sha256: 'a'.repeat(64) }] }
};
const meta = { has_next: false, next_cursor: '' };
function serviceFor(): EnterpriseApprovalService {
  return {
    list: vi.fn(async () => ({ data: [item], meta })), detail: vi.fn(async () => ({ data: structuredClone(detail) })),
    files: vi.fn(async () => ({ items: [{ path: 'SKILL.md', size: 20 }] })), file: vi.fn(async () => ({ data: { path: 'SKILL.md', size: 20, content: '# 本轮原始内容' } })),
    skillDecision: vi.fn(async () => ({})), workflowDecision: vi.fn(async () => ({ data: { instance_id: 'instance-1', task_id: 'task-1', status: 'running' } })), trial: vi.fn(async () => ({ trialId: 'trial-1', projectId: 'project-1', skillName: '日报 Skill', version: '1.0', expiresAt: '2026-10-27T02:00:00Z' }))
  };
}
const baseProps = { signedIn: true, online: true, identityKey: 'gateway:a', onOpenAccount: vi.fn(), onNavigationChange: vi.fn() };
async function openItem() { fireEvent.click(await screen.findByRole('button', { name: /日报 Skill/ })); await screen.findByRole('heading', { name: /日报 Skill/ }); }

describe('客户端审批中心', () => {
  beforeEach(() => sessionStorage.clear());
  it('默认选择首条审批，刷新保留手动选择，返回列表后不强制重开详情', async () => {
    const second = { ...item, id: 'review-2', title: '第二条审批', can_process: false };
    const service = serviceFor();
    service.list = vi.fn(async () => ({ data: [item, second], meta }));
    service.detail = vi.fn(async (_kind, id) => ({ data: { ...detail, item: id === second.id ? second : item } }));
    render(<EnterpriseApprovalsPage {...baseProps} service={service} />);
    const list = within(screen.getByRole('region', { name: '审批列表' }));
    await waitFor(() => expect(list.getByRole('button', { name: /日报 Skill/ })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(list.getByRole('button', { name: /第二条审批/ }));
    expect(await screen.findByRole('heading', { name: /第二条审批/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新审批中心' }));
    await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
    expect(list.getByRole('button', { name: /第二条审批/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
    fireEvent.focus(window);
    await waitFor(() => expect(service.list).toHaveBeenCalledTimes(3));
    expect(list.getByRole('button', { name: /第二条审批/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('heading', { name: /第二条审批/ })).not.toBeInTheDocument();
  });

  it('筛选和翻页后选择新列表首项，空列表清除旧详情', async () => {
    const second = { ...item, id: 'review-2', title: '第二页审批', can_process: false };
    const service = serviceFor();
    service.list = vi.fn(async filters => ({ data: filters.view === 'done' ? [] : [filters.cursor ? second : item],
      meta: filters.cursor ? meta : { has_next: true, next_cursor: 'page-2' } }));
    service.detail = vi.fn(async (_kind, id) => ({ data: { ...detail, item: id === second.id ? second : item } }));
    render(<EnterpriseApprovalsPage {...baseProps} service={service} />);
    expect(await screen.findByRole('heading', { name: /日报 Skill/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('heading', { name: /第二页审批/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '已办' }));
    await screen.findByText('暂无审批记录');
    expect(screen.queryByRole('heading', { name: /第二页审批/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '待办' }));
    expect(await screen.findByRole('heading', { name: /日报 Skill/ })).toBeInTheDocument();
  });

  it('按待办、已办、我发起及类型状态查询，查看本轮文件和 AI 报告', async () => {
    const service = serviceFor();
    render(<EnterpriseApprovalsPage {...baseProps} service={service} />);
    await openItem();
    expect(await screen.findByRole('heading', { name: '本轮原始内容' })).toBeInTheDocument();
    expect(screen.getByText('审核内容完整')).toBeInTheDocument();
    expect(service.files).toHaveBeenCalledWith('review-1', expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button', { name: '已办' }));
    await waitFor(() => expect(service.list).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'done', cursor: '' }), expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole('button', { name: '我发起' }));
    fireEvent.change(screen.getByRole('combobox', { name: '类型' }), { target: { value: 'workflow' } });
    fireEvent.change(screen.getByRole('combobox', { name: '整单状态' }), { target: { value: 'running' } });
    await waitFor(() => expect(service.list).toHaveBeenLastCalledWith({ view: 'initiated', type: 'workflow', status: 'running', cursor: '' }, expect.any(AbortSignal)));
  });
  it('按文件列表切换并预览本轮文本文件', async () => {
    const service = serviceFor();
    service.files = vi.fn(async () => ({ items: [{ path: 'SKILL.md', size: 20 }, { path: 'README.txt', size: 12 }] }));
    service.file = vi.fn(async (_id, path) => ({ data: { path, size: path === 'SKILL.md' ? 20 : 12, content: path === 'SKILL.md' ? '# 本轮原始内容' : '补充说明' } }));
    render(<EnterpriseApprovalsPage {...baseProps} service={service} />);
    await openItem();
    const files = screen.getByRole('navigation', { name: '审核文件' });
    fireEvent.click(within(files).getByRole('button', { name: /README.txt/ }));
    await waitFor(() => expect(screen.getByText('补充说明')).toBeInTheDocument());
    expect(within(files).getByRole('button', { name: /README.txt/ })).toHaveAttribute('aria-pressed', 'true');
  });
  it('按当前审批版本选择项目并启动试用', async () => {
    const service = serviceFor();
    const onTrial = vi.fn(async () => {});
    render(<EnterpriseApprovalsPage {...baseProps} service={service} projects={[{ id: 'project-1', name: '测试项目', cwd: '/tmp/project' }]} currentProjectId="project-1" onTrial={onTrial} />);
    await openItem();
    fireEvent.click(screen.getByRole('button', { name: '下载并试用' }));
    fireEvent.click(screen.getByRole('button', { name: '使用所选项目' }));
    await waitFor(() => expect(onTrial).toHaveBeenCalledWith('review-1', 'project-1'));
  });
  it('已结束的审批不显示试用入口', async () => {
    const service = serviceFor();
    service.list = vi.fn(async () => ({ data: [{ ...item, business_status: 'approved', can_process: false }], meta }));
    service.detail = vi.fn(async () => ({ data: { ...detail, item: { ...item, business_status: 'approved', can_process: false } } }));
    render(<EnterpriseApprovalsPage {...baseProps} service={service} projects={[{ id: 'project-1', name: '测试项目', cwd: '/tmp/project' }]} onTrial={vi.fn()} />);
    await openItem();
    expect(screen.queryByRole('button', { name: '下载并试用' })).not.toBeInTheDocument();
  });
  it('通过需完整评分，提交后刷新待办；多人审核清楚区分本人和整体结果', async () => {
    const service = serviceFor();
    service.skillDecision = vi.fn(async () => {
      service.detail = vi.fn(async () => ({ data: { ...detail, item: { ...item, my_status: 'approved' as const, can_process: false } } }));
      return {};
    });
    render(<EnterpriseApprovalsPage {...baseProps} service={service} />); await openItem();
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    expect(screen.getByRole('button', { name: '确认通过' })).toBeDisabled();
    for (const label of ['场景价值', '结果有效', '使用友好', '复用价值']) fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }));
    await waitFor(() => expect(service.skillDecision).toHaveBeenCalledWith('review-1', { decision: 'approved', comment: '', scores: { scenario_value: 4, result_effectiveness: 4, ease_of_use: 4, reuse_value: 4 } }));
    expect(await screen.findByText('我已通过，仍待其他审核人处理')).toBeInTheDocument();
    expect(service.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: '确认通过' })).not.toBeInTheDocument();
  });
  it('驳回意见不可为空白；审核轮次或版本不匹配时禁用处理', async () => {
    const service = serviceFor();
    const view = render(<EnterpriseApprovalsPage {...baseProps} service={service} />); await openItem();
    fireEvent.click(screen.getByRole('button', { name: '驳回' }));
    fireEvent.change(screen.getByRole('textbox', { name: '审批意见' }), { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: '确认驳回' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '审批意见' }), { target: { value: '缺少输入说明' } });
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }));
    await waitFor(() => expect(service.skillDecision).toHaveBeenCalledWith('review-1', { decision: 'rejected', comment: '缺少输入说明', scores: {} }));
    view.unmount();
    service.detail = vi.fn(async () => ({ data: { ...detail, item: { ...item, version_id: 'other-version' } } }));
    render(<EnterpriseApprovalsPage {...baseProps} service={service} />); await openItem();
    expect(screen.getByText('本轮审核内容不可用，仅可查看审批状态')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '处理审批' })).not.toBeInTheDocument();
  });
  it('工作流提交失败后恢复原输入重试，重复点击仅提交一次，409 后阻止继续处理', async () => {
    const service = serviceFor();
    const workflowItem: EnterpriseApprovalItem = { ...item, kind: 'workflow', type: 'workflow', id: 'task-1' };
    service.list = vi.fn(async () => ({ data: [workflowItem], meta }));
    service.detail = vi.fn(async () => ({ data: { item: workflowItem, task: { task_id: 'task-1', instance_id: 'instance-1', node_id: 'review', type: 'approval' as const, status: 'pending', instruction: '审核日报', input: { text: '原始审批内容' } } } }));
    let reject!: (error: Error) => void;
    service.workflowDecision = vi.fn(() => new Promise<Awaited<ReturnType<EnterpriseApprovalService['workflowDecision']>>>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const view = render(<EnterpriseApprovalsPage {...baseProps} service={service} />); await openItem();
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    fireEvent.change(screen.getByRole('textbox', { name: '审批意见' }), { target: { value: '原始意见' } });
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }));
    fireEvent.click(screen.getByRole('button', { name: '提交中…' }));
    expect(service.workflowDecision).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('网络中断')));
    const first = vi.mocked(service.workflowDecision).mock.calls[0]!;
    expect(first).toEqual(['task-1', 'approve', '原始意见', expect.any(String)]);
    view.unmount();
    render(<EnterpriseApprovalsPage {...baseProps} service={service} />); await openItem();
    expect(screen.getByRole('textbox', { name: '审批意见' })).toHaveValue('原始意见');
    expect(screen.getByRole('textbox', { name: '审批意见' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试原提交' }));
    expect(vi.mocked(service.workflowDecision).mock.calls[1]).toEqual(first);
    await act(async () => reject(new ApiClientError({ status: 409, code: 'CONFLICT', message: '状态变化' })));
    expect(screen.getByRole('button', { name: '重试原提交' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('审批状态已变化');
  });
  it('返回列表保留筛选；前台刷新保留正在填写的意见；换账号清除旧内容', async () => {
    const service = serviceFor();
    const view = render(<EnterpriseApprovalsPage {...baseProps} service={service} />);
    fireEvent.click(screen.getByRole('button', { name: '已办' })); await openItem();
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    fireEvent.change(screen.getByRole('textbox', { name: '审批意见' }), { target: { value: '尚未提交的意见' } });
    fireEvent.focus(window);
    await waitFor(() => expect(service.detail).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox', { name: '审批意见' })).toHaveValue('尚未提交的意见');
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
    expect(screen.getByRole('button', { name: '已办' })).toHaveAttribute('aria-current', 'page');
    view.rerender(<EnterpriseApprovalsPage {...baseProps} service={{ ...service, list: vi.fn(async () => ({ data: [], meta })) }} identityKey="gateway:b" />);
    expect(screen.queryByText('生成日报')).not.toBeInTheDocument();
    await screen.findByText('暂无审核待办');
    expect(within(screen.getByRole('region', { name: '审批列表' })).queryByRole('button', { name: /日报 Skill/ })).not.toBeInTheDocument();
  });
  it('退出登录立即隐藏企业内容，不能继续提交', async () => {
    const service = serviceFor();
    const view = render(<EnterpriseApprovalsPage {...baseProps} service={service} />); await openItem();
    view.rerender(<EnterpriseApprovalsPage {...baseProps} service={service} signedIn={false} />);
    expect(screen.queryByText('生成日报')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录企业账户' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '通过' })).not.toBeInTheDocument();
  });
});
