import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowRequestId } from './request-id.js';

describe('工作流请求 UUID', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('优先使用原生 randomUUID', () => {
    const id = '01234567-89ab-4cde-8f01-23456789abcd';
    const nativeUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(id);
    const randomValues = vi.spyOn(crypto, 'getRandomValues');
    expect(createWorkflowRequestId()).toBe(id);
    expect(nativeUUID).toHaveBeenCalledTimes(1);
    expect(randomValues).not.toHaveBeenCalled();
  });

  it.each([
    [0, '00000000-0000-4000-8000-000000000000'],
    [255, 'ffffffff-ffff-4fff-bfff-ffffffffffff']
  ] as const)('缺少 randomUUID 时用随机字节 %s 设置 UUID v4 版本和变体', (byte, expected) => {
    const randomValues = vi.fn((values: Uint8Array) => { values.fill(byte); return values; });
    vi.stubGlobal('crypto', { getRandomValues: randomValues });
    expect(createWorkflowRequestId()).toBe(expected);
    expect(randomValues).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(randomValues.mock.calls[0]![0]).toHaveLength(16);
  });

  it('缺少 randomUUID 时独立请求生成不同的合法 UUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const first = createWorkflowRequestId();
    const second = createWorkflowRequestId();
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first).toMatch(pattern);
    expect(second).toMatch(pattern);
    expect(first).not.toBe(second);
  });
});
