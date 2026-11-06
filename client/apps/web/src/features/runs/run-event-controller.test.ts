import type { AgentEventEnvelope } from '@clawee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubscribeRunEventsInput } from '../../runtime/sse.js';
import { createRunEventController } from './run-event-controller.js';

describe('run event controller', () => {
  it('终态 EOF 等待输出协调，完成后不再退避重连', async () => {
    vi.useFakeTimers();
    const subscribe = vi.fn(async (input: SubscribeRunEventsInput) => { input.onEvent(createEvent(1)); });
    let resolve!: (value: boolean) => void;
    const onStreamEnd = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const onError = vi.fn();
    const controller = createRunEventController({ subscribe, reconnectDelays: [500] });
    controller.start({ runId: 'run_1', baseUrl: 'http://localhost', onEvent: () => {}, onStateChange: () => {}, onError, onStreamEnd });
    await vi.advanceTimersByTimeAsync(0);
    expect(onStreamEnd).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(subscribe).toHaveBeenCalledTimes(1);
    resolve(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    controller.stop();
  });

  it('EOF 协调结果在替换控制器后失效', async () => {
    let finish!: (value: boolean) => void;
    const onError = vi.fn();
    const controller = createRunEventController({ subscribe: async input => {
      if (input.runId === 'run_2') await new Promise<void>(resolve => input.signal?.addEventListener('abort', () => resolve()));
    } });
    controller.start({ runId: 'run_1', baseUrl: 'http://localhost', onEvent: () => {}, onStateChange: () => {}, onError,
      onStreamEnd: () => new Promise<boolean>(resolve => { finish = resolve; }) });
    await Promise.resolve(); await Promise.resolve();
    const states = vi.fn();
    controller.start({ runId: 'run_2', baseUrl: 'http://localhost', onEvent: () => {}, onStateChange: states, onError });
    finish(true);
    await Promise.resolve(); await Promise.resolve();
    expect(states.mock.calls).toEqual([['connecting']]);
    expect(onError).not.toHaveBeenCalled();
    controller.stop();
  });

  const originalBridge = window.claweeDesktop;
  afterEach(() => {
    window.claweeDesktop = originalBridge;
    vi.useRealTimers();
  });

  it('断流耗时与恢复真实记录一次，正常done不产生新故障', async () => {
    vi.useFakeTimers();
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    const subscriptions: SubscribeRunEventsInput[] = [];
    const controller = createRunEventController({
      reconnectDelays: [500],
      subscribe: async input => {
        subscriptions.push(input);
        if (subscriptions.length === 1) {
          await new Promise(resolve => setTimeout(resolve, 250));
          throw new Error('private stream error');
        }
        input.onEvent(createEvent(1));
        input.onEvent(createEvent(2));
        input.onEvent(createDoneEvent(3));
      }
    });
    controller.start({ baseUrl: 'http://localhost', runId: 'run_1', onEvent: () => {}, onStateChange: () => {}, onError: () => {} });
    await vi.advanceTimersByTimeAsync(250);
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'error', duration_ms: 250, run_id: 'run_1' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(reportIncident).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'recovered', duration_ms: 500 }));
    expect(reportIncident).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(reportIncident.mock.calls)).not.toContain('private');
    controller.stop();
  });

  it('主动停止后抛出的SSE错误不报告', async () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    const controller = createRunEventController({ subscribe: async input => {
      await new Promise<void>(resolve => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('intentional close');
    } });
    controller.start({ baseUrl: 'http://localhost', runId: 'run_1', onEvent: () => {}, onStateChange: () => {}, onError: () => {} });
    controller.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it('reconnects from the latest sequence and ignores duplicate events', async () => {
    vi.useFakeTimers();
    const subscriptions: SubscribeRunEventsInput[] = [];
    const received: number[] = [];
    const states: string[] = [];
    const subscribe = vi.fn(async (input: SubscribeRunEventsInput) => {
      subscriptions.push(input);
      if (subscriptions.length === 1) {
        input.onEvent(createEvent(2));
        input.onEvent(createEvent(2));
        return;
      }
      input.onEvent(createEvent(3));
      input.onEvent(createDoneEvent(4));
    });
    const controller = createRunEventController({
      subscribe,
      reconnectDelays: [500, 1_000]
    });

    controller.start({
      baseUrl: 'https://runtime.test',
      token: 'token',
      runId: 'run_1',
      fromSeq: 1,
      onEvent: event => received.push(event.seq),
      onStateChange: state => states.push(state),
      onError: error => {
        throw error;
      }
    });

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    expect(subscriptions[0]?.fromSeq).toBe(1);
    expect(received).toEqual([2]);

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));

    expect(subscriptions[1]?.fromSeq).toBe(2);
    expect(received).toEqual([2, 3, 4]);
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected', 'idle']);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(subscriptions).toHaveLength(2);
  });

  it('stops after the configured reconnect attempts and reports one final error', async () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    const states: string[] = [];
    const subscribe = vi.fn(async () => {
      throw new Error('connection lost');
    });
    const controller = createRunEventController({
      subscribe,
      reconnectDelays: [500, 1_000]
    });

    controller.start({
      baseUrl: 'https://runtime.test',
      token: 'token',
      runId: 'run_1',
      onEvent: () => undefined,
      onStateChange: state => states.push(state),
      onError: error => errors.push(error)
    });

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(3));

    expect(errors.map(error => error.message)).toEqual(['connection lost']);
    expect(states).toEqual([
      'connecting',
      'reconnecting',
      'disconnected'
    ]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(subscribe).toHaveBeenCalledTimes(3);
  });

  it('does not reconnect after an active stop', async () => {
    vi.useFakeTimers();
    let subscription: SubscribeRunEventsInput | undefined;
    const subscribe = vi.fn(async (input: SubscribeRunEventsInput) => {
      subscription = input;
      await new Promise<void>(resolve => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const controller = createRunEventController({
      subscribe,
      reconnectDelays: [500]
    });

    controller.start({
      baseUrl: 'https://runtime.test',
      token: 'token',
      runId: 'run_1',
      onEvent: () => undefined,
      onStateChange: () => undefined,
      onError: error => {
        throw error;
      }
    });

    await vi.waitFor(() => expect(subscription).toBeDefined());
    controller.stop();

    expect(subscription?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores callbacks from a replaced subscription generation', async () => {
    const subscriptions: SubscribeRunEventsInput[] = [];
    const received: string[] = [];
    const subscribe = vi.fn(async (input: SubscribeRunEventsInput) => {
      subscriptions.push(input);
      await new Promise<void>(resolve => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const controller = createRunEventController({ subscribe });
    const start = (runId: string) => controller.start({
      baseUrl: 'https://runtime.test',
      token: 'token',
      runId,
      onEvent: event => received.push(event.runId),
      onStateChange: () => undefined,
      onError: error => {
        throw error;
      }
    });

    start('run_1');
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    start('run_2');
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));

    subscriptions[0]?.onEvent(createEvent(1, 'run_1'));
    subscriptions[1]?.onEvent(createEvent(1, 'run_2'));

    expect(received).toEqual(['run_2']);
    controller.stop();
  });
});

function createEvent(seq: number, runId = 'run_1'): AgentEventEnvelope {
  return {
    id: `event_${runId}_${seq}`,
    runId,
    seq,
    ts: new Date(0).toISOString(),
    type: 'assistant_message',
    payload: {
      type: 'assistant_message',
      text: `message ${seq}`,
      format: 'plain_text',
      delivery: 'message'
    },
    normalizerVersion: 1
  };
}

function createDoneEvent(seq: number, runId = 'run_1'): AgentEventEnvelope {
  return {
    id: `event_${runId}_${seq}`,
    runId,
    seq,
    ts: new Date(0).toISOString(),
    type: 'done',
    payload: {
      type: 'done',
      status: 'succeeded',
      terminationReason: 'completed'
    },
    normalizerVersion: 1
  };
}
