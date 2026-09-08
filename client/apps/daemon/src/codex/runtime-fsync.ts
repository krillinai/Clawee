import { fsyncSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

type SyncFileDescriptor = (descriptor: number) => void;

export async function flushRuntimeFileHandle(
  handle: Pick<FileHandle, 'sync'>,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (isIgnorableWindowsFsyncError(error, platform)) return;
    throw error;
  }
}

export function flushRuntimeFileDescriptor(
  descriptor: number,
  platform: NodeJS.Platform = process.platform,
  flush: SyncFileDescriptor = fsyncSync
): void {
  try {
    flush(descriptor);
  } catch (error) {
    if (isIgnorableWindowsFsyncError(error, platform)) return;
    throw error;
  }
}

function isIgnorableWindowsFsyncError(
  error: unknown,
  platform: NodeJS.Platform
): boolean {
  return (
    platform === 'win32'
    && error instanceof Error
    && (error as NodeJS.ErrnoException).code === 'EPERM'
  );
}
