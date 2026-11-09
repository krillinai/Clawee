import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomerUpdateController, type CustomerUpdateRelease } from '../src/main/customer-update.js';
import { CustomerUpdateJournal } from '../src/main/customer-update-record.js';
import { CustomerUpdateError } from '../src/main/customer-update-error.js';
import { DesktopUpdateBusyError } from '../src/main/customer-update-daemon.js';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
const directories: string[] = [];
const controllers: CustomerUpdateController[] = [];
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.dispose());
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
  vi.useRealTimers();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-update-recovery-'));
  directories.push(directory);
  const path = join(directory, 'update.json');
  const release: CustomerUpdateRelease = {
    kind: 'customer-desktop-update', gateway_url: 'https://gateway.example', version: '1.0.20', notes: '', revision: 1,
    published_at: '2026-10-20T00:00:00Z', packages: [{ platform: 'macos', arch: 'arm64',
      sha512: Buffer.alloc(64, 5).toString('base64'), size: 20, url: 'https://cdn.example/app.zip' }]
  };
  const identity = () => ({ gateway: release.gateway_url, targetVersion: release.version,
    platform: release.packages[0]!.platform, arch: release.packages[0]!.arch, sha512: release.packages[0]!.sha512 });
  function boot(version = '1.0.19') {
    const journal = new CustomerUpdateJournal(path);
    const native = {
      check: vi.fn(async () => ({ version: release.version, releaseNotes: release.notes,
        files: release.packages.map(({ url, size, sha512 }) => ({ url, size, sha512 })) })),
      download: vi.fn(async () => {}), verify: vi.fn(async () => {}), discard: vi.fn(async () => {}),
      install: vi.fn(async (authorize: () => void) => { authorize(); }), onProgress: vi.fn()
    };
    const prepare = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const recover = vi.fn(async () => {});
    const readRelease = vi.fn(async () => ({ update: structuredClone(release) }));
    const controller = new CustomerUpdateController({ journal, automatic: true, currentVersion: version,
      gateway: release.gateway_url, platform: 'darwin', arch: 'arm64', native, prepare, stop, recover, readRelease });
    controllers.push(controller);
    return { journal, native, prepare, stop, recover, readRelease, controller };
  }
  return { boot, release, path, identity };
}

