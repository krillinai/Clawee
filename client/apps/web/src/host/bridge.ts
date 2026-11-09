import type { ConnectionConfig } from '../runtime/types.js';
import type { DesktopUpdateState } from '@clawee/protocol';

export type HostBridgeResult = { ok: true } | { ok: false; code: 'UNSUPPORTED' | 'FAILED'; message: string };

export type HostNotification = {
  title: string;
  body: string;
  threadId?: string;
  runId?: string;
  approvalId?: string;
};

export type BackgroundNotificationConfiguration =
  | { enabled: false }
  | { enabled: true };

export type DesktopPreferences = {
  closeBehavior: 'hide' | 'quit';
};

export type DesktopPlatform = 'darwin' | 'win32' | 'linux';
export type ProjectDirectorySelectionPurpose = 'add' | 'create' | 'replace';

export type HostWindowChrome = {
  integratedTitleBar: true;
  titleBarHeight: number;
  trafficLightInset: number;
};

export type HostBridge = {
  kind: 'browser' | 'desktop';
  platform?: DesktopPlatform;
  installationDirectory?: string | null;
  windowChrome?: HostWindowChrome;
  readConnectionConfig(): Promise<ConnectionConfig | null>;
  openExternal(url: string): Promise<void>;
  openFile?(path: string): Promise<HostBridgeResult>;
  revealPath(path: string): Promise<HostBridgeResult>;
  notify(message: HostNotification): Promise<void>;
  configureBackgroundNotifications?(
    configuration: BackgroundNotificationConfiguration
  ): Promise<HostBridgeResult>;
  subscribeConnectionConfig?(
    listener: (connection: ConnectionConfig | null) => void
  ): () => void;
  restartRuntime?(): Promise<HostBridgeResult>;
  exportDiagnostics?(): Promise<HostBridgeResult>;
  readDesktopPreferences?(): Promise<DesktopPreferences>;
  updateDesktopPreferences?(
    preferences: Partial<DesktopPreferences>
  ): Promise<DesktopPreferences>;
  selectProjectDirectory?(
    purpose?: ProjectDirectorySelectionPurpose
  ): Promise<string | null>;
  selectContextDirectory?(): Promise<string | null>;
  resolveDroppedFilePath?(file: File): string | null;
  readUpdateState?(): Promise<DesktopUpdateState>;
  subscribeUpdateState?(listener: (state: DesktopUpdateState) => void): () => void;
  checkForUpdates?(): Promise<HostBridgeResult>;
  deferUpdate?(): Promise<HostBridgeResult>;
  acknowledgeUpdateQuiescence?(updateId: string, busy?: boolean): Promise<void>;
  downloadUpdate?(): Promise<HostBridgeResult>;
  installUpdate?(): Promise<HostBridgeResult>;
  testUpdate?(simulatedVersion: string): Promise<HostBridgeResult>;
  cancelUpdateTest?(): Promise<HostBridgeResult>;
};
