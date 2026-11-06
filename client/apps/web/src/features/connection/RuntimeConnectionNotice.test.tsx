import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeConnectionNotice } from './RuntimeConnectionNotice.js';

describe('本地连接恢复入口', () => {
  it('重试只恢复连接；重启服务需要确认任务中断', async () => {
    const onRetry = vi.fn(async () => {});
    const restartRuntime = vi.fn(async () => ({ ok: true as const }));
    render(<RuntimeConnectionNotice hostBridge={{ restartRuntime }} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
    expect(restartRuntime).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: '重启本地服务' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '重启本地服务' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('这会中断正在执行的任务');
    expect(restartRuntime).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认重启' }));
    await waitFor(() => expect(restartRuntime).toHaveBeenCalledOnce());
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('浏览器不展示无效重启入口，恢复失败可再次操作', async () => {
    const onRetry = vi.fn(async () => { throw new Error('failed'); });
    render(<RuntimeConnectionNotice hostBridge={{}} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: '重启本地服务' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('本地服务恢复失败');
    expect(screen.getByRole('button', { name: '重试连接' })).toBeEnabled();
  });
});
