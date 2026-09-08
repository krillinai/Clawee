import { describe, expect, it, vi } from 'vitest';
import {
  createNativeProjectDirectoryPicker,
  ProjectDirectoryPickerError,
  type NativeCommandRunner
} from '../../src/projects/native-directory-picker.js';

describe('native project directory picker', () => {
  it('opens a macOS NSOpenPanel with directory-only behavior', async () => {
    const runCommand = vi.fn<NativeCommandRunner>(async () => ({
      exitCode: 0,
      stdout: '/Users/test/Projects/My Project\n',
      stderr: ''
    }));
    const picker = createNativeProjectDirectoryPicker({
      platform: 'darwin',
      homeDirectory: '/Users/test',
      runCommand
    });

    await expect(picker.selectDirectory('create'))
      .resolves.toBe('/Users/test/Projects/My Project');
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [command, args] = runCommand.mock.calls[0]!;
    expect(command).toBe('/usr/bin/osascript');
    expect(args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(args[3]).toContain('$.NSOpenPanel.openPanel');
    expect(args[3]).toContain('panel.setCanChooseDirectories(true)');
    expect(args[3]).toContain('panel.setCanChooseFiles(false)');
    expect(args[3]).toContain('panel.setPrompt($(\"打开\"))');
  });

  it('returns null when the native panel is canceled', async () => {
    const picker = createNativeProjectDirectoryPicker({
      platform: 'darwin',
      runCommand: async () => ({
        exitCode: 0,
        stdout: '__CLAWEE_DIRECTORY_PICKER_CANCELLED__\n',
        stderr: ''
      })
    });

    await expect(picker.selectDirectory('add')).resolves.toBeNull();
  });

  it('rejects a second request while a native panel is still open', async () => {
    let resolveCommand: ((value: {
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void) | undefined;
    const command = new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => {
      resolveCommand = resolve;
    });
    const picker = createNativeProjectDirectoryPicker({
      platform: 'darwin',
      runCommand: () => command
    });

    const first = picker.selectDirectory('add');
    await expect(picker.selectDirectory('replace')).rejects.toMatchObject({
      code: 'PROJECT_DIRECTORY_PICKER_BUSY'
    });
    resolveCommand?.({
      exitCode: 0,
      stdout: '__CLAWEE_DIRECTORY_PICKER_CANCELLED__',
      stderr: ''
    });
    await expect(first).resolves.toBeNull();
  });

  it('reports native command failures without falling back to a custom browser', async () => {
    const picker = createNativeProjectDirectoryPicker({
      platform: 'darwin',
      runCommand: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'NSOpenPanel failed'
      })
    });

    await expect(picker.selectDirectory('add')).rejects.toEqual(
      new ProjectDirectoryPickerError(
        'PROJECT_DIRECTORY_PICKER_FAILED',
        'NSOpenPanel failed'
      )
    );
  });
});
