import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, Task, Template, WorkflowService } from '../../services/workflow-service.js';
import { WorkflowPage, type WorkflowNavigationState } from './WorkflowPage.js';

const task: Task = {
  task_id: 'task-a', instance_id: 'instance-a', node_id: 'review', type: 'approval',
  status: 'pending', assignee_user_id: 'a', instruction: '审核', input: { text: '私密文本' }
};
const instance: Instance = {
  id: 'instance-a', template_id: 'template-a', status: 'running', current_node_id: 'review',
  started_at: '2026-09-21T00:00:00Z',
  nodes: [{ node_id: 'review', order: 0, type: 'approval', title: '审核', assignee_user_id: 'a', instruction: '审核' }],
  tasks: [task]
};
const meta = { next_cursor: '', has_next: false };

function serviceFor(userId: string): WorkflowService {
  return {
    templates: vi.fn(async () => ({ data: [], meta })),
    instances: vi.fn(async () => ({ data: userId === 'a' ? [instance] : [], meta })),
    tasks: vi.fn(async () => ({ data: userId === 'a' ? [task] : [], meta })),
    instance: vi.fn(async () => ({ data: instance })),
    capability: vi.fn(async () => ({ canExecute: false })),
    decide: vi.fn()
  } as unknown as WorkflowService;
}

