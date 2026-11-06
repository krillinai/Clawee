import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRunRecoveryTriggers } from './use-run-recovery-triggers.js';

afterEach(() => vi.useRealTimers());

describe('运行恢复触发', () => {
  it('初次挂载时不安排可能迟到的自动恢复', () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    renderHook(() => useRunRecoveryTriggers(recover, true));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(recover).not.toHaveBeenCalled();
  });
  it('daemon不可达时仍可通过online/focus尝试恢复，同一批触发只调用一次', () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    const { rerender, unmount } = renderHook(({ connected }) => useRunRecoveryTriggers(recover, connected), {
      initialProps: { connected: false }
    });
    act(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(100);
    });
    expect(recover).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(recover).toHaveBeenCalledTimes(1);
    rerender({ connected: true });
    act(() => { vi.advanceTimersByTime(100); });
    expect(recover).toHaveBeenCalledTimes(2);
    unmount();
    act(() => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(100); });
    expect(recover).toHaveBeenCalledTimes(2);
  });
});
