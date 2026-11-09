import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import {
  DebouncedWindowStateWriter,
  nativePageZoomFactor,
  nativeWindowChromeOptions,
  WindowManager
} from '../src/main/window-manager.js';

const windowMocks = vi.hoisted(() => ({
  hide: vi.fn(), show: vi.fn(), focus: vi.fn(), loadURL: vi.fn(),
  on: vi.fn(), isDestroyed: () => false,
  isMinimized: () => false, isMaximized: () => false,
  getBounds: () => ({ width: 1280, height: 820 }),
  webContents: {
    setZoomFactor: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn(),
    getURL: vi.fn(() => 'clawee-app://app/index.html'), isDestroyed: vi.fn(() => false), isCrashed: vi.fn(() => false)
  }
}));
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function () { return windowMocks; }),
  screen: {}, shell: {}
}));

beforeEach(() => { vi.clearAllMocks(); });

describe('窗口退出', () => {
  it('仅仍存活的工作台需要编辑确认，启动失败页与崩溃渲染进程不阻止修复更新', () => {
    const manager = new WindowManager({
      preloadPath: '', development: false, appEntryAt: 0, requestQuit: vi.fn(),
      settings: { read: () => ({ closeBehavior: 'hide', notificationsEnabled: true }), update: vi.fn(), flush: vi.fn() }
    });
    expect(manager.hasWorkspace).toBe(false);
    manager.create();
    expect(manager.hasWorkspace).toBe(true);
    windowMocks.webContents.isCrashed.mockReturnValueOnce(true);
    expect(manager.hasWorkspace).toBe(false);
    windowMocks.webContents.getURL.mockReturnValueOnce('clawee-app://bootstrap/index.html');
    expect(manager.hasWorkspace).toBe(false);
    expect(manager.hasWorkspace).toBe(true);
  });

  it.each(['hide', 'quit'] as const)('原生更新关窗前放行关闭，取消安装后恢复 %s 行为', closeBehavior => {
    const requestQuit = vi.fn();
    const manager = new WindowManager({
      preloadPath: '', development: false, appEntryAt: 0, requestQuit,
      settings: {
        read: () => ({ closeBehavior, notificationsEnabled: true }),
        update: vi.fn(), flush: vi.fn()
      }
    });
    manager.create();
    const close = windowMocks.on.mock.calls.find(([event]) => event === 'close')![1] as (event: { preventDefault(): void }) => void;
    const event = { preventDefault: vi.fn() };
    manager.beginQuit();
    close(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(requestQuit).not.toHaveBeenCalled();
    manager.cancelQuit();
    close(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(requestQuit).toHaveBeenCalledTimes(closeBehavior === 'quit' ? 1 : 0);
    manager.show();
    expect(windowMocks.show).toHaveBeenCalledOnce();
  });

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

describe('PDF 预览窗口', () => {
  it('开启内置查看器并保留渲染进程隔离', () => {
    const manager = new WindowManager({
      preloadPath: '', development: false, appEntryAt: 0, requestQuit: vi.fn(),
      settings: {
        read: () => ({ closeBehavior: 'hide', notificationsEnabled: true }),
        update: vi.fn(), flush: vi.fn()
      }
    });
    manager.create();
    expect(BrowserWindow).toHaveBeenLastCalledWith(expect.objectContaining({
      webPreferences: expect.objectContaining({
        plugins: true, nodeIntegration: false, contextIsolation: true, sandbox: true,
        additionalArguments: ['--clawee-packaged']
      })
    }));
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
