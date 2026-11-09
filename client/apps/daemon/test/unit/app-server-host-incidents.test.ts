import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAppServerHost } from '../../src/codex/app-server-host-2026-07-28.js';
import { spawnCodexProcess, terminateCodexProcess } from '../../src/codex/process.js';

vi.mock('../../src/codex/process.js', () => ({
  spawnCodexProcess: vi.fn(),
  terminateCodexProcess: vi.fn(async () => {})
}));

const original = Object.getOwnPropertyDescriptor(process, 'parentPort');
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  if (original) Object.defineProperty(process, 'parentPort', original);
  else Reflect.deleteProperty(process, 'parentPort');
});

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
  });
  vi.mocked(spawnCodexProcess).mockReturnValue(child as unknown as ChildProcess);
  const postMessage = vi.fn();
  Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
  const host = createCodexAppServerHost({ codexBin: 'fake', codexHome: '/tmp', cwd: '/tmp', profile: 'default' });
  return { child, host, postMessage };
}

describe('app-server进程异常观测', () => {
  it('接收超过 1 MiB 的恢复响应和工具通知，并完整结束任务', async () => {
    const { child, host } = fixture();
    const text = 'x'.repeat(2 * 1024 * 1024);
    const onNotification = vi.fn();
    const job = host.run({ cwd: '/tmp', sandbox: 'read-only', prompt: 'test', codexThreadId: 'thread-1', onNotification });
    const result = job.result.catch(error => error);
    child.stdin.on('data', (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString());
      const response = message.method === 'initialize' ? {}
        : message.method === 'thread/resume' ? { thread: { id: 'thread-1', history: text } }
          : message.method === 'turn/start' ? { turn: { id: 'turn-1' } } : undefined;
      if (response === undefined) return;
      child.stdout.write(JSON.stringify({ id: message.id, result: response }) + '\n');
      if (message.method !== 'turn/start') return;
      child.stdout.write(JSON.stringify({ method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-1', item: { id: 'tool-1', type: 'mcpToolCall', result: text }
      } }) + '\n');
      child.stdout.write(JSON.stringify({ method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' }
      } }) + '\n');
    });

    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ turnStatus: 'completed', outputTruncation: { frames: { truncated: false } } });
    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({
      method: 'item/completed', params: expect.objectContaining({ item: expect.objectContaining({ result: text }) })
    }));
    child.emit('close', 0, null);
    await host.close();
  });

  it.each([false, true])('超限消息立即失败并清理进程，分块=%s', async fragmented => {
    const { child, host } = fixture();
    const job = host.run({ cwd: '/tmp', sandbox: 'read-only', prompt: 'test', inactivityTimeoutMs: 600_000 });
    const failure = job.result.catch(error => error);
    const chunk = 'x'.repeat(1024 * 1024);
    if (fragmented) {
      for (let index = 0; index < 33; index += 1) child.stdout.write(chunk);
    } else {
      child.stdout.write(chunk.repeat(33) + '\n');
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(await failure).toMatchObject({ code: 'CODEX_APP_SERVER_FRAME_TOO_LARGE', incidentStage: 'initialize' });
    expect(terminateCodexProcess).toHaveBeenCalledWith(child, 'SIGTERM');
    expect(host.isReusable()).toBe(false);
    child.emit('close', 1, null);
    await host.close();
  });

  it.each([false, true])('主动关闭不生成进程故障，活动turn=%s', async active => {
    const { child, host, postMessage } = fixture();
    const job = active ? host.run({ cwd: '/tmp', sandbox: 'read-only', prompt: 'private' }) : undefined;
    const result = job?.result.catch(error => error);
    const closing = host.close('runner shutdown');
    child.stdin.emit('error', Object.assign(new Error('expected pipe close'), { code: 'EPIPE' }));
    child.emit('close', null, 'SIGTERM');
    await closing;
    if (result) expect(await result).toMatchObject({ incidentExpectedStop: true, incidentStage: 'process_exit' });
    expect(postMessage).not.toHaveBeenCalled();
    expect(terminateCodexProcess).toHaveBeenCalledTimes(1);
  });

  it('活动turn初始化失败仍标记initialize，并保留耗时', async () => {
    const { child, host, postMessage } = fixture();
    const job = host.run({ cwd: '/tmp', sandbox: 'read-only', prompt: 'private' });
    const failure = job.result.catch(error => error);
    vi.setSystemTime(1500);
    child.emit('error', Object.assign(new Error('private'), { code: 'EPIPE' }));
    expect(await failure).toMatchObject({ incidentStage: 'initialize', incidentDurationMs: 500, incidentUnresponsiveMs: 500 });
    expect(postMessage).not.toHaveBeenCalled();
    child.emit('close', 1, null);
    await host.close();
  });

  it('空闲进程异常退出只报告一次，携带退出码和实际耗时', async () => {
    const { child, host, postMessage } = fixture();
    vi.setSystemTime(1750);
    child.emit('close', 17, null);
    await Promise.resolve();
    await host.close();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ error_code: 'APP_SERVER_UNEXPECTED_EXIT', exit_code: 17, duration_ms: 750, unresponsive_ms: 750 }) }));
  });
});
