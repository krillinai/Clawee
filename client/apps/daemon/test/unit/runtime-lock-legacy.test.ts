import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireRuntimeLock } from '../../src/runtime-lock.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createServer: vi.fn()
}));

let tempDir = '';
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  vi.mocked(createServer).mockReturnValue({
    once: vi.fn(),
    listen: (_options: unknown, ready: () => void) => ready(),
    unref: vi.fn(),
    close: (closed: () => void) => closed()
  } as unknown as ReturnType<typeof createServer>);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', platformDescriptor);
  if (tempDir.length > 0) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Legacy Runtime owner diagnostics', () => {
  it('refuses a live Windows daemon using the previous lease port range', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const path = createLegacyLock();
    writeFileSync(`${path}.json`, JSON.stringify({
      version: 2, pid: 43119, instanceId: randomUUID(),
      dataDir: realpathSync(tempDir).toLowerCase(), leasePort: 59_999
    }));
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: JSON.stringify('"C:\\Clawee\\resources\\daemon\\dist\\main.js"')
    } as ReturnType<typeof spawnSync>);
    await expect(acquireRuntimeLock(tempDir)).rejects.toMatchObject({
      code: 'DAEMON_DATA_DIR_IN_USE', details: { reason: 'legacy-daemon-command', ownerPid: 43119 }
    });
    expect(readFileSync(path, 'utf8')).toBe('43119\n');
  });

  it.each(['win32', 'darwin'] as const)('refuses a verified legacy daemon on %s', async platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    const path = createLegacyLock();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const command = platform === 'win32'
      ? '"C:\\Clawee\\resources\\daemon\\dist\\main.js"'
      : '/Applications/Clawee.app/Contents/Resources/daemon/dist/main.js';
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: platform === 'win32' ? JSON.stringify(command) : command } as ReturnType<typeof spawnSync>);
    await expect(acquireRuntimeLock(tempDir)).rejects.toMatchObject({
      code: 'DAEMON_DATA_DIR_IN_USE', details: { reason: 'legacy-daemon-command', ownerPid: 43119 }
    });
    expect(readFileSync(path, 'utf8')).toBe('43119\n');
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(43119, 0);
    if (platform === 'win32') expect(spawnSync).toHaveBeenCalledWith('powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive']), expect.objectContaining({ windowsHide: true, timeout: 2_000 }));
  });

  it('does not delete a legacy lock when process inspection is unavailable', async () => {
    const path = createLegacyLock();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as ReturnType<typeof spawnSync>);
    await expect(acquireRuntimeLock(tempDir)).rejects.toMatchObject({
      code: 'DAEMON_DATA_DIR_LOCK_UNVERIFIED', details: { reason: 'legacy-owner-identity-unavailable' }
    });
    expect(readFileSync(path, 'utf8')).toBe('43119\n');
  });

  it('treats EPERM as unknown rather than as a dead owner', async () => {
    const path = createLegacyLock();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    await expect(acquireRuntimeLock(tempDir)).rejects.toMatchObject({
      code: 'DAEMON_DATA_DIR_LOCK_UNVERIFIED', details: { systemCode: 'EPERM' }
    });
    expect(readFileSync(path, 'utf8')).toBe('43119\n');
    expect(kill).toHaveBeenCalledExactlyOnceWith(43119, 0);
  });

  it('fails closed for a damaged lock instead of assuming no owner exists', async () => {
    const path = createLegacyLock();
    writeFileSync(path, 'invalid');
    await expect(acquireRuntimeLock(tempDir)).rejects.toMatchObject({
      code: 'DAEMON_DATA_DIR_LOCK_UNVERIFIED', details: { reason: 'invalid-lock-pid' }
    });
    expect(readFileSync(path, 'utf8')).toBe('invalid');
  });
});

function createLegacyLock(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-legacy-lock-'));
  const path = join(tempDir, 'clawee-runtime.lock');
  writeFileSync(path, '43119\n');
  return path;
}
