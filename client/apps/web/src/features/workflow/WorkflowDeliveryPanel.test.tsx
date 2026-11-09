import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EnterpriseWorkflowExecution } from '@clawee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowDeliveryPanel } from './WorkflowDeliveryPanel.js';

function execution(overrides: Partial<EnterpriseWorkflowExecution> = {}): EnterpriseWorkflowExecution {
  return {
    status: 'awaiting_confirmation', runId: 'run-1', threadId: 'thread-1', runStatus: 'succeeded',
    delivery: { text: '# AI 初稿', edited: false, version: 1, sourceRunId: 'run-1', latestText: '# AI 初稿', files: [], locked: false },
    ...overrides
  };
}

describe('节点人工交付区域', () => {
  it('仅展示待人工确认，编辑保存后才可提交且不修改原始回复', async () => {
    const onSave = vi.fn(async () => undefined);
    const onSubmit = vi.fn(async () => undefined);
    render(<WorkflowDeliveryPanel execution={execution()} online running={false} onSave={onSave} onSubmit={onSubmit} />);
    expect(screen.getByText('待人工确认')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '编辑交付结果' }));
    fireEvent.change(screen.getByRole('textbox', { name: '交付结果正文' }), { target: { value: '# 人工定稿' } });
    expect(screen.getByRole('button', { name: '完成节点并上传结果' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ version: 1, text: '# 人工定稿' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '完成节点并上传结果' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(1));
  });

  it('轮询不覆盖编辑框，保存失败保留人工输入', async () => {
    const onSave = vi.fn(async () => { throw new Error('交付草稿已变化，请刷新后重试'); });
    const onSubmit = vi.fn(async () => undefined);
    const view = render(<WorkflowDeliveryPanel execution={execution()} online running={false} onSave={onSave} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑交付结果' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '未保存的手改' } });
    const next = execution(); next.delivery = { ...next.delivery!, text: '后续回复', latestText: '后续回复', version: 2 };
    view.rerender(<WorkflowDeliveryPanel execution={next} online running={false} onSave={onSave} onSubmit={onSubmit} />);
    expect(screen.getByRole('textbox')).toHaveValue('未保存的手改');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('交付草稿已变化'));
    expect(screen.getByRole('textbox')).toHaveValue('未保存的手改');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('最新回复替换与附件选择必须由用户触发', async () => {
    const onSave = vi.fn(async () => undefined);
    const state = execution();
    state.delivery!.files = [{ path: 'report.md', name: 'report.md', sizeBytes: 12, sha256: 'a'.repeat(64), selected: true }];
    render(<WorkflowDeliveryPanel execution={state} online running={false} onSave={onSave} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '使用最新回复' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ version: 1, useLatest: true }));
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ version: 1, selectedPaths: [] }));
  });

  it.each(['running', 'submitting', 'offline'] as const)('%s 时禁止提交', status => {
    const state = execution({ status: status === 'submitting' ? 'submitting' : 'awaiting_confirmation' });
    render(<WorkflowDeliveryPanel execution={state} online={status !== 'offline'} running={status === 'running'} onSave={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: '完成节点并上传结果' })).toBeDisabled();
  });

  it('提交失败显示原内容重试，锁定编辑和附件', async () => {
    const state = execution({ status: 'submit_failed' }); state.delivery!.locked = true;
    const onSubmit = vi.fn(async () => undefined);
    render(<WorkflowDeliveryPanel execution={state} online running={false} onSave={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: '编辑交付结果' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试完成节点并上传结果' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(1));
  });
});
