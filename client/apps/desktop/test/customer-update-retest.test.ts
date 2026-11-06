import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomerUpdateController, type CustomerUpdateRelease } from '../src/main/customer-update.js';
import { CustomerUpdateJournal } from '../src/main/customer-update-record.js';
import { DesktopUpdateBusyError } from '../src/main/customer-update-daemon.js';
import { CustomerUpdateError } from '../src/main/customer-update-error.js';
import type { DesktopUpdateConnection } from '@clawee/protocol';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
const roots: string[] = [];
const controllers: CustomerUpdateController[] = [];
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.dispose());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.useRealTimers();
});

function fixture(platform: 'win32' | 'darwin' = 'win32') {
  const root = mkdtempSync(join(tmpdir(), 'clawee-update-retest-'));
  roots.push(root);
  const journalPath = join(root, 'update.json');
  const release: CustomerUpdateRelease = {
    kind: 'customer-desktop-update', gateway_url: 'https://test.example', version: '1.0.20', notes: '', revision: 1,
    published_at: '2026-10-20T00:00:00Z', packages: [{ platform: platform === 'win32' ? 'windows' : 'macos', arch: 'x64',
      url: `https://files.example/update.${platform === 'win32' ? 'exe' : 'zip'}`, size: 20, sha512: Buffer.alloc(64, 1).toString('base64') }]
  };
  let receipt: { targetVersion: string; fingerprint: string } | undefined;
  const originalConnection = { gateway: release.gateway_url };
  let connection: DesktopUpdateConnection | null = originalConnection;
  function boot(version = '1.0.20') {
    const native = {
      check: vi.fn(async () => ({ version: release.version, releaseNotes: release.notes,
        files: release.packages.map(({ url, size, sha512 }) => ({ url, size, sha512 })) })),
      download: vi.fn(async () => {}), verify: vi.fn(async () => {}), onProgress: vi.fn(),
      install: vi.fn(async (authorize: () => void) => { authorize(); })
    };
    const prepare = vi.fn(async () => {}), stop = vi.fn(async () => {}), recover = vi.fn(async () => {});
    const readRelease = vi.fn(async () => ({ update: structuredClone(release) }));
    const journal = new CustomerUpdateJournal(journalPath);
    const controller = new CustomerUpdateController({ native, prepare, stop, recover, readRelease, journal,
      gateway: release.gateway_url, automatic: true, platform, arch: 'x64', currentVersion: version,
      getConnection: async () => connection,
      readInstallReceipt: platform === 'win32' ? () => receipt : undefined });
    controllers.push(controller);
    return { controller, native, prepare, stop, recover, readRelease, journal };
  }
  return { boot, release, originalConnection, setConnection: (next: typeof connection) => { connection = next; },
    setReceipt: (next: typeof receipt) => { receipt = next; } };
}

