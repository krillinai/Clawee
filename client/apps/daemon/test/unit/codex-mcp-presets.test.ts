import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverLocalMcpPresets,
  type McpPresetCommandRunner
} from '../../src/codex/mcp/presets.js';

let tempDir = '';

afterEach(() => {
  if (tempDir.length > 0) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = '';
});

describe('local MCP presets', () => {
  it('does not probe Computer Use outside macOS', async () => {
    const commandRunner = vi.fn<McpPresetCommandRunner>();

    await expect(discoverLocalMcpPresets({
      platform: 'linux',
      homeDir: '/tmp/not-used',
      commandRunner
    })).resolves.toEqual([]);
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('discovers the signed OpenAI Computer Use client', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-presets-'));
    const command = createComputerUseLayout(tempDir);
    const commandRunner = createValidCodesignRunner();

    await expect(discoverLocalMcpPresets({
      platform: 'darwin',
      homeDir: tempDir,
      commandRunner
    })).resolves.toEqual([{
      name: 'computer-use',
      displayName: 'Computer Use',
      description: '使用 OpenAI Computer Use 客户端操作这台 Mac 上的应用。',
      provider: 'OpenAI',
      platform: 'macOS',
      transport: 'stdio',
      command,
      args: ['mcp']
    }]);
    expect(commandRunner).toHaveBeenCalledTimes(4);
  });

  it('rejects symlinks in the trusted Computer Use path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-presets-'));
    const home = join(tempDir, 'home');
    const external = join(tempDir, 'external');
    mkdirSync(home, { recursive: true });
    createComputerUseLayout(external);
    symlinkSync(join(external, '.codex'), join(home, '.codex'), 'dir');
    const commandRunner = createValidCodesignRunner();

    await expect(discoverLocalMcpPresets({
      platform: 'darwin',
      homeDir: home,
      commandRunner
    })).resolves.toEqual([]);
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('rejects clients not signed by the expected OpenAI team', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-presets-'));
    createComputerUseLayout(tempDir);
    const commandRunner = vi.fn<McpPresetCommandRunner>(async (_command, args) => (
      args[0] === '-dv'
        ? {
            status: 0,
            stdout: '',
            stderr: [
              `Identifier=${bundleIdentifier(args.at(-1) ?? '')}`,
              'TeamIdentifier=UNTRUSTED'
            ].join('\n')
          }
        : { status: 0, stdout: '', stderr: '' }
    ));

    await expect(discoverLocalMcpPresets({
      platform: 'darwin',
      homeDir: tempDir,
      commandRunner
    })).resolves.toEqual([]);
  });
});

function createComputerUseLayout(home: string): string {
  const command = join(
    home,
    '.codex',
    'computer-use',
    'Codex Computer Use.app',
    'Contents',
    'SharedSupport',
    'SkyComputerUseClient.app',
    'Contents',
    'MacOS',
    'SkyComputerUseClient'
  );
  mkdirSync(dirname(command), { recursive: true });
  writeFileSync(command, 'signed client');
  chmodSync(command, 0o755);
  return command;
}

function createValidCodesignRunner(): McpPresetCommandRunner {
  return vi.fn(async (_command, args) => (
    args[0] === '-dv'
      ? {
          status: 0,
          stdout: '',
          stderr: [
            `Identifier=${bundleIdentifier(args.at(-1) ?? '')}`,
            'TeamIdentifier=2DC432GLL2'
          ].join('\n')
        }
      : { status: 0, stdout: '', stderr: '' }
  ));
}

function bundleIdentifier(path: string): string {
  return path.endsWith('SkyComputerUseClient.app')
    ? 'com.openai.sky.CUAService.cli'
    : 'com.openai.sky.CUAService';
}
