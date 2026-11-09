import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

// jsdom 尚未实现当前 Electron/浏览器提供的组合取消信号。
if (typeof AbortSignal.any !== 'function') {
  Object.defineProperty(AbortSignal, 'any', {
    configurable: true,
    value(signals: AbortSignal[]) {
      const controller = new AbortController();
      const abort = () => {
        controller.abort(signals.find(signal => signal.aborted)?.reason);
        signals.forEach(signal => signal.removeEventListener('abort', abort));
      };
      signals.forEach(signal => signal.addEventListener('abort', abort, { once: true }));
      if (signals.some(signal => signal.aborted)) abort();
      return controller.signal;
    }
  });
}

Object.defineProperty(window, 'confirm', {
  configurable: true,
  writable: true,
  value: () => true
});

type RectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  toJSON(): Record<string, number>;
};

function createRect(): RectLike {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON() {
      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0
      };
    }
  };
}

function createRectList(rects: RectLike[] = []) {
  return {
    length: rects.length,
    item(index: number) {
      return rects[index] ?? null;
    },
    [Symbol.iterator]: function* iterator() {
      yield* rects;
    }
  };
}

const rangePrototype = document.createRange().constructor.prototype as Range;

if (typeof rangePrototype.getBoundingClientRect !== 'function') {
  Object.defineProperty(rangePrototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return createRect();
    }
  });
}

if (typeof rangePrototype.getClientRects !== 'function') {
  Object.defineProperty(rangePrototype, 'getClientRects', {
    configurable: true,
    value() {
      return createRectList();
    }
  });
}
