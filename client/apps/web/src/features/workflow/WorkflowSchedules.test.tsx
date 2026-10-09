import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ScheduleOperationResponse, ScheduleResponse } from '@clawee/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../runtime/errors.js';
import type { createScheduleService } from '../../services/schedule-service.js';
import type { Template } from '../../services/workflow-service.js';
import { WorkflowSchedules } from './WorkflowSchedules.js';

type Service = ReturnType<typeof createScheduleService>;
const template: Template = { id: 'template-a', name: '每日审核', description: '', status: 'enabled', revision: 1,
  nodes: [{ node_id: 'review', order: 0, type: 'approval', title: '审核', instruction: '审核', assignee_user_id: 'a' }] };
const schedule = { id: 'plan-a', action: 'workflow_start', threadId: null, name: '每日审核计划', cron: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true,
  workflow: { templateId: template.id, initialInput: { text: '审核' } }, lastWorkflowInstanceId: 'instance-a' } as unknown as ScheduleResponse;
const failed = { id: 'operation-a', scheduleId: schedule.id, operation: 'run_now', status: 'failed', triggerId: 'original-trigger', errorCode: 'WORKFLOW_START_UNKNOWN',
  errorMessage: '结果未知', createdAt: '2026-10-09T00:00:00Z' } as unknown as ScheduleOperationResponse;

function serviceFor(overrides: Partial<Service> = {}): Service {
  return {
    listSchedules: vi.fn(async () => ({ schedules: [schedule, { ...schedule, id: 'agent', action: 'agent_run', name: '普通任务' } as unknown as ScheduleResponse] })),
    getSchedule: vi.fn(async () => ({ ...schedule, prompt: '' })),
    createWorkflowSchedule: vi.fn(async () => schedule),
    updateSchedule: vi.fn(async () => schedule),
    deleteSchedule: vi.fn(async () => ({ deleted: true as const })),
    runNow: vi.fn(async () => ({ run: null, schedule, skipped: false, queued: false, triggerId: 'new-trigger', workflowInstanceId: 'instance-a' })),
    listOperations: vi.fn(async () => ({ operations: [failed] })),
    ...overrides
  } as Service;
}

function renderPlans(service = serviceFor(), createTemplate: Template | null = null) {
  const onOpenInstance = vi.fn();
  return { service, onOpenInstance, ...render(<WorkflowSchedules identityKey="origin-a:agent-a:user-a" service={service} online createTemplate={createTemplate} onOpenInstance={onOpenInstance} />) };
}

