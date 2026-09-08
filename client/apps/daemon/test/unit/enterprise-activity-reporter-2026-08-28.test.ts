import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnterpriseHttpError } from '../../src/enterprise/http-client-2026-07-30.js';
import { createEnterpriseActivityReporter } from '../../src/enterprise/activity-reporter-2026-08-28.js';
import type { EnterpriseActivityEventsRequest } from '../../src/enterprise/activity-event-projector-2026-08-28.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('enterprise activity reporter', () => {
  it('does not retain or send runs while reporting is paused', async () => {
    vi.useFakeTimers();
    const reportAgentActivity = vi.fn(async () => undefined);
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity },
      requireAccessToken: vi.fn(async () => 'access-token')
    });

    reporter.registerRun(runInput('disabled'));
    reporter.resume();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reportAgentActivity).not.toHaveBeenCalled();
  });

  it('flushes a small batch after 500ms and keeps stable event ids', async () => {
    vi.useFakeTimers();
    const reportAgentActivity = vi.fn(async (
      _token: string,
      _request: EnterpriseActivityEventsRequest
    ) => undefined);
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    reporter.registerRun(runInput('run_1'));

    expect(reportAgentActivity).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(reportAgentActivity).toHaveBeenCalledOnce();
    const request = reportAgentActivity.mock.calls[0]![1];
    expect(request.events[0]?.event_id).toBe('evt_run_1_created');
    expect(request.events[0]?.event_id).toBe('evt_run_1_created');
  });

  it('flushes immediately at 20 events and splits batches by count', async () => {
    vi.useFakeTimers();
    const reportAgentActivity = vi.fn(async (
      _token: string,
      _request: EnterpriseActivityEventsRequest
    ) => undefined);
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    for (let index = 0; index < 20; index += 1) {
      reporter.registerRun(runInput(`run_${index}`));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(reportAgentActivity).toHaveBeenCalledOnce();
    expect(reportAgentActivity.mock.calls[0]![1].events).toHaveLength(20);
  });

  it('retries 5xx and clears then pauses on authorization rejection', async () => {
    vi.useFakeTimers();
    const reportAgentActivity = vi.fn<(
      token: string,
      request: EnterpriseActivityEventsRequest
    ) => Promise<void>>()
      .mockRejectedValueOnce(new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'response', 500))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new EnterpriseHttpError('ENTERPRISE_UNAUTHORIZED', 'response', 401));
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    reporter.registerRun(runInput('retry'));
    await vi.advanceTimersByTimeAsync(500);
    expect(reportAgentActivity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reportAgentActivity).toHaveBeenCalledTimes(2);

    reporter.registerRun(runInput('unauthorized'));
    await vi.advanceTimersByTimeAsync(500);
    expect(reportAgentActivity).toHaveBeenCalledTimes(3);
    reporter.registerRun(runInput('paused'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reportAgentActivity).toHaveBeenCalledTimes(3);
  });

  it('splits large events into requests below 512 KiB', async () => {
    vi.useFakeTimers();
    const requests: EnterpriseActivityEventsRequest[] = [];
    const reporter = createEnterpriseActivityReporter({
      httpClient: {
        reportAgentActivity: vi.fn(async (_token, request) => {
          requests.push(request);
        })
      },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    for (let index = 0; index < 20; index += 1) {
      reporter.registerRun({
        ...runInput(`large_${index}`),
        prompt: 'x'.repeat(64 * 1024)
      });
    }

    await vi.advanceTimersByTimeAsync(0);

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap(request => request.events)).toHaveLength(20);
    for (const request of requests) {
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThanOrEqual(512 * 1024);
    }
  });

  it('uses 1, 2, 5 and 10 second retry intervals', async () => {
    vi.useFakeTimers();
    const attemptedAt: number[] = [];
    const reportAgentActivity = vi.fn(async () => {
      attemptedAt.push(Date.now());
      if (attemptedAt.length < 5) {
        throw new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'response', 500);
      }
    });
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    reporter.registerRun(runInput('retry_schedule'));

    await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000 + 5_000 + 10_000);

    expect(attemptedAt.map((value, index) => index === 0 ? 0 : value - attemptedAt[index - 1]!))
      .toEqual([0, 1_000, 2_000, 5_000, 10_000]);
  });

  it('drops a rejected batch and continues with later events', async () => {
    vi.useFakeTimers();
    const reportAgentActivity = vi.fn<(
      token: string,
      request: EnterpriseActivityEventsRequest
    ) => Promise<void>>()
      .mockRejectedValueOnce(new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'response', 400))
      .mockResolvedValue(undefined);
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    reporter.registerRun(runInput('invalid'));
    await vi.advanceTimersByTimeAsync(500);
    reporter.registerRun(runInput('valid'));
    await vi.advanceTimersByTimeAsync(500);

    expect(reportAgentActivity).toHaveBeenCalledTimes(2);
    expect(reportAgentActivity.mock.calls[1]![1].events[0]?.run_id).toBe('valid');
  });

  it('drops the oldest event when the in-memory queue exceeds 500 entries', () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn();
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity: vi.fn(async () => undefined) },
      requireAccessToken: vi.fn(async () => 'access-token'),
      onDiagnostic
    });
    reporter.resume();
    for (let index = 0; index < 501; index += 1) {
      reporter.registerRun(runInput(`queued_${index}`));
    }

    expect(onDiagnostic).toHaveBeenLastCalledWith({
      code: 'ACTIVITY_QUEUE_OVERFLOW',
      droppedEvents: 1
    });
    expect(onDiagnostic).toHaveBeenCalledOnce();

    reporter.clear('test');
    reporter.resume();
    reporter.registerRun(runInput('after_clear'));

    expect(onDiagnostic).toHaveBeenCalledOnce();
  });

  it('does not remove later events when an in-flight batch overflows out of the queue', async () => {
    vi.useFakeTimers();
    let releaseFirstRequest!: () => void;
    const firstRequest = new Promise<void>(resolve => {
      releaseFirstRequest = resolve;
    });
    const requests: EnterpriseActivityEventsRequest[] = [];
    const reportAgentActivity = vi.fn(async (
      _token: string,
      request: EnterpriseActivityEventsRequest
    ) => {
      requests.push(request);
      if (requests.length === 1) await firstRequest;
    });
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    for (let index = 0; index < 20; index += 1) {
      reporter.registerRun(runInput(`queued_${index}`));
    }
    await vi.advanceTimersByTimeAsync(0);

    for (let index = 20; index < 520; index += 1) {
      reporter.registerRun(runInput(`queued_${index}`));
    }
    const closing = reporter.close();
    releaseFirstRequest();
    await closing;

    const sentRunIds = requests.flatMap(request => request.events.map(event => event.run_id));
    expect(sentRunIds.slice(20)).toEqual(
      Array.from({ length: 500 }, (_, index) => `queued_${index + 20}`)
    );
  });

  it('limits close flush waiting to two seconds', async () => {
    vi.useFakeTimers();
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity: vi.fn(() => new Promise<void>(() => undefined)) },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    reporter.registerRun(runInput('closing'));

    const closing = reporter.close();
    await vi.advanceTimersByTimeAsync(1_999);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
  });

  it('does not retry an in-flight request after close times out', async () => {
    vi.useFakeTimers();
    const reportAgentActivity = vi.fn(() => new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('late failure')), 2_500);
    }));
    const reporter = createEnterpriseActivityReporter({
      httpClient: { reportAgentActivity },
      requireAccessToken: vi.fn(async () => 'access-token')
    });
    reporter.resume();
    reporter.registerRun(runInput('closing_failure'));

    const closing = reporter.close();
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(reportAgentActivity).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(reportAgentActivity).toHaveBeenCalledOnce();
  });
});

function runInput(runId: string) {
  return {
    runId,
    threadId: `thread_${runId}`,
    prompt: 'run tests',
    createdBy: 'api' as const,
    workspaceName: 'clawee-agent',
    createdAt: '2026-08-28T10:00:00.000Z'
  };
}
