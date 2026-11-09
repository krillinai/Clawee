import { afterEach, describe, expect, it, vi } from 'vitest';
import { net } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomerUpdateController, type CustomerUpdateRelease } from '../src/main/customer-update.js';
import { DesktopUpdateBusyError, readDaemonUpdateConnection } from '../src/main/customer-update-daemon.js';
import { readConfiguredUpdateConnection } from '../src/main/enterprise-user-config-2026-08-06.js';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

const controllers: CustomerUpdateController[] = [];
const directories: string[] = [];

function fixture() {
  const release: CustomerUpdateRelease = {
    kind: 'customer-desktop-update', gateway_url: 'https://customer.example.com', version: '1.0.6',
    notes: '通用客户端更新', revision: 2, published_at: '2026-10-12T00:00:00Z',
    packages: [{ platform: 'macos', arch: 'arm64', url: 'https://cdn.example.com/v1.0.6/Clawee.zip', size: 123, sha512: Buffer.alloc(64, 1).toString('base64') }]
  };
  const getConnection = vi.fn(async () => ({ gateway: release.gateway_url, sessionId: 'session-1' } as { gateway: string; sessionId: string } | null));
  const readRelease = vi.fn(async (_gateway: string) => ({ update: structuredClone(release) as CustomerUpdateRelease | null }));
  const native = {
    check: vi.fn(async () => ({ version: release.version, releaseNotes: release.notes, files: release.packages.map(({ url, sha512, size }) => ({ url, sha512, size })) })),
    download: vi.fn(async () => undefined), verify: vi.fn(async () => undefined),
    install: vi.fn(async (authorize: () => void) => { authorize(); }), onProgress: vi.fn()
  };
  const prepare = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const recover = vi.fn(async () => undefined);
  const controller = new CustomerUpdateController({ getConnection, automatic: true, currentVersion: '1.0.5', platform: 'darwin', arch: 'arm64', native, readRelease, prepare, stop, recover });
  controllers.push(controller);
  return { controller, release, getConnection, readRelease, native, prepare, stop, recover };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(net.fetch).mockReset();
});

