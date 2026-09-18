import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown, installParentPortShutdown } from '../../src/shutdown.js';

describe('graceful shutdown', () => {
  it('shares one server close across repeated shutdown signals', async () => {
    const signals = new EventEmitter();
    let releaseClose!: () => void;
    const closeBlocked = new Promise<void>(resolve => {
      releaseClose = resolve;
    });
    const close = vi.fn(() => closeBlocked);
    const onError = vi.fn();

    const uninstall = installGracefulShutdown({
      close,
      onError,
      signalSource: signals
    });

    signals.emit('SIGTERM');
    signals.emit('SIGINT');

    expect(close).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    releaseClose();
    await closeBlocked;
    uninstall();
  });

  it('reports server close failures', async () => {
    const signals = new EventEmitter();
    const error = new Error('close failed');
    const onError = vi.fn();

    installGracefulShutdown({
      close: async () => {
        throw error;
      },
      onError,
      signalSource: signals
    });

    signals.emit('SIGTERM');
    await expect.poll(() => onError).toHaveBeenCalledWith(error);
  });
});

describe('parent port shutdown', () => {
  it('exits only after cleanup completes and ignores repeated requests', async () => {
    const parentPort = new EventEmitter();
    let releaseClose!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => {
      releaseClose = resolve;
    }));
    const finish = vi.fn();
    const onError = vi.fn();
    installParentPortShutdown({ parentPort, close, finish, onError });

    parentPort.emit('message', { data: { type: 'unrelated' } });
    expect(close).not.toHaveBeenCalled();
    parentPort.emit('message', { data: { type: 'shutdown' } });
    parentPort.emit('message', { data: { type: 'shutdown' } });
    expect(close).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();

    releaseClose();
    await expect.poll(() => finish).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports cleanup failures before finishing the process', async () => {
    const parentPort = new EventEmitter();
    const error = new Error('close failed');
    const onError = vi.fn();
    const finish = vi.fn(() => expect(onError).toHaveBeenCalledWith(error));
    installParentPortShutdown({
      parentPort,
      close: async () => { throw error; },
      finish,
      onError
    });
    parentPort.emit('message', { type: 'shutdown' });
    await expect.poll(() => finish).toHaveBeenCalledOnce();
  });
});
