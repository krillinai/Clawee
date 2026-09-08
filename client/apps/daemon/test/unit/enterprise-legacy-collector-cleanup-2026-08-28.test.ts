import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupLegacyEnterpriseCollector } from '../../src/enterprise/legacy-collector-cleanup-2026-08-28.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('legacy enterprise collector cleanup', () => {
  it('does nothing when the managed installation is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawee-cleanup-'));
    const spawnProcess = vi.fn();

    await cleanupLegacyEnterpriseCollector({
      collectorRoot: join(root, 'collector'),
      spawn: spawnProcess as never
    });

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('runs the existing unix cleanup command and writes the marker on success', async () => {
    const root = await createManagedInstallation();
    const markerPath = join(root, 'cleanup.done');
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });

    await cleanupLegacyEnterpriseCollector({
      platform: 'linux',
      collectorRoot: join(root, 'collector'),
      markerPath,
      spawn: spawnProcess as never
    });

    const binary = join(root, 'collector', 'bin', 'clawee-collector');
    expect(spawnProcess).toHaveBeenCalledWith(binary, [
      'setup', 'unix-user', 'cleanup-runtime',
      '--binary', binary,
      '--config', join(root, 'collector', 'config.toml')
    ], {
      stdio: 'ignore',
      windowsHide: true
    });
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).not.toBe('');
  });

  it('does not throw or write a marker when cleanup fails', async () => {
    const root = await createManagedInstallation();
    const markerPath = join(root, 'cleanup.done');
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(cleanupLegacyEnterpriseCollector({
      platform: 'linux',
      collectorRoot: join(root, 'collector'),
      markerPath,
      spawn: spawnProcess as never
    })).resolves.toBeUndefined();

    expect(existsSync(markerPath)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('COLLECTOR_CLEANUP_FAILED'));
  });
});

async function createManagedInstallation(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clawee-cleanup-'));
  const collectorRoot = join(root, 'collector');
  await mkdir(join(collectorRoot, 'bin'), { recursive: true });
  await writeFile(join(collectorRoot, 'bin', 'clawee-collector'), 'collector');
  await writeFile(join(collectorRoot, 'config.toml'), 'config');
  return root;
}