describe('客户端单次升级复测', () => {
  it('真实版本不变；复用授权、下载、最终校验和安装，只执行一次', async () => {
    const test = fixture();
    const value = test.boot();
    expect(await value.controller.testUpdate('1.0.19')).toEqual({ ok: true });
    expect(value.controller.currentState).toMatchObject({ currentVersion: '1.0.20', nativePending: true,
      test: { simulatedVersion: '1.0.19', status: 'pending' } });
    expect(value.native.check).toHaveBeenCalledWith(expect.stringContaining('/windows/x64/'), '1.0.19');
    expect(value.native.verify).toHaveBeenCalledWith(test.release.packages[0], true);
    expect(value.readRelease.mock.calls.length).toBeGreaterThan(2);
    await value.controller.runAutomaticUpdate();
    await value.controller.testUpdate('1.0.19');
    expect(value.native.install).toHaveBeenCalledOnce();
  });

  it.each(['', '1.0.20', '1.0.21', '1.0.19-rc', '9007199254740992.0.0'])('无效模拟版本 %s 不启动下载或停机', async version => {
    const value = fixture().boot();
    expect(await value.controller.testUpdate(version)).toMatchObject({ ok: false });
    expect(value.native.download).not.toHaveBeenCalled();
    expect(value.stop).not.toHaveBeenCalled();
  });

  it('后台批准旧包时拒绝真实降级', async () => {
    const test = fixture();
    test.release.version = '1.0.19';
    const value = test.boot();
    expect(await value.controller.testUpdate('1.0.18')).toMatchObject({ ok: false });
    expect(value.native.download).not.toHaveBeenCalled();
    expect(value.stop).not.toHaveBeenCalled();
  });

  it.each(['1.0.20', '1.0.21'])('macOS 无安装凭证也可执行同版本或更高版本复测：%s', async version => {
    const test = fixture('darwin');
    test.release.version = version;
    const value = test.boot();
    expect(await value.controller.testUpdate('1.0.19')).toEqual({ ok: true });
    expect(value.controller.currentState).toMatchObject({ currentVersion: '1.0.20', nativePending: true,
      test: { simulatedVersion: '1.0.19', status: 'pending' } });
    expect(value.native.check).toHaveBeenCalledWith(expect.stringContaining('/macos/x64/'), '1.0.19');
    expect(value.journal.latestTest()).toMatchObject({ targetVersion: version, fromVersion: '1.0.20', phase: 'awaiting_start' });
    expect(value.native.install).toHaveBeenCalledOnce();
  });

  it.each([
    ['1.0.20', true, 'succeeded'], ['1.0.19', true, 'failed'],
    ['1.0.21', true, 'failed'], ['1.0.20', false, 'failed']
  ] as const)('macOS 重启后按记录目标版本和初始化结果判断：版本=%s，就绪=%s', async (version, ready, status) => {
    const test = fixture('darwin');
    expect(await test.boot().controller.testUpdate('1.0.19')).toEqual({ ok: true });
    test.release.version = '1.0.22';
    const next = test.boot(version);
    if (version === '1.0.20') expect(next.controller.currentState.test?.status).toBe('pending');
    next.controller.confirmLocalStartup(ready);
    expect(next.controller.currentState.test?.status).toBe(status);
    if (status === 'succeeded') expect(next.controller.currentState.test?.message).toContain('重启后版本校验通过');
    expect(next.journal.latestTest()?.targetVersion).toBe('1.0.20');
    expect(next.readRelease).not.toHaveBeenCalled();
    expect(next.native.install).not.toHaveBeenCalled();
  });

  it.each([false, true])('macOS 原生安装报错后重启到同版本不能报告通过：已接管=%s', async handedOff => {
    const test = fixture('darwin');
    const value = test.boot();
    value.native.install.mockImplementationOnce(async authorize => {
      if (handedOff) authorize();
      throw new CustomerUpdateError('SIGNATURE_FAILED', '签名无效');
    });
    expect(await value.controller.testUpdate('1.0.19')).toMatchObject({ ok: false });
    expect(value.recover).toHaveBeenCalledTimes(handedOff ? 0 : 1);
    const next = test.boot();
    next.controller.confirmLocalStartup(true);
    expect(next.controller.currentState.test?.status).toBe('failed');
    expect(next.native.install).not.toHaveBeenCalled();
  });

  it('任务忙只等待，取消后不自动重试、不沿用模拟参数', async () => {
    vi.useFakeTimers();
    const value = fixture().boot();
    value.prepare.mockRejectedValue(new DesktopUpdateBusyError('等待工作空闲'));
    const testing = value.controller.testUpdate('1.0.19');
    await vi.advanceTimersByTimeAsync(0);
    expect(value.controller.currentState.test?.status).toBe('waiting');
    expect(await value.controller.testUpdate('1.0.18')).toMatchObject({ ok: false });
    expect(await value.controller.checkForUpdates()).toMatchObject({ ok: false });
    expect(value.controller.cancelUpdateTest()).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await testing).toMatchObject({ ok: false });
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.native.install).not.toHaveBeenCalled();
    expect(value.controller.currentState.test?.status).toBe('cancelled');
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.native.install).not.toHaveBeenCalled();
  });

  it('等待空闲后只进入一次安装，批准快照变化不能越过复核', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const value = test.boot();
    value.prepare.mockRejectedValueOnce(new DesktopUpdateBusyError('等待工作空闲'));
    const testing = value.controller.testUpdate('1.0.19');
    await vi.advanceTimersByTimeAsync(0);
    test.release.revision += 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await testing).toMatchObject({ ok: false });
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.native.install).not.toHaveBeenCalled();
  });

  it('停机失败恢复，跨重启保留失败记录且不自动再次执行', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const value = test.boot('1.0.19');
    value.stop.mockRejectedValue(new Error('DAEMON_SHUTDOWN_TIMEOUT'));
    expect(await value.controller.testUpdate('1.0.18')).toMatchObject({ ok: false });
    expect(value.recover).toHaveBeenCalledOnce();
    const next = test.boot('1.0.19');
    next.controller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(next.controller.currentState.test?.status).toBe('failed');
    expect(next.stop).not.toHaveBeenCalled();
    expect(next.native.install).not.toHaveBeenCalled();
  });

  it.each(['check-network', 'signature'] as const)('后台准备失败也保留单次暂停，重启不能自动续跑：%s', async scenario => {
    vi.useFakeTimers();
    const test = fixture();
    const value = test.boot('1.0.19');
    if (scenario === 'check-network') value.native.check.mockRejectedValue(new CustomerUpdateError('NETWORK_FAILED', '网络中断'));
    else value.native.verify.mockRejectedValue(new CustomerUpdateError('SIGNATURE_FAILED', '签名无效'));
    expect(await value.controller.testUpdate('1.0.18')).toMatchObject({ ok: false });
    const next = test.boot('1.0.19');
    next.controller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(next.controller.currentState.test?.status).toBe('failed');
    expect(next.native.install).not.toHaveBeenCalled();
    expect(next.stop).not.toHaveBeenCalled();
  });

  it('取消下载后迟到的完成回调不能停机或安装，重新测试必须重新核对授权', async () => {
    const test = fixture();
    const value = test.boot();
    let finish: () => void = () => {};
    value.native.download.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const testing = value.controller.testUpdate('1.0.19');
    await vi.waitFor(() => expect(value.native.download).toHaveBeenCalledOnce());
    expect(value.controller.cancelUpdateTest()).toEqual({ ok: true });
    finish();
    expect(await testing).toMatchObject({ ok: false });
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.native.install).not.toHaveBeenCalled();
    const beforeRetry = value.readRelease.mock.calls.length;
    expect(await value.controller.testUpdate('1.0.19')).toEqual({ ok: true });
    expect(value.readRelease.mock.calls.length).toBeGreaterThan(beforeRetry);
    expect(value.native.install).toHaveBeenCalledOnce();
  });

  it('等待期间移除更新源后结束测试；重新连接也不能自动续跑原包', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const value = test.boot('1.0.19');
    value.prepare.mockRejectedValueOnce(new DesktopUpdateBusyError('等待工作空闲'));
    const testing = value.controller.testUpdate('1.0.18');
    await vi.advanceTimersByTimeAsync(0);
    test.setConnection(null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await testing).toMatchObject({ ok: false });
    test.setConnection(test.originalConnection);
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.native.install).not.toHaveBeenCalled();
  });

  it('稍后安装同样阻止测试继续推进，可以明确取消', async () => {
    vi.useFakeTimers();
    const value = fixture().boot();
    value.prepare.mockRejectedValueOnce(new DesktopUpdateBusyError('等待工作空闲'));
    const testing = value.controller.testUpdate('1.0.19');
    await vi.advanceTimersByTimeAsync(0);
    expect(value.controller.deferInstall()).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(value.stop).not.toHaveBeenCalled();
    value.controller.cancelUpdateTest();
    expect(await testing).toMatchObject({ ok: false });
  });

  it.each(['missing', 'stale', 'wrong-target', 'fresh'] as const)('同版本启动须确认本次 NSIS 完成记录：%s', async scenario => {
    const test = fixture();
    test.setReceipt({ targetVersion: '1.0.20', fingerprint: 'previous' });
    await test.boot().controller.testUpdate('1.0.19');
    test.setReceipt(scenario === 'missing' ? undefined : { targetVersion: scenario === 'wrong-target' ? '1.0.21' : '1.0.20',
      fingerprint: scenario === 'stale' ? 'previous' : 'new-install' });
    const next = test.boot();
    next.controller.confirmLocalStartup(true);
    expect(next.controller.currentState.test?.status).toBe(scenario === 'fresh' ? 'succeeded' : 'failed');
    expect(next.native.install).not.toHaveBeenCalled();
  });

  it('安装完成但本地初始化失败不能报告复测成功', async () => {
    const test = fixture();
    await test.boot().controller.testUpdate('1.0.19');
    test.setReceipt({ targetVersion: '1.0.20', fingerprint: 'new-install' });
    const next = test.boot();
    next.controller.confirmLocalStartup(false);
    expect(next.controller.currentState.test?.status).toBe('failed');
    expect(next.controller.currentState.errorCode).toBe('LOCAL_INITIALIZATION_FAILED');
  });
});
