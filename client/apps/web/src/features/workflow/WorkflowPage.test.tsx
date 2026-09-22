import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    sessionStorage.setItem('workflow:start:a:template-a', 'original-key');
    sessionStorage.setItem('workflow:start:a:template-a:input', '{"text":"原输入"}');
    render(<WorkflowPage service={service} signedIn online userId="a" />);

    fireEvent.click(screen.getByRole('button', { name: '模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /内容生成/ }));
    const input = await screen.findByRole('textbox', { name: '初始输入' });
    await waitFor(() => expect(input).toHaveValue('原输入'));
    expect(input).toBeDisabled();
    expect(screen.getByText('上次发起尚未确认，仅可用原输入重试。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试发起' }));
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
    render(<WorkflowPage service={service} signedIn online userId="a" />);
    fireEvent.click(screen.getByRole('button', { name: '模板' }));
    fireEvent.click(await screen.findByRole('button', { name: /内容生成/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '初始输入' }), { target: { value: '第一行\n第二行' } });
    fireEvent.click(screen.getByRole('button', { name: '发起实例' }));
    await waitFor(() => expect(service.start).toHaveBeenCalledWith('template-a', { text: '第一行\n第二行' }, expect.any(String)));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络中断');
    expect(JSON.parse(sessionStorage.getItem('workflow:start:a:template-a:input') ?? '')).toEqual({ text: '第一行\n第二行' });
  });

  it('submits plain text and announces a running Agent conversation', async () => {
    const agentTask: Task = { ...task, type: 'agent', instruction: '生成', node_id: 'agent', input: { text: '主题' } };
    const agentInstance: Instance = { ...instance, current_node_id: 'agent', nodes: [{ node_id: 'agent', order: 0, type: 'agent', title: '生成', assignee_user_id: 'a', instruction: '生成' }], tasks: [agentTask] };
    const service = serviceFor('a');
    service.tasks = vi.fn(async () => ({ data: [agentTask], meta }));
    service.instance = vi.fn(async () => ({ data: agentInstance }));
    service.capability = vi.fn(async () => ({ canExecute: true }));
    service.execute = vi.fn(async () => ({ runId: 'run-1', threadId: 'thread-1', status: 'running' }));
    const onExecutionStarted = vi.fn();
    render(<WorkflowPage service={service} signedIn online userId="a" projectId="project-1" onExecutionStarted={onExecutionStarted} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent · 生成/ }));
    fireEvent.click(await screen.findByRole('button', { name: '执行 Agent 任务' }));
    await waitFor(() => expect(service.execute).toHaveBeenCalledWith('task-a', 'project-1'));
    expect(onExecutionStarted).toHaveBeenCalledWith('thread-1');
  });
});
