import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsInstallStatePath, waitForWindowsInstall, windowsUpdateNeedsRelaunch, readWindowsInstallReceipt } from '../src/main/windows-install-state.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(state?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'clawee-install-state-'));
  roots.push(root);
  const installDirectory = join(root, 'Clawee');
  const path = windowsInstallStatePath(installDirectory);
  if (state) await writeFile(path, JSON.stringify(state));
  return { installDirectory, path };
}

const installing = { schemaVersion: 1, state: 'installing', installerPid: process.pid, targetVersion: '1.0.16' };

describe('Windows 安装启动门禁', () => {
  it('完成凭据读取现有 NSIS 文件；旧记录、损坏和安装中不能冒充本次完成', async () => {
    const { installDirectory, path } = await fixture();
    expect(readWindowsInstallReceipt(installDirectory)).toBeUndefined();
    await writeFile(path, JSON.stringify(installing));
    expect(readWindowsInstallReceipt(installDirectory)).toBeUndefined();
    await writeFile(path, JSON.stringify({ ...installing, state: 'complete', elapsedMs: 100 }));
    const first = readWindowsInstallReceipt(installDirectory);
    expect(first).toMatchObject({ targetVersion: '1.0.16' });
    expect(readWindowsInstallReceipt(installDirectory)).toEqual(first);
    await writeFile(path, JSON.stringify({ ...installing, state: 'complete', elapsedMs: 200 }));
    expect(readWindowsInstallReceipt(installDirectory)?.fingerprint).not.toBe(first?.fingerprint);
    await writeFile(path, '{broken');
    expect(readWindowsInstallReceipt(installDirectory)).toBeUndefined();
  });
  it('加载旧版本的等待进程只重启一次，完成记录和失败不能造成重启循环', () => {
    const state = { schemaVersion: 1 as const, state: 'complete' as const, installerPid: 123, targetVersion: '1.0.20', waited: true };
    expect(windowsUpdateNeedsRelaunch(state, '1.0.19', false)).toBe(true);
    expect(() => windowsUpdateNeedsRelaunch(state, '1.0.19', true)).toThrow('旧版本');
    expect(() => windowsUpdateNeedsRelaunch({ ...state, waited: false }, '1.0.19', false)).toThrow('旧版本');
    expect(windowsUpdateNeedsRelaunch(state, '1.0.20', false)).toBe(false);
    expect(windowsUpdateNeedsRelaunch(state, '1.0.21', false)).toBe(false);
  });
  it('普通安装目录不等待，状态记录位于安装目录之外', async () => {
    const { installDirectory, path } = await fixture();
    expect(path).toBe(`${installDirectory}.clawee-update.json`);
    expect(await waitForWindowsInstall({ installDirectory })).toBeUndefined();
  });

  it('安装进程存活时等待完成，期间不放行桌面初始化', async () => {
    const { installDirectory, path } = await fixture(installing);
    let released = false;
    const waiting = waitForWindowsInstall({
      installDirectory,
      onWaiting: async () => {
        expect(released).toBe(false);
        await writeFile(path, JSON.stringify({ ...installing, state: 'complete', elapsedMs: 125000 }));
      }
    }).then(result => { released = true; return result; });
    expect(released).toBe(false);
    expect(await waiting).toMatchObject({ targetVersion: '1.0.16', elapsedMs: 125000, waited: true });
  });

  it('安装已完成时直接放行，并保留安装耗时', async () => {
    const { installDirectory } = await fixture({ ...installing, state: 'complete', elapsedMs: 1234 });
    expect(await waitForWindowsInstall({ installDirectory })).toMatchObject({ waited: false, elapsedMs: 1234 });
  });

  it('安装进程已退出但未完成时明确报错', async () => {
    const { installDirectory } = await fixture(installing);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }); });
    await expect(waitForWindowsInstall({ installDirectory })).rejects.toThrow('安装未完成');
  });

  it('读到安装中状态后安装器完成并退出时仍正常放行', async () => {
    const { installDirectory, path } = await fixture(installing);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      writeFileSync(path, JSON.stringify({ ...installing, state: 'complete', elapsedMs: 1234 }));
      throw Object.assign(new Error('exited'), { code: 'ESRCH' });
    });
    expect(await waitForWindowsInstall({ installDirectory })).toMatchObject({ state: 'complete', elapsedMs: 1234 });
  });

  it('等待期间状态消失或目标版本变化时不放行', async () => {
    for (const nextState of [undefined, { ...installing, state: 'complete', targetVersion: '1.0.17' }]) {
      const { installDirectory, path } = await fixture(installing);
      await expect(waitForWindowsInstall({ installDirectory, onWaiting: async () => {
        if (nextState === undefined) await rm(path);
        else await writeFile(path, JSON.stringify(nextState));
      } })).rejects.toThrow('安装状态已变化');
    }
  });

  it('状态损坏时不把安装当成成功', async () => {
    const { installDirectory } = await fixture({ ...installing, installerPid: -1 });
    await expect(waitForWindowsInstall({ installDirectory })).rejects.toThrow('安装状态无效');
  });

  it('安装等待可以取消，不继续加载桌面主进程', async () => {
    const { installDirectory } = await fixture(installing);
    const controller = new AbortController();
    await expect(waitForWindowsInstall({ installDirectory, signal: controller.signal, onWaiting: () => controller.abort() })).rejects.toThrow('取消');
  });

  it('活跃安装等待有上限，不无限隐藏真实安装失败', async () => {
    const { installDirectory } = await fixture(installing);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    await expect(waitForWindowsInstall({ installDirectory, onWaiting: () => { clock.mockReturnValue(10 * 60_000 + 1); } })).rejects.toThrow('超时');
  });
});
