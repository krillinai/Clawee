import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNativeMetadata, CustomerUpdateController, readCustomerUpdateGateway, readPublicCustomerRelease,
  type CustomerUpdateRelease, type NativeUpdateAdapter
} from '../src/main/customer-update.js';
import { requestDaemonUpdate } from '../src/main/customer-update-daemon.js';

const release: CustomerUpdateRelease = {
  kind: 'customer-desktop-update', gateway_url: 'https://customer.example.com',
  version: '0.1.9', notes: '客户更新说明', revision: 7, published_at: '2026-10-09T00:00:00Z',
  packages: [{ platform: 'macos', arch: 'arm64', url: 'https://files.customer.example/0.1.9/Clawee-arm64.zip', sha512: Buffer.alloc(64, 1).toString('base64'), size: 123 }]
};

function fixture(overrides: Partial<ConstructorParameters<typeof CustomerUpdateController>[0]> = {}) {
  const order: string[] = [];
  let progress: (percent: number) => void = () => undefined;
  const native = {
    check: vi.fn(async () => ({ version: release.version, releaseNotes: release.notes, files: release.packages.map(({ url, sha512, size }) => ({ url, sha512, size })) })),
    download: vi.fn(async () => { order.push('download'); }),
    verify: vi.fn(async () => { order.push('verify'); }),
    install: vi.fn(async (authorizeQuit: () => void) => { order.push('install'); authorizeQuit(); }),
    onProgress: (listener: (percent: number) => void) => { progress = listener; }
  } satisfies NativeUpdateAdapter;
  const readRelease = vi.fn(async (_gateway: string): Promise<{ update: unknown }> => ({ update: structuredClone(release) }));
  const prepare = vi.fn(async () => { order.push('prepare'); });
  const stop = vi.fn(async () => { order.push('stop'); });
  const recover = vi.fn(async () => { order.push('recover'); });
  const controller = new CustomerUpdateController({
    gateway: release.gateway_url, currentVersion: '0.1.8', platform: 'darwin', arch: 'arm64',
    native, readRelease, prepare, stop, recover, ...overrides
  });
  return { controller, native, readRelease, prepare, stop, recover, order, progress: (value: number) => progress(value) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('客户更新状态机', () => {
  it.each([
    { gateway: undefined }, { native: undefined }, { platform: 'linux' as const }, { platform: 'win32' as const, arch: 'arm64' }
  ])('未注入客户渠道或不支持的平台完全不访问更新源：%j', async overrides => {
    const value = fixture(overrides);
    value.controller.start();
    expect(value.controller.currentState).toMatchObject({ supported: false, status: 'idle', currentVersion: '0.1.8' });
    expect(await value.controller.checkForUpdates()).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(await value.controller.downloadUpdate()).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(await value.controller.installUpdate()).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(value.readRelease).not.toHaveBeenCalled();
    expect(value.native.check).not.toHaveBeenCalled();
  });

  it('启动检查、每五分钟轮询且检查单飞，绝不自动下载', async () => {
    vi.useFakeTimers();
    const value = fixture();
    value.controller.start();
    const first = value.controller.checkForUpdates();
    expect(first).toBe(value.controller.checkForUpdates());
    await first;
    expect(value.readRelease).toHaveBeenCalledOnce();
    expect(value.native.check).toHaveBeenCalledWith('https://customer.example.com/api/v1/public/client-updates/7/macos/arm64/');
    expect(value.controller.currentState.status).toBe('available');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(value.readRelease).toHaveBeenCalledTimes(2);
    expect(value.native.download).not.toHaveBeenCalled();
    expect(value.native.install).not.toHaveBeenCalled();
    value.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['null', 'older', 'equal', 'other-platform'])('未发布/不属于本平台/非新版本保持 idle：%s', async scenario => {
    const value = fixture();
    const current = structuredClone(release);
    if (scenario === 'older') current.version = '0.1.7';
    if (scenario === 'equal') current.version = '0.1.8';
    if (scenario === 'other-platform') current.packages[0]!.arch = 'x64';
    value.readRelease.mockResolvedValue({ update: scenario === 'null' ? null : current });
    expect(await value.controller.checkForUpdates()).toEqual({ ok: true });
    expect(value.controller.currentState.status).toBe('idle');
    expect(value.native.check).not.toHaveBeenCalled();
  });

  it.each(['kind', 'gateway', 'version', 'http', 'sha512', 'size', 'duplicate'])('拒绝无效发布和跨客户更新：%s', async scenario => {
    const value = fixture();
    const invalid = structuredClone(release) as unknown as Record<string, unknown>;
    const packages = invalid.packages as CustomerUpdateRelease['packages'];
    if (scenario === 'kind') invalid.kind = 'official-desktop-update';
    if (scenario === 'gateway') invalid.gateway_url = 'https://other.example.com';
    if (scenario === 'version') invalid.version = '0.1.9-beta.1';
    if (scenario === 'http') packages[0]!.url = 'http://files.example/Clawee.zip';
    if (scenario === 'sha512') packages[0]!.sha512 = 'invalid';
    if (scenario === 'size') packages[0]!.size = 0;
    if (scenario === 'duplicate') packages.push({ ...packages[0]! });
    value.readRelease.mockResolvedValue({ update: invalid as unknown as CustomerUpdateRelease });
    expect(await value.controller.checkForUpdates()).toMatchObject({ ok: false });
    expect(value.controller.currentState.status).toBe('error');
    expect(value.native.check).not.toHaveBeenCalled();
  });

  it.each(['9007199254740992.0.0', '1.9007199254740992.0', '1.2.9007199254740992', '99999999999999999999.0.0'])('版本分量超出安全整数时不调用原生更新器：%s', async version => {
    const value = fixture();
    value.readRelease.mockResolvedValue({ update: { ...release, version } });
    expect(await value.controller.checkForUpdates()).toMatchObject({ ok: false });
    expect(value.native.check).not.toHaveBeenCalled();
  });

  it.each(['9007199254740991.0.0', '1.9007199254740991.0', '1.2.9007199254740991', '9007199254740991.9007199254740991.9007199254740991'])('安全整数边界版本可进入更新检查：%s', async version => {
    const value = fixture();
    value.readRelease.mockResolvedValue({ update: { ...release, version } });
    value.native.check.mockResolvedValue({ version, releaseNotes: release.notes, files: release.packages.map(({ url, sha512, size }) => ({ url, sha512, size })) });
    expect(await value.controller.checkForUpdates()).toEqual({ ok: true });
    expect(value.controller.currentState).toMatchObject({ status: 'available', version });
  });

  it('下载进度、下载/安装单飞以及普通关闭不安装', async () => {
    const value = fixture();
    await value.controller.checkForUpdates();
    let finish: (() => void) | undefined;
    value.native.download.mockImplementationOnce(() => new Promise<void>(resolve => { value.order.push('download'); finish = resolve; }));
    const download = value.controller.downloadUpdate();
    expect(download).toBe(value.controller.downloadUpdate());
    expect(await value.controller.installUpdate()).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(value.controller.currentState.status).toBe('downloading'));
    value.progress(45.5);
    expect(value.controller.currentState.progress).toBe(45.5);
    finish!();
    await download;
    value.controller.dispose();
    expect(value.controller.currentState.status).toBe('downloaded');
    expect(value.native.install).not.toHaveBeenCalled();
    const install = value.controller.installUpdate();
    expect(install).toBe(value.controller.installUpdate());
    await install;
    expect(value.order).toEqual(['download', 'verify', 'prepare', 'stop', 'verify', 'install']);
    expect(value.controller.canQuitForInstall).toBe(true);
  });

  it('下载/摘要失败允许重试，未校验成功不可安装', async () => {
    const value = fixture();
    await value.controller.checkForUpdates();
    value.native.download.mockRejectedValueOnce(new Error('SHA512 不匹配'));
    expect(await value.controller.downloadUpdate()).toMatchObject({ ok: false });
    expect(await value.controller.installUpdate()).toMatchObject({ ok: false });
    expect(value.prepare).not.toHaveBeenCalled();
    expect(await value.controller.downloadUpdate()).toEqual({ ok: true });
    expect(value.controller.currentState.status).toBe('downloaded');
  });

  it('安装准备失败后再次下载已校验缓存恢复downloaded，仍重新核对发布快照', async () => {
    const value = fixture();
    await value.controller.checkForUpdates();
    await value.controller.downloadUpdate();
    value.prepare.mockRejectedValueOnce(new Error('busy'));
    await value.controller.installUpdate();
    expect(value.controller.currentState.status).toBe('error');
    const checks = value.readRelease.mock.calls.length;
    await value.controller.downloadUpdate();
    expect(value.readRelease.mock.calls.length).toBe(checks + 1);
    expect(value.native.download).toHaveBeenCalledOnce();
    expect(value.controller.currentState).toMatchObject({ status: 'downloaded', progress: 100, error: undefined });
  });

  it('离线检查和已下载文件损坏均不进入 installing，损坏后可重新下载', async () => {
    const value = fixture();
    await value.controller.checkForUpdates();
    await value.controller.downloadUpdate();
    value.readRelease.mockRejectedValueOnce(new Error('offline'));
    expect(await value.controller.installUpdate()).toMatchObject({ ok: false });
    expect(value.prepare).not.toHaveBeenCalled();
    value.native.verify.mockRejectedValueOnce(new Error('文件损坏'));
    expect(await value.controller.installUpdate()).toMatchObject({ ok: false });
    expect(value.controller.currentState.status).toBe('error');
    expect(value.native.install).not.toHaveBeenCalled();
    expect(await value.controller.downloadUpdate()).toEqual({ ok: true });
  });

  it.each(['revision', 'notes', 'published_at', 'sha512', 'url', 'size', 'kind', 'gateway', 'version', 'arch'])('下载后完整快照变化阻止安装：%s', async field => {
    const value = fixture();
    await value.controller.checkForUpdates();
    await value.controller.downloadUpdate();
    const current = structuredClone(release);
    if (field === 'revision') current.revision += 1;
    if (field === 'notes') current.notes = '不同说明';
    if (field === 'published_at') current.published_at = '2026-10-09T01:00:00Z';
    if (field === 'sha512') current.packages[0]!.sha512 = Buffer.alloc(64, 2).toString('base64');
    if (field === 'url') current.packages[0]!.url = 'https://files.example/other.zip';
    if (field === 'size') current.packages[0]!.size += 1;
    if (field === 'kind') (current as unknown as Record<string, unknown>).kind = 'official';
    if (field === 'gateway') current.gateway_url = 'https://other.example.com';
    if (field === 'version') current.version = '0.2.0';
    if (field === 'arch') current.packages[0]!.arch = 'x64';
    value.readRelease.mockResolvedValue({ update: current });
    expect(await value.controller.installUpdate()).toMatchObject({ ok: false });
    expect(value.native.install).not.toHaveBeenCalled();
    expect(value.prepare).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'stop', 'install'])('准备409、停机超时和原生安装失败解除门禁并可重试：%s', async phase => {
    const value = fixture();
    await value.controller.checkForUpdates();
    await value.controller.downloadUpdate();
    const failing = phase === 'prepare' ? value.prepare : phase === 'stop' ? value.stop : value.native.install;
    failing.mockRejectedValueOnce(new Error(`${phase} failed`));
    expect(await value.controller.installUpdate()).toMatchObject({ ok: false });
    expect(value.recover).toHaveBeenCalledOnce();
    expect(value.controller.canQuitForInstall).toBe(false);
    if (phase !== 'install') expect(value.native.install).not.toHaveBeenCalled();
    expect(await value.controller.installUpdate()).toEqual({ ok: true });
  });

  it('停机完成后再次核对发布快照，离线恢复 bootstrap 而不是安装', async () => {
    const value = fixture();
    await value.controller.checkForUpdates();
    await value.controller.downloadUpdate();
    value.stop.mockImplementationOnce(async () => {
      value.readRelease.mockRejectedValueOnce(new Error('offline after stop'));
    });
    expect(await value.controller.installUpdate()).toMatchObject({ ok: false });
    expect(value.recover).toHaveBeenCalledOnce();
    expect(value.native.install).not.toHaveBeenCalled();
    expect(value.controller.canQuitForInstall).toBe(false);
  });

  it('原生安装等待期间不允许普通退出，只有即将 quitAndInstall 才授权', async () => {
    const value = fixture();
    await value.controller.checkForUpdates();
    await value.controller.downloadUpdate();
    let continueInstall: (() => void) | undefined;
    value.native.install.mockImplementationOnce(authorize => new Promise<void>(resolve => {
      continueInstall = () => { authorize(); resolve(); };
    }));
    const installing = value.controller.installUpdate();
    await vi.waitFor(() => expect(continueInstall).toBeDefined());
    expect(value.controller.installationPending).toBe(true);
    expect(value.controller.canQuitForInstall).toBe(false);
    continueInstall!();
    await installing;
    expect(value.controller.canQuitForInstall).toBe(true);
  });
});

describe('客户包标记与认证隔离', () => {
  it('无标记、非法标记、回环HTTP和开发模式不阻断启动', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-customer-marker-'));
    try {
      mkdirSync(join(root, 'deployment'));
      expect(readCustomerUpdateGateway(root, true)).toBeUndefined();
      for (const value of ['broken', '{"gateway_url":"http://127.0.0.1:1904"}', '{"gateway_url":"https://customer.example.com/path"}', '{"gateway_url":"https://customer.example.com","token":"secret"}']) {
        writeFileSync(join(root, 'deployment/customer-update.json'), value);
        expect(readCustomerUpdateGateway(root, true)).toBeUndefined();
      }
      writeFileSync(join(root, 'deployment/customer-update.json'), JSON.stringify({ gateway_url: release.gateway_url }));
      expect(readCustomerUpdateGateway(root, false)).toBeUndefined();
      expect(readCustomerUpdateGateway(root, true)).toBe(release.gateway_url);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('公开检查固定 Gateway、不携带凭据且不跟随重定向', async () => {
    const fetcher = vi.fn(async (_url: string | URL, _options: RequestInit) => new Response(JSON.stringify({ update: release })));
    vi.stubGlobal('fetch', fetcher);
    await readPublicCustomerRelease(release.gateway_url);
    expect(fetcher).toHaveBeenCalledWith(`${release.gateway_url}/api/v1/public/client-updates`, expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
    const options = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(options?.headers).not.toHaveProperty('Authorization');
  });

  it('prepare/cancel 仅向本地daemon发送本机token，409失败', async () => {
    const fetcher = vi.fn(async (_url: string | URL, _options: RequestInit) => new Response(JSON.stringify({ error: { code: 'DESKTOP_UPDATE_BUSY' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(requestDaemonUpdate({ address: 'http://127.0.0.1:1234', token: 'local-token' }, 'prepare')).rejects.toThrow('未结束');
    expect(fetcher).toHaveBeenCalledWith(new URL('http://127.0.0.1:1234/desktop-update/prepare'), expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer local-token' }, redirect: 'error' }));
    fetcher.mockResolvedValue(new Response(JSON.stringify({ prepared: false })));
    await requestDaemonUpdate({ address: 'http://127.0.0.1:1234', token: 'local-token' }, 'cancel');
    await expect(requestDaemonUpdate({ address: 'https://gateway.example', token: 'local-token' }, 'prepare')).rejects.toThrow('本机');
  });

  it.each([403, 503])('daemon拒绝准备不能被当作门禁成功：%s', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'DESKTOP_UPDATE_UNAVAILABLE' } }), { status })));
    await expect(requestDaemonUpdate({ address: 'http://127.0.0.1:1234', token: 'local-token' }, 'prepare')).rejects.toThrow(String(status));
  });

  it('prepare必须确认prepared:true，cancel必须确认prepared:false', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ prepared: false })));
    vi.stubGlobal('fetch', fetcher);
    const connection = { address: 'http://127.0.0.1:1234', token: 'local-token' };
    await expect(requestDaemonUpdate(connection, 'prepare')).rejects.toThrow('门禁状态');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ prepared: true })));
    await expect(requestDaemonUpdate(connection, 'prepare')).resolves.toBeUndefined();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ prepared: true })));
    await expect(requestDaemonUpdate(connection, 'cancel')).rejects.toThrow('门禁状态');
  });

  it.each(['version', 'notes', 'url', 'size', 'sha512', 'packages'])('拒绝feed metadata偏离批准快照：%s', field => {
    const info: Record<string, unknown> = { version: release.version, releaseNotes: release.notes, files: release.packages.map(({ url, size, sha512 }) => ({ url, size, sha512 })) };
    const file = (info.files as Record<string, unknown>[])[0]!;
    if (field === 'version') info.version = '0.2.0';
    if (field === 'notes') info.releaseNotes = 'different';
    if (field === 'url') file.url = 'https://official.example/other.zip';
    if (field === 'size') file.size = 999;
    if (field === 'sha512') file.sha512 = 'invalid';
    if (field === 'packages') info.packages = { x64: { file: 'web-installer.exe' } };
    expect(() => assertNativeMetadata(info, release, release.packages[0]!)).toThrow('快照');
  });
});