describe('通用客户端运行时更新渠道', () => {
  it('启动检查遇到临时网络故障后自动重试并完成升级', async () => {
    vi.useFakeTimers();
    const context = fixture();
    context.readRelease.mockRejectedValueOnce(new TypeError('fetch failed'));
    context.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.native.download).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.native.install).toHaveBeenCalledOnce();
  });
  it('无包内客户标记也能按当前连接自动下载和安装', async () => {
    const context = fixture();
    expect(context.controller.currentState.supported).toBe(true);
    await context.controller.checkForUpdates();
    const first = context.controller.runAutomaticUpdate();
    expect(context.controller.runAutomaticUpdate()).toBe(first);
    await first;
    expect(context.native.download).toHaveBeenCalledOnce();
    expect(context.prepare).toHaveBeenCalledOnce();
    expect(context.native.install).toHaveBeenCalledOnce();
    expect(context.controller.canQuitForInstall).toBe(true);
    expect(context.native.check).toHaveBeenCalledWith('https://customer.example.com/api/v1/public/client-updates/2/macos/arm64/');
  });

  it.each(['disconnected', 'disabled', 'equal', 'newer'] as const)('无连接、停用和非新版本不下载安装：%s', async scenario => {
    const context = fixture();
    if (scenario === 'disconnected') context.getConnection.mockResolvedValue(null);
    if (scenario === 'disabled') context.readRelease.mockResolvedValue({ update: null });
    if (scenario === 'equal') context.release.version = '1.0.5';
    if (scenario === 'newer') context.release.version = '1.0.4';
    await context.controller.checkForUpdates();
    await context.controller.runAutomaticUpdate();
    expect(context.native.download).not.toHaveBeenCalled();
    expect(context.native.install).not.toHaveBeenCalled();
  });

  it('启动发现更新后每三十秒尝试安装，任务忙时不重复下载', async () => {
    vi.useFakeTimers();
    const context = fixture();
    context.prepare.mockRejectedValueOnce(new DesktopUpdateBusyError('busy'));
    context.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.controller.currentState).toMatchObject({ status: 'waiting', error: undefined });
    expect(context.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(context.prepare).toHaveBeenCalledOnce();
    expect(context.native.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(context.native.download).toHaveBeenCalledOnce();
    expect(context.native.install).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('长时间等待安装也不重新检查版本，退出后停止安装重试', async () => {
    vi.useFakeTimers();
    const context = fixture();
    context.prepare.mockRejectedValue(new DesktopUpdateBusyError('busy'));
    context.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const nativeChecks = context.native.check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(context.prepare).toHaveBeenCalledTimes(21);
    expect(context.native.check).toHaveBeenCalledTimes(nativeChecks);
    expect(context.native.download).toHaveBeenCalledOnce();
    expect(context.controller.currentState.status).toBe('waiting');
    context.controller.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.prepare).toHaveBeenCalledTimes(21);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['server', 'session', 'logout'] as const)('下载期间仅更新源变化取消旧包，账号与退出不取消：%s', async change => {
    const context = fixture();
    context.native.download.mockImplementationOnce(async () => {
      context.getConnection.mockResolvedValue({ gateway: change === 'server' ? 'https://other.example.com' : context.release.gateway_url, sessionId: change === 'logout' ? '' : 'session-2' });
    });
    await context.controller.checkForUpdates();
    await context.controller.runAutomaticUpdate();
    expect(context.prepare).toHaveBeenCalledTimes(change === 'server' ? 0 : 1);
    expect(context.native.install).toHaveBeenCalledTimes(change === 'server' ? 0 : 1);
  });

  it('安装准备后停用策略阻止停机和安装', async () => {
    const context = fixture();
    context.prepare.mockImplementationOnce(async () => { context.readRelease.mockResolvedValue({ update: null }); });
    await context.controller.checkForUpdates();
    await context.controller.runAutomaticUpdate();
    expect(context.stop).not.toHaveBeenCalled();
    expect(context.native.install).not.toHaveBeenCalled();
    expect(context.recover).toHaveBeenCalledOnce();
  });

  it('停机后以被冻结的连接核对快照，不依赖已退出的daemon', async () => {
    const context = fixture();
    context.stop.mockImplementationOnce(async () => { context.getConnection.mockRejectedValue(new Error('daemon stopped')); });
    await context.controller.checkForUpdates();
    await context.controller.runAutomaticUpdate();
    expect(context.native.install).toHaveBeenCalledOnce();
    expect(context.readRelease).toHaveBeenLastCalledWith(context.release.gateway_url);
  });

  it('启动无更新后每十五分钟复查，重复启动不增加轮询', async () => {
    vi.useFakeTimers();
    const context = fixture();
    context.readRelease.mockResolvedValue({ update: null });
    context.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const connectionReads = context.getConnection.mock.calls.length;
    context.controller.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(context.readRelease).toHaveBeenCalledTimes(3);
    expect(context.getConnection.mock.calls.length).toBeGreaterThan(connectionReads);
    expect(vi.getTimerCount()).toBe(1);
    context.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['disconnected', 'error'] as const)('启动无法检查后继续轮询与退避重试：%s', async scenario => {
    vi.useFakeTimers();
    const context = fixture();
    if (scenario === 'disconnected') context.getConnection.mockResolvedValue(null);
    if (scenario === 'error') context.readRelease.mockRejectedValue(new Error('offline'));
    context.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const connectionReads = context.getConnection.mock.calls.length;
    const releaseReads = context.readRelease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(context.getConnection.mock.calls.length).toBeGreaterThan(connectionReads);
    if (scenario === 'error') expect(context.readRelease.mock.calls.length).toBeGreaterThan(releaseReads);
    expect(context.native.download).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    context.controller.dispose();
  });

  it('手动检查发现更新后仍每三十秒尝试安装', async () => {
    vi.useFakeTimers();
    const context = fixture();
    context.readRelease.mockResolvedValueOnce({ update: null });
    context.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await context.controller.checkForUpdates();
    context.prepare.mockRejectedValueOnce(new DesktopUpdateBusyError('busy'));
    await context.controller.runAutomaticUpdate();
    expect(context.controller.currentState.status).toBe('waiting');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.native.download).toHaveBeenCalledOnce();
    expect(context.native.install).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('等待安装期间切换来源后取消旧包，重新检查新来源', async () => {
    vi.useFakeTimers();
    const context = fixture();
    context.prepare.mockRejectedValueOnce(new DesktopUpdateBusyError('busy'));
    context.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const releaseReads = context.readRelease.mock.calls.length;
    context.getConnection.mockResolvedValue({ gateway: 'https://other.example.com', sessionId: 'session-2' });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(context.readRelease.mock.calls.length).toBeGreaterThan(releaseReads);
    expect(context.readRelease).toHaveBeenLastCalledWith('https://other.example.com');
    expect(context.native.install).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    context.controller.dispose();
  });

  it('daemon 更新来源接口保持本机 token 保护，不返回登录身份', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ connection: { gateway: 'https://customer.example.com', sessionId: 'a'.repeat(64) } }), { status: 200 }));
    vi.mocked(net.fetch).mockImplementation(fetch);
    const connection = { address: 'http://127.0.0.1:1905', token: 'local-secret' };
    await expect(readDaemonUpdateConnection(connection)).resolves.toEqual({ gateway: 'https://customer.example.com' });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1905/desktop-update/context', expect.objectContaining({ headers: { Authorization: 'Bearer local-secret' }, redirect: 'error' }));
    await expect(readDaemonUpdateConnection({ ...connection, address: 'https://remote.example.com' })).rejects.toThrow('本机');
  });

  it('直接读取本机已保存来源，无需 daemon；切换、未配置与非法来源不沿用旧渠道', () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-update-source-'));
    directories.push(directory);
    const path = join(directory, 'config.toml');
    for (const gateway of ['https://customer.example.com', 'https://other.example.com/']) {
      writeFileSync(path, `gateway = "${gateway}"\n`);
      expect(readConfiguredUpdateConnection(path)).toEqual({ gateway: new URL(gateway).origin });
    }
    for (const gateway of ['http://customer.example.com', 'https://enterprise.invalid', 'https://user:secret@customer.example.com', 'https://customer.example.com/path', 'https://customer.example.com?source=other']) {
      writeFileSync(path, `gateway = "${gateway}"\n`);
      expect(readConfiguredUpdateConnection(path)).toBeNull();
    }
    writeFileSync(path, 'invalid');
    expect(readConfiguredUpdateConnection(path)).toBeNull();
    rmSync(path);
    expect(readConfiguredUpdateConnection(path)).toBeNull();
  });
});
