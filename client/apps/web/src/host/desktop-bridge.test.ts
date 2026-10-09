import type { DesktopUpdateState } from '@clawee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDesktopHostBridge } from './desktop-bridge.js';
import { browserBridge } from './browser-bridge.js';
import type { HostBridgeResult } from './bridge.js';

function baseApi(): NonNullable<typeof window.claweeDesktop> {
  return {
    ...browserBridge,
    kind: 'desktop', platform: 'darwin',
    subscribeConnectionConfig: () => () => undefined,
    restartRuntime: async () => ({ ok: true }),
    reloadWorkspace: async () => ({ ok: true }),
    workspaceReady: () => undefined,
    readDesktopPreferences: async () => ({ closeBehavior: 'hide' }),
    updateDesktopPreferences: async () => ({ closeBehavior: 'hide' }),
    selectProjectDirectory: async () => null,
    resolveDroppedFilePath: () => null,
    configureBackgroundNotifications: async () => ({ ok: true }),
    subscribeNavigation: () => () => undefined
  };
}

describe('桌面更新 Bridge', () => {
  afterEach(() => { delete window.claweeDesktop; });

  it('旧 Bridge 没有更新能力时不暴露无效方法', () => {
    window.claweeDesktop = baseApi();
    expect(readDesktopHostBridge()?.readUpdateState).toBeUndefined();
  });

  it('更新状态、订阅及操作均通过现有原生边界', async () => {
    const state: DesktopUpdateState = { supported: true, status: 'idle', currentVersion: '0.1.8' };
    const unsubscribe = vi.fn();
    const api = {
      ...baseApi(),
      readUpdateState: vi.fn(async () => state),
      subscribeUpdateState: vi.fn(() => unsubscribe),
      checkForUpdates: vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true })),
      downloadUpdate: vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true })),
      installUpdate: vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }))
    };
    window.claweeDesktop = api;
    const bridge = readDesktopHostBridge()!;
    await expect(bridge.readUpdateState!()).resolves.toEqual(state);
    const listener = vi.fn();
    expect(bridge.subscribeUpdateState!(listener)).toBe(unsubscribe);
    expect(api.subscribeUpdateState).toHaveBeenCalledWith(listener);
    await expect(bridge.checkForUpdates!()).resolves.toEqual({ ok: true });
    await expect(bridge.downloadUpdate!()).resolves.toEqual({ ok: true });
    await expect(bridge.installUpdate!()).resolves.toEqual({ ok: true });
  });
});
