import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportDesktopDiagnostics } from '../src/main/diagnostics.js';

describe('Desktop diagnostics', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  it('exports bounded, redacted lifecycle and desktop logs without a running daemon', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clawee-diagnostics-'));
    directories.push(directory);
    const dataDir = join(directory, 'daemon');
    const logDir = join(directory, 'logs');
    await mkdir(dataDir);
    await mkdir(logDir);
    await writeFile(join(dataDir, 'daemon-lifecycle.log'), '{"event":"DAEMON_SHUTDOWN_STARTED","reason":"parent-heartbeat-timeout"}\n');
    await writeFile(join(logDir, 'desktop-main.log'), 'old-record\n'.repeat(40000)
      + '{"message":"Runtime proxy request failed","details":{"token":"private-value"}}\n');
    await writeFile(join(directory, 'private.txt'), 'must-not-export');
    // Windows 使用无需管理员权限的目录联接，仍验证链接目标不会被导出。
    await symlink(
      process.platform === 'win32' ? directory : join(directory, 'private.txt'),
      join(logDir, 'desktop-main.log.1'),
      process.platform === 'win32' ? 'junction' : 'file'
    );
    let writtenPayload = '';

    await expect(exportDesktopDiagnostics({
      state: { phase: 'failed', startedAt: '', updatedAt: '', attempt: 1 },
      dataDir,
      logDir,
      dependencies: {
        showSaveDialog: async () => ({ canceled: false, filePath: join(directory, 'diagnostics.json') }),
        getAppVersion: () => '0.1.8',
        writeFile: async (_path, contents) => { writtenPayload = contents; },
        now: () => new Date('2026-10-16T00:00:00.000Z')
      }
    })).resolves.toEqual({ ok: true });

    const payload = JSON.parse(writtenPayload);
    expect(payload.daemonPid).toBeNull();
    expect(payload.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'daemon-lifecycle.log', missing: false,
        content: expect.stringContaining('parent-heartbeat-timeout') }),
      expect.objectContaining({ source: 'desktop-main.log', missing: false, truncated: true,
        content: expect.stringContaining('Runtime proxy request failed') }),
      expect.objectContaining({ source: 'desktop-main.log.1', missing: true, content: '' })
    ]));
    expect(Buffer.byteLength(writtenPayload)).toBeLessThan(1024 * 1024);
    expect(writtenPayload).not.toContain('private-value');
    expect(writtenPayload).not.toContain('must-not-export');
  });

  it('recursively redacts the final payload before writing', async () => {
    let writtenPayload = '';

    await expect(exportDesktopDiagnostics({
      state: {
        phase: 'failed',
        startedAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
        attempt: 1,
        error: {
          code: 'TEST',
          message: 'Authorization: Bearer secret-value'
        }
      },
      dataDir: '/tmp/TOKEN=secret-value/data',
      logDir: '/tmp/logs',
      dependencies: {
        showSaveDialog: vi.fn(async () => ({
          canceled: false,
          filePath: '/tmp/diagnostics.json'
        })),
        getAppVersion: () => '0.1.0',
        writeFile: async (_path, contents) => {
          writtenPayload = contents;
        },
        now: () => new Date('2026-07-16T00:00:00.000Z')
      }
    })).resolves.toEqual({ ok: true });

    const payload = writtenPayload;
    expect(payload).not.toContain('secret-value');
    expect(payload).toContain('[REDACTED]');
    expect(payload).toContain('/tmp/');
    expect(JSON.parse(payload).logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'daemon-lifecycle.log', missing: true })
    ]));
  });

  it('does not write when the user cancels the export', async () => {
    const writeFile = vi.fn(async (
      _path: string,
      _contents: string,
      _options: { mode: number }
    ) => undefined);
    const result = await exportDesktopDiagnostics({
      state: {
        phase: 'idle',
        startedAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
        attempt: 0
      },
      dataDir: '/tmp/data',
      logDir: '/tmp/logs',
      dependencies: {
        showSaveDialog: vi.fn(async () => ({ canceled: true })),
        getAppVersion: () => '0.1.0',
        writeFile,
        now: () => new Date('2026-07-16T00:00:00.000Z')
      }
    });

    expect(result).toMatchObject({ ok: false });
    expect(writeFile).not.toHaveBeenCalled();
  });
});
