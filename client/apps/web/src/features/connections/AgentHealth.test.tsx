import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseMcpHealthResponse } from '@clawee/protocol';
import { ApiClientError } from '../../runtime/errors.js';
import { AgentHealth } from './AgentHealth.js';

afterEach(() => { vi.useRealTimers(); });

const ready: EnterpriseMcpHealthResponse = {
  status: 'ready', message: 'MCP 连接正常，实际执行以任务结果为准', checkedAt: '2026-10-29T06:00:00Z'
};

describe('AgentHealth', () => {
  it('打开时只检查一次，停留不刷新，手动重查展示最新结果', async () => {
    const user = userEvent.setup();
    const checkMcpHealth = vi.fn().mockResolvedValueOnce(ready).mockResolvedValue({
      ...ready, status: 'attention', message: '模型配置未就绪'
    });
    render(<AgentHealth upstreamId="demo" name="演示助手" connected signedIn service={{ checkMcpHealth }} onSessionExpired={vi.fn()} />);
    expect(await screen.findByText('连接正常')).toBeInTheDocument();
    expect(screen.getByText(/最近检查/)).toBeInTheDocument();
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(checkMcpHealth).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await user.click(screen.getByRole('button', { name: '立即检查 演示助手' }));
    expect(await screen.findByText('模型配置未就绪')).toBeInTheDocument();
    expect(checkMcpHealth).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('连接正常')).not.toBeInTheDocument();
  });

  it('重查失败会清除原来的绿色状态，服务恢复后可再次检查', async () => {
    const user = userEvent.setup();
    const checkMcpHealth = vi.fn().mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new Error('private diagnostic'))
      .mockResolvedValue(ready);
    render(<AgentHealth upstreamId="demo" name="演示助手" connected signedIn service={{ checkMcpHealth }} onSessionExpired={vi.fn()} />);
    await screen.findByText('连接正常');
    const button = screen.getByRole('button', { name: '立即检查 演示助手' });
    await user.click(button);
    expect(await screen.findByText('未确认')).toBeInTheDocument();
    expect(screen.queryByText('连接正常')).not.toBeInTheDocument();
    expect(screen.queryByText('private diagnostic')).not.toBeInTheDocument();
    await user.click(button);
    expect(await screen.findByText('连接正常')).toBeInTheDocument();
  });

  it.each([401, 403])('HTTP %s 提示登录或权限问题，不显示连接失败', async status => {
    const onSessionExpired = vi.fn();
    const checkMcpHealth = vi.fn().mockRejectedValue(new ApiClientError({
      status, code: status === 401 ? 'ENTERPRISE_UNAUTHORIZED' : 'ENTERPRISE_FORBIDDEN', message: 'private diagnostic'
    }));
    render(<AgentHealth upstreamId="demo" name="演示助手" connected signedIn service={{ checkMcpHealth }} onSessionExpired={onSessionExpired} />);
    expect(await screen.findByText('需处理')).toBeInTheDocument();
    expect(screen.queryByText('连接失败')).not.toBeInTheDocument();
    expect(onSessionExpired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it('未登录或客户端断开时不探测，旧请求不覆盖新实例结果', async () => {
    let resolve!: (result: EnterpriseMcpHealthResponse) => void;
    const checkMcpHealth = vi.fn(() => new Promise<EnterpriseMcpHealthResponse>(done => { resolve = done; }));
    const service = { checkMcpHealth };
    const props = { upstreamId: 'demo', name: '演示助手', connected: true, signedIn: false, service, onSessionExpired: vi.fn() };
    const { rerender } = render(<AgentHealth {...props} />);
    expect(checkMcpHealth).not.toHaveBeenCalled();
    rerender(<AgentHealth {...props} signedIn />);
    await waitFor(() => { expect(checkMcpHealth).toHaveBeenCalledTimes(1); });
    rerender(<AgentHealth {...props} connected={false} signedIn />);
    await act(async () => { resolve(ready); });
    expect(screen.queryByText('连接正常')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