describe('客户更新跨重启保护', () => {
  it('停机超时只打断一次；重启和同包 revision 变化都不解除暂停，明确重试重新授权', async () => {
    vi.useFakeTimers();
    const context = fixture();
    const first = context.boot();
    first.stop.mockRejectedValue(new CustomerUpdateError('DAEMON_SHUTDOWN_TIMEOUT', '停止超时'));
    first.controller.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.recover).toHaveBeenCalledOnce();
    expect(first.controller.currentState).toMatchObject({ status: 'paused', recovery: 'restored' });
    first.controller.dispose();
    context.release.revision++;
    const second = context.boot();
    await second.controller.checkForUpdates();
    await second.controller.runAutomaticUpdate();
    expect(second.controller.currentState.status).toBe('paused');
    expect(second.native.download).not.toHaveBeenCalled();
    expect(second.stop).not.toHaveBeenCalled();
    expect(await second.controller.downloadUpdate()).toEqual({ ok: true });
    await second.controller.runAutomaticUpdate();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(second.readRelease.mock.calls.length).toBeGreaterThan(3);
  });

  it('等待任务和编辑条件不恢复工作台、不增加安装尝试', async () => {
    const context = fixture();
    const value = context.boot();
    value.prepare.mockRejectedValue(new DesktopUpdateBusyError('仍在输入'));
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.controller.currentState.status).toBe('waiting');
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.journal.get(context.identity())).toMatchObject({ phase: 'ready', attempts: 0 });
  });

  it('网络退避跨启动保留，超过三次仍可自动恢复下载', async () => {
    vi.useFakeTimers();
    const context = fixture();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const value = context.boot();
      value.native.download.mockRejectedValue(new CustomerUpdateError('NETWORK_FAILED', '网络暂时不可用'));
      await value.controller.checkForUpdates();
      await value.controller.runAutomaticUpdate();
      expect(value.native.download).toHaveBeenCalledOnce();
      await value.controller.runAutomaticUpdate();
      expect(value.native.download).toHaveBeenCalledOnce();
      expect(value.stop).not.toHaveBeenCalled();
      expect(value.journal.get(context.identity())?.networkFailures).toBe(attempt);
      value.controller.dispose();
      await vi.advanceTimersByTimeAsync(30_000 * 2 ** (attempt - 1));
    }
    const next = context.boot();
    await next.controller.checkForUpdates();
    expect(next.controller.currentState.status).toBe('available');
    await next.controller.runAutomaticUpdate();
    expect(next.native.install).toHaveBeenCalledOnce();
  });

  it('损坏包仅清理对应下载一次，再次损坏暂停', async () => {
    const context = fixture();
    const value = context.boot();
    value.native.download.mockRejectedValue(new CustomerUpdateError('PACKAGE_CORRUPT', '校验失败'));
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.native.discard).toHaveBeenCalledOnce();
    await value.controller.runAutomaticUpdate();
    expect(value.native.download).toHaveBeenCalledTimes(2);
    expect(value.native.discard).toHaveBeenCalledOnce();
    expect(value.controller.currentState.status).toBe('paused');
  });

  it('持续网络故障的重试间隔上限为十五分钟，恢复后清零失败计数', async () => {
    vi.useFakeTimers();
    const context = fixture();
    const value = context.boot();
    value.native.download.mockRejectedValue(new CustomerUpdateError('NETWORK_FAILED', '网络暂时不可用'));
    await value.controller.checkForUpdates();
    for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      await value.controller.runAutomaticUpdate();
      expect(value.journal.get(context.identity())?.phase).toBe('ready');
      expect(value.journal.get(context.identity())!.nextRetryAt - Date.now()).toBe(delay);
      vi.setSystemTime(Date.now() + delay);
    }
    value.native.download.mockResolvedValue(undefined);
    await value.controller.runAutomaticUpdate();
    expect(value.native.download).toHaveBeenCalledTimes(8);
    expect(value.native.install).toHaveBeenCalledOnce();
    expect(value.journal.get(context.identity())?.networkFailures).toBe(0);
  });

  it('安装前来源复核的临时网络错误持续退避，不停止服务', async () => {
    vi.useFakeTimers();
    const context = fixture();
    const value = context.boot();
    await value.controller.checkForUpdates();
    await value.controller.downloadUpdate();
    value.readRelease.mockRejectedValue(new CustomerUpdateError('NETWORK_FAILED', '网络暂时不可用'));
    await value.controller.runAutomaticUpdate();
    expect(value.controller.currentState.status).toBe('error');
    expect(value.journal.get(context.identity())?.networkFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(value.journal.get(context.identity())).toMatchObject({ phase: 'ready', networkFailures: 3 });
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.stop).not.toHaveBeenCalled();
  });

  it('停机后网络复核失败先恢复再退避，原生安装网络失败直接暂停', async () => {
    const context = fixture();
    const value = context.boot();
    value.stop.mockImplementation(async () => {
      value.readRelease.mockRejectedValueOnce(new CustomerUpdateError('NETWORK_FAILED', '复核网络暂时不可用'));
    });
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.recover).toHaveBeenCalledOnce();
    expect(value.native.install).not.toHaveBeenCalled();
    expect(value.journal.get(context.identity())).toMatchObject({ phase: 'ready', networkFailures: 1 });
    value.native.install.mockRejectedValueOnce(new CustomerUpdateError('NETWORK_FAILED', '原生更新器网络失败'));
    value.stop.mockImplementation(async () => {});
    await value.controller.installUpdate();
    expect(value.journal.get(context.identity())).toMatchObject({ phase: 'paused', errorCode: 'NETWORK_FAILED' });
    expect(value.recover).toHaveBeenCalledTimes(2);
  });

  it.each(['SIGNATURE_FAILED', 'INSUFFICIENT_SPACE', 'PERMISSION_DENIED'])('%s 在后台失败，不停机也不自动重试', async code => {
    const context = fixture();
    const value = context.boot();
    value.native.verify.mockRejectedValue(new CustomerUpdateError(code, '更新准备失败'));
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    await value.controller.runAutomaticUpdate();
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.native.download).toHaveBeenCalledOnce();
    expect(value.controller.currentState).toMatchObject({ status: 'paused', errorCode: code });
  });

  it('安装器接管后的异常保留待确认状态；不恢复 Runtime，也不重复请求安装器', async () => {
    const context = fixture();
    const value = context.boot();
    value.native.install.mockImplementation(async authorize => { authorize(); throw new CustomerUpdateError('NATIVE_EXIT_TIMEOUT', '退出超时'); });
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.controller.installationPending).toBe(true);
    expect(value.controller.currentState.nativePending).toBe(true);
    await value.controller.installUpdate();
    expect(value.native.install).toHaveBeenCalledOnce();
    expect(value.journal.get(context.identity())?.phase).toBe('awaiting_start');
  });

  it('恢复失败同时保留原始错误和恢复错误，迟到授权不能继续安装', async () => {
    const context = fixture();
    const value = context.boot();
    let lateAuthorize!: () => void;
    value.native.install.mockImplementation(async authorize => { lateAuthorize = authorize; throw new CustomerUpdateError('NATIVE_PREPARE_TIMEOUT', '安装准备超时'); });
    value.recover.mockRejectedValue(new Error('恢复失败'));
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.controller.currentState).toMatchObject({ status: 'paused', recovery: 'failed', errorCode: 'NATIVE_PREPARE_TIMEOUT', recoveryCode: 'WORKSPACE_RECOVERY_FAILED' });
    expect(() => lateAuthorize()).toThrow();
    expect(value.journal.get(context.identity())).toMatchObject({ phase: 'paused', errorCode: 'NATIVE_PREPARE_TIMEOUT', recoveryCode: 'WORKSPACE_RECOVERY_FAILED' });
  });

  it.each(['preparing', 'native_requested', 'awaiting_start'] as const)('进程在 %s 终止，旧版重启暂停', phase => {
    const context = fixture();
    const value = context.boot();
    const record = value.journal.ensure(context.identity(), '1.0.19');
    value.journal.save({ ...record, phase });
    context.boot();
    expect(new CustomerUpdateJournal(context.path).get(context.identity())?.phase).toBe('paused');
  });

  it.each([true, false])('实际目标版本启动仍要等待本地初始化确认：%s', ready => {
    const context = fixture();
    const value = context.boot();
    value.journal.save({ ...value.journal.ensure(context.identity(), '1.0.19'), phase: 'awaiting_start' });
    const next = context.boot('1.0.20');
    next.readRelease.mockRejectedValue(new Error('Gateway 离线，模型未配置'));
    expect(next.journal.get(context.identity())?.phase).toBe('awaiting_start');
    next.controller.confirmLocalStartup(ready);
    expect(next.readRelease).not.toHaveBeenCalled();
    expect(next.journal.get(context.identity())?.phase).toBe(ready ? 'succeeded' : 'paused');
    expect(readFileSync(context.path, 'utf8')).not.toContain('cdn.example');
  });

  it.each(['invalid', JSON.stringify({ schemaVersion: 1, records: [{}] }), JSON.stringify({ schemaVersion: 99, records: [] })])('损坏更新记录自动备份重建，重新获取授权后可自动安装：%s', async contents => {
    const context = fixture();
    writeFileSync(context.path, contents);
    const value = context.boot();
    expect(value.journal.unavailable).toBe(false);
    const backups = readdirSync(join(context.path, '..')).filter(name => name.startsWith('update.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(context.path, '..', backups[0]!), 'utf8')).toBe(contents);
    expect(JSON.parse(readFileSync(context.path, 'utf8'))).toEqual({ schemaVersion: 1, records: [] });
    expect(await value.controller.checkForUpdates()).toEqual({ ok: true });
    await value.controller.runAutomaticUpdate();
    expect(value.readRelease).toHaveBeenCalled();
    expect(value.native.install).toHaveBeenCalledOnce();
    expect(context.boot().journal.unavailable).toBe(false);
  });

  it('更新记录路径不是文件时保留原内容，不能冒充已恢复', async () => {
    const context = fixture();
    mkdirSync(context.path);
    writeFileSync(join(context.path, 'keep'), '保留内容');
    const value = context.boot();
    expect(await value.controller.checkForUpdates()).toMatchObject({ ok: false });
    expect(value.native.install).not.toHaveBeenCalled();
    expect(readFileSync(join(context.path, 'keep'), 'utf8')).toBe('保留内容');
  });

  it('冻结后记录写入失败仍解除门禁，禁止停机', async () => {
    const context = fixture();
    const value = context.boot();
    value.prepare.mockImplementation(async () => { mkdirSync(`${context.path}.tmp`); });
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.recover).toHaveBeenCalledOnce();
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.controller.currentState).toMatchObject({ status: 'paused', recovery: 'restored', errorCode: 'UPDATE_RECORD_WRITE_FAILED' });
  });

  it('只有真正变化的包才能重新进入自动准备，仍需读取当前授权', async () => {
    const context = fixture();
    const first = context.boot();
    first.stop.mockRejectedValue(new CustomerUpdateError('DAEMON_SHUTDOWN_TIMEOUT', '停机超时'));
    await first.controller.checkForUpdates();
    await first.controller.runAutomaticUpdate();
    first.controller.dispose();
    context.release.packages[0]!.sha512 = Buffer.alloc(64, 6).toString('base64');
    const next = context.boot();
    await next.controller.checkForUpdates();
    await next.controller.runAutomaticUpdate();
    expect(next.readRelease).toHaveBeenCalled();
    expect(next.native.install).toHaveBeenCalledOnce();
  });

  it('工作台确认发生竞争时回到等待，不累计失败；旧确认不能满足新尝试', async () => {
    const context = fixture();
    const value = context.boot();
    value.stop.mockImplementation(async () => {
      const wait = value.controller.waitForWorkspace('current-attempt');
      value.controller.acknowledgeWorkspace('old-attempt');
      value.controller.acknowledgeWorkspace('current-attempt', true);
      await wait;
    });
    await value.controller.checkForUpdates();
    await value.controller.runAutomaticUpdate();
    expect(value.controller.currentState.status).toBe('waiting');
    expect(value.recover).toHaveBeenCalledOnce();
    expect(value.native.install).not.toHaveBeenCalled();
    expect(value.journal.get(context.identity())).toMatchObject({ phase: 'ready', attempts: 0 });
  });
});
