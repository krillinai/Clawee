import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UtilityProcess } from 'electron';
import type { DesktopLogger } from '../src/main/logger.js';

const electronMocks = vi.hoisted(() => ({
  fork: vi.fn()
}));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: electronMocks.fork
  }
}));

import {
  DaemonManager,
  type DaemonStartInput
} from '../src/main/daemon-manager.js';

describe('DaemonManager', () => {
  beforeEach(() => {
    electronMocks.fork.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears shutdown timers when the daemon exits normally', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child as unknown as UtilityProcess);
    const manager = new DaemonManager(fakeLogger());
    const started = manager.start(startInput());
    await Promise.resolve();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;

    await manager.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves time for forced cleanup within the total shutdown budget', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = new FakeUtilityProcess();
    vi.spyOn(child, 'postMessage').mockImplementation(() => undefined);
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => undefined);
    electronMocks.fork.mockReturnValue(child as unknown as UtilityProcess);
    const cleanup = vi.fn(async () => undefined);
    const manager = new DaemonManager(fakeLogger(), cleanup);
    const started = manager.start(startInput());
    await Promise.resolve();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;
    child.emit('message', { type: 'codex_child_started', pid: 43121 });

    let stopped = false;
    const stop = manager.stop(5_000).then(() => { stopped = true; });
    const failed = expect(stop).rejects.toThrow('DAEMON_STOP_TIMEOUT');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(kill).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(43121, false);
    await vi.advanceTimersByTimeAsync(500);
    expect(process.kill).toHaveBeenCalledWith(child.pid, 'SIGKILL');
    expect(cleanup).toHaveBeenCalledWith(43121, true);
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    expect(stopped).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a queued start before forking when quit begins during startup', async () => {
    const manager = new DaemonManager(fakeLogger());
    const started = manager.start(startInput());
    const failed = expect(started).rejects.toMatchObject({ code: 'DAEMON_START_CANCELLED' });
    await manager.stop();
    await failed;
    expect(electronMocks.fork).not.toHaveBeenCalled();
  });

  it('stops a forked daemon before readiness without accepting late startup output', async () => {
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child);
    const manager = new DaemonManager(fakeLogger());
    const connection = vi.fn();
    manager.on('connection', connection);
    const started = manager.start(startInput());
    const failed = expect(started).rejects.toThrow('Daemon exited before ready');
    await Promise.resolve();
    await manager.stop();
    await failed;
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    expect(connection).not.toHaveBeenCalled();
    expect(manager.pid).toBeUndefined();
  });

  it('rejects readiness arriving after shutdown begins, including a child without a PID yet', async () => {
    const child = new FakeUtilityProcess();
    Object.defineProperty(child, 'pid', { value: undefined });
    vi.spyOn(child, 'postMessage').mockImplementation(() => undefined);
    electronMocks.fork.mockReturnValue(child);
    const manager = new DaemonManager(fakeLogger());
    const connection = vi.fn();
    manager.on('connection', connection);
    const started = manager.start(startInput());
    const failed = expect(started).rejects.toMatchObject({ code: 'DAEMON_START_CANCELLED' });
    await Promise.resolve();
    expect(manager.hasProcess).toBe(true);
    const stopped = manager.stop();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await failed;
    child.emit('exit', 0);
    await stopped;
    expect(connection).not.toHaveBeenCalled();
    expect(manager.hasProcess).toBe(false);
  });

  it('retries Windows termination through the owned UtilityProcess rather than taskkill by PID', async () => {
    vi.useFakeTimers();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const child = new FakeUtilityProcess();
      vi.spyOn(child, 'postMessage').mockImplementation(() => undefined);
      const kill = vi.spyOn(child, 'kill').mockImplementation(() => undefined);
      const processKill = vi.spyOn(process, 'kill');
      electronMocks.fork.mockReturnValue(child);
      const manager = new DaemonManager(fakeLogger());
      const started = manager.start(startInput());
      await Promise.resolve();
      child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
      await started;
      const stopped = expect(manager.stop(5_000)).rejects.toThrow('DAEMON_STOP_TIMEOUT');
      await vi.advanceTimersByTimeAsync(5_000);
      await stopped;
      expect(kill).toHaveBeenCalledTimes(2);
      expect(processKill).not.toHaveBeenCalled();
      child.emit('exit', 0);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('cancels a concurrent restart when desktop quit also requests stop', async () => {
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child);
    const manager = new DaemonManager(fakeLogger());
    const started = manager.start(startInput());
    await Promise.resolve();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;
    const restart = manager.restart(startInput());
    const failed = expect(restart).rejects.toMatchObject({ code: 'DAEMON_START_CANCELLED' });
    await manager.stop();
    await failed;
    expect(electronMocks.fork).toHaveBeenCalledOnce();
  });

  it('confirms exit before an immediate restart and distinguishes cleanup from process exit', async () => {
    const child = new FakeUtilityProcess();
    const nextChild = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValueOnce(child).mockReturnValueOnce(nextChild);
    const logger = fakeLogger();
    const manager = new DaemonManager(logger);
    const started = manager.start(startInput());
    await Promise.resolve();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;
    await manager.stop();
    expect(manager.pid).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('Daemon shutdown cleanup finished',
      expect.objectContaining({ processExited: true }));
    const restarted = manager.start(startInput());
    await Promise.resolve();
    nextChild.stdout.write('{"address":"127.0.0.1:43122","token":"secret"}\n');
    await restarted;
    await manager.stop();
  });

  it('rejects an unconfirmed exit and never forks a replacement over a live daemon', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = new FakeUtilityProcess();
    vi.spyOn(child, 'postMessage').mockImplementation(() => undefined);
    vi.spyOn(child, 'kill').mockImplementation(() => undefined);
    electronMocks.fork.mockReturnValue(child);
    const logger = fakeLogger();
    const manager = new DaemonManager(logger);
    const started = manager.start(startInput());
    await Promise.resolve();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;
    const stopped = expect(manager.stop(1_000)).rejects.toThrow('DAEMON_STOP_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(logger.info).toHaveBeenCalledWith('Daemon shutdown cleanup finished',
      expect.objectContaining({ processExited: false, pid: child.pid }));
    await expect(manager.start(startInput())).rejects.toThrow();
    expect(electronMocks.fork).toHaveBeenCalledOnce();
    child.emit('exit', 1);
  });

  it('waits for Codex process-tree cleanup after the daemon exits', async () => {
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child as unknown as UtilityProcess);
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(() => new Promise<void>(resolve => {
      finishCleanup = resolve;
    }));
    const manager = new DaemonManager(fakeLogger(), cleanup);
    const started = manager.start(startInput());
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;
    child.emit('message', { type: 'codex_child_started', pid: 43121 });

    const stopped = manager.stop();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith(43121, true));
    let resolved = false;
    void stopped.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    finishCleanup?.();
    await stopped;
    expect(resolved).toBe(true);
  });

  it('does not wait indefinitely for Codex cleanup after the daemon exits', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child as unknown as UtilityProcess);
    const manager = new DaemonManager(fakeLogger(), () => new Promise(() => undefined));
    const started = manager.start(startInput());
    await Promise.resolve();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;
    child.emit('message', { type: 'codex_child_started', pid: 43121 });

    const stop = manager.stop(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await stop;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('update shutdown rejects timeout instead of force killing or declaring success', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    vi.spyOn(child, 'postMessage').mockImplementation(() => undefined);
    const kill = vi.spyOn(child, 'kill');
    electronMocks.fork.mockReturnValue(child as unknown as UtilityProcess);
    const manager = new DaemonManager(fakeLogger());
    const started = manager.start(startInput());
    await Promise.resolve();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;
    const stopped = expect(manager.stopForUpdate(1_000)).rejects.toThrow('停止超时');
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(kill).not.toHaveBeenCalled();
    expect(manager.currentConnection).toBeDefined();
    manager.resumeAfterUpdate();
  });

  it('update shutdown waits for exit and rejects unfinished Codex cleanup', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child as unknown as UtilityProcess);
    const manager = new DaemonManager(fakeLogger(), () => new Promise(() => undefined));
    const started = manager.start(startInput());
    await Promise.resolve();
    child.stdout.write('{"address":"127.0.0.1:43120","token":"secret"}\n');
    await started;
    child.emit('message', { type: 'codex_child_started', pid: 43121 });
    const stopped = expect(manager.stopForUpdate(1_000)).rejects.toThrow('停止超时');
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(manager.pid).toBeUndefined();
  });
});

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 43119;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  postMessage(message: unknown): void {
    if (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'shutdown'
    ) {
      queueMicrotask(() => this.emit('exit', 0));
    }
  }

  kill(): void {
    queueMicrotask(() => this.emit('exit', 0));
  }
}

function startInput(): DaemonStartInput {
  return {
    entryPath: '/tmp/daemon.js',
    cwd: '/tmp',
    env: {},
    runtime: {
      candidate: {
        runtimeId: 'codex-rust-v0.146.0-layout-1',
        source: 'embedded-package',
        codexVersion: '0.146.0',
        releaseTag: 'rust-v0.146.0',
        target: 'aarch64-apple-darwin',
        layoutVersion: 1,
        entryPath: '/tmp/codex',
        homePath: '/tmp/codex-home',
        contentSha256: 'a'.repeat(64),
        minimumClaweeVersion: '1.0.0',
        migrationSourceHome: null
      },
      previous: null,
      claweeVersion: '1.0.0'
    },
    dataDir: '/tmp/daemon-data',
    defaultCwd: '/tmp',
    defaultProjectRoot: '/tmp',
    requireProbe: true,
    probeVerified: false,
    enterpriseConfigPath: '/tmp/config.toml'
  };
}

function fakeLogger(): DesktopLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    warnRateLimited: vi.fn(),
    flush: vi.fn(async () => undefined)
  };
}
