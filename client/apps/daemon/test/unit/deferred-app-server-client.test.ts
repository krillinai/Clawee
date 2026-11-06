import { describe, expect, it, vi } from 'vitest';
import { createDeferredCodexAppServerClient } from '../../src/codex/deferred-app-server-client.js';

describe('延迟激活的 Codex app-server 客户端', () => {
  it('切换后请求立即使用新客户端，退出时不会被旧连接清理重新激活', async () => {
    let finishClose!: () => void;
    const closing = new Promise<void>(resolve => { finishClose = resolve; });
    const previous = {
      async request<Result>() { return 'previous' as Result; },
      close: vi.fn(() => closing)
    };
    const next = {
      async request<Result>() { return 'next' as Result; },
      close: vi.fn(async () => undefined)
    };
    const client = createDeferredCodexAppServerClient();
    await client.activate(previous);
    const activated = vi.fn();
    const activation = client.activate(next).then(activated);

    try {
      expect(client.ready()).toBe(true);
      await expect(client.request('model/list', {})).resolves.toBe('next');
      expect(previous.close).toHaveBeenCalledOnce();
      expect(next.close).not.toHaveBeenCalled();
      expect(activated).not.toHaveBeenCalled();

      await client.deactivate();
      expect(next.close).toHaveBeenCalledOnce();
    } finally {
      finishClose();
      await activation;
      expect(client.ready()).toBe(false);
      await client.close();
    }
    expect(client.ready()).toBe(false);
    expect(previous.close).toHaveBeenCalledOnce();
    expect(next.close).toHaveBeenCalledOnce();
  });

  it('关闭后拒绝激活并释放传入的新客户端', async () => {
    const client = createDeferredCodexAppServerClient();
    await client.close();
    const next = {
      async request<Result>() { return undefined as Result; },
      close: vi.fn(async () => undefined)
    };

    await expect(client.activate(next)).rejects.toThrow('Deferred Codex app-server client is closed');
    expect(client.ready()).toBe(false);
    expect(next.close).toHaveBeenCalledOnce();
  });
});
