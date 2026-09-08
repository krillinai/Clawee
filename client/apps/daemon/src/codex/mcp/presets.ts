import type { CodexMcpPresetResponse } from '@clawee/protocol';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import { promisify } from 'node:util';

const OPENAI_TEAM_IDENTIFIER = '2DC432GLL2';
const COMPUTER_USE_OUTER_IDENTIFIER = 'com.openai.sky.CUAService';
const COMPUTER_USE_CLIENT_IDENTIFIER = 'com.openai.sky.CUAService.cli';
const COMPUTER_USE_RELATIVE_PATH = [
  '.codex',
  'computer-use',
  'Codex Computer Use.app',
  'Contents',
  'SharedSupport',
  'SkyComputerUseClient.app',
  'Contents',
  'MacOS',
  'SkyComputerUseClient'
] as const;
const execFileAsync = promisify(execFile);

export type McpPresetProvider = () => Promise<CodexMcpPresetResponse[]>;

export type McpPresetCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type McpPresetCommandRunner = (
  command: string,
  args: string[]
) => Promise<McpPresetCommandResult>;

export function createLocalMcpPresetProvider(input: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  commandRunner?: McpPresetCommandRunner;
} = {}): McpPresetProvider {
  return () => discoverLocalMcpPresets(input);
}

export async function discoverLocalMcpPresets(input: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  commandRunner?: McpPresetCommandRunner;
} = {}): Promise<CodexMcpPresetResponse[]> {
  if ((input.platform ?? process.platform) !== 'darwin') return [];

  const home = resolve(input.homeDir ?? homedir());
  const command = join(home, ...COMPUTER_USE_RELATIVE_PATH);
  const outerApp = join(
    home,
    '.codex',
    'computer-use',
    'Codex Computer Use.app'
  );
  const clientApp = join(
    outerApp,
    'Contents',
    'SharedSupport',
    'SkyComputerUseClient.app'
  );
  const commandRunner = input.commandRunner ?? runCommand;

  try {
    await assertSafeComputerUsePath(home, command);
    await verifySignedBundle({
      path: outerApp,
      identifier: COMPUTER_USE_OUTER_IDENTIFIER,
      commandRunner
    });
    await verifySignedBundle({
      path: clientApp,
      identifier: COMPUTER_USE_CLIENT_IDENTIFIER,
      commandRunner
    });
  } catch {
    return [];
  }

  return [{
    name: 'computer-use',
    displayName: 'Computer Use',
    description: '使用 OpenAI Computer Use 客户端操作这台 Mac 上的应用。',
    provider: 'OpenAI',
    platform: 'macOS',
    transport: 'stdio',
    command,
    args: ['mcp']
  }];
}

async function assertSafeComputerUsePath(
  home: string,
  command: string
): Promise<void> {
  const relativeCommand = relative(home, command);
  if (
    relativeCommand.length === 0
    || isAbsolute(relativeCommand)
    || relativeCommand === '..'
    || relativeCommand.startsWith(`..${sep}`)
  ) {
    throw new Error('MCP_PRESET_PATH_ESCAPE');
  }

  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) {
    throw new Error('MCP_PRESET_PATH_INVALID');
  }

  let current = home;
  for (const [index, segment] of COMPUTER_USE_RELATIVE_PATH.entries()) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error('MCP_PRESET_PATH_INVALID');
    }
    const isCommand = index === COMPUTER_USE_RELATIVE_PATH.length - 1;
    if (
      (isCommand && !info.isFile())
      || (isCommand && (info.mode & 0o111) === 0)
      || (!isCommand && !info.isDirectory())
    ) {
      throw new Error('MCP_PRESET_PATH_INVALID');
    }
  }

  const [homeReal, commandReal] = await Promise.all([
    realpath(home),
    realpath(command)
  ]);
  const relativeReal = relative(homeReal, commandReal);
  if (
    relativeReal.length === 0
    || isAbsolute(relativeReal)
    || relativeReal === '..'
    || relativeReal.startsWith(`..${sep}`)
  ) {
    throw new Error('MCP_PRESET_PATH_ESCAPE');
  }
}

async function verifySignedBundle(input: {
  path: string;
  identifier: string;
  commandRunner: McpPresetCommandRunner;
}): Promise<void> {
  const verification = await input.commandRunner('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    input.path
  ]);
  if (verification.status !== 0) {
    throw new Error('MCP_PRESET_SIGNATURE_INVALID');
  }

  const details = await input.commandRunner('/usr/bin/codesign', [
    '-dv',
    '--verbose=4',
    input.path
  ]);
  const output = `${details.stdout}\n${details.stderr}`;
  if (
    details.status !== 0
    || !hasSigningField(output, 'Identifier', input.identifier)
    || !hasSigningField(output, 'TeamIdentifier', OPENAI_TEAM_IDENTIFIER)
  ) {
    throw new Error('MCP_PRESET_SIGNATURE_INVALID');
  }
}

function hasSigningField(
  output: string,
  field: string,
  expected: string
): boolean {
  return output.split(/\r?\n/).some(
    line => line.trim() === `${field}=${expected}`
  );
}

async function runCommand(
  command: string,
  args: string[]
): Promise<McpPresetCommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return {
      status: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const result = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      status: typeof result.code === 'number' ? result.code : null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.message ?? ''
    };
  }
}
