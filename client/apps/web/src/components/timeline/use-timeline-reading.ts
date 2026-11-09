import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { StateSnapshot, VirtuosoHandle } from 'react-virtuoso';

type Anchor = { id: string; offset: number };
type ReadingState = {
  mode: 'follow' | 'free';
  anchor?: Anchor;
  snapshot?: StateSnapshot;
  itemKeys?: string[];
  contentVersion?: unknown;
};
type ListState = { virtuosoRef: RefObject<VirtuosoHandle>; itemKeys: string[] };
const savedReading = new Map<string, ReadingState>();

export function useTimelineReading(key: string | undefined, contentVersion: unknown, target?: string, list?: ListState) {
  const saved = key === undefined ? undefined : savedReading.get(key);
  const mode = useRef<'follow' | 'free'>(target === undefined ? saved?.mode ?? 'follow' : 'free');
  const scroller = useRef<HTMLElement>();
  const [element, setElement] = useState<HTMLElement>();
  const [free, setFree] = useState(mode.current === 'free');
  const [hasNewContent, setHasNewContent] = useState(false);
  const gesture = useRef<'up' | 'down'>();
  const dragging = useRef(false);
  const lastTop = useRef(0);
  const touchY = useRef<number>();
  const committed = useRef({ list, contentVersion });
  const previousContent = useRef(contentVersion);

  const release = useCallback(() => {
    gesture.current = 'up';
    mode.current = 'free';
    setFree(true);
  }, []);

  useLayoutEffect(() => {
    const next = key === undefined ? undefined : savedReading.get(key);
    mode.current = target === undefined ? next?.mode ?? 'follow' : 'free';
    gesture.current = undefined;
    dragging.current = false;
    touchY.current = undefined;
    previousContent.current = contentVersion;
    setFree(mode.current === 'free');
    setHasNewContent(false);
    return () => {
      if (key !== undefined && scroller.current !== undefined) {
        if (savedReading.size >= 100) savedReading.delete(savedReading.keys().next().value!);
        const state: ReadingState = {
          mode: mode.current,
          itemKeys: committed.current.list?.itemKeys,
          contentVersion: committed.current.contentVersion
        };
        // 仅离开会话时读取一次可见项，供历史窗口变化时按消息定位。
        const root = scroller.current;
        if (mode.current === 'free') {
          const top = root.getBoundingClientRect().top;
          const item = [...root.querySelectorAll<HTMLElement>('[data-timeline-id]')]
            .find(node => node.getBoundingClientRect().bottom > top + 1);
          if (item !== undefined) state.anchor = { id: item.dataset.timelineId!, offset: item.getBoundingClientRect().top - top };
          committed.current.list?.virtuosoRef.current?.getState(snapshot => {
            state.snapshot = {
              ...snapshot,
              // 离开前的原生 scroll 事件可能尚未派发，使用当前视口位置。
              scrollTop: root.scrollTop - (root.querySelector('.timeline-load-older')?.getBoundingClientRect().height ?? 0)
            };
          });
        }
        savedReading.set(key, state);
      }
    };
  }, [key]);

  useLayoutEffect(() => { committed.current = { list, contentVersion }; });

  useLayoutEffect(() => {
    if (previousContent.current !== contentVersion && mode.current === 'free') setHasNewContent(true);
    previousContent.current = contentVersion;
  }, [contentVersion]);

  useEffect(() => {
    if (element === undefined) return;
    const scroll = () => {
      const top = element.scrollTop;
      if (dragging.current && top < lastTop.current) release();
      else if (dragging.current && top > lastTop.current) gesture.current = 'down';
      if (gesture.current === 'down' && top > lastTop.current && element.scrollHeight - top - element.clientHeight <= 12) {
        mode.current = 'follow'; setFree(false); setHasNewContent(false);
      }
      lastTop.current = top;
    };
    // 惯性和平滑滚动会在同一次手势后继续派发多帧 scroll。
    const scrollEnd = () => { gesture.current = undefined; };
    element.addEventListener('scroll', scroll, { passive: true });
    element.addEventListener('scrollend', scrollEnd);
    const pointerUp = () => { dragging.current = false; };
    window.addEventListener('pointerup', pointerUp);
    return () => {
      element.removeEventListener('scroll', scroll);
      element.removeEventListener('scrollend', scrollEnd);
      window.removeEventListener('pointerup', pointerUp);
    };
  }, [element, release]);

  const wheel = (deltaY: number) => {
    if (deltaY < 0) {
      const root = scroller.current;
      if (root === undefined || root.scrollHeight > root.clientHeight + 1) release();
    } else if (deltaY > 0) {
      gesture.current = 'down';
    }
  };

  return {
    mode, free, hasNewContent,
    restoreStateFrom: saved?.mode === 'free' && saved.contentVersion === contentVersion && list !== undefined
      && saved.itemKeys?.length === list.itemKeys.length
      && saved.itemKeys.every((id, index) => id === list.itemKeys[index]) ? saved.snapshot : undefined,
    savedAnchor: saved?.mode === 'free' ? saved.anchor : undefined,
    scrollerRef: useCallback((node: HTMLElement | Window | null) => {
      const next = node instanceof HTMLElement ? node : undefined;
      scroller.current = next; setElement(next);
    }, []),
    navigate: release, wheel,
    follow() { gesture.current = undefined; mode.current = 'follow'; setFree(false); setHasNewContent(false); },
    handlers: {
      onWheel(event: React.WheelEvent) { wheel(event.deltaY); },
      onTouchStart(event: React.TouchEvent) { touchY.current = event.touches[0]?.clientY; },
      onTouchMove(event: React.TouchEvent) {
        const next = event.touches[0]?.clientY;
        if (next !== undefined && touchY.current !== undefined) {
          if (next > touchY.current) release();
          else if (next < touchY.current) gesture.current = 'down';
        }
        touchY.current = next;
      },
      onKeyDown(event: React.KeyboardEvent) {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) release();
        else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) gesture.current = 'down';
      },
      onPointerDown() { dragging.current = true; gesture.current = undefined; }
    }
  };
}
