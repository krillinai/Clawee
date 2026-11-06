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
    expect(readDesktopHostBridge()?.selectContextDirectory).toBeUndefined();
    expect(readDesktopHostBridge()?.exportDiagnostics).toBeUndefined();
    expect(readDesktopHostBridge()?.testUpdate).toBeUndefined();
    expect(readDesktopHostBridge()?.openFile).toBeUndefined();
  });

  it('透传客户端安装目录', () => {
    window.claweeDesktop = {
      ...baseApi(),
      installationDirectory: '/Applications/Clawee.app'
    };
    expect(readDesktopHostBridge()?.installationDirectory).toBe('/Applications/Clawee.app');
  });

  it('原文档路径通过原生边界传递并保留系统错误', async () => {
    const path = "/Users/test/培训方案 O'Brien.pptx";
    const openFile = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: false, code: 'FAILED', message: '无法使用默认应用打开' }));
    window.claweeDesktop = { ...baseApi(), openFile };
    await expect(readDesktopHostBridge()!.openFile!(path)).resolves.toMatchObject({ ok: false, message: '无法使用默认应用打开' });
    expect(openFile).toHaveBeenCalledExactlyOnceWith(path);
  });

  it('升级测试只传递模拟版本和取消操作，不允许前端传入包地址', async () => {
    const testUpdate = vi.fn(async (_version: string): Promise<HostBridgeResult> => ({ ok: true }));
    const cancelUpdateTest = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }));
    window.claweeDesktop = { ...baseApi(), testUpdate, cancelUpdateTest };
    const bridge = readDesktopHostBridge()!;
    await expect(bridge.testUpdate!('1.0.19')).resolves.toEqual({ ok: true });
    await expect(bridge.cancelUpdateTest!()).resolves.toEqual({ ok: true });
    expect(testUpdate).toHaveBeenCalledExactlyOnceWith('1.0.19');
    expect(cancelUpdateTest).toHaveBeenCalledOnce();
  });

  it('诊断导出通过原生边界，保留取消结果', async () => {
    const exportDiagnostics = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: false, code: 'FAILED', message: '已取消导出' }));
    window.claweeDesktop = { ...baseApi(), exportDiagnostics };
    await expect(readDesktopHostBridge()!.exportDiagnostics!()).resolves.toMatchObject({ message: '已取消导出' });
    expect(exportDiagnostics).toHaveBeenCalledOnce();
  });

  it('通过原生边界选择参考文件夹并保留取消结果', async () => {
    const selectContextDirectory = vi.fn().mockResolvedValueOnce('C:\\资料').mockResolvedValueOnce(null);
    window.claweeDesktop = { ...baseApi(), selectContextDirectory };
    const bridge = readDesktopHostBridge()!;
    await expect(bridge.selectContextDirectory!()).resolves.toBe('C:\\资料');
    await expect(bridge.selectContextDirectory!()).resolves.toBeNull();
    expect(selectContextDirectory).toHaveBeenCalledTimes(2);
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