describe('工作流本机定时计划', () => {
  beforeEach(() => sessionStorage.clear());

  it('R3 工作流列表显式请求动作筛选，不先加载普通 Agent 列表', async () => {
    const { service } = renderPlans();
    await screen.findByRole('button', { name: /每日审核计划/ });
    expect(service.listSchedules).toHaveBeenCalledWith(true);
  });

  it('R1 丢失创建响应后两次调用复用同一 UUID 和快照，只产生一计划', async () => {
    const plans = new Map<string, ScheduleResponse>();
    const createWorkflowSchedule = vi.fn(async (input: Parameters<Service['createWorkflowSchedule']>[0]): Promise<ScheduleResponse> => {
      const { requestId } = input as typeof input & { requestId: string };
      if (!plans.has(requestId)) plans.set(requestId, { ...schedule, id: `plan-${plans.size}` });
      if (createWorkflowSchedule.mock.calls.length === 1) throw new Error('响应丢失');
      return plans.get(requestId)!;
    });
    const { service } = renderPlans(serviceFor({ createWorkflowSchedule }), template);
    fireEvent.change(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' }), { target: { value: '{"text":"原输入"}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    const retry = await screen.findByRole('button', { name: '重试创建计划' });
    expect(screen.getByRole('textbox', { name: '计划名称' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消编辑' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' }), { target: { value: '{"text":"不能换入"}' } });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(service.createWorkflowSchedule).toHaveBeenCalledTimes(2);
    const [first, second] = createWorkflowSchedule.mock.calls.map(call => call[0]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i), workflow: { initialInput: { text: '原输入' } } });
    expect(plans.size).toBe(1);
  });

  it('R1 未知创建关闭重开原样恢复，成功后独立创建使用新 UUID', async () => {
    const create = vi.fn(async (_input: Parameters<Service['createWorkflowSchedule']>[0]): Promise<ScheduleResponse> => {
      if (create.mock.calls.length === 1) throw new Error('响应丢失');
      return schedule;
    });
    const service = serviceFor({ createWorkflowSchedule: create });
    const view = renderPlans(service, template);
    fireEvent.change(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' }), { target: { value: '{"text":"私密原输入"}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await screen.findByRole('button', { name: '重试创建计划' });
    view.unmount();
    const reopened = renderPlans(service, { ...template, id: 'template-b', name: '不同模板' });
    expect(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' })).toHaveValue(JSON.stringify({ text: '私密原输入' }, null, 2));
    fireEvent.click(screen.getByRole('button', { name: '重试创建计划' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    reopened.unmount();
    renderPlans(service, template);
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2]?.[0]).not.toHaveProperty('requestId', (create.mock.calls[0]?.[0] as { requestId?: string }).requestId);
  });

  it('R1 不向其他身份恢复原请求或原输入', async () => {
    const service = serviceFor({ createWorkflowSchedule: vi.fn(async () => { throw new Error('响应丢失'); }) });
    const view = renderPlans(service, template);
    fireEvent.change(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' }), { target: { value: '{"text":"前身份输入"}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await screen.findByRole('button', { name: '重试创建计划' });
    view.unmount();
    render(<WorkflowSchedules identityKey="origin-b:agent-b:user-b" service={service} online createTemplate={template} onOpenInstance={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' })).toHaveValue('{}');
    expect(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '重试创建计划' })).not.toBeInTheDocument();
    await screen.findByRole('button', { name: /每日审核计划/ });
  });

  it('R1 已确定拒绝允许改正内容，新提交不复用旧 UUID', async () => {
    const create = vi.fn(async (_input: Parameters<Service['createWorkflowSchedule']>[0]): Promise<ScheduleResponse> => {
      if (create.mock.calls.length === 1) throw new ApiClientError({ status: 400, code: 'CRON_INVALID', message: 'invalid' });
      return schedule;
    });
    renderPlans(serviceFor({ createWorkflowSchedule: create }), template);
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox', { name: 'Cron' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Cron' }), { target: { value: '0 8 * * *' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(create.mock.calls[1]?.[0]).toMatchObject({ cron: '0 8 * * *' });
    expect(create.mock.calls[1]?.[0].requestId).not.toBe(create.mock.calls[0]?.[0].requestId);
  });

  it.each([400, 404])('R1 未知创建重试被 %s 拒绝也不悄然改为新创建', async status => {
    const create = vi.fn(async (_input: Parameters<Service['createWorkflowSchedule']>[0]): Promise<ScheduleResponse> => {
      if (create.mock.calls.length === 1) throw new Error('响应丢失');
      throw new ApiClientError({ status, code: status === 404 ? 'SCHEDULE_NOT_FOUND' : 'SCHEDULE_INVALID', message: 'conflict or deleted' });
    });
    renderPlans(serviceFor({ createWorkflowSchedule: create }), template);
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重试创建计划' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重试创建计划' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: '计划名称' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消编辑' })).toBeDisabled();
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    expect(sessionStorage.getItem('workflow:schedule-create:origin-a:agent-a:user-a')).not.toBeNull();
  });

  it('R1 旧创建迟到成功不清除之后新创建的未知上下文', async () => {
    let resolveFirst!: (result: ScheduleResponse) => void;
    const first = new Promise<ScheduleResponse>(resolve => { resolveFirst = resolve; });
    const create = vi.fn(async (_input: Parameters<Service['createWorkflowSchedule']>[0]): Promise<ScheduleResponse> => {
      if (create.mock.calls.length === 1) return first;
      if (create.mock.calls.length === 2) return schedule;
      throw new Error('新创建响应丢失');
    });
    const service = serviceFor({ createWorkflowSchedule: create });
    const initial = renderPlans(service, template);
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    initial.unmount();
    const retry = renderPlans(service, template);
    fireEvent.click(screen.getByRole('button', { name: '重试创建计划' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    retry.unmount();
    const next = renderPlans(service, template);
    fireEvent.change(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' }), { target: { value: '{"text":"独立新创建"}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await screen.findByRole('alert');
    await act(async () => resolveFirst(schedule));
    next.unmount();
    renderPlans(service, null);
    expect(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' })).toHaveValue(JSON.stringify({ text: '独立新创建' }, null, 2));
    expect(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试创建计划' }));
    await screen.findByRole('alert');
    expect(create.mock.calls[3]?.[0]).toEqual(create.mock.calls[2]?.[0]);
  });
  it('创建确定性工作流动作，不依赖模型或项目', async () => {
    const { service } = renderPlans(serviceFor(), template);
    expect(screen.getByText(/由当前客户端发起/)).toHaveTextContent('daemon');
    fireEvent.change(screen.getByRole('textbox', { name: '计划名称' }), { target: { value: '晨间审核' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Cron' }), { target: { value: '0 8 * * *' } });
    fireEvent.change(screen.getByRole('textbox', { name: '时区' }), { target: { value: 'Asia/Shanghai' } });
    fireEvent.change(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' }), { target: { value: '{"text":"需求","count":2}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(service.createWorkflowSchedule).toHaveBeenCalledWith({ action: 'workflow_start', requestId: expect.any(String), name: '晨间审核', cron: '0 8 * * *', timezone: 'Asia/Shanghai', enabled: true,
      workflow: { templateId: 'template-a', initialInput: { text: '需求', count: 2 } } }));
    expect(screen.queryByText(/模型选择|运行配置|修复会话/)).not.toBeInTheDocument();
  });

  it.each(['[]', 'null', '"文本"', '{invalid'])('拒绝无效初始输入 %s', async value => {
    const { service } = renderPlans(serviceFor(), template);
    fireEvent.change(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' }), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('JSON 对象');
    expect(service.createWorkflowSchedule).not.toHaveBeenCalled();
  });

  it('按 UTF-8 字节拒绝超出 1 MiB 的初始输入', async () => {
    const { service } = renderPlans(serviceFor(), template);
    fireEvent.change(screen.getByRole('textbox', { name: '初始输入（JSON 对象）' }), { target: { value: JSON.stringify({ text: '中'.repeat(350000) }) } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 MiB');
    expect(service.createWorkflowSchedule).not.toHaveBeenCalled();
  });

  it.each(['计划名称', 'Cron', '时区'])('拒绝空字段 %s', async field => {
    const { service } = renderPlans(serviceFor(), template);
    fireEvent.change(screen.getByRole('textbox', { name: field }), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(service.createWorkflowSchedule).not.toHaveBeenCalled();
  });

  it('拒绝无效时区', async () => {
    const { service } = renderPlans(serviceFor(), template);
    fireEvent.change(screen.getByRole('textbox', { name: '时区' }), { target: { value: 'Invalid/Zone' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('时区');
    expect(service.createWorkflowSchedule).not.toHaveBeenCalled();
  });

  it('中文展示服务端 Cron 校验错误，不自动重试', async () => {
    const service = serviceFor({ createWorkflowSchedule: vi.fn(async () => { throw new ApiClientError({ status: 400, code: 'CRON_INVALID', message: 'internal invalid cron' }); }) });
    renderPlans(service, template);
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cron');
    expect(screen.getByRole('alert')).not.toHaveTextContent('internal');
    expect(service.createWorkflowSchedule).toHaveBeenCalledTimes(1);
  });

  it('只列工作流计划，启停不改动作，删除先确认', async () => {
    const { service } = renderPlans();
    expect(await screen.findByRole('button', { name: /每日审核计划/ })).toBeInTheDocument();
    expect(screen.queryByText('普通任务')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /每日审核计划/ }));
    fireEvent.click(await screen.findByRole('button', { name: '暂停计划' }));
    await waitFor(() => expect(service.updateSchedule).toHaveBeenCalledWith('plan-a', { enabled: false }));
    fireEvent.click(screen.getByRole('button', { name: '删除计划' }));
    expect(service.deleteSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(service.deleteSchedule).toHaveBeenCalledWith('plan-a'));
  });

  it('编辑完整输入并保持模板，不注入 prompt 或模型', async () => {
    const { service } = renderPlans();
    fireEvent.click(await screen.findByRole('button', { name: /每日审核计划/ }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑计划' }));
    expect(await screen.findByRole('textbox', { name: '初始输入（JSON 对象）' })).toHaveValue(JSON.stringify({ text: '审核' }, null, 2));
    fireEvent.change(screen.getByRole('textbox', { name: '计划名称' }), { target: { value: '修改后的计划' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(service.updateSchedule).toHaveBeenCalledWith('plan-a', expect.objectContaining({ name: '修改后的计划', workflow: { templateId: 'template-a', initialInput: { text: '审核' } } })));
    expect(vi.mocked(service.updateSchedule).mock.calls[0]?.[1]).not.toHaveProperty('action');
    expect(vi.mocked(service.updateSchedule).mock.calls[0]?.[1]).not.toHaveProperty('requestId');
  });

  it('立即发起创建新触发；未知结果只重试原触发并关联实例', async () => {
    const { service, onOpenInstance } = renderPlans();
    fireEvent.click(await screen.findByRole('button', { name: /每日审核计划/ }));
    expect(await screen.findByText('结果未知')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试原触发' }));
    await waitFor(() => expect(service.runNow).toHaveBeenCalledWith('plan-a', { triggerId: 'original-trigger' }));
    expect(service.runNow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: '立即发起' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '立即发起' }));
    await waitFor(() => expect(service.runNow).toHaveBeenCalledWith('plan-a'));
    fireEvent.click(screen.getByRole('button', { name: '查看最近实例' }));
    expect(onOpenInstance).toHaveBeenCalledWith('instance-a');
  });

  it('请求结果未知时提示从记录重试，不自动新建触发', async () => {
    const service = serviceFor({ runNow: vi.fn(async () => { throw new Error('secret internal server error'); }) });
    renderPlans(service);
    fireEvent.click(await screen.findByRole('button', { name: /每日审核计划/ }));
    fireEvent.click(await screen.findByRole('button', { name: '立即发起' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('触发记录');
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret');
    expect(service.runNow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(service.listOperations).toHaveBeenCalled());
  });

  it('离线只读，不显示修改、立即发起或原触发重试入口', async () => {
    const service = serviceFor();
    const view = renderPlans(service);
    fireEvent.click(await screen.findByRole('button', { name: /每日审核计划/ }));
    await screen.findByText('结果未知');
    view.rerender(<WorkflowSchedules identityKey="origin-a:agent-a:user-a" service={service} online={false} createTemplate={null} onOpenInstance={view.onOpenInstance} />);
    expect(screen.queryByRole('button', { name: '立即发起' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试原触发' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑计划' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '每日审核计划' })).toBeInTheDocument();
  });

  it('慢触发记录不得覆盖后来选中的计划', async () => {
    let resolveFirst!: (value: { operations: ScheduleOperationResponse[] }) => void;
    const service = serviceFor({
      listSchedules: vi.fn(async () => ({ schedules: [schedule, { ...schedule, id: 'plan-b', name: '第二计划' }] })),
      listOperations: vi.fn((id: string) => id === 'plan-a' ? new Promise<{ operations: ScheduleOperationResponse[] }>(resolve => { resolveFirst = resolve; }) : Promise.resolve({ operations: [] }))
    });
    renderPlans(service);
    fireEvent.click(await screen.findByRole('button', { name: /每日审核计划/ }));
    fireEvent.click(screen.getByRole('button', { name: /第二计划/ }));
    await act(async () => resolveFirst({ operations: [failed] }));
    expect(screen.queryByText('结果未知')).not.toBeInTheDocument();
  });

  it('同一触发的成功记录阻止旧失败记录出现重试入口', async () => {
    const service = serviceFor({ listOperations: vi.fn(async () => ({ operations: [failed, { ...failed, id: 'success', status: 'succeeded' as const, workflowInstanceId: 'instance-a', errorMessage: null }] })) });
    const { onOpenInstance } = renderPlans(service);
    fireEvent.click(await screen.findByRole('button', { name: /每日审核计划/ }));
    fireEvent.click(await screen.findByRole('button', { name: '查看关联实例' }));
    expect(onOpenInstance).toHaveBeenCalledWith('instance-a');
    expect(screen.queryByRole('button', { name: '重试原触发' })).not.toBeInTheDocument();
  });

  it('拒绝越权错误时使用固定中文提示，原触发重试不自动转为新触发', async () => {
    const service = serviceFor({ runNow: vi.fn(async () => { throw new ApiClientError({ status: 403, code: 'ENTERPRISE_FORBIDDEN', message: '/internal/server/path' }); }) });
    renderPlans(service);
    fireEvent.click(await screen.findByRole('button', { name: /每日审核计划/ }));
    fireEvent.click(await screen.findByRole('button', { name: '重试原触发' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不属于当前账号');
    expect(screen.getByRole('alert')).not.toHaveTextContent('/internal');
    expect(service.runNow).toHaveBeenCalledTimes(1);
    expect(service.runNow).toHaveBeenCalledWith('plan-a', { triggerId: 'original-trigger' });
  });

  it('提交进行中禁止双击创建或启动第二触发', async () => {
    let finish!: (value: ScheduleResponse) => void;
    const service = serviceFor({ createWorkflowSchedule: vi.fn(() => new Promise<ScheduleResponse>(resolve => { finish = resolve; })) });
    renderPlans(service, template);
    const save = screen.getByRole('button', { name: '保存计划' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(save).toBeDisabled();
    expect(service.createWorkflowSchedule).toHaveBeenCalledTimes(1);
    await act(async () => finish(schedule));
  });
});
