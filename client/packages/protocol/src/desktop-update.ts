export type DesktopUpdateState = {
  supported: boolean;
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'downloaded' | 'waiting' | 'installing' | 'paused' | 'error';
  currentVersion: string;
  version?: string;
  notes?: string;
  progress?: number;
  error?: string;
  automatic?: boolean;
  gateway?: string;
  updateId?: string;
  attemptId?: string;
  errorCode?: string;
  recoveryCode?: string;
  recovery?: 'restored' | 'failed' | 'pending';
  nativePending?: boolean;
  deferredUntil?: number;
  testUnsupportedReason?: string;
  test?: {
    simulatedVersion: string;
    status: 'running' | 'waiting' | 'pending' | 'succeeded' | 'failed' | 'unsupported' | 'cancelled';
    message?: string;
  };
};

// daemon 的兜底期限短于桌面等待预算，外层保留确认和恢复时间。
export const UPDATE_DAEMON_CLEANUP_MS = 10_000;
export const UPDATE_DESKTOP_STOP_MS = 13_000;

export type DesktopUpdateConnection = {
  gateway: string;
};
