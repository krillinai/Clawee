import { describe, expect, it, vi } from 'vitest';
import {
  DebouncedWindowStateWriter,
  nativePageZoomFactor,
  nativeWindowChromeOptions,
  WindowManager
} from '../src/main/window-manager.js';

const windowMocks = vi.hoisted(() => ({
  hide: vi.fn(), show: vi.fn(), loadURL: vi.fn(),
  on: vi.fn(), isDestroyed: () => false,
  isMinimized: () => false, isMaximized: () => false,
  getBounds: () => ({ width: 1280, height: 820 }),
  webContents: {
    setZoomFactor: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn()
  }
}));
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function () { return windowMocks; }),
  screen: {}, shell: {}
}));

describe('窗口退出', () => {
  it('立即隐藏窗口，且退出期间不再显示或加载启动页', async () => {
    const update = vi.fn(() => ({ closeBehavior: 'hide' as const, notificationsEnabled: true }));
    const manager = new WindowManager({
      preloadPath: '', development: false, appEntryAt: 0, requestQuit: vi.fn(),
      settings: {
        read: () => ({ closeBehavior: 'hide', notificationsEnabled: true }),
        update, flush: vi.fn()
      }
    });
    manager.create();
    manager.beginQuit();
    expect(update).toHaveBeenCalledOnce();
    expect(windowMocks.hide).toHaveBeenCalledOnce();
    manager.show();
    await manager.loadBootstrap();
    expect(windowMocks.show).not.toHaveBeenCalled();
    expect(windowMocks.loadURL).not.toHaveBeenCalled();
  });
});

describe('Window state debounce', () => {
  it('coalesces move and resize bursts and flushes the final state', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const writer = new DebouncedWindowStateWriter(write, 300);

    for (let index = 0; index < 20; index += 1) writer.schedule();
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(write).not.toHaveBeenCalled();
    writer.flush();
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('Native page zoom', () => {
  it('resets persisted Chromium zoom on Windows only', () => {
    expect(nativePageZoomFactor('win32')).toBe(1);
    expect(nativePageZoomFactor('darwin')).toBeUndefined();
    expect(nativePageZoomFactor('linux')).toBeUndefined();
  });
});

describe('Native window chrome', () => {
  it('uses an inset native title bar on macOS', () => {
    expect(nativeWindowChromeOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 }
    });
  });

  it('keeps the platform title bar outside macOS', () => {
    expect(nativeWindowChromeOptions('win32')).toEqual({});
    expect(nativeWindowChromeOptions('linux')).toEqual({});
  });
});
