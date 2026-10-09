export type DesktopUpdateState = {
  supported: boolean;
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  currentVersion: string;
  version?: string;
  notes?: string;
  progress?: number;
  error?: string;
};
