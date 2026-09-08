import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@iarna/toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCodexMcpServerBearerTokens,
  getCodexMcpConfigurationFingerprint,
  renameCodexMcpServer,
  setCodexMcpServerBearerToken,
  setCodexMcpServerEnabled,
  setCodexMcpServerToolTimeout
} from '../../src/codex/mcp/config-store-2026-08-12.js';

let tempDir = '';

afterEach(() => {
  if (tempDir.length > 0) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = '';
});

describe('Codex MCP config store', () => {
  it('renames an MCP entry atomically without losing runtime configuration', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, [
      'model = "gpt-test"',
      '',
      '[mcp_servers.enterprise_crm-main_9f9de575]',
      'url = "https://example.test/mcp"',
      'enabled = false',
      'tool_timeout_sec = 7500',
      '',
      '[mcp_servers.enterprise_crm-main_9f9de575.http_headers]',
      'Authorization = "Bearer secret"',
      'X-Claw-Agent-ID = "agent_1"',
      ''
    ].join('\n'), { mode: 0o644 });

    await expect(renameCodexMcpServer({
      codexHome: tempDir,
      currentName: 'enterprise_crm-main_9f9de575',
      nextName: 'enterprise_crm'
    })).resolves.toBe(true);

    const parsed = parse(readFileSync(configPath, 'utf8')) as {
      model: string;
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.model).toBe('gpt-test');
    expect(parsed.mcp_servers['enterprise_crm-main_9f9de575']).toBeUndefined();
    expect(parsed.mcp_servers.enterprise_crm).toEqual({
      url: 'https://example.test/mcp',
      enabled: false,
      tool_timeout_sec: 7_500,
      http_headers: {
        Authorization: 'Bearer secret',
        'X-Claw-Agent-ID': 'agent_1'
      }
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('does not overwrite an existing MCP while renaming', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, [
      '[mcp_servers.legacy]',
      'url = "https://example.test/legacy"',
      '',
      '[mcp_servers.semantic]',
      'url = "https://example.test/semantic"',
      ''
    ].join('\n'));

    await expect(renameCodexMcpServer({
      codexHome: tempDir,
      currentName: 'legacy',
      nextName: 'semantic'
    })).rejects.toThrow('MCP_SERVER_ALREADY_EXISTS');

    const parsed = parse(readFileSync(configPath, 'utf8')) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers.legacy).toBeDefined();
    expect(parsed.mcp_servers.semantic).toBeDefined();
  });

  it('updates only the native enabled flag and preserves other config', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, [
      'model = "gpt-test"',
      '',
      '[mcp_servers.github]',
      'url = "https://example.test/mcp"',
      'bearer_token_env_var = "GITHUB_TOKEN"',
      '',
      '[mcp_servers.local]',
      'command = "node"',
      'args = ["server.js"]',
      ''
    ].join('\n'));

    await setCodexMcpServerEnabled({
      codexHome: tempDir,
      name: 'github',
      enabled: false
    });

    const parsed = parse(readFileSync(configPath, 'utf8')) as {
      model: string;
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.model).toBe('gpt-test');
    expect(parsed.mcp_servers.github).toMatchObject({
      url: 'https://example.test/mcp',
      bearer_token_env_var: 'GITHUB_TOKEN',
      enabled: false
    });
    expect(parsed.mcp_servers.local).toMatchObject({
      command: 'node',
      args: ['server.js']
    });
  });

  it('rejects missing servers without creating a new config entry', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'model = "gpt-test"\n');

    await expect(setCodexMcpServerEnabled({
      codexHome: tempDir,
      name: 'missing',
      enabled: true
    })).rejects.toThrow('MCP_SERVER_NOT_FOUND');

    expect(parse(readFileSync(configPath, 'utf8'))).toEqual({
      model: 'gpt-test'
    });
  });

  it('sets the MCP tool timeout without changing sibling configuration', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, [
      'model = "gpt-test"',
      '',
      '[mcp_servers.enterprise_tasks]',
      'url = "https://example.test/mcp"',
      'enabled = true',
      '',
      '[mcp_servers.local]',
      'command = "node"',
      ''
    ].join('\n'), { mode: 0o640 });

    await expect(setCodexMcpServerToolTimeout({
      codexHome: tempDir,
      name: 'enterprise_tasks',
      timeoutSec: 7_500
    })).resolves.toBe(true);
    await expect(setCodexMcpServerToolTimeout({
      codexHome: tempDir,
      name: 'enterprise_tasks',
      timeoutSec: 7_500
    })).resolves.toBe(false);

    const parsed = parse(readFileSync(configPath, 'utf8')) as {
      model: string;
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed).toMatchObject({
      model: 'gpt-test',
      mcp_servers: {
        enterprise_tasks: {
          url: 'https://example.test/mcp',
          enabled: true,
          tool_timeout_sec: 7_500
        },
        local: { command: 'node' }
      }
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o640);
  });

  it('persists a safe override for an MCP supplied by a Codex plugin', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'model = "gpt-test"\n');

    await setCodexMcpServerEnabled({
      codexHome: tempDir,
      name: 'github',
      enabled: false,
      fallbackServer: {
        name: 'github',
        enabled: true,
        transport: 'http',
        status: 'configured',
        url: 'https://api.githubcopilot.com/mcp/',
        bearerTokenEnvVar: 'GITHUB_PAT_TOKEN',
        envKeys: [],
        hasSecrets: false,
        codexHome: tempDir,
        codexHomeMode: 'isolated',
        diagnostics: []
      }
    });

    const parsed = parse(readFileSync(configPath, 'utf8')) as {
      model: string;
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.model).toBe('gpt-test');
    expect(parsed.mcp_servers.github).toEqual({
      url: 'https://api.githubcopilot.com/mcp/',
      bearer_token_env_var: 'GITHUB_PAT_TOKEN',
      enabled: false
    });
  });

  it('does not persist a discovered MCP whose secret fields were redacted', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'model = "gpt-test"\n');

    await expect(setCodexMcpServerEnabled({
      codexHome: tempDir,
      name: 'private-server',
      enabled: false,
      fallbackServer: {
        name: 'private-server',
        enabled: true,
        transport: 'http',
        status: 'configured',
        url: 'https://example.test/mcp',
        envKeys: [],
        hasSecrets: true,
        codexHome: tempDir,
        codexHomeMode: 'isolated',
        diagnostics: []
      }
    })).rejects.toThrow('MCP_SERVER_INVALID');

    expect(parse(readFileSync(configPath, 'utf8'))).toEqual({
      model: 'gpt-test'
    });
  });

  it('stores and removes account authorization headers in one config write', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, [
      'model = "gpt-test"',
      '',
      '[mcp_servers.enterprise_crm]',
      'url = "https://example.test/mcp"',
      'bearer_token_env_var = "CLAWEE_ENTERPRISE_MCP_TOKEN"',
      '',
      '[mcp_servers.enterprise_crm.http_headers]',
      'X-Tenant = "tenant-a"',
      ''
    ].join('\n'), { mode: 0o644 });

    await expect(setCodexMcpServerBearerToken({
      codexHome: tempDir,
      name: 'enterprise_crm',
      token: 'account-mcp-secret',
      agentId: 'agent_1'
    })).resolves.toBe(true);

    let parsed = parse(readFileSync(configPath, 'utf8')) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers.enterprise_crm).toMatchObject({
      url: 'https://example.test/mcp',
      http_headers: {
        Authorization: 'Bearer account-mcp-secret',
        'X-Claw-Agent-ID': 'agent_1',
        'X-Tenant': 'tenant-a'
      }
    });
    expect(parsed.mcp_servers.enterprise_crm)
      .not.toHaveProperty('bearer_token_env_var');
    if (process.platform !== 'win32') {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }

    await expect(setCodexMcpServerBearerToken({
      codexHome: tempDir,
      name: 'enterprise_crm'
    })).resolves.toBe(true);

    parsed = parse(readFileSync(configPath, 'utf8')) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers.enterprise_crm).toMatchObject({
      http_headers: {
        'X-Tenant': 'tenant-a'
      }
    });
  });

  it('clears managed enterprise tokens without invoking Codex', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, [
      '[mcp_servers.enterprise_crm]',
      'url = "https://example.test/mcp/crm"',
      '',
      '[mcp_servers.enterprise_crm.http_headers]',
      'authorization = "Bearer enterprise-secret"',
      'x-claw-agent-id = "agent_1"',
      'X-Tenant = "tenant-a"',
      '',
      '[mcp_servers.github]',
      'url = "https://example.test/mcp/github"',
      '',
      '[mcp_servers.github.http_headers]',
      'Authorization = "Bearer github-secret"',
      ''
    ].join('\n'));

    await expect(clearCodexMcpServerBearerTokens({
      codexHome: tempDir,
      namePrefix: 'enterprise_'
    })).resolves.toBe(true);

    const parsed = parse(readFileSync(configPath, 'utf8')) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers.enterprise_crm).toMatchObject({
      http_headers: {
        'X-Tenant': 'tenant-a'
      }
    });
    expect(parsed.mcp_servers.github).toMatchObject({
      http_headers: {
        Authorization: 'Bearer github-secret'
      }
    });
  });

  it('fingerprints every native MCP field but ignores unrelated config', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-mcp-config-'));
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, [
      'model = "gpt-test"',
      '',
      '[mcp_servers.github]',
      'url = "https://example.test/mcp"',
      '',
      '[mcp_servers.github.http_headers]',
      'X-Tenant = "tenant-a"',
      ''
    ].join('\n'));
    const initial = await getCodexMcpConfigurationFingerprint(tempDir);

    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(
      'model = "gpt-test"',
      'model = "gpt-other"'
    ));
    await expect(getCodexMcpConfigurationFingerprint(tempDir))
      .resolves.toBe(initial);

    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(
      'tenant-a',
      'tenant-b'
    ));
    const changed = await getCodexMcpConfigurationFingerprint(tempDir);
    expect(changed).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(initial);
    expect(changed).not.toContain('tenant-b');
  });
});
