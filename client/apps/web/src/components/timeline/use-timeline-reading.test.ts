import type { KeyboardEvent, TouchEvent, WheelEvent } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimelineReading } from './use-timeline-reading.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function scroller() {
  const root = document.createElement('div');
  const marker = document.createElement('div');
  marker.dataset.timelineId = 'anchor-a';
  root.append(marker);
  document.body.append(root);
  let top = 800;
  Object.defineProperties(root, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.min(800, Math.max(0, value)); } }
  });
  root.getBoundingClientRect = () => ({ top: 0, bottom: 200 } as DOMRect);
  marker.getBoundingClientRect = () => ({ top: 800 - top, bottom: 900 - top } as DOMRect);
  return { root, marker };
}

function flushFrame() {
  act(() => { vi.advanceTimersByTime(20); });
}

function scroll(root: HTMLElement, top = root.scrollTop) {
  act(() => { root.scrollTop = top; root.dispatchEvent(new Event('scroll')); });
}

describe('useTimelineReading', () => {
  it('does not undo a scroll that arrives before a pending layout correction', () => {
    const { root } = scroller();
    const { result, rerender } = renderHook(({ content }) => useTimelineReading('reading-pending-scroll', content), {
      initialProps: { content: 'one' }
    });
    act(() => { result.current.scrollerRef(root); });
    flushFrame();
    act(() => { result.current.handlers.onWheel({ deltaY: -100 } as WheelEvent); });
    scroll(root, 700);

    rerender({ content: 'two' });
    // The browser can move the viewport before delivering its next scroll event.
    root.scrollTop = 650;
    flushFrame();
    scroll(root);

    expect(root.scrollTop).toBe(650);
  });

  it('keeps the latest reading position after momentum scrolls without another wheel event', () => {
    const { root } = scroller();
    const { result, rerender } = renderHook(({ content }) => useTimelineReading('reading-momentum', content), {
      initialProps: { content: 'one' }
    });
    act(() => { result.current.scrollerRef(root); });
    flushFrame();

    act(() => { result.current.handlers.onWheel({ deltaY: -100 } as WheelEvent); });
    scroll(root, 700);
    scroll(root, 650);
    scroll(root, 600);
    rerender({ content: 'two' });
    flushFrame();

    expect(root.scrollTop).toBe(600);
    expect(result.current.free).toBe(true);
  });

  it.each(['wheel', 'keyboard', 'touch', 'scrollbar'])('resumes following when %s scrolling reaches the bottom over multiple frames', input => {
    const { root } = scroller();
    const { result, rerender } = renderHook(({ content }) => useTimelineReading(`reading-return-${input}`, content), {
      initialProps: { content: 'one' }
    });
    act(() => { result.current.scrollerRef(root); });
    act(() => { result.current.handlers.onWheel({ deltaY: -200 } as WheelEvent); });
    scroll(root, 600);
    rerender({ content: 'two' });
    expect(result.current.hasNewContent).toBe(true);

    act(() => {
      if (input === 'wheel') result.current.handlers.onWheel({ deltaY: 100 } as WheelEvent);
      else if (input === 'keyboard') result.current.handlers.onKeyDown({ key: 'End' } as KeyboardEvent);
      else if (input === 'touch') {
        result.current.handlers.onTouchStart({ touches: [{ clientY: 200 }] } as unknown as TouchEvent);
        result.current.handlers.onTouchMove({ touches: [{ clientY: 100 }] } as unknown as TouchEvent);
      } else result.current.handlers.onPointerDown();
    });
    scroll(root, 700);
    expect(result.current.free).toBe(true);
    // Pointer release can precede the remaining momentum scroll events.
    act(() => { window.dispatchEvent(new Event('pointerup')); });
    scroll(root, 760);
    expect(result.current.free).toBe(true);
    scroll(root, 800);

    expect(result.current.free).toBe(false);
    expect(result.current.hasNewContent).toBe(false);
  });

  it('does not resume following for layout changes after downward scrolling has ended', () => {
    const { root } = scroller();
    const { result } = renderHook(() => useTimelineReading('reading-scroll-ended', 'initial'));
    act(() => { result.current.scrollerRef(root); });
    act(() => { result.current.handlers.onWheel({ deltaY: -200 } as WheelEvent); });
    scroll(root, 600);
    act(() => { result.current.handlers.onWheel({ deltaY: 100 } as WheelEvent); });
    scroll(root, 700);
    act(() => { root.dispatchEvent(new Event('scrollend')); });
    scroll(root, 800);

    expect(result.current.free).toBe(true);
  });

  it('keeps following when an upward wheel cannot move the conversation', () => {
    const root = document.createElement('div');
    Object.defineProperties(root, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 200 }
    });
    document.body.append(root);
    const { result } = renderHook(() => useTimelineReading('reading-no-overflow', 'initial'));
    act(() => { result.current.scrollerRef(root); });
    flushFrame();

    act(() => { result.current.handlers.onWheel({ deltaY: -8 } as WheelEvent); });
    expect(result.current.free).toBe(false);
  });

  it('离开会话保存 Virtuoso 快照，数据窗口变化时仅提供消息定位', () => {
    const { root } = scroller();
    const snapshot = { ranges: [{ startIndex: 0, endIndex: 0, size: 100 }], scrollTop: 700 };
    const getState = vi.fn(callback => callback(snapshot));
    const virtuosoRef = { current: { getState } } as unknown as import('react').RefObject<import('react-virtuoso').VirtuosoHandle>;
    const { result, rerender } = renderHook(({ key, content, itemKeys }) => useTimelineReading(key, content, undefined, { virtuosoRef, itemKeys }), {
      initialProps: { key: 'reading-a', content: 'a-1', itemKeys: ['older', 'anchor-a'] }
    });
    act(() => { result.current.scrollerRef(root); });
    act(() => { result.current.handlers.onWheel({ deltaY: -100 } as WheelEvent); });
    scroll(root, 700);
    rerender({ key: 'reading-a', content: 'a-2', itemKeys: ['older', 'anchor-a'] });
    expect(result.current.hasNewContent).toBe(true);

    rerender({ key: 'reading-b', content: 'b-1', itemKeys: ['anchor-b'] });
    expect(result.current.free).toBe(false);
    expect(result.current.hasNewContent).toBe(false);
    expect(getState).toHaveBeenCalledTimes(1);
    rerender({ key: 'reading-a', content: 'a-2', itemKeys: ['older', 'anchor-a'] });
    expect(result.current.free).toBe(true);
    expect(result.current.restoreStateFrom).toEqual(snapshot);
    expect(result.current.savedAnchor).toEqual({ id: 'anchor-a', offset: 100 });

    rerender({ key: 'reading-b', content: 'b-1', itemKeys: ['anchor-b'] });
    rerender({ key: 'reading-a', content: 'a-2', itemKeys: ['anchor-a'] });
    expect(result.current.restoreStateFrom).toBeUndefined();
    expect(result.current.savedAnchor).toEqual({ id: 'anchor-a', offset: 100 });
    // 阅读状态与位置快照本身不会写入 scroller 的位置。
    expect(root.scrollTop).toBe(700);
    rerender({ key: 'reading-b', content: 'b-1', itemKeys: ['anchor-b'] });
    rerender({ key: 'reading-a', content: 'changed', itemKeys: ['older', 'anchor-a'] });
    expect(result.current.restoreStateFrom).toBeUndefined();
  });

  it('轻微上滚、触摸上翻及程序导航不会因接近底部重新跟随', () => {
    const { root } = scroller();
    const { result } = renderHook(() => useTimelineReading('reading-gestures', 'initial'));
    act(() => { result.current.scrollerRef(root); });
    flushFrame();

    act(() => { result.current.handlers.onWheel({ deltaY: -1 } as WheelEvent); });
    scroll(root);
    expect(result.current.free).toBe(true);
    act(() => { result.current.follow(); });
    flushFrame();

    act(() => {
      result.current.handlers.onTouchStart({ touches: [{ clientY: 100 }] } as unknown as TouchEvent);
      result.current.handlers.onTouchMove({ touches: [{ clientY: 101 }] } as unknown as TouchEvent);
    });
    scroll(root);
    expect(result.current.free).toBe(true);
    act(() => { result.current.follow(); });
    flushFrame();

    act(() => { result.current.navigate(); });
    scroll(root);
    expect(result.current.free).toBe(true);
  });

  it('只有主动向下滚至真正末尾才恢复跟随，布局补偿不冒充用户滚动', () => {
    const { root } = scroller();
    const { result, rerender } = renderHook(({ content }) => useTimelineReading('reading-bottom', content), {
      initialProps: { content: 'one' }
    });
    act(() => { result.current.scrollerRef(root); });
    flushFrame();
    act(() => { result.current.handlers.onKeyDown({ key: 'PageUp' } as KeyboardEvent); });
    scroll(root, 790);
    expect(result.current.free).toBe(true);

    act(() => { result.current.handlers.onKeyDown({ key: 'ArrowDown' } as KeyboardEvent); });
    rerender({ content: 'two' });
    flushFrame();
    scroll(root);
    expect(result.current.free).toBe(true);
    expect(result.current.hasNewContent).toBe(true);

    act(() => { result.current.handlers.onWheel({ deltaY: 10 } as WheelEvent); });
    scroll(root, 800);
    expect(result.current.free).toBe(false);
    expect(result.current.hasNewContent).toBe(false);
  });
});
