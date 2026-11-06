import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerUpdateRelease } from '../src/main/customer-update.js';
import { CustomerUpdateController } from '../src/main/customer-update.js';

type FakeUpdater = EventEmitter & {
  installDirectory?: string;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  disableWebInstaller: boolean;
  disableDifferentialDownload: boolean;
  setFeedURL: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  verifyUpdateCodeSignature: ReturnType<typeof vi.fn>;
  currentVersion: { major: number; minor: number; patch: number; version: string; raw: string };
};
const mocks = vi.hoisted(() => ({ instances: [] as FakeUpdater[], updateConfig: '',
  signatureVerifier: vi.fn(async (): Promise<string | null> => null) }));
const roots: string[] = [];

vi.mock('original-fs', async () => ({ promises: await import('node:fs/promises') }));

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  access: vi.fn(async () => {}), statfs: vi.fn(async () => ({ bavail: 100_000_000, bsize: 4096 }))
}));

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
    currentVersion = { major: 0, minor: 1, patch: 9, version: '0.1.9', raw: '0.1.9' };
    setFeedURL = vi.fn();
    checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '0.1.9' } }));
    downloadUpdate = vi.fn(async () => { throw new Error('下载失败'); });
    quitAndInstall = vi.fn(() => { app.emit('before-quit'); });
    verifyUpdateCodeSignature = mocks.signatureVerifier;
    constructor() { super(); mocks.instances.push(this); }
  }
  return { default: { MacUpdater: Fake, NsisUpdater: Fake } };
});

import { app, autoUpdater } from 'electron';
import { createCustomerNativeUpdater } from '../src/main/customer-update-native.js';

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.updateConfig = 'publisherName: Clawee\n';
  mocks.signatureVerifier.mockReset().mockResolvedValue(null);
  app.removeAllListeners();
  autoUpdater.removeAllListeners();
  vi.mocked(autoUpdater.checkForUpdates).mockClear();
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Windows 原生更新器安装目录', () => {
  it('固定使用当前可执行文件所在目录', () => {
    createCustomerNativeUpdater('win32');
    expect(mocks.instances[0]!.installDirectory).toBe(dirname(app.getPath('exe')));
  });
});

function windowsUpdateFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-windows-update-'));
  roots.push(directory);
  const path = join(directory, 'Clawee.exe');
  const bytes = Buffer.from('Windows installer fixture');
  writeFileSync(path, bytes);
  const artifact = {
    platform: 'windows' as const, arch: 'x64' as const, url: 'https://files.example/Clawee.exe',
    sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length
  };
  const release: CustomerUpdateRelease = {
    kind: 'customer-desktop-update', gateway_url: 'https://customer.example.com',
    version: '0.1.9', notes: 'Windows 更新', revision: 7, published_at: '2026-10-12T00:00:00Z',
    packages: [artifact]
  };
  const adapter = createCustomerNativeUpdater('win32')!;
  const updater = mocks.instances[0]!;
  updater.checkForUpdates.mockResolvedValue({ updateInfo: {
    version: release.version, releaseNotes: release.notes,
    files: [{ url: artifact.url, sha512: artifact.sha512, size: artifact.size }]
  } });
  updater.downloadUpdate.mockImplementation(async () => {
    if (mocks.updateConfig.includes('publisherName: Clawee')) {
      const error = await updater.verifyUpdateCodeSignature(['Clawee'], path);
      if (error !== null) throw new Error(error);
    }
    updater.emit('update-downloaded', {
      version: release.version, releaseNotes: release.notes,
      files: [{ url: artifact.url, sha512: artifact.sha512, size: artifact.size }], downloadedFile: path
    });
  });
  return { adapter, updater, release, artifact, path, bytes };
}

