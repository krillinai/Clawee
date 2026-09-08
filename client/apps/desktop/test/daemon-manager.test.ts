import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
