import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerUpdateRelease } from '../src/main/customer-update.js';
import { CustomerUpdateController } from '../src/main/customer-update.js';

type FakeUpdater = EventEmitter & {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  disableWebInstaller: boolean;
  disableDifferentialDownload: boolean;
  setFeedURL: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
};
const mocks = vi.hoisted(() => ({ instances: [] as FakeUpdater[] }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const app = Object.assign(new EventEmitter(), { getPath: vi.fn(() => '/missing/Clawee.app/Contents/MacOS/Clawee') });
  const autoUpdater = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() });
  return { app, autoUpdater };
});

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  const { app } = await import('electron');
  class Fake extends EventEmitter {
    autoDownload = true;
    autoInstallOnAppQuit = true;
    autoRunAppAfterInstall = false;
    disableWebInstaller = false;
    disableDifferentialDownload = false;
    setFeedURL = vi.fn();
    checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '0.1.9' } }));
    downloadUpdate = vi.fn(async () => { throw new Error('下载失败'); });
    quitAndInstall = vi.fn(() => { app.emit('before-quit'); });
    constructor() { super(); mocks.instances.push(this); }
  }
  return { default: { MacUpdater: Fake, NsisUpdater: Fake } };
});

import { app, autoUpdater } from 'electron';
import { createCustomerNativeUpdater } from '../src/main/customer-update-native.js';

beforeEach(() => {
  mocks.instances.length = 0;
  app.removeAllListeners();
  autoUpdater.removeAllListeners();
  vi.mocked(autoUpdater.checkForUpdates).mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('native adapter生命周期（原生边界fake）', () => {
  it('不支持的平台不初始化更新器，支持平台强制关闭所有自动安装/下载开关', () => {
    expect(createCustomerNativeUpdater('linux')).toBeUndefined();
    expect(mocks.instances).toHaveLength(0);
    createCustomerNativeUpdater('darwin');
    expect(mocks.instances[0]).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, autoRunAppAfterInstall: true, disableWebInstaller: true, disableDifferentialDownload: true });
  });

  it('只从主进程固定feed检查，下载失败不启动Squirrel或安装', async () => {
    const adapter = createCustomerNativeUpdater('darwin')!;
    const feed = 'https://customer.example/api/v1/public/client-updates/7/macos/arm64/';
    await adapter.check(feed);
    expect(mocks.instances[0]!.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: feed, useMultipleRangeRequest: false });
    const release = { version: '0.1.9', notes: '', packages: [] } as unknown as CustomerUpdateRelease;
    await expect(adapter.download(release, { platform: 'macos', arch: 'arm64', url: 'https://files.example/Clawee.zip', sha512: '', size: 1 })).rejects.toThrow('下载失败');
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.instances[0]!.quitAndInstall).not.toHaveBeenCalled();
    expect(mocks.instances[0]!.listenerCount('update-downloaded')).toBe(0);
  });

  it('明确安装后才原生检查，原生验签ready之后才授权退出再quitAndInstall', async () => {
    const adapter = createCustomerNativeUpdater('darwin')!;
    const order: string[] = [];
    const install = adapter.install(() => order.push('authorized'));
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(order).toEqual([]);
    expect(mocks.instances[0]!.quitAndInstall).not.toHaveBeenCalled();
    mocks.instances[0]!.quitAndInstall.mockImplementationOnce(() => { order.push('quitAndInstall'); app.emit('before-quit'); });
    autoUpdater.emit('update-downloaded');
    await install;
    expect(order).toEqual(['authorized', 'quitAndInstall']);
    expect(autoUpdater.listenerCount('update-downloaded')).toBe(0);
    expect(autoUpdater.listenerCount('error')).toBe(0);
    expect(app.listenerCount('before-quit')).toBe(0);
  });

  it('原生验签失败不授权退出或残留安装监听，重试仍需新的明确安装', async () => {
    const adapter = createCustomerNativeUpdater('darwin')!;
    const authorize = vi.fn();
    const failed = adapter.install(authorize);
    const rejected = expect(failed).rejects.toThrow('签名无效');
    autoUpdater.emit('error', new Error('签名无效'));
    await rejected;
    expect(authorize).not.toHaveBeenCalled();
    expect(mocks.instances[0]!.quitAndInstall).not.toHaveBeenCalled();
    expect(autoUpdater.listenerCount('update-downloaded')).toBe(0);
    const retried = adapter.install(authorize);
    autoUpdater.emit('update-downloaded');
    await retried;
    expect(authorize).toHaveBeenCalledOnce();
  });

  it('quitAndInstall同步报错时清理退出监听与计时器', async () => {
    const adapter = createCustomerNativeUpdater('darwin')!;
    mocks.instances[0]!.quitAndInstall.mockImplementationOnce(() => { throw new Error('安装器失败'); });
    const installing = adapter.install(vi.fn());
    autoUpdater.emit('update-downloaded');
    await expect(installing).rejects.toThrow('安装器失败');
    expect(app.listenerCount('before-quit')).toBe(0);
    expect(mocks.instances[0]!.listenerCount('error')).toBe(1);
  });

  it('实际adapter等待Squirrel挂起有界超时，控制器recover后迟到回调不再安装', async () => {
    vi.useFakeTimers();
    const adapter = createCustomerNativeUpdater('darwin')!;
    const release: CustomerUpdateRelease = {
      kind: 'customer-desktop-update', gateway_url: 'https://customer.example.com',
      version: '0.1.9', notes: '客户更新', revision: 7, published_at: '2026-10-09T00:00:00Z',
      packages: [{ platform: 'macos', arch: 'arm64', url: 'https://files.example/Clawee-arm64.zip', sha512: Buffer.alloc(64, 1).toString('base64'), size: 123 }]
    };
    mocks.instances[0]!.checkForUpdates.mockResolvedValue({ updateInfo: {
      version: release.version, releaseNotes: release.notes,
      files: release.packages.map(({ url, sha512, size }) => ({ url, sha512, size }))
    } });
    const order: string[] = [];
    const recover = vi.fn(async () => { order.push('recover'); });
    const controller = new CustomerUpdateController({
      gateway: release.gateway_url, currentVersion: '0.1.8', platform: 'darwin', arch: 'arm64',
      native: { ...adapter, download: vi.fn(async () => undefined), verify: vi.fn(async () => undefined) },
      readRelease: async () => ({ update: release }),
      prepare: async () => { order.push('prepare'); },
      stop: async () => { order.push('stop'); },
      recover
    });
    await controller.checkForUpdates();
    await controller.downloadUpdate();
    const installing = controller.installUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['prepare', 'stop']);
    expect(controller.currentState.status).toBe('installing');
    expect(controller.canQuitForInstall).toBe(false);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await installing).toMatchObject({ ok: false, message: expect.stringContaining('超时') });
    expect(order).toEqual(['prepare', 'stop', 'recover']);
    expect(controller.currentState.status).toBe('error');
    expect(controller.installationPending).toBe(false);
    expect(controller.canQuitForInstall).toBe(false);
    expect(autoUpdater.listenerCount('update-downloaded')).toBe(0);
    expect(autoUpdater.listenerCount('error')).toBe(0);
    expect(app.listenerCount('before-quit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    autoUpdater.emit('update-downloaded');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.instances[0]!.quitAndInstall).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
    expect(controller.currentState.status).toBe('error');
  });
});
