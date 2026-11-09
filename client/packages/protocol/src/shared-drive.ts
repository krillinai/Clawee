/** 网盘真实文件回执，可用于普通任务交付。 */
export type SharedDriveArtifact = {
  space_id: string;
  file_id: string;
  logical_path: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  revision: number;
  sha256: string;
};

export type SharedDriveTransferError = { file_name: string; code: string; message: string };
export type SharedDriveUploadItem = {
  path: string;
  spaceId?: string;
  logicalPath: string;
  /** 最近一次尝试的状态；重试失败时仍保留已有成功回执。 */
  status: 'pending' | 'uploaded' | 'failed';
  artifact?: SharedDriveArtifact;
  error?: SharedDriveTransferError;
};
export type SharedDriveDownloadItem = {
  artifact: SharedDriveArtifact;
  status: 'pending' | 'downloaded' | 'failed';
  relativePath?: string;
  error?: SharedDriveTransferError;
};
export type SharedDriveState = {
  uploads: SharedDriveUploadItem[];
  downloads: SharedDriveDownloadItem[];
  remoteDeliveries?: Array<{
    taskId: string;
    status: 'none' | 'complete' | 'incomplete';
    errors: SharedDriveTransferError[];
  }>;
};
