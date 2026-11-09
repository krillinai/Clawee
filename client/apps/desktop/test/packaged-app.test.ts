import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForProcessExit } from '../e2e/packaged-app.js';

describe('Packaged process exit waiting', () => {
  afterEach(() => vi.useRealTimers());

  it('removes the exit listener after a timeout', async () => {
    vi.useFakeTimers();
    const child = processFixture();
    const exited = waitForProcessExit(child, 5_500);
    expect(child.listenerCount('exit')).toBe(1);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await exited).toBe(false);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('clears its timeout after a confirmed exit', async () => {
    vi.useFakeTimers();
    const child = processFixture();
    const exited = waitForProcessExit(child, 5_500);
    child.emit('exit', 0);
    expect(await exited).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('does not wait again for a process that has already exited', async () => {
    const child = processFixture();
    Object.assign(child, { exitCode: 0 });
    expect(await waitForProcessExit(child, 5_500)).toBe(true);
    expect(child.listenerCount('exit')).toBe(0);
  });
});

function processFixture(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null
  }) as unknown as ChildProcess;
}
