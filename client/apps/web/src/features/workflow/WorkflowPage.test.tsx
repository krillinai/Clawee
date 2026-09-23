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
