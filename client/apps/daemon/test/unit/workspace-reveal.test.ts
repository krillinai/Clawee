import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultRevealExecutor } from '../../src/workspace-files/reveal.js';

vi.mock('node:os', () => ({ platform: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn((_command: string, _args: string[], callback: (error: null) => void) => callback(null))
}));

beforeEach(() => vi.clearAllMocks());

describe('workspace reveal executor', () => {
  it.each([
    {
      mode: 'file' as const,
      absolutePath: String.raw`C:\Users\example\Default Project\中文 报告,测试.pptx`,
      expectedArgs: ['/select,', String.raw`C:\Users\example\Default Project\中文 报告,测试.pptx`]
    },
    {
      mode: 'directory' as const,
      absolutePath: String.raw`C:\Users\example\Default Project`,
      expectedArgs: [String.raw`C:\Users\example\Default Project`]
    }
  ])('reveals a Windows $mode in a visible Explorer window without waiting for its exit', async ({ mode, absolutePath, expectedArgs }) => {
    vi.mocked(platform).mockReturnValue('win32');
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await expect(defaultRevealExecutor({ absolutePath, mode })).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith('explorer.exe', expectedArgs, {
      detached: true, stdio: 'ignore', windowsHide: false
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('reports an Explorer launch failure', async () => {
    vi.mocked(platform).mockReturnValue('win32');
    const child = new EventEmitter();
    const error = new Error('Explorer could not start');
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('error', error));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await expect(defaultRevealExecutor({ absolutePath: 'C:\\workspace', mode: 'directory' })).rejects.toBe(error);
  });

  it.each(['file', 'directory'] as const)('keeps macOS %s reveal behavior', async mode => {
    vi.mocked(platform).mockReturnValue('darwin');
    await defaultRevealExecutor({ absolutePath: '/workspace/report.pptx', mode });
    expect(execFile).toHaveBeenCalledWith('open', mode === 'file' ? ['-R', '/workspace/report.pptx'] : ['/workspace/report.pptx'], expect.any(Function));
  });

  it('returns an explicit unsupported error on other platforms', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    await expect(defaultRevealExecutor({ absolutePath: '/workspace', mode: 'directory' })).rejects.toMatchObject({ code: 'REVEAL_UNAVAILABLE' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
