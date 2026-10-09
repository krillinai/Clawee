import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, Task, Template, WorkflowService } from '../../services/workflow-service.js';
import { WorkflowPage } from './WorkflowPage.js';

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
    fireEvent.click(await screen.findByRole('button', { name: '重试 Agent 执行' }));
    await waitFor(() => expect(service.prepare).toHaveBeenCalledWith('task-a', 'project-1'));
    expect(onTaskPrepared).toHaveBeenCalledWith('task-a', expect.objectContaining({ threadId: 'retry-thread' }));
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('rejected 实例不显示执行或审批入口，即使残留待办', async () => {
    const service = serviceFor('a');
    service.instance = vi.fn(async () => ({ data: { ...instance, status: 'rejected' } }));
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(await screen.findByRole('button', { name: /审批 · 审核/ }));
    expect(await screen.findByRole('heading', { name: '实例 instance-a' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '驳回' })).not.toBeInTheDocument();
  });

  it('只在合法模板且在线时提供定时创建，不要求模型或项目', async () => {
    const template: Template = { id: 'template-a', name: '审批模板', description: '', status: 'enabled', revision: 1, nodes: instance.nodes };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    const scheduleService = { listSchedules: vi.fn(async () => ({ schedules: [] })) } as unknown as NonNullable<Parameters<typeof WorkflowPage>[0]['scheduleService']>;
    const view = render(<WorkflowPage service={service} scheduleService={scheduleService} signedIn online userId="a" />);
    fireEvent.click(screen.getByRole('button', { name: '模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /审批模板/ }));
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
    expect(screen.queryByRole('button', { name: '发起 Agent 执行' })).not.toBeInTheDocument();
    expect(service.prepare).not.toHaveBeenCalled();
  });

  it('模型未 ready 仍可发起首节点为 Agent 的实例，但不自动 prepare', async () => {
    const template: Template = { id: 'template-a', name: '无需模型发起', description: '', status: 'enabled', revision: 1,
      nodes: [{ ...instance.nodes[0]!, type: 'agent' }] };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.start = vi.fn(async () => ({ data: { instance_id: instance.id, task_id: 'agent-task', status: 'running' } }));
    service.prepare = vi.fn();
    render(<WorkflowPage service={service} signedIn online modelReady={false} userId="a" projectId="project-1" />);
    fireEvent.click(screen.getByRole('button', { name: '模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /无需模型发起/ }));
    fireEvent.click(await screen.findByRole('button', { name: '发起任务' }));
    await waitFor(() => expect(service.start).toHaveBeenCalled());
    await screen.findByRole('heading', { name: '实例 instance-a' });
    expect(service.prepare).not.toHaveBeenCalled();
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
    const template: Template = { id: 'template-a', name: '审批模板', description: '', status: 'enabled', revision: 1, nodes: instance.nodes };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.start = vi.fn(async () => { throw new Error('网络中断'); });
    sessionStorage.setItem('workflow:start:origin-one:a:template-a', 'old-key');
    sessionStorage.setItem('workflow:start:origin-one:a:template-a:input', '{"text":"前服务私密输入"}');
    render(<WorkflowPage service={service} identityKey="origin-two" signedIn online userId="a" />);
    fireEvent.click(screen.getByRole('button', { name: '模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /审批模板/ }));
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
    expect(await screen.findByRole('heading', { name: `实例 ${instance.id}` })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: '发起 Agent 执行' }));
    await waitFor(() => expect(service.prepare).toHaveBeenCalledWith(task.task_id, 'project-b'));
    expect(prepared).toHaveBeenCalledWith(task.task_id, expect.objectContaining({ threadId: 'thread-b' }));
    service.instance = vi.fn(async () => ({ data: { ...instance, status: 'succeeded', tasks: [{ ...shared, status: 'completed', handled_by: 'b' }], user_names: { a: '张三', b: '李四' } } }));
    service.tasks = vi.fn(async () => ({ data: [], meta }));
    fireEvent.click(screen.getByRole('button', { name: '刷新工作流' }));
    expect(await screen.findByText('实际处理人：李四')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发起 Agent 执行' })).not.toBeInTheDocument();
  });

  it('服务端授权的角色模板无需从角色中挑一人即可发起', async () => {
    const template: Template = { id: 'role-template', name: '角色审核', description: '', status: 'enabled', revision: 1, nodes: [{ node_id: 'review', order: 0, type: 'approval', title: '审核', instruction: '审核', assignee_role_ids: ['reviewers'], assignee_user_ids: [] }] };
    const service = serviceFor('a');
    service.templates = vi.fn(async () => ({ data: [template], meta }));
    service.template = vi.fn(async () => ({ data: template }));
    service.start = vi.fn(async () => ({ data: { instance_id: instance.id, task_id: task.task_id, status: 'running' } }));
    render(<WorkflowPage service={service} signedIn online userId="b" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '模板' })); });
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
    expect(screen.queryByRole('heading', { name: '实例 instance-a' })).not.toBeInTheDocument();
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
    expect(await screen.findByText((_, element) => element?.tagName === 'PRE' && element.textContent === '第一行\n第二行')).toBeInTheDocument();
    expect(screen.getByText('处理结果')).toBeInTheDocument();
    expect(screen.queryByText(/internal|不展示|也不展示|"text"/)).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: '模板' }));
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
    fireEvent.click(screen.getByRole('button', { name: '模板' }));
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
    const steps = await screen.findAllByRole('listitem');
    const [first, second, third] = steps as [HTMLElement, HTMLElement, HTMLElement];
    expect(steps.map(step => step.getAttribute('data-state'))).toEqual(['completed', 'current', 'upcoming']);
    expect(within(first).getByText('已完成')).toBeInTheDocument();
    expect(within(second).getByText('待审批')).toBeInTheDocument();
    expect(within(second).getByRole('textbox', { name: '审批意见' })).toBeInTheDocument();
    expect(within(second).getByRole('button', { name: '批准' })).toBeInTheDocument();
    expect(within(third).getByText('未执行')).toBeInTheDocument();
    expect(within(third).queryByRole('button')).not.toBeInTheDocument();
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
    const steps = await screen.findAllByRole('listitem');
    const [first, second] = steps as [HTMLElement, HTMLElement];
    expect(steps.map(step => step.getAttribute('data-state'))).toEqual(['current', 'upcoming']);
    expect(await within(first).findByText('Agent 任务尚未启动')).toBeInTheDocument();
    expect(within(first).queryByText('idle')).not.toBeInTheDocument();
    expect(within(first).getByText('任务要求')).toBeInTheDocument();
    expect(within(first).getByText('主题')).toBeInTheDocument();
    expect(within(first).queryByRole('textbox', { name: '任务要求' })).not.toBeInTheDocument();
    fireEvent.click(within(first).getByRole('button', { name: '发起 Agent 执行' }));
    expect(within(second).queryByRole('button')).not.toBeInTheDocument();
    await waitFor(() => expect(service.prepare).toHaveBeenCalledWith('task-a', 'project-1'));
    expect(service.execute).not.toHaveBeenCalled();
    expect(onTaskPrepared).toHaveBeenCalledWith('task-a', { threadId: 'thread-1', instruction: '生成', input: '主题', firstNode: true, customInput: '主题' });
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
    const second = (await screen.findAllByRole('listitem'))[1] as HTMLElement;
    fireEvent.change(within(second).getByRole('textbox', { name: '任务要求' }), { target: { value: '只选三条' } });
    fireEvent.click(within(second).getByRole('button', { name: '发起 Agent 执行' }));
    await waitFor(() => expect(onTaskPrepared).toHaveBeenCalledWith('task-a', expect.objectContaining({ firstNode: false, customInput: '只选三条' })));
  });

  it('opens the first task draft after starting from its node', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: '模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /内容生成/ }));
    const first = await screen.findByRole('listitem');
    fireEvent.change(within(first).getByRole('textbox', { name: '任务要求' }), { target: { value: '用户需求' } });
    await waitFor(() => expect(service.capability).toHaveBeenCalled());
    fireEvent.click(within(first).getByRole('button', { name: '发起任务' }));
    await waitFor(() => expect(onTaskPrepared).toHaveBeenCalledWith('first-task', expect.objectContaining({ customInput: '用户需求' })));
  });
});
