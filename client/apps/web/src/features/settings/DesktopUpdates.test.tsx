import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  afterEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });

  it('网络恢复时检查更新，卸载后不再触发', async () => {
    const test = fixture();
    const view = render(<Harness host={test.host} />);
    await screen.findByRole('button', { name: '检查更新' });
    fireEvent(window, new Event('online'));
    expect(test.host.checkForUpdates).toHaveBeenCalledOnce();
    view.unmount();
    fireEvent(window, new Event('online'));
    expect(test.host.checkForUpdates).toHaveBeenCalledOnce();
  });

  it.each(['win32', 'darwin', 'linux'] as const)('升级测试入口共用，不由前端硬编码平台：%s', async platform => {
    const test = fixture({ supported: true, status: 'idle', currentVersion: '1.0.20' });
    test.host.platform = platform;
    test.host.testUpdate = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }));
    test.host.cancelUpdateTest = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }));
    render(<Harness host={test.host} />);
    fireEvent.click(await screen.findByText('升级测试', { selector: 'summary' }));
    expect(screen.getByText(/实际运行版本仍为 1.0.20/)).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '模拟起始版本' });
    fireEvent.change(input, { target: { value: '1.0.19' } });
    fireEvent.click(screen.getByRole('button', { name: '执行一次升级测试' }));
    await waitFor(() => expect(test.host.testUpdate).toHaveBeenCalledExactlyOnceWith('1.0.19'));
    expect(test.host.installUpdate).not.toHaveBeenCalled();
  });

  it('不支持原生更新时展示原因并禁用测试', async () => {
    const test = fixture({ supported: false, status: 'idle', currentVersion: '1.0.20', testUnsupportedReason: '当前平台没有受支持的原生更新器' });
    test.host.testUpdate = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: false, code: 'UNSUPPORTED', message: '不支持' }));
    test.host.cancelUpdateTest = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }));
    render(<Harness host={test.host} />);
    fireEvent.click(await screen.findByText('升级测试', { selector: 'summary' }));
    expect(screen.getByRole('status')).toHaveTextContent('没有受支持的原生更新器');
    expect(screen.getByRole('button', { name: '执行一次升级测试' })).toBeDisabled();
    expect(test.host.testUpdate).not.toHaveBeenCalled();
  });

  it('测试等待期间禁止重复执行，但可以取消长时间等待的调用', async () => {
    const test = fixture({ ...available, automatic: true });
    let finish: (result: HostBridgeResult) => void = () => {};
    test.host.testUpdate = vi.fn(() => new Promise<HostBridgeResult>(resolve => { finish = resolve; }));
    test.host.cancelUpdateTest = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }));
    render(<Harness host={test.host} />);
    fireEvent.click(await screen.findByText('升级测试', { selector: 'summary' }));
    fireEvent.change(screen.getByRole('textbox', { name: '模拟起始版本' }), { target: { value: '0.1.7' } });
    fireEvent.click(screen.getByRole('button', { name: '执行一次升级测试' }));
    test.publish({ ...available, status: 'waiting', automatic: true, test: { simulatedVersion: '0.1.7', status: 'waiting' } });
    expect(screen.getByRole('button', { name: '执行一次升级测试' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消测试' }));
    await waitFor(() => expect(test.host.cancelUpdateTest).toHaveBeenCalledOnce());
    await act(async () => finish({ ok: false, code: 'FAILED', message: '升级测试已取消' }));
  });

  it('严重失败显示已恢复和暂停；原生接管后隐藏重试入口', async () => {
    const test = fixture({ ...available, status: 'paused', automatic: true, recovery: 'restored', errorCode: 'DAEMON_SHUTDOWN_TIMEOUT' });
    render(<Harness host={test.host} />);
    const notice = await screen.findByRole('status', { name: '客户端自动更新' });
    expect(notice).toHaveTextContent('自动安装已暂停');
    expect(notice).toHaveTextContent('工作台已恢复');
    expect(within(notice).getByRole('link', { name: '官方安装包' })).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(test.host.downloadUpdate).toHaveBeenCalledOnce());
    test.publish({ ...available, status: 'paused', automatic: true, nativePending: true });
    expect(within(notice).queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(notice).toHaveTextContent('结果待确认');
  });

  it('自动更新使用非阻塞状态提示，等待空闲时不要求确认安装', async () => {
    const test = fixture({ ...available, status: 'waiting', automatic: true, gateway: 'https://customer.example.com' });
    render(<Harness host={test.host} />);
    expect(await screen.findByText('https://customer.example.com')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '安装并重启' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '客户端自动更新' })).toHaveTextContent('更新已就绪，等待任务完成和文件保存');
  });

  it.each(['available', 'downloading', 'downloaded', 'waiting', 'installing', 'error'] as const)(
    '自动更新 %s 独立展示版本与状态，空闲后隐藏提示', async status => {
      const test = fixture({ ...available, status, automatic: true, progress: 42,
        error: status === 'error' ? '暂时无法连接更新服务' : undefined });
      render(<Harness host={test.host} />);
      const notice = await screen.findByRole('status', { name: '客户端自动更新' });
      expect(within(notice).getByText('客户端更新 · 0.1.9')).toHaveClass('desktop-update-notice-title');
      expect(notice.querySelector('.desktop-update-notice-text')).not.toBeEmptyDOMElement();
      expect(notice.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      if (status === 'error') expect(within(notice).getByRole('alert')).toHaveTextContent('暂时无法连接更新服务');
      test.publish({ ...available, status: 'idle', automatic: true });
      expect(screen.queryByRole('status', { name: '客户端自动更新' })).not.toBeInTheDocument();
    }
  );

  it.each(['available', 'downloading', 'verifying', 'downloaded', 'waiting', 'installing', 'paused', 'error'] as const)(
    '自动更新 %s 可关闭，同版本状态变化不再弹出且设置页仍可检查', async status => {
      const test = fixture({ ...available, status, automatic: true, progress: 42 });
      render(<Harness host={test.host} />);
      const notice = await screen.findByRole('status', { name: '客户端自动更新' });
      const close = within(notice).getByRole('button', { name: '关闭更新提示' });
      expect(close).toBeEnabled();
      fireEvent.click(close);
      expect(screen.queryByRole('status', { name: '客户端自动更新' })).not.toBeInTheDocument();
      expect(test.host.checkForUpdates).not.toHaveBeenCalled();
      expect(test.host.downloadUpdate).not.toHaveBeenCalled();
      expect(test.host.installUpdate).not.toHaveBeenCalled();

      const failed = { ...available, status: 'error' as const, automatic: true, error: '暂时无法连接更新服务' };
      test.publish(failed);
      test.publish({ ...failed });
      expect(screen.queryByRole('status', { name: '客户端自动更新' })).not.toBeInTheDocument();
      const settings = screen.getByRole('region', { name: '客户端版本更新' });
      expect(within(settings).getByRole('alert')).toHaveTextContent('暂时无法连接更新服务');
      fireEvent.click(within(settings).getByRole('button', { name: '检查更新' }));
      await waitFor(() => expect(test.host.checkForUpdates).toHaveBeenCalledOnce());
    }
  );

  it('自动更新关闭状态在本次会话内保留，新版本和新会话可再次提示', async () => {
    const test = fixture({ ...available, status: 'error', automatic: true });
    const first = render(<Harness host={test.host} />);
    fireEvent.click(within(await screen.findByRole('status', { name: '客户端自动更新' }))
      .getByRole('button', { name: '关闭更新提示' }));
    first.unmount();

    const second = render(<Harness host={test.host} />);
    await screen.findByRole('heading', { name: '客户端版本更新' });
    expect(screen.queryByRole('status', { name: '客户端自动更新' })).not.toBeInTheDocument();
    test.publish({ ...available, automatic: true, version: '0.1.10' });
    expect(screen.getByRole('status', { name: '客户端自动更新' })).toHaveTextContent('客户端更新 · 0.1.10');
    second.unmount();

    window.sessionStorage.clear();
    render(<Harness host={test.host} />);
    expect(await screen.findByRole('status', { name: '客户端自动更新' })).toHaveTextContent('客户端更新 · 0.1.9');
  });

  it('浏览器和不支持更新的包不显示无效入口', async () => {
    const { rerender } = render(<Harness host={browserBridge} />);
    expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument();
    const test = fixture({ supported: false, status: 'idle', currentVersion: '0.1.8' });
    rerender(<Harness host={test.host} />);
    await waitFor(() => expect(test.host.readUpdateState).toHaveBeenCalled());
    expect(screen.queryByText('客户端版本更新')).not.toBeInTheDocument();
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
    await screen.findByText('客户端版本更新');
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

  it('版本与更新服务器使用独立标签，检查按钮位于标题栏', async () => {
    const test = fixture({ ...available, automatic: true, gateway: 'https://customer.example.com' });
    render(<Harness host={test.host} />);
    const heading = await screen.findByRole('heading', { name: '客户端版本更新' });
    expect(heading.parentElement).toContainElement(screen.getByRole('button', { name: '检查更新' }));
    expect(screen.getByText('当前版本').tagName).toBe('DT');
    expect(screen.getByText('0.1.8').tagName).toBe('DD');
    expect(screen.getByText('更新服务器').tagName).toBe('DT');
    expect(screen.getByText('https://customer.example.com').tagName).toBe('DD');
  });

  it.each([0, 28.4, 100])('下载进度 %s 独立显示百分比并禁用重复检查', async progress => {
    const test = fixture({ ...available, status: 'downloading', progress });
    render(<Harness host={test.host} />);
    const progressbar = await screen.findByRole('progressbar', { name: '更新下载进度' });
    expect(progressbar).toHaveAttribute('value', String(progress));
    expect(progressbar).toHaveAttribute('max', '100');
    expect(screen.getByRole('status')).toHaveTextContent(`正在下载更新${Math.round(progress)}%`);
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled();
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