describe('native adapter生命周期（原生边界fake）', () => {
  it.each([
    ['win32', false], ['win32', true], ['darwin', false], ['darwin', true]
  ] as const)('%s 模拟版本只影响本次原生检查，完成或失败后恢复：失败=%s', async (platform, failed) => {
    const adapter = createCustomerNativeUpdater(platform)!;
    const updater = mocks.instances[0]!;
    updater.checkForUpdates.mockImplementationOnce(async () => {
      expect(updater.currentVersion).toMatchObject({ major: 0, minor: 1, patch: 8, version: '0.1.8' });
      if (failed) throw new Error('网络错误');
      return { updateInfo: { version: '0.1.9' } };
    });
    const checking = adapter.check('https://gateway.example/feed/', '0.1.8');
    if (failed) await expect(checking).rejects.toThrow('网络错误');
    else await expect(checking).resolves.toEqual({ version: '0.1.9' });
    expect(updater.currentVersion).toMatchObject({ major: 0, minor: 1, patch: 9, version: '0.1.9' });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(['space', 'permission'])('后台拒绝空间或权限不足：%s', async failure => {
    const { adapter, release, artifact } = windowsUpdateFixture();
    if (failure === 'space') vi.mocked(statfs).mockResolvedValueOnce({ bavail: 0, bsize: 4096 } as Awaited<ReturnType<typeof statfs>>);
    else vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error('只读目录'), { code: 'EACCES' }));
    await expect(adapter.download(release, artifact)).rejects.toThrow();
  });

  it('最终摘要仍检测文件替换，清理只删除对应包', async () => {
    const { adapter, release, artifact, path, bytes } = windowsUpdateFixture();
    const unrelated = `${path}.other`;
    writeFileSync(unrelated, '保留');
    await adapter.download(release, artifact);
    writeFileSync(path, Buffer.alloc(bytes.length, 2));
    await expect(adapter.verify(artifact, true)).rejects.toMatchObject({ code: 'PACKAGE_CORRUPT' });
    await adapter.discard!();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('后台校验期间替换包，即使摘要相同也不能缓存校验结果', async () => {
    const { adapter, updater, release, artifact, path, bytes } = windowsUpdateFixture();
    vi.mocked(statfs).mockImplementationOnce(async () => {
      writeFileSync(`${path}.replacement`, bytes);
      renameSync(`${path}.replacement`, path);
      return { bavail: 100_000_000, bsize: 4096 } as Awaited<ReturnType<typeof statfs>>;
    });
    await expect(adapter.download(release, artifact)).rejects.toMatchObject({ code: 'PACKAGE_CORRUPT' });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('最终校验不复用被替换文件的校验结果，后台重新校验后才可继续', async () => {
    const { adapter, release, artifact, path, bytes } = windowsUpdateFixture();
    vi.mocked(statfs).mockClear();
    await adapter.download(release, artifact);
    await adapter.verify(artifact, true);
    expect(statfs).toHaveBeenCalledOnce();
    writeFileSync(`${path}.replacement`, bytes);
    renameSync(`${path}.replacement`, path);
    await expect(adapter.verify(artifact, true)).rejects.toMatchObject({ code: 'PACKAGE_NOT_VERIFIED' });
    await adapter.verify(artifact);
    await adapter.verify(artifact, true);
    expect(statfs).toHaveBeenCalledTimes(2);
  });

  it('原生安装单飞，接管后即使退出超时也不能再次调用安装器', async () => {
    vi.useFakeTimers();
    const adapter = createCustomerNativeUpdater('win32')!;
    const updater = mocks.instances[0]!;
    updater.quitAndInstall.mockImplementation(() => {});
    const work = adapter.install(vi.fn());
    const failure = expect(work).rejects.toMatchObject({ code: 'NATIVE_EXIT_TIMEOUT' });
    await expect(adapter.install(vi.fn())).rejects.toMatchObject({ code: 'NATIVE_RESULT_UNKNOWN' });
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    app.emit('before-quit');
    await expect(adapter.install(vi.fn())).rejects.toMatchObject({ code: 'NATIVE_RESULT_UNKNOWN' });
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
  it.each(['version: 0.1.8\n', 'publisherName: null\n'])('Windows 无签名发布者时可执行同版本升级测试：%s', async config => {
    mocks.updateConfig = config;
    const { adapter, updater, release } = windowsUpdateFixture();
    const prepare = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const controller = new CustomerUpdateController({
      gateway: release.gateway_url, currentVersion: release.version, platform: 'win32', arch: 'x64',
      native: adapter, readRelease: async () => ({ update: release }), prepare, stop, recover: vi.fn(async () => {}),
      readInstallReceipt: () => undefined
    });
    try {
      expect(await controller.testUpdate('0.1.8')).toEqual({ ok: true });
      expect(controller.currentState).toMatchObject({ currentVersion: release.version, nativePending: true,
        test: { simulatedVersion: '0.1.8', status: 'pending' } });
      expect(updater.currentVersion.version).toBe(release.version);
      expect(prepare).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(mocks.signatureVerifier).not.toHaveBeenCalled();
      expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    } finally { controller.dispose(); }
  });

  it('Windows 未签名更新仍拒绝大小或 SHA512 不符的文件', async () => {
    const { adapter, updater, release, artifact, path, bytes } = windowsUpdateFixture();
    writeFileSync(path, Buffer.alloc(bytes.length, 1));
    await expect(adapter.download(release, artifact)).rejects.toThrow('SHA512');
    writeFileSync(path, 'short');
    await expect(adapter.download(release, artifact)).rejects.toThrow('大小');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('Windows 已配置发布者时也允许下载和安装未签名包', async () => {
    mocks.updateConfig = 'publisherName: Clawee\n';
    mocks.signatureVerifier.mockResolvedValue('文件未签名');
    const { adapter, updater, release, artifact } = windowsUpdateFixture();
    await adapter.download(release, artifact);
    await adapter.verify(artifact, true);
    await adapter.install(vi.fn());
    expect(mocks.signatureVerifier).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

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
    const order: string[] = [];
    const adapter = createCustomerNativeUpdater('darwin', () => order.push('windows-ready'))!;
    const install = adapter.install(() => order.push('authorized'));
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(order).toEqual([]);
    expect(mocks.instances[0]!.quitAndInstall).not.toHaveBeenCalled();
    mocks.instances[0]!.quitAndInstall.mockImplementationOnce(() => { order.push('quitAndInstall'); app.emit('before-quit'); });
    autoUpdater.emit('update-downloaded');
    await install;
    expect(order).toEqual(['authorized', 'windows-ready', 'quitAndInstall']);
    expect(mocks.instances[0]!.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(autoUpdater.listenerCount('update-downloaded')).toBe(0);
    expect(autoUpdater.listenerCount('error')).toBe(0);
    expect(app.listenerCount('before-quit')).toBe(0);
  });

  it('原生更新先关闭窗口再触发before-quit，关窗必须已放行', async () => {
    let windowsCanClose = false;
    const adapter = createCustomerNativeUpdater('darwin', () => { windowsCanClose = true; })!;
    const updater = mocks.instances[0]!;
    updater.quitAndInstall.mockImplementationOnce(() => {
      expect(windowsCanClose).toBe(true);
      app.emit('before-quit');
    });
    const installing = adapter.install(vi.fn());
    expect(windowsCanClose).toBe(false);
    autoUpdater.emit('update-downloaded');
    await installing;
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
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
    expect(controller.currentState.status).toBe('paused');
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
    expect(controller.currentState.status).toBe('paused');
  });
});
