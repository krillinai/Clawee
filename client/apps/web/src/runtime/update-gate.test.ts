import { describe, expect, it, vi } from 'vitest';
import { createUpdateRequestGate } from './update-gate.js';

describe('更新请求门禁', () => {
  it('停止已有长连接，拒绝轮询和重连，恢复后使用新信号', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const gate = createUpdateRequestGate(fetcher);
    await gate.fetch('/codex/models/events');
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    gate.pause();
    expect(signal.aborted).toBe(true);
    await expect(gate.fetch('/runs/1/events')).rejects.toMatchObject({ name: 'AbortError' });
    await expect(gate.fetch('/healthz')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
    gate.resume();
    await gate.fetch('/healthz');
    expect(fetcher.mock.calls[1]![1]!.signal!.aborted).toBe(false);
  });

  it('保留原调用方取消信号', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const gate = createUpdateRequestGate(fetcher);
    const controller = new AbortController();
    await gate.fetch('/runs/1/events', { signal: controller.signal });
    controller.abort();
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
