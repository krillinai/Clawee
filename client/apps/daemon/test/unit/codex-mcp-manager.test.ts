import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpManager } from '../../src/codex/mcp/manager.js';
import type { ResolvedCodexHome } from '../../src/codex/home.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';

const capabilities = {
  mcpAdd: true,
  mcpAddEnv: true,
  mcpAddUrl: true,
  mcpAddBearerTokenEnvVar: true,
  mcpAddOAuth: true
};

let tempDir = '';
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('codex mcp manager', () => {
  it('includes local presets in cached MCP list responses', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const presetProvider = vi.fn(async () => [{
      name: 'computer-use',
      displayName: 'Computer Use',
      description: 'Control local apps.',
      provider: 'OpenAI',
      platform: 'macOS',
      transport: 'stdio' as const,
      command: '/Applications/Computer Use',
      args: ['mcp']
    }]);
    const manager = createMcpManager({
      codexBin,
      codexHome,
      db,
      capabilities,
      presetProvider
    });

    const first = await manager.listServers();
    const second = await manager.listServers();

    expect(first.presets).toEqual([expect.objectContaining({
      name: 'computer-use',
      command: '/Applications/Computer Use'
    })]);
    expect(second).toEqual(first);
    expect(presetProvider).toHaveBeenCalledTimes(1);
  });

  it('runs add/list/get/remove through codex and stores redacted operations', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createMcpManager({ codexBin, codexHome, db, capabilities });

    const added = await manager.addServer({
      name: 'github',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { GITHUB_TOKEN: 'real-secret' }
    });
    const list = await manager.listServers();
    const got = await manager.getServer('github');
    const removed = await manager.removeServer('github', false);

    expect(added.server).toMatchObject({ name: 'github', transport: 'stdio' });
    expect(list.servers).toHaveLength(1);
    expect(got).toMatchObject({ name: 'github', transport: 'stdio' });
    expect(removed).toMatchObject({ removed: true });

    expect(added.operation).toMatchObject({
      operation: 'add',
      serverName: 'github',
      command: expect.arrayContaining(['GITHUB_TOKEN=[REDACTED]']),
      status: 'succeeded'
    });
    expect(added.operation.command).not.toContain('GITHUB_TOKEN=real-secret');

    const commands = readCommands(tempDir);
    expect(commands).toContain('mcp add github --env GITHUB_TOKEN=real-secret -- node server.js');
    expect(commands).toEqual([
      'mcp add github --env GITHUB_TOKEN=real-secret -- node server.js',
      'mcp get github --json',
      'mcp list --json',
      'mcp get github --json',
      'mcp remove github'
    ]);

    expect(manager.listOperations().map((operation) => operation.operation)).toEqual([
      'remove',
      'get',
      'list',
      'get',
      'add'
    ]);
  });

  it('rejects unconfirmed global CODEX_HOME writes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'global');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createMcpManager({ codexBin, codexHome, db, capabilities });

    await expect(
      manager.addServer({
        name: 'github',
        transport: 'stdio',
        command: 'node'
      })
    ).rejects.toThrow('MCP_WRITE_CONFIRMATION_REQUIRED');

    expect(manager.listOperations()).toEqual([]);
    expect(readCommands(tempDir)).toEqual([]);
  });

  it('supports destructured addServer calls and still logs the verification get', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const { addServer, listOperations } = createMcpManager({ codexBin, codexHome, db, capabilities });

    const added = await addServer({
      name: 'github',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { GITHUB_TOKEN: 'real-secret' }
    });

    expect(added.server).toMatchObject({ name: 'github', transport: 'stdio' });
    expect(readCommands(tempDir)).toEqual([
      'mcp add github --env GITHUB_TOKEN=real-secret -- node server.js',
      'mcp get github --json'
    ]);
    expect(listOperations().map((operation) => operation.operation)).toEqual(['get', 'add']);
  });

  it('redacts add request env values from failed operation diagnostics', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createMcpManager({ codexBin, codexHome, db, capabilities });

    await expect(
      manager.addServer({
        name: 'fail-add',
        transport: 'stdio',
        command: 'node',
        env: { GITHUB_TOKEN: 'real-secret' }
      })
    ).rejects.toThrow('[REDACTED]');

    const failed = manager.listOperations()[0];
    expect(failed).toMatchObject({
      operation: 'add',
      status: 'failed',
      errorCode: 'MCP_COMMAND_FAILED'
    });
    expect(JSON.stringify(failed)).toContain('[REDACTED]');
    expect(JSON.stringify(failed)).not.toContain('real-secret');
  });

  it('returns diagnostics and logs a failed operation when list fails', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'fail-list-codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createMcpManager({ codexBin, codexHome, db, capabilities });

    const listed = await manager.listServers();

    expect(listed).toMatchObject({
      servers: [],
      diagnostics: ['list failed']
    });
    expect(manager.listOperations()[0]).toMatchObject({
      operation: 'list',
      status: 'failed',
      errorCode: 'MCP_COMMAND_FAILED',
      errorMessage: 'list failed'
    });
  });

  it('caches list results and deduplicates concurrent codex commands', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const onPerformanceEvent = vi.fn();
    const manager = createMcpManager({
      codexBin,
      codexHome,
      db,
      capabilities,
      onPerformanceEvent
    });

    const [first, second] = await Promise.all([
      manager.listServers(),
      manager.listServers()
    ]);
    const third = await manager.listServers();

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(readCommands(tempDir)).toEqual(['mcp list --json']);
    expect(manager.listOperations().map(operation => operation.operation)).toEqual([
      'list'
    ]);
    expect(onPerformanceEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: 'codex_mcp',
      event: 'list_cache',
      outcome: 'joined'
    }));
    expect(onPerformanceEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: 'codex_mcp',
      event: 'list_cache',
      outcome: 'hit'
    }));
    expect(onPerformanceEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: 'codex_mcp',
      event: 'command_completed',
      operation: 'list',
      exitCode: 0
    }));
  });

  it('invalidates the list cache after a successful MCP mutation', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createMcpManager({ codexBin, codexHome, db, capabilities });

    await manager.listServers();
    await manager.addServer({
      name: 'github',
      transport: 'stdio',
      command: 'node'
    });
    await manager.listServers();

    expect(readCommands(tempDir).filter(command => command === 'mcp list --json'))
      .toHaveLength(2);
  });

  it('refreshes the list when config.toml changes or refresh is forced', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createMcpManager({ codexBin, codexHome, db, capabilities });

    await manager.listServers();
    mkdirSync(codexHome.path, { recursive: true });
    writeFileSync(join(codexHome.path, 'config.toml'), '[mcp_servers.github]\n');
    await manager.listServers();
    await manager.listServers({ forceRefresh: true });

    expect(readCommands(tempDir).filter(command => command === 'mcp list --json'))
      .toHaveLength(3);
  });

  it('materializes a safe native override before toggling a plugin MCP', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-manager-'));
    const codexHome = makeCodexHome(join(tempDir, 'codex-home'), 'isolated');
    const codexBin = makeFakeCodex(tempDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createMcpManager({ codexBin, codexHome, db, capabilities });

    const result = await manager.setServerEnabled('plugin-github', false, false);

    expect(result.server).toMatchObject({
      name: 'plugin-github',
      enabled: false,
      transport: 'http'
    });
    const config = readFileSync(join(codexHome.path, 'config.toml'), 'utf8');
    expect(config).toContain('[mcp_servers.plugin-github]');
    expect(config).toContain('url = "https://api.githubcopilot.com/mcp/"');
    expect(config).toContain('bearer_token_env_var = "GITHUB_PAT_TOKEN"');
    expect(config).toContain('enabled = false');
    expect(readCommands(tempDir)).toEqual([
      'mcp get plugin-github --json',
      'mcp get plugin-github --json'
    ]);
  });
});

