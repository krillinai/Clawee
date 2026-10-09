import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DesktopUpdateState } from '@clawee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge, HostBridgeResult } from '../../host/bridge.js';
import { browserBridge } from '../../host/browser-bridge.js';
import { DesktopUpdateNotice, DesktopUpdateSettings, useDesktopUpdates } from './DesktopUpdates.js';

function fixture(initial: DesktopUpdateState = { supported: true, status: 'idle', currentVersion: '0.1.8' }) {
  let listener: ((state: DesktopUpdateState) => void) | undefined;
  const unsubscribe = vi.fn();
  const host: HostBridge = {
    ...browserBridge,
    kind: 'desktop',
    readUpdateState: vi.fn(async () => initial),
    subscribeUpdateState: vi.fn(callback => { listener = callback; return unsubscribe; }),
    checkForUpdates: vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true })),
    downloadUpdate: vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true })),
    installUpdate: vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }))
  };
  return { host, unsubscribe, publish: (state: DesktopUpdateState) => act(() => listener?.(state)) };
}

function Harness({ host }: { host: HostBridge }) {
  const updates = useDesktopUpdates(host);
  return <><DesktopUpdateSettings updates={updates} /><DesktopUpdateNotice updates={updates} /></>;
}

const available: DesktopUpdateState = {
  supported: true, status: 'available', currentVersion: '0.1.8', version: '0.1.9', notes: '适配客户工作流'
};

describe('客户更新交互', () => {
  afterEach(() => { window.localStorage.clear(); });

  it('浏览器和不支持更新的包不显示无效入口', async () => {
    const { rerender } = render(<Harness host={browserBridge} />);
    expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument();
    const test = fixture({ supported: false, status: 'idle', currentVersion: '0.1.8' });
    rerender(<Harness host={test.host} />);
    await waitFor(() => expect(test.host.readUpdateState).toHaveBeenCalled());
    expect(screen.queryByText('客户版本更新')).not.toBeInTheDocument();
  });

  it('提示新版本，稍后不重复提示，但保留设置页下载入口', async () => {
    const test = fixture(available);
    const { unmount } = render(<Harness host={test.host} />);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('0.1.9');
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    test.publish({ ...available });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载更新' })).toBeEnabled();
    unmount();
    render(<Harness host={test.host} />);
    await screen.findByText('客户版本更新');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    test.publish({ ...available, version: '0.1.10' });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('0.1.10');
  });

  it('显示下载进度，校验完成后提供安装，不提前调用安装', async () => {
    const test = fixture(available);
    render(<Harness host={test.host} />);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getAllByRole('button', { name: '下载更新' })[0]!);
    await waitFor(() => expect(test.host.downloadUpdate).toHaveBeenCalledTimes(1));
    test.publish({ ...available, status: 'downloading', progress: 42 });
    expect(screen.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute('value', '42');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(test.host.installUpdate).not.toHaveBeenCalled();
    test.publish({ ...available, status: 'downloaded' });
    fireEvent.click(screen.getAllByRole('button', { name: '安装并重启' })[0]!);
    await waitFor(() => expect(test.host.installUpdate).toHaveBeenCalledTimes(1));
  });

  it('安装被任务门禁拒绝时显示原因，仍可再次安装', async () => {
    const test = fixture({ ...available, status: 'downloaded' });
    test.host.installUpdate = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: false, code: 'FAILED', message: '还有未结束的本地任务' }));
    render(<Harness host={test.host} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '安装并重启' }))[0]!);
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('还有未结束的本地任务');
    await waitFor(() => expect(screen.getAllByRole('button', { name: '安装并重启' })[0]).toBeEnabled());
  });

  it('订阅的新状态不会被较晚返回的旧读取结果覆盖', async () => {
    const test = fixture();
    let resolveRead: ((state: DesktopUpdateState) => void) | undefined;
    test.host.readUpdateState = vi.fn(() => new Promise<DesktopUpdateState>(resolve => { resolveRead = resolve; }));
    const { unmount } = render(<Harness host={test.host} />);
    test.publish(available);
    await act(async () => resolveRead?.({ supported: true, status: 'idle', currentVersion: '0.1.8' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('0.1.9');
    unmount();
    expect(test.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('重复点击不会同时发起多个操作，异常后可重试', async () => {
    const test = fixture();
    let rejectCheck: ((reason: Error) => void) | undefined;
    test.host.checkForUpdates = vi.fn(() => new Promise<HostBridgeResult>((_resolve, reject) => { rejectCheck = reject; }));
    render(<Harness host={test.host} />);
    const button = await screen.findByRole('button', { name: '检查更新' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(test.host.checkForUpdates).toHaveBeenCalledTimes(1);
    await act(async () => rejectCheck?.(new Error('暂时无法连接更新服务')));
    expect(screen.getByRole('alert')).toHaveTextContent('暂时无法连接更新服务');
    expect(button).toBeEnabled();
  });
});
