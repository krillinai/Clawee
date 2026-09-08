import type { ConnectionConfig } from '../runtime/types.js';
import type {
  DesktopPlatform,
  HostBridge,
  HostBridgeResult,
  HostNotification,
  ProjectDirectorySelectionPurpose
} from './bridge.js';

type DesktopApi = {
  kind: 'desktop';
  platform: DesktopPlatform;
  windowChrome?: {
    integratedTitleBar: boolean;
    titleBarHeight?: number;
    trafficLightInset?: number;
  };
  readConnectionConfig(): Promise<ConnectionConfig | null>;
  subscribeConnectionConfig(
    listener: (connection: ConnectionConfig | null) => void
  ): () => void;
  restartRuntime(): Promise<HostBridgeResult>;
  reloadWorkspace(): Promise<HostBridgeResult>;
  workspaceReady(): void;
  readDesktopPreferences(): Promise<{
    closeBehavior: 'hide' | 'quit';
  }>;
  updateDesktopPreferences(preferences: {
    closeBehavior?: 'hide' | 'quit';
  }): Promise<{
    closeBehavior: 'hide' | 'quit';
  }>;
  selectProjectDirectory(
    purpose?: ProjectDirectorySelectionPurpose
  ): Promise<string | null>;
  resolveDroppedFilePath(file: File): string | null;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<HostBridgeResult>;
  notify(message: HostNotification): Promise<void>;
  configureBackgroundNotifications(
    configuration: { enabled: boolean }
  ): Promise<HostBridgeResult>;
  subscribeNavigation(listener: (route: string) => void): () => void;
};

declare global {
  interface Window {
    claweeDesktop?: DesktopApi;
  }
}

export type DesktopHostBridge = HostBridge & {
  kind: 'desktop';
  platform: DesktopPlatform;
  subscribeConnectionConfig(
    listener: (connection: ConnectionConfig | null) => void
  ): () => void;
  restartRuntime(): Promise<HostBridgeResult>;
};

export function readDesktopHostBridge(): DesktopHostBridge | undefined {
  const api = window.claweeDesktop;
  if (
    api?.kind !== 'desktop'
    || !isDesktopPlatform(api.platform)
  ) return undefined;
  const windowChrome = api.windowChrome?.integratedTitleBar === true
    && typeof api.windowChrome.titleBarHeight === 'number'
    && typeof api.windowChrome.trafficLightInset === 'number'
    ? {
        integratedTitleBar: true as const,
        titleBarHeight: api.windowChrome.titleBarHeight,
        trafficLightInset: api.windowChrome.trafficLightInset
      }
    : undefined;
  return {
    kind: 'desktop',
    platform: api.platform,
    ...(windowChrome === undefined ? {} : { windowChrome }),
    readConnectionConfig: () => api.readConnectionConfig(),
    subscribeConnectionConfig: listener => api.subscribeConnectionConfig(listener),
    restartRuntime: () => api.restartRuntime(),
    readDesktopPreferences: () => api.readDesktopPreferences(),
    updateDesktopPreferences: preferences =>
      api.updateDesktopPreferences(preferences),
    selectProjectDirectory: purpose => api.selectProjectDirectory(purpose),
    resolveDroppedFilePath: file => api.resolveDroppedFilePath(file),
    openExternal: url => api.openExternal(url),
    revealPath: path => api.revealPath(path),
    notify: message => api.notify(message),
    configureBackgroundNotifications: configuration =>
      api.configureBackgroundNotifications(configuration)
  };
}

function isDesktopPlatform(value: unknown): value is DesktopPlatform {
  return value === 'darwin' || value === 'win32' || value === 'linux';
}

export function subscribeDesktopNavigation(listener: (route: string) => void): () => void {
  return window.claweeDesktop?.subscribeNavigation(listener) ?? (() => undefined);
}

export function signalDesktopWorkspaceReady(): void {
  window.claweeDesktop?.workspaceReady();
}