function makeCodexHome(path: string, mode: ResolvedCodexHome['mode']): ResolvedCodexHome {
  return {
    path,
    mode,
    source: mode === 'global' ? 'default' : 'isolated',
    writable: mode === 'isolated'
  };
}

function makeFakeCodex(dir: string): string {
  const codexBin = join(dir, 'fake-codex.js');
  const commandsPath = JSON.stringify(join(dir, 'commands.json'));
  writeFileSync(
    codexBin,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const commandsPath = ${commandsPath};
const command = process.argv.slice(2).join(' ');
const commands = existsSync(commandsPath) ? JSON.parse(readFileSync(commandsPath, 'utf8')) : [];
commands.push(command);
writeFileSync(commandsPath, JSON.stringify(commands));

if (command === 'mcp list --json') {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.includes('fail-list')) {
    process.stderr.write('list failed');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([{ name: 'github', transport: 'stdio', command: 'node', args: ['server.js'], env: { GITHUB_TOKEN: 'real-secret' } }]));
  process.exit(0);
}
if (command === 'mcp get github --json') {
  process.stdout.write(JSON.stringify({ name: 'github', transport: 'stdio', command: 'node', args: ['server.js'], env: { GITHUB_TOKEN: 'real-secret' } }));
  process.exit(0);
}
if (command === 'mcp get plugin-github --json') {
  const configPath = process.env.CODEX_HOME
    ? require('node:path').join(process.env.CODEX_HOME, 'config.toml')
    : '';
  const config = configPath && existsSync(configPath)
    ? readFileSync(configPath, 'utf8')
    : '';
  process.stdout.write(JSON.stringify({
    name: 'plugin-github',
    enabled: !/enabled\\s*=\\s*false/.test(config),
    transport: {
      type: 'streamable_http',
      url: 'https://api.githubcopilot.com/mcp/',
      bearer_token_env_var: 'GITHUB_PAT_TOKEN'
    }
  }));
  process.exit(0);
}
if (/^mcp (add|remove|login|logout)\\b/.test(command)) {
  if (command.startsWith('mcp add fail-add ')) {
    process.stderr.write('codex saw bare secret real-secret');
    process.exit(1);
  }
  process.exit(0);
}
process.stderr.write('not found\\n');
process.exit(1);
`
  );
  chmodSync(codexBin, 0o755);
  return codexBin;
}

function readCommands(dir: string): string[] {
  try {
    return JSON.parse(readFileSync(join(dir, 'commands.json'), 'utf8')) as string[];
  } catch {
    return [];
  }
}
