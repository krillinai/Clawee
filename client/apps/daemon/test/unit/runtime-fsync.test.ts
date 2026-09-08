import { describe, expect, it, vi } from 'vitest';
import {
  flushRuntimeFileDescriptor,
  flushRuntimeFileHandle
} from '../../src/codex/runtime-fsync.js';

describe('Runtime file durability', () => {
  it('tolerates Windows EPERM from async and sync fsync calls', async () => {
    const windowsEperm = Object.assign(
      new Error('EPERM: operation not permitted, fsync'),
      { code: 'EPERM' }
    );
    const asyncFlush = vi.fn().mockRejectedValue(windowsEperm);
    const syncFlush = vi.fn(() => {
      throw windowsEperm;
    });

    await expect(flushRuntimeFileHandle(
      { sync: asyncFlush },
      'win32'
    )).resolves.toBeUndefined();
    expect(() => flushRuntimeFileDescriptor(
      1,
      'win32',
      syncFlush
    )).not.toThrow();
    expect(asyncFlush).toHaveBeenCalledOnce();
    expect(syncFlush).toHaveBeenCalledOnce();
  });

  it('does not suppress fsync failures on other platforms or error codes', async () => {
    const windowsEperm = Object.assign(
      new Error('EPERM: operation not permitted, fsync'),
      { code: 'EPERM' }
    );
    const windowsEio = Object.assign(
      new Error('EIO: input/output error, fsync'),
      { code: 'EIO' }
    );

    await expect(flushRuntimeFileHandle(
      { sync: vi.fn().mockRejectedValue(windowsEperm) },
      'linux'
    )).rejects.toBe(windowsEperm);
    expect(() => flushRuntimeFileDescriptor(
      1,
      'win32',
      () => {
        throw windowsEio;
      }
    )).toThrow(windowsEio);
  });
});
