import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BootstrapController } from '../src/main/bootstrap-controller.js';
import type { DaemonManager } from '../src/main/daemon-manager.js';
import type { DesktopLogger } from '../src/main/logger.js';
import * as resolver from '../src/main/runtime-resolver.js';

function fixture() {
  const connection = { address: 'http://127.0.0.1:60764', token: 'token' };
  const daemon = Object.assign(new EventEmitter(), {
    currentConnection: undefined as typeof connection | undefined,
    hasProcess: false,
    start: vi.fn(async () => { daemon.hasProcess = true; daemon.currentConnection = connection; return connection; }),
    restart: vi.fn(async () => connection),
    stop: vi.fn(async () => { daemon.hasProcess = false; daemon.currentConnection = undefined; }),
    stopForUpdate: vi.fn(async () => {}),
    resumeAfterUpdate: vi.fn()
  });
  vi.spyOn(resolver, 'resolveDevelopmentRuntime').mockResolvedValue({
    defaultCwd: '/tmp', env: {}, verificationMode: 'cached',
    launchContext: { candidate: {
      runtimeId: 'test-runtime', source: 'external-development', target: 'test',
      entryPath: '/tmp/codex', homePath: '/tmp/codex-home', contentSha256: 'a'.repeat(64)
    } }
  } as unknown as resolver.ResolvedDesktopRuntime);
  const controller = new BootstrapController({
    daemon: daemon as unknown as DaemonManager,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as DesktopLogger,
    daemonEntryPath: '/tmp/daemon.js', dataDir: '/tmp/data', defaultProjectRoot: '/tmp',
    development: true, resourcesPath: '/tmp/resources', runtimeManifestPath: '/tmp/manifest.json',
    developmentRuntimeDirectory: '/tmp/runtime', developmentCodexHome: '/tmp/codex-home',
    claweeVersion: '0.1.8', enterpriseConfigPath: '/tmp/config.toml'
  });
  return { controller, daemon, connection };
}

describe('统一 Runtime 恢复', () => {
  afterEach(() => vi.restoreAllMocks());

  it('首次启动失败后健康检查保留原始错误，不重复恢复或上报', async () => {
    const { controller, daemon } = fixture();
    vi.mocked(resolver.resolveDevelopmentRuntime).mockRejectedValue(new Error('runtime unavailable'));
    await controller.start();
    const failed = controller.currentState;
    const changed = vi.fn();
    controller.on('state', changed);
    await controller.recoverConnection();
    await controller.recoverConnection();
    expect(controller.currentState).toEqual(failed);
    expect(changed).not.toHaveBeenCalled();
    expect(daemon.start).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('自动退出恢复和健康检查只启动一次，连续退出受重试预算限制', async () => {
    const { controller, daemon } = fixture();
    await controller.start();
    controller.markWorkspaceReady();
    daemon.hasProcess = false; daemon.currentConnection = undefined;
    daemon.emit('exit', { reason: 'unexpected', code: 1 });
    await controller.recoverConnection();
    expect(daemon.start).toHaveBeenCalledTimes(2);
    daemon.hasProcess = false; daemon.currentConnection = undefined;
    daemon.emit('exit', { reason: 'unexpected', code: 1 });
    await controller.recoverConnection();
    expect(daemon.start).toHaveBeenCalledTimes(2);
    expect(controller.currentState.error?.code).toBe('DAEMON_RESTART_EXHAUSTED');
    await controller.stop();
  });

  it('并发手动重启合并；主动退出后禁止后台恢复', async () => {
    const { controller, daemon, connection } = fixture();
    await controller.start();
    let release!: () => void;
    daemon.restart.mockImplementation(() => new Promise(resolve => { release = () => resolve(connection); }));
    const first = controller.restartRuntime();
    const second = controller.restartRuntime();
    expect(first).toBe(second);
    expect(daemon.restart).toHaveBeenCalledOnce();
    release(); await first;
    await controller.stop();
    await controller.recoverConnection();
    expect(daemon.start).toHaveBeenCalledOnce();
  });

  it('更新安装期间即使进程消失也不自动恢复', async () => {
    const { controller, daemon } = fixture();
    await controller.start();
    await controller.stopForUpdate();
    daemon.hasProcess = false; daemon.currentConnection = undefined;
    await controller.recoverConnection();
    expect(daemon.start).toHaveBeenCalledOnce();
    await controller.stop();
  });
});