describe('WorkflowPage', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('默认打开首条待办，手动选择其他项后刷新保留选择，不执行任务', async () => {
    const second = { ...task, task_id: 'task-b', instance_id: 'instance-b', instruction: '第二条待办' };
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [task, second], meta }));
    service.instance = vi.fn(async id => ({ data: id === second.instance_id ? { ...instance, id, tasks: [second] } : instance }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    const list = within(screen.getByRole('region', { name: '工作流列表' }));
    await waitFor(() => expect(list.getByRole('button', { name: /审批 · 审核/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(await screen.findByText('私密文本')).toBeInTheDocument();
    fireEvent.click(list.getByRole('button', { name: /第二条待办/ }));
    await waitFor(() => expect(list.getByRole('button', { name: /第二条待办/ })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: '刷新工作流' }));
    await waitFor(() => expect(service.instance).toHaveBeenLastCalledWith('instance-b'));
    expect(list.getByRole('button', { name: /第二条待办/ })).toHaveAttribute('aria-pressed', 'true');
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('流程模板进入和翻页时自动打开第一项，空页不保留旧详情', async () => {
    const first: Template = { id: 'template-first', name: '首个模板', description: '', status: 'enabled', revision: 1, nodes: [] };
    const second: Template = { ...first, id: 'template-second', name: '下一页模板' };
    const service = serviceFor('b');
    service.templates = vi.fn(async (cursor = '') => ({ data: cursor === 'empty' ? [] : [cursor ? second : first],
      meta: { has_next: cursor !== 'empty', next_cursor: cursor === 'empty' ? '' : cursor ? 'empty' : 'page-2' } }));
    service.template = vi.fn(async id => ({ data: id === first.id ? first : second }));
    render(<WorkflowPage service={service} signedIn online userId="b" />);
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    expect(await screen.findByRole('heading', { name: first.name, level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^下一页\s*$/ }));
    expect(await screen.findByRole('heading', { name: second.name, level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^下一页\s*$/ }));
    await waitFor(() => expect(service.templates).toHaveBeenLastCalledWith('empty'));
    expect(screen.queryByRole('heading', { name: second.name, level: 2 })).not.toBeInTheDocument();
  });

  it('流程模板详情优先显示负责人昵称', async () => {
    const template: Template = {
      id: 'template-names', name: '昵称模板', description: '', status: 'enabled', revision: 1,
      nodes: [{ node_id: 'review', order: 0, type: 'approval', title: '审核', assignee_user_id: 'a', instruction: '审核' }],
      user_names: { a: '课程开发者' }
    };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /昵称模板/ }));
    const detail = await screen.findByRole('listitem');
    expect(detail).toHaveTextContent('负责人：课程开发者');
    expect(detail).not.toHaveTextContent('负责人：a');
  });

  it('首项详情迟到时不会覆盖用户后来选择的工作流', async () => {
    const second = { ...task, task_id: 'task-b', instance_id: 'instance-b', instruction: '第二条待办' };
    let resolveFirst!: (value: { data: Instance }) => void;
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [task, second], meta }));
    service.instance = vi.fn(id => id === instance.id ? new Promise<{ data: Instance }>(resolve => { resolveFirst = resolve; })
      : Promise.resolve({ data: { ...instance, id, tasks: [second] } }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    await waitFor(() => expect(service.instance).toHaveBeenCalledWith(instance.id));
    const row = screen.getByRole('button', { name: /第二条待办/ });
    fireEvent.click(row);
    await waitFor(() => expect(row).toHaveAttribute('aria-pressed', 'true'));
    await act(async () => resolveFirst({ data: instance }));
    expect(row).toHaveAttribute('aria-pressed', 'true');
  });

  it('导航恢复时不被默认首项覆盖', async () => {
    const service = serviceFor('a');
    const restored = { ...instance, id: 'instance-restored' };
    service.instance = vi.fn(async () => ({ data: restored }));
    render(<WorkflowPage service={service} signedIn online userId="a" navigationState={{
      tab: 'tasks', status: 'running', taskFilter: 'all', instanceId: restored.id,
      cursors: { templates: '', instances: '', tasks: '' },
      history: { templates: [], instances: [], tasks: [] }
    }} />);
    await waitFor(() => expect(service.instance).toHaveBeenCalledWith(restored.id));
    expect(vi.mocked(service.instance).mock.calls.some(([id]) => id === instance.id)).toBe(false);
  });

  it.each(['approve', 'reject'] as const)('HTTP 环境缺少 randomUUID 时仍可 %s，并复用原审批请求重试', async decision => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const service = serviceFor('a');
    service.decide = vi.fn(async () => { throw new Error('网络中断'); });
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    const button = await screen.findByRole('button', { name: decision === 'approve' ? '批准' : '驳回' });
    fireEvent.change(screen.getByRole('textbox', { name: '审批意见' }), { target: { value: '原意见' } });
    fireEvent.click(button);
    await screen.findByText('网络中断');
    await waitFor(() => expect(button).toBeEnabled());
    const request = vi.mocked(service.decide).mock.calls[0]!;
    expect(request).toEqual(['task-a', decision, '原意见', expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)]);
    fireEvent.click(button);
    await waitFor(() => expect(service.decide).toHaveBeenCalledTimes(2));
    expect(vi.mocked(service.decide).mock.calls[1]).toEqual(request);
  });

  it('审批请求生成失败时展示错误并恢复按钮，不提交任务', async () => {
    vi.stubGlobal('crypto', { getRandomValues: vi.fn(() => { throw new Error('随机源不可用'); }) });
    const service = serviceFor('a');
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    const button = await screen.findByRole('button', { name: '批准' });
    fireEvent.click(button);
    expect(await screen.findByText('随机源不可用')).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('流程模板翻页后保留流程任务名称，重新加载更新名称，切换身份清空名称缓存', async () => {
    const service = serviceFor('a');
    let name = '热点新闻流程';
    service.templates = vi.fn(async (cursor = '') => ({
      data: [{ id: cursor ? 'template-b' : instance.template_id, name: cursor ? '其他流程' : name, description: '', status: 'enabled', revision: 1, nodes: instance.nodes }],
      meta: cursor ? meta : { has_next: true, next_cursor: 'next-template-page' }
    }));
    const view = render(<WorkflowPage service={service} signedIn online userId="a" identityKey="gateway-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByRole('heading', { name, level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /下一页/ }));
    expect(await screen.findByRole('button', { name: /其他流程/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '流程任务' }));
    expect(screen.getByRole('heading', { name, level: 2 })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '工作流列表' })).getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    name = '更新后的热点流程';
    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    expect(await screen.findByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '待我处理' }));
    expect(screen.getByRole('heading', { name, level: 2 })).toBeInTheDocument();
    const otherService = serviceFor('a');
    view.rerender(<WorkflowPage service={otherService} signedIn online userId="a" identityKey="gateway-b" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByRole('heading', { name: '审核', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name, level: 2 })).not.toBeInTheDocument();
  });

  it('查看历史时刷新保留节点，流转后自动定位新节点，离线仍可查看历史', async () => {
    const service = serviceFor('a');
    const historyNode: Instance['nodes'][number] = { node_id: 'collect', order: 0, type: 'agent', title: '采集资料', instruction: '采集', assignee_user_id: 'a' };
    const nextNode: Instance['nodes'][number] = { node_id: 'draft', order: 2, type: 'agent', title: '撰写草稿', instruction: '撰写', assignee_user_id: 'a' };
    const historyTask: Task = { ...task, task_id: 'collect-task', node_id: 'collect', type: 'agent', status: 'completed', output: { text: '历史结果' } };
    let detail: Instance = { ...instance, nodes: [historyNode, ...instance.nodes, nextNode], tasks: [historyTask, task] };
    service.instance = vi.fn(async () => ({ data: detail }));
    const view = render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    const nodeDetail = within(await screen.findByRole('region', { name: '节点详情' }));
    expect(nodeDetail.getByRole('heading', { name: '审核' })).toBeInTheDocument();
    expect(screen.queryByText('历史结果')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /查看节点：采集资料/ }));
    expect(nodeDetail.getByText('历史结果')).toBeInTheDocument();
    const calls = vi.mocked(service.instance).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '刷新工作流' }));
    await waitFor(() => expect(service.instance).toHaveBeenCalledTimes(calls + 1));
    expect(nodeDetail.getByRole('heading', { name: '采集资料' })).toBeInTheDocument();
    detail = { ...detail, current_node_id: 'draft', tasks: [historyTask, { ...task, status: 'completed' }, { ...task, task_id: 'draft-task', node_id: 'draft', type: 'agent' }] };
    fireEvent.click(screen.getByRole('button', { name: '刷新工作流' }));
    expect(await screen.findByRole('heading', { name: '撰写草稿' })).toBeInTheDocument();
    const nextDetail = within(screen.getByRole('region', { name: '节点详情' }));
    expect(nextDetail.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
    view.rerender(<WorkflowPage service={service} signedIn online={false} userId="a" />);
    fireEvent.click(screen.getByRole('button', { name: /查看节点：采集资料/ }));
    expect(nextDetail.getByText('历史结果')).toBeInTheDocument();
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('无当前节点的已结束流程任务默认展示最后一个已有结果的节点', async () => {
    const service = serviceFor('a');
    service.instance = vi.fn(async () => ({ data: { ...instance, status: 'succeeded', current_node_id: undefined, tasks: [{ ...task, status: 'completed', comment: '已确认', decision: 'approve' }] } }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    const detail = within(await screen.findByRole('region', { name: '节点详情' }));
    expect(detail.getByRole('heading', { name: '审核' })).toBeInTheDocument();
    expect(detail.getByText(/已确认/)).toBeInTheDocument();
    expect(detail.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回当前节点' })).not.toBeInTheDocument();
  });

  it('按待办类型筛选后默认选中第一项，刷新和切换视图保留选择，不提交任务', async () => {
    const service = serviceFor('a');
    const agentTask: Task = { ...task, task_id: 'task-agent', instance_id: 'instance-agent', type: 'agent', instruction: '生成产品推荐' };
    service.tasks = vi.fn(async () => ({ data: [task, agentTask], meta }));
    service.instance = vi.fn(async id => ({ data: id === agentTask.instance_id
      ? { ...instance, id, nodes: [{ ...instance.nodes[0]!, type: 'agent' as const }], tasks: [agentTask] } : instance }));
    service.prepare = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    const queue = within(screen.getByRole('region', { name: '工作流列表' }));
    fireEvent.click(await queue.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByText(/私密文本/)).toBeInTheDocument();
    expect(queue.queryByText('instance-a')).not.toBeInTheDocument();
    expect(queue.getByRole('button', { name: /审批 · 审核/ })).toHaveAccessibleName(/发起于/);
    expect(queue.getByRole('button', { name: /Agent · 生成产品推荐/ })).toHaveAccessibleName(/流程任务 ce-agent/);
    fireEvent.click(queue.getByRole('button', { name: '待执行' }));
    expect(queue.queryByRole('button', { name: /审批 · 审核/ })).not.toBeInTheDocument();
    expect(queue.getByRole('button', { name: /Agent · 生成产品推荐/ })).toBeInTheDocument();
    await waitFor(() => expect(queue.getByRole('button', { name: /Agent · 生成产品推荐/ })).toHaveAttribute('aria-pressed', 'true'));
    const calls = vi.mocked(service.instance).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '刷新工作流' }));
    await waitFor(() => expect(service.instance).toHaveBeenCalledTimes(calls + 1));
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    expect(screen.queryByText(/私密文本/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '待我处理' }));
    expect(queue.getByRole('button', { name: /Agent · 生成产品推荐/ })).toHaveAttribute('aria-pressed', 'true');
    expect(queue.getByRole('button', { name: '待执行' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(queue.getByRole('button', { name: '待审批' }));
    await waitFor(() => expect(queue.getByRole('button', { name: /审批 · 审核/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(queue.queryByRole('button', { name: /Agent · 生成产品推荐/ })).not.toBeInTheDocument();
    fireEvent.click(queue.getByRole('button', { name: '全部' }));
    await act(async () => {});
    expect(queue.getByRole('button', { name: /Agent · 生成产品推荐/ })).toBeInTheDocument();
    expect(service.decide).not.toHaveBeenCalled();
    expect(service.prepare).not.toHaveBeenCalled();
  });

  it('当前页无匹配项仍可翻页，且筛选不会在换身份后保留', async () => {
    const service = serviceFor('a');
    service.tasks = vi.fn(async (cursor = '') => cursor
      ? { data: [{ ...task, type: 'agent' as const, instruction: '生成产品推荐' }], meta }
      : { data: [task], meta: { has_next: true, next_cursor: 'next-page' } });
    const view = render(<WorkflowPage service={service} signedIn online userId="a" identityKey="gateway-a" />);
    await screen.findByRole('button', { name: /审批 · 审核/ });
    fireEvent.click(screen.getByRole('button', { name: '待执行' }));
    expect(screen.getByText('当前页暂无匹配待办')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
    expect(await screen.findByRole('button', { name: /Agent · 生成产品推荐/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeInTheDocument();
    view.rerender(<WorkflowPage service={serviceFor('b')} signedIn online userId="b" identityKey="gateway-b" />);
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /Agent · 生成产品推荐/ })).not.toBeInTheDocument();
    expect(await screen.findByText('暂无待办')).toBeInTheDocument();
  });

  it('历史执行待确认时不重复启动，确认后恢复原结果同步', async () => {
    const service = serviceFor('a');
    const agentTask: Task = { ...task, type: 'agent' };
    service.instance = vi.fn(async () => ({ data: { ...instance, tasks: [agentTask], nodes: [{ ...instance.nodes[0]!, type: 'agent' as const }] } }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execution = vi.fn(async () => ({ status: 'legacy_pending', runStatus: 'succeeded' }));
    service.recoverExecution = vi.fn(async () => ({ status: 'completed', runId: 'original-run' }));
    service.prepare = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    const recovery = await screen.findByRole('button', { name: '确认在当前企业恢复结果同步' });
    expect(screen.getByRole('button', { name: '继续处理节点' })).toBeDisabled();
    expect(service.prepare).not.toHaveBeenCalled();
    fireEvent.click(recovery);
    await waitFor(() => expect(service.recoverExecution).toHaveBeenCalledWith('task-a'));
  });

  it('展示正式文件并下载到当前项目，撤权刷新后清除正文与文件', async () => {
    const service = serviceFor('a');
    const artifact = { file_id: 'file-a', logical_path: 'instances/instance-a/nodes/review/sub/result.md', revision: 2, sha256: 'a'.repeat(64), file_name: 'result.md' };
    service.instance = vi.fn(async () => ({ data: { ...instance, shared_space_id: 'space-a', instance_path_prefix: 'instances/instance-a/', tasks: [{ ...task, artifacts: [artifact] }] } }));
    service.downloadArtifact = vi.fn(async () => ({ relativePath: artifact.logical_path }));
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByText('result.md · 版本 2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'result.md · 版本 2' })).toHaveAttribute('href', '/enterprise/shared-files/file-a/preview');
    expect(screen.getByText(/文件 ID：file-a/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('region', { name: '正式结果文件' })[0]!.querySelector('summary')!);
    fireEvent.click(screen.getByRole('button', { name: '下载到项目' }));
    await waitFor(() => expect(service.downloadArtifact).toHaveBeenCalledWith('instance-a', 'file-a', 'project-a'));
    service.instance = vi.fn(async () => { throw new Error('空间权限不足'); });
    fireEvent.click(screen.getByRole('button', { name: '刷新工作流' }));
    expect(await screen.findByText('空间权限不足')).toBeInTheDocument();
    expect(screen.queryByText(/私密文本/)).not.toBeInTheDocument();
    expect(screen.queryByText('result.md · 版本 2')).not.toBeInTheDocument();
  });

  it.each(['confirming', 'unavailable'] as const)('R2 身份 %s 时不挂载变更界面或迁移临时 Origin 缓存', async identityStatus => {
    const service = serviceFor('a');
    sessionStorage.setItem('workflow:start:unknown:a:template-a:input', '{"text":"未知身份输入"}');
    render(<WorkflowPage service={service} identityStatus={identityStatus} signedIn online userId="a" />);
    expect(screen.getByText(identityStatus === 'confirming' ? /正在确认工作流身份/ : /工作流身份不可用/)).toBeInTheDocument();
    expect(service.templates).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '发起任务' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem('workflow:start:unknown:a:template-a:input')).toBe('{"text":"未知身份输入"}');
  });

  it('换账号无需父组件 key 也立即清除原账户详情', async () => {
    const view = render(<WorkflowPage service={serviceFor('a')} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByText(/私密文本/)).toBeInTheDocument();
    await act(async () => view.rerender(<WorkflowPage service={serviceFor('b')} signedIn online userId="b" />));
    expect(screen.queryByText(/私密文本/)).not.toBeInTheDocument();
  });

  it('同账号切换 Origin 或 Agent 时不保留原详情', async () => {
    const service = serviceFor('a');
    const view = render(<WorkflowPage service={service} identityKey="https://one.example:agent-a" signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByText(/私密文本/)).toBeInTheDocument();
    await act(async () => view.rerender(<WorkflowPage service={serviceFor('b')} identityKey="https://two.example:agent-b" signedIn online userId="a" />));
    expect(screen.queryByText(/私密文本/)).not.toBeInTheDocument();
  });

  it('Agent 节点未填写任务要求时隐藏空白任务要求区域', async () => {
    const agentTask: Task = { ...task, type: 'agent', input: { text: '  ' } };
    const agentInstance = { ...instance, tasks: [agentTask], nodes: [{ ...instance.nodes[0]!, type: 'agent' as const }] };
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [agentTask], meta }));
    service.instances = vi.fn(async () => ({ data: [agentInstance], meta }));
    service.instance = vi.fn(async () => ({ data: agentInstance }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    const detailElement = await screen.findByRole('region', { name: '节点详情' });
    const detail = within(detailElement);
    expect(detail.queryByText('任务要求')).not.toBeInTheDocument();
    expect(detailElement.querySelector('pre')).not.toBeInTheDocument();
    expect(detailElement.querySelector('.workflow-data')).not.toBeInTheDocument();
  });

  it.each(['failed', 'canceled'])('Agent %s 保留当前节点并提供重试入口', async runStatus => {
    const agentTask: Task = { ...task, type: 'agent' };
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [agentTask], meta }));
    service.instance = vi.fn(async () => ({ data: { ...instance, tasks: [agentTask], nodes: [{ ...instance.nodes[0]!, type: 'agent' as const }] } }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execution = vi.fn(async () => ({ status: 'pending', runStatus }));
    service.prepare = vi.fn(async () => ({ threadId: 'retry-thread', instruction: '审核', input: '原要求', firstNode: true }));
    const onTaskPrepared = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-1" onTaskPrepared={onTaskPrepared} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent · 审核/ }));
    fireEvent.click(await screen.findByRole('button', { name: '继续处理节点' }));
    await waitFor(() => expect(service.prepare).toHaveBeenCalledWith('task-a', 'project-1'));
    expect(onTaskPrepared).toHaveBeenCalledWith('task-a', expect.objectContaining({ threadId: 'retry-thread' }));
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('rejected 流程任务不显示执行或审批入口，即使残留待办', async () => {
    const service = serviceFor('a');
    service.instance = vi.fn(async () => ({ data: { ...instance, status: 'rejected' } }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByRole('heading', { name: '审核', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '驳回' })).not.toBeInTheDocument();
  });

  it('只在合法流程模板且在线时提供定时创建，不要求模型或项目', async () => {
    const template: Template = { id: 'template-a', name: '审批流程模板', description: '', status: 'enabled', revision: 1, nodes: instance.nodes };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    const scheduleService = { listSchedules: vi.fn(async () => ({ schedules: [] })) } as unknown as NonNullable<Parameters<typeof WorkflowPage>[0]['scheduleService']>;
    const view = render(<WorkflowPage service={service} scheduleService={scheduleService} signedIn online userId="a" />);
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /审批流程模板/ }));
    fireEvent.click(await screen.findByRole('button', { name: '创建定时计划' }));
    expect(await screen.findByRole('form', { name: '创建工作流定时计划' })).toBeInTheDocument();
    view.rerender(<WorkflowPage service={service} scheduleService={scheduleService} signedIn online={false} userId="a" />);
    expect(screen.queryByRole('button', { name: '保存计划' })).not.toBeInTheDocument();
  });

  it('模型未 ready 时即使服务称可执行且项目存在，也禁止 Agent 准备', async () => {
    const service = serviceFor('a');
    const agentTask: Task = { ...task, type: 'agent' };
    service.tasks = vi.fn(async () => ({ data: [agentTask], meta }));
    service.instance = vi.fn(async () => ({ data: { ...instance, tasks: [agentTask], nodes: [{ ...instance.nodes[0]!, type: 'agent' as const }] } }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execution = vi.fn(async () => ({ status: 'idle' }));
    service.prepare = vi.fn();
    render(<WorkflowPage service={service} signedIn online modelReady={false} userId="a" projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent · 审核/ }));
    expect(await screen.findByText(/模型尚未就绪/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开执行会话' })).toBeDisabled();
    expect(service.prepare).not.toHaveBeenCalled();
  });

  it.each([true, false])('模型未 ready 仍可发起首节点为 Agent 的流程任务，但不自动 prepare，randomUUID 可用=%s', async nativeUUID => {
    if (!nativeUUID) vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const template: Template = { id: 'template-a', name: '无需模型发起', description: '', status: 'enabled', revision: 1,
      nodes: [{ ...instance.nodes[0]!, type: 'agent' }] };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.start = vi.fn(async () => ({ data: { instance_id: instance.id, task_id: 'agent-task', status: 'running' } }));
    service.prepare = vi.fn();
    render(<WorkflowPage service={service} signedIn online modelReady={false} userId="a" projectId="project-1" />);
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /无需模型发起/ }));
    fireEvent.click(await screen.findByRole('button', { name: '发起任务' }));
    await waitFor(() => expect(service.start).toHaveBeenCalled());
    await screen.findByRole('heading', { name: '无需模型发起', level: 2 });
    expect(service.prepare).not.toHaveBeenCalled();
  });

  it('发起请求缓存失败时展示错误并恢复按钮，不提交任务', async () => {
    const template: Template = { id: 'template-a', name: '审批流程模板', description: '', status: 'enabled', revision: 1, nodes: instance.nodes };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.start = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /审批流程模板/ }));
    const button = await screen.findByRole('button', { name: '发起任务' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('会话存储不可用'); });
    fireEvent.click(button);
    expect(await screen.findByText('会话存储不可用')).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(service.start).not.toHaveBeenCalled();
  });

  it('账号切换立即清除计划和初始输入，即使旧计划请求随后返回', async () => {
    let resolveOld!: (value: { schedules: [] }) => void;
    const scheduleService = { listSchedules: vi.fn(() => new Promise<{ schedules: [] }>(resolve => { resolveOld = resolve; })) } as unknown as NonNullable<Parameters<typeof WorkflowPage>[0]['scheduleService']>;
    const view = render(<WorkflowPage service={serviceFor('a')} scheduleService={scheduleService} signedIn online userId="a" />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '定时计划' })));
    await act(async () => view.rerender(<WorkflowPage service={serviceFor('b')} scheduleService={scheduleService} signedIn online userId="b" />));
    await act(async () => resolveOld({ schedules: [] }));
    expect(screen.queryByRole('region', { name: '本机工作流计划' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '初始输入（JSON 对象）' })).not.toBeInTheDocument();
    expect(screen.getByText('暂无待办')).toBeInTheDocument();
  });

  it('登录退出再登录不保留前一次计划页面', async () => {
    const service = serviceFor('a');
    const scheduleService = { listSchedules: vi.fn(async () => ({ schedules: [] })) } as unknown as NonNullable<Parameters<typeof WorkflowPage>[0]['scheduleService']>;
    const view = render(<WorkflowPage service={service} scheduleService={scheduleService} signedIn online userId="a" />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '定时计划' })));
    await act(async () => view.rerender(<WorkflowPage service={service} scheduleService={scheduleService} signedIn={false} online userId="a" />));
    expect(screen.queryByText(/由当前客户端发起/)).not.toBeInTheDocument();
    await act(async () => view.rerender(<WorkflowPage service={service} scheduleService={scheduleService} signedIn online userId="a" />));
    expect(screen.queryByText(/由当前客户端发起/)).not.toBeInTheDocument();
  });

  it('Origin 之间不复用手动发起的幂等键和私密输入', async () => {
    const template: Template = { id: 'template-a', name: '审批流程模板', description: '', status: 'enabled', revision: 1, nodes: instance.nodes };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.start = vi.fn(async () => { throw new Error('网络中断'); });
    sessionStorage.setItem('workflow:start:origin-one:a:template-a', 'old-key');
    sessionStorage.setItem('workflow:start:origin-one:a:template-a:input', '{"text":"前服务私密输入"}');
    render(<WorkflowPage service={service} identityKey="origin-two" signedIn online userId="a" />);
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /审批流程模板/ }));
    expect(await screen.findByRole('textbox', { name: '任务要求' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: '重试发起' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发起任务' }));
    await waitFor(() => expect(service.start).toHaveBeenCalledWith('template-a', { text: '' }, expect.not.stringMatching('old-key')));
  });

  it('审批未知结果仅用原决定、意见和 key 重试，不能改为驳回', async () => {
    const service = serviceFor('a');
    service.decide = vi.fn(async () => { throw new Error('网络中断'); });
    sessionStorage.setItem('workflow:decision:a:task-a', 'decision-key');
    sessionStorage.setItem('workflow:decision:a:task-a:decision', '{"decision":"approve","comment":"原审批意见"}');
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    const retry = await screen.findByRole('button', { name: '重试批准' });
    expect(screen.getByRole('textbox', { name: '审批意见' })).toHaveValue('原审批意见');
    expect(screen.getByRole('textbox', { name: '审批意见' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '驳回' })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(service.decide).toHaveBeenCalledWith('task-a', 'approve', '原审批意见', 'decision-key'));
  });

  it('第二个候选也能审批，并展示全体候选姓名', async () => {
    const shared = { ...task, assignee_user_ids: ['a', 'b', 'a'] };
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [shared], meta }));
    service.instance = vi.fn(async () => ({ data: { ...instance, tasks: [shared], user_names: { a: '张三', b: '李四' } } }));
    service.decide = vi.fn(async () => ({ data: { instance_id: instance.id, task_id: task.task_id, status: 'succeeded' } }));
    render(<WorkflowPage service={service} signedIn online userId="b" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByText(/负责人：张三、李四/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(service.decide).toHaveBeenCalledWith(task.task_id, 'approve', '', expect.any(String)));
  });

  it.each(['c', 'a'])('快照之外账户 %s 不显示处理入口，即使旧首负责人字段匹配', async (userId) => {
    const service = serviceFor('a');
    service.instance = vi.fn(async () => ({ data: { ...instance, tasks: [{ ...task, assignee_user_ids: ['b'] }] } }));
    render(<WorkflowPage service={service} signedIn online userId={userId} />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByRole('heading', { name: '审核', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '驳回' })).not.toBeInTheDocument();
  });

  it('第二个 Agent 候选可以准备执行，完成后展示真实处理人而非首负责人', async () => {
    const shared: Task = { ...task, type: 'agent', assignee_user_ids: ['a', 'b'] };
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [shared], meta }));
    service.instance = vi.fn(async () => ({ data: { ...instance, nodes: [{ node_id: task.node_id, order: 0, type: 'agent' as const, title: '审核', instruction: '审核', resolved_user_ids: ['a', 'b'] }], tasks: [shared], user_names: { a: '张三', b: '李四' } } }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execution = vi.fn(async () => ({ status: 'idle' }));
    service.prepare = vi.fn(async () => ({ threadId: 'thread-b', instruction: '审核', input: '内容', firstNode: true }));
    const prepared = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="b" projectId="project-b" onTaskPrepared={prepared} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent · 审核/ }));
    fireEvent.click(await screen.findByRole('button', { name: '打开执行会话' }));
    await waitFor(() => expect(service.prepare).toHaveBeenCalledWith(task.task_id, 'project-b'));
    expect(prepared).toHaveBeenCalledWith(task.task_id, expect.objectContaining({ threadId: 'thread-b' }));
    service.instance = vi.fn(async () => ({ data: { ...instance, status: 'succeeded', tasks: [{ ...shared, status: 'completed', handled_by: 'b' }], user_names: { a: '张三', b: '李四' } } }));
    service.tasks = vi.fn(async () => ({ data: [], meta }));
    fireEvent.click(screen.getByRole('button', { name: '刷新工作流' }));
    expect(await screen.findByText('实际处理人：李四')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开执行会话' })).not.toBeInTheDocument();
  });

  it('服务端授权的角色流程模板无需从角色中挑一人即可发起', async () => {
    const template: Template = { id: 'role-template', name: '角色审核', description: '', status: 'enabled', revision: 1, nodes: [{ node_id: 'review', order: 0, type: 'approval', title: '审核', instruction: '审核', assignee_role_ids: ['reviewers'], assignee_user_ids: [] }] };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.start = vi.fn(async () => ({ data: { instance_id: instance.id, task_id: task.task_id, status: 'running' } }));
    render(<WorkflowPage service={service} signedIn online userId="b" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '流程模板' })); });
    const templateButton = await screen.findByRole('button', { name: /角色审核/ });
    await act(async () => { fireEvent.click(templateButton); });
    const startButton = await screen.findByRole('button', { name: '发起任务' });
    await act(async () => { fireEvent.click(startButton); });
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(template.id, { text: '' }, expect.any(String)));
  });

  it('drops the previous account details when the account key changes', async () => {
    const view = render(<WorkflowPage key="a" service={serviceFor('a')} signedIn online userId="a" />);
    const taskButton = await screen.findByRole('button', { name: /审批 · 审核/ });
    await act(async () => { fireEvent.click(taskButton); });
    expect(await screen.findByText(/私密文本/)).toBeInTheDocument();

    view.rerender(<WorkflowPage key="b" service={serviceFor('b')} signedIn online userId="b" />);
    expect(screen.queryByText(/私密文本/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '审核', level: 2 })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('暂无待办')).toBeInTheDocument());
  });

  it('keeps loaded details read-only while offline', async () => {
    const service = serviceFor('a');
    const view = render(<WorkflowPage key="a" service={service} signedIn online userId="a" />);
    const taskButton = await screen.findByRole('button', { name: /审批 · 审核/ });
    await act(async () => { fireEvent.click(taskButton); });
    expect(await screen.findByText(/私密文本/)).toBeInTheDocument();

    view.rerender(<WorkflowPage key="a" service={service} signedIn online={false} userId="a" />);
    expect(screen.getByText(/私密文本/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('当前离线');
    expect(screen.getByRole('button', { name: '刷新工作流' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('shows only the text field in task inputs and outputs', async () => {
    const service = serviceFor('a');
    service.instance = vi.fn(async () => ({ data: {
      ...instance, tasks: [{ ...task, input: { text: '第一行\n第二行', internal: '不展示' }, output: { text: '处理结果', internal: '也不展示' } }]
    } }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    const inputModes = within(await screen.findByRole('group', { name: '待审批内容显示方式' }));
    fireEvent.click(inputModes.getByRole('button', { name: '原文' }));
    expect(await screen.findByText((_, element) => element?.tagName === 'PRE' && element.textContent === '第一行\n第二行')).toBeInTheDocument();
    expect(screen.getByText('处理结果')).toBeInTheDocument();
    expect(screen.queryByText(/internal|不展示|也不展示|"text"/)).not.toBeInTheDocument();
  });

  it('previews approval Markdown and preserves the original text and approval opinion when switching modes', async () => {
    const text = '# 产品推荐\n\n推荐 **便携款**。\n\n- 轻便\n- 易收纳\n\n| 产品 | 价格 |\n| --- | --- |\n| 便携款 | 199 元 |';
    const service = serviceFor('a');
    service.instance = vi.fn(async () => ({ data: { ...instance, tasks: [{ ...task, input: { text } }] } }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByRole('heading', { name: '产品推荐', level: 1 })).toBeInTheDocument();
    const nodeDetail = within(screen.getByRole('region', { name: '节点详情' }));
    expect(nodeDetail.getAllByRole('listitem')).toHaveLength(3);
    expect(nodeDetail.getByRole('table')).toHaveTextContent('便携款199 元');
    expect(screen.getByRole('button', { name: '预览' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: '审批意见' }), { target: { value: '确认推荐内容' } });
    fireEvent.click(screen.getByRole('button', { name: '原文' }));
    expect(nodeDetail.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === text)).toBeInTheDocument();
    expect(nodeDetail.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(nodeDetail.getByRole('heading', { name: '产品推荐' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '审批意见' })).toHaveValue('确认推荐内容');
    expect(screen.getByRole('contentinfo', { name: '当前审批' })).toBeInTheDocument();
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('previews completed Agent output with an independent raw toggle while keeping the current approval available', async () => {
    const output = '# 热点新闻\n\n**行业动态**\n\n- 模型发布\n- 产品更新';
    const service = serviceFor('a');
    const agentNode: Instance['nodes'][number] = { node_id: 'collect', order: 0, type: 'agent', title: '追踪热点', instruction: '整理新闻', assignee_user_id: 'a' };
    const agentTask: Task = { ...task, task_id: 'collect-task', node_id: 'collect', type: 'agent', status: 'completed', input: { text: '找三条新闻' }, output: { text: output, internal: '内部输出元数据' } };
    service.instance = vi.fn(async () => ({ data: { ...instance, nodes: [agentNode, ...instance.nodes], tasks: [agentTask, task] } }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    fireEvent.click(await screen.findByRole('button', { name: /查看节点：追踪热点/ }));
    expect(screen.getByRole('heading', { name: '热点新闻', level: 1 })).toBeInTheDocument();
    const modes = within(screen.getByRole('group', { name: '输出显示方式' }));
    expect(modes.getByRole('button', { name: '预览' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(modes.getByRole('button', { name: '原文' }));
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === output)).toBeInTheDocument();
    expect(screen.queryByText('内部输出元数据')).not.toBeInTheDocument();
    fireEvent.click(modes.getByRole('button', { name: '预览' }));
    expect(screen.getByRole('heading', { name: '热点新闻' })).toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo', { name: '当前审批' })).getByRole('button', { name: '批准' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回当前节点' }));
    expect(within(screen.getByRole('group', { name: '待审批内容显示方式' })).getByRole('button', { name: '预览' })).toHaveAttribute('aria-pressed', 'true');
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('shows and reuses the original input for an unconfirmed start', async () => {
    const template: Template = {
      id: 'template-a', name: '内容生成', description: '', status: 'enabled', revision: 1,
      nodes: [{ node_id: 'agent', order: 0, type: 'agent', title: '生成', assignee_user_id: 'a', instruction: '生成' }]
    };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.start = vi.fn(async () => { throw new Error('网络中断'); });
    service.capability = vi.fn(async () => ({ canExecute: true }));
    sessionStorage.setItem('workflow:start:a:template-a', 'original-key');
    sessionStorage.setItem('workflow:start:a:template-a:input', '{"text":"原输入"}');
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-1" />);

    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /内容生成/ }));
    const input = await screen.findByRole('textbox', { name: '任务要求' });
    await waitFor(() => expect(input).toHaveValue('原输入'));
    expect(input).toBeDisabled();
    expect(screen.getByText('上次发起尚未确认，仅可用原输入重试。')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: '重试发起' });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(service.start).toHaveBeenCalledWith('template-a', { text: '原输入' }, 'original-key'));
  });

  it('submits plain initial text as the text field', async () => {
    const template: Template = {
      id: 'template-a', name: '内容生成', description: '', status: 'enabled', revision: 1,
      nodes: [{ node_id: 'agent', order: 0, type: 'agent', title: '生成', assignee_user_id: 'a', instruction: '生成' }]
    };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.start = vi.fn(async () => { throw new Error('网络中断'); });
    service.capability = vi.fn(async () => ({ canExecute: true }));
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-1" />);
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /内容生成/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '任务要求' }), { target: { value: '第一行\n第二行' } });
    const startButton = screen.getByRole('button', { name: '发起任务' });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);
    await waitFor(() => expect(service.start).toHaveBeenCalledWith('template-a', { text: '第一行\n第二行' }, expect.any(String)));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络中断');
    expect(JSON.parse(sessionStorage.getItem('workflow:start:a:template-a:input') ?? '')).toEqual({ text: '第一行\n第二行' });
  });

  it('places approval controls in the current node and distinguishes processed and future nodes', async () => {
    const service = serviceFor('a');
    service.instance = vi.fn(async () => ({ data: {
      ...instance,
      nodes: [
        { node_id: 'agent', order: 0, type: 'agent' as const, title: '采集', assignee_user_id: 'a', instruction: '采集' },
        ...instance.nodes,
        { node_id: 'next', order: 2, type: 'agent' as const, title: '生成', assignee_user_id: 'a', instruction: '生成' }
      ],
      tasks: [{ ...task, node_id: 'agent', type: 'agent' as const, status: 'completed' }, task]
    } }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    const progress = await screen.findByRole('navigation', { name: '节点进度' });
    const steps = within(progress).getAllByRole('listitem');
    const [first, second, third] = steps as [HTMLElement, HTMLElement, HTMLElement];
    expect(steps.map(step => step.getAttribute('data-state'))).toEqual(['completed', 'current', 'upcoming']);
    expect(within(first).getByText('已完成')).toBeInTheDocument();
    expect(within(second).getByText('待审批')).toBeInTheDocument();
    const detail = within(screen.getByRole('region', { name: '节点详情' }));
    const approval = within(screen.getByRole('contentinfo', { name: '当前审批' }));
    expect(detail.getByRole('heading', { name: '审核' })).toBeInTheDocument();
    expect(approval.getByText('当前审批：审核')).toBeInTheDocument();
    fireEvent.change(approval.getByRole('textbox', { name: '审批意见' }), { target: { value: '核对结果' } });
    expect(approval.getByRole('button', { name: '批准' })).toBeInTheDocument();
    expect(detail.queryByRole('heading', { name: '采集' })).not.toBeInTheDocument();
    expect(within(third).getByText('未执行')).toBeInTheDocument();
    fireEvent.click(within(first).getByRole('button'));
    expect(detail.getByRole('heading', { name: '采集' })).toBeInTheDocument();
    expect(detail.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
    expect(approval.getByRole('button', { name: '批准' })).toBeInTheDocument();
    expect(approval.getByRole('textbox', { name: '审批意见' })).toHaveValue('核对结果');
    fireEvent.click(within(third).getByRole('button'));
    expect(detail.getByRole('heading', { name: '生成' })).toBeInTheDocument();
    expect(detail.queryByRole('button', { name: '打开执行会话' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回当前节点' }));
    expect(approval.getByRole('button', { name: '批准' })).toBeInTheDocument();
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('prepares the first Agent node with its saved requirement without another input', async () => {
    const agentTask: Task = { ...task, type: 'agent', instruction: '生成', node_id: 'agent', input: { text: '主题' } };
    const agentInstance: Instance = { ...instance, current_node_id: 'agent', nodes: [{ node_id: 'agent', order: 0, type: 'agent', title: '生成', assignee_user_id: 'a', instruction: '生成' }, { node_id: 'review', order: 1, type: 'approval', title: '审核', assignee_user_id: 'a', instruction: '审核' }], tasks: [agentTask] };
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [agentTask], meta }));
    service.instance = vi.fn(async () => ({ data: agentInstance }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execution = vi.fn(async () => ({ status: 'idle' }));
    service.prepare = vi.fn(async () => ({ threadId: 'thread-1', instruction: '生成', input: '主题', firstNode: true }));
    service.execute = vi.fn();
    const onTaskPrepared = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-1" onTaskPrepared={onTaskPrepared} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent · 生成/ }));
    await screen.findByRole('heading', { name: '生成', level: 2 });
    const progress = await screen.findByRole('navigation', { name: '节点进度' });
    const steps = within(progress).getAllByRole('listitem');
    const first = within(screen.getByRole('region', { name: '节点详情' }));
    expect(steps.map(step => step.getAttribute('data-state'))).toEqual(['current', 'upcoming']);
    const execution = screen.getByRole('region', { name: '当前节点执行' });
    const executionStatus = await within(execution).findByText('Agent 任务尚未启动');
    expect(executionStatus.parentElement).toHaveClass('workflow-instance-heading');
    expect(executionStatus.parentElement).toHaveTextContent('当前节点：生成');
    expect(progress.compareDocumentPosition(execution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('region', { name: '节点详情' }).compareDocumentPosition(execution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(first.queryByText('idle')).not.toBeInTheDocument();
    expect(first.getByText('任务要求')).toBeInTheDocument();
    expect(first.getByText('主题')).toBeInTheDocument();
    expect(first.queryByRole('textbox', { name: '任务要求' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开执行会话' }));
    await waitFor(() => expect(service.prepare).toHaveBeenCalledWith('task-a', 'project-1'));
    expect(service.execute).not.toHaveBeenCalled();
    expect(onTaskPrepared).toHaveBeenCalledWith('task-a', expect.objectContaining({ threadId: 'thread-1', instruction: '生成', input: '主题', firstNode: true, customInput: '主题', context: { instanceId: instance.id, workflowName: '生成', nodeTitle: '生成', nodeOrder: 0 } }));
  });

  it('keeps the supplemental requirement on a later Agent node', async () => {
    const agentTask: Task = { ...task, type: 'agent', instruction: '生成', node_id: 'agent', input: { text: '上一步结果' } };
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [agentTask], meta }));
    service.instance = vi.fn(async () => ({ data: { ...instance, current_node_id: 'agent', nodes: [
      { node_id: 'start', order: 0, type: 'approval' as const, title: '开始', assignee_user_id: 'a', instruction: '确认' },
      { node_id: 'agent', order: 1, type: 'agent' as const, title: '生成', assignee_user_id: 'a', instruction: '生成' }
    ], tasks: [agentTask] } }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execution = vi.fn(async () => ({ status: 'idle' }));
    service.prepare = vi.fn(async () => ({ threadId: 'thread-2', instruction: '生成', input: '上一步结果', firstNode: false }));
    const onTaskPrepared = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-1" onTaskPrepared={onTaskPrepared} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent · 生成/ }));
    const second = await screen.findByRole('region', { name: '当前节点执行' });
    fireEvent.change(within(second).getByRole('textbox', { name: '补充任务要求' }), { target: { value: '只选三条' } });
    fireEvent.click(within(second).getByRole('button', { name: '打开执行会话' }));
    await waitFor(() => expect(onTaskPrepared).toHaveBeenCalledWith('task-a', expect.objectContaining({ firstNode: false, customInput: '只选三条' })));
  });

  it.each([
    ['awaiting_confirmation', '待人工确认'], ['submit_failed', '提交未确认，请进入会话重试'],
    ['failed', '执行失败'], ['canceled', '执行已取消'], ['running', 'Agent 正在执行'], ['queued', '等待执行']
  ])('进度条准确显示 %s，允许进入已有会话继续处理', async (status, label) => {
    const service = serviceFor('a');
    const agentTask: Task = { ...task, type: 'agent' };
    service.tasks = vi.fn(async () => ({ data: [agentTask], meta }));
    service.instance = vi.fn(async () => ({ data: { ...instance, tasks: [agentTask], nodes: [{ ...instance.nodes[0]!, type: 'agent' as const }] } }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execution = vi.fn(async () => ({ status }));
    service.prepare = vi.fn(async () => ({ threadId: 'existing-thread', instruction: '审核', input: '', firstNode: false, resuming: true }));
    const onTaskPrepared = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-1" onTaskPrepared={onTaskPrepared} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent · 审核/ }));
    expect(await screen.findByRole('button', { name: `查看节点：审核 · ${label}` })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '工作流列表' })).getByText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续处理节点' }));
    await waitFor(() => expect(onTaskPrepared).toHaveBeenCalledWith(task.task_id, expect.objectContaining({ resuming: true })));
  });

  it('缺少项目时解释原因，选择项目后才能打开执行会话', async () => {
    const service = serviceFor('a');
    const agentTask: Task = { ...task, type: 'agent' };
    service.tasks = vi.fn(async () => ({ data: [agentTask], meta }));
    service.instance = vi.fn(async () => ({ data: { ...instance, tasks: [agentTask], nodes: [{ ...instance.nodes[0]!, type: 'agent' as const }] } }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execution = vi.fn(async () => ({ status: 'idle' }));
    service.prepare = vi.fn();
    const onSelectProject = vi.fn();
    const projects = [{ id: 'project-a', name: '内容项目', cwd: '/content', sandbox: 'workspace-write' as const, profile: 'default', model: null, reasoning: null }];
    const props = { service, signedIn: true, online: true, userId: 'a', projects, modelLabel: '审核模型', onSelectProject };
    const view = render(<WorkflowPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent · 审核/ }));
    expect(await screen.findByText('请选择执行项目')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开执行会话' })).toBeDisabled();
    expect(screen.queryByText('审核模型')).not.toBeInTheDocument();
    expect(screen.queryByText('访问权限')).not.toBeInTheDocument();
    expect(screen.queryByText(/打开会话后确认配置/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '执行项目' }), { target: { value: 'project-a' } });
    expect(onSelectProject).toHaveBeenCalledWith('project-a');
    expect(service.prepare).not.toHaveBeenCalled();
    view.rerender(<WorkflowPage {...props} projectId="project-a" />);
    expect(screen.getByRole('button', { name: '打开执行会话' })).toBeEnabled();
  });

  it('从会话返回时恢复流程任务、筛选和分页，重新读取最新详情', async () => {
    const service = serviceFor('a');
    let navigation: WorkflowNavigationState | undefined;
    const view = render(<WorkflowPage service={service} signedIn online userId="a" onNavigationChange={value => { navigation = value; }} />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    await screen.findByRole('heading', { name: '审核', level: 2 });
    fireEvent.click(screen.getByRole('button', { name: '待审批' }));
    fireEvent.click(screen.getByRole('button', { name: '流程任务' }));
    fireEvent.change(screen.getByRole('combobox', { name: '流程任务状态' }), { target: { value: 'all' } });
    await waitFor(() => expect(navigation).toMatchObject({ tab: 'instances', status: 'all', taskFilter: 'approval', instanceId: instance.id }));
    view.unmount();
    service.instance = vi.fn(async () => ({ data: { ...instance, status: 'succeeded' } }));
    const saved = { ...navigation!, cursors: { templates: '', instances: 'page-2', tasks: '' }, history: { templates: [], instances: [''], tasks: [] } };
    render(<WorkflowPage service={service} signedIn online userId="a" navigationState={saved} />);
    expect(await screen.findByRole('heading', { name: '审核', level: 2 })).toBeInTheDocument();
    expect(service.instances).toHaveBeenCalledWith('all', 'page-2');
    expect(service.instance).toHaveBeenCalledWith(instance.id);
    expect(screen.getByRole('button', { name: '流程任务' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '上一页' })).toBeInTheDocument();
  });

  it('发起流程任务后停留详情确认配置，不自动准备或执行 Agent', async () => {
    const template: Template = { id: 'template-a', name: '内容生成', description: '', status: 'enabled', revision: 1,
      nodes: [{ node_id: 'agent', order: 0, type: 'agent', title: '生成', assignee_user_id: 'a', instruction: '生成' }] };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.start = vi.fn(async () => ({ data: { instance_id: 'instance-a', task_id: 'first-task', status: 'running' } }));
    service.prepare = vi.fn(async () => ({ threadId: 'thread-1', instruction: '生成', input: '用户需求', firstNode: true }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    const onTaskPrepared = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-1" onTaskPrepared={onTaskPrepared} />);
    fireEvent.click(screen.getByRole('button', { name: '流程模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /内容生成/ }));
    const first = await screen.findByRole('listitem');
    fireEvent.change(within(first).getByRole('textbox', { name: '任务要求' }), { target: { value: '用户需求' } });
    await waitFor(() => expect(service.capability).toHaveBeenCalled());
    fireEvent.click(within(first).getByRole('button', { name: '发起任务' }));
    await screen.findByRole('heading', { name: '内容生成', level: 2 });
    expect(service.start).toHaveBeenCalledWith('template-a', { text: '用户需求' }, expect.any(String));
    expect(service.prepare).not.toHaveBeenCalled();
    expect(onTaskPrepared).not.toHaveBeenCalled();
  });
});
