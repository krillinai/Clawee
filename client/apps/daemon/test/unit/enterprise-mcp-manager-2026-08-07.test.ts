import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexMcpServerResponse } from '@clawee/protocol';
import type { McpManager } from '../../src/codex/mcp/manager.js';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import { EnterpriseHttpError } from '../../src/enterprise/http-client-2026-07-30.js';
import {
  createEnterpriseMcpManager,
  ENTERPRISE_MCP_TOKEN_ENV
} from '../../src/enterprise/mcp-manager-2026-08-07.js';
import type {
  EnterpriseMcpPreference,
  EnterpriseMcpPreferenceRepository
} from '../../src/enterprise/mcp-preferences-2026-08-07.js';
import type {
  EnterpriseSessionManager
} from '../../src/enterprise/session-manager-2026-07-30.js';

const agentId = 'clawee_550e8400-e29b-41d4-a716-446655440000';
const endpoint = 'https://enterprise.example/mcp/servers/crm-main';
const nativeName = 'enterprise_crm';
const legacyNativeName = 'enterprise_crm-main_b5803223';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enterprise MCP manager', () => {
  it('derives install and enable state from the Codex native server list', async () => {
    const fixture = createFixture({
      nativeServers: [nativeServer({
        name: 'installed-from-cli',
        enabled: true,
        url: endpoint
      })]
    });

    const response = await fixture.manager.listConnections();

    expect(response).toMatchObject({
      agentId,
      tokenStatus: 'ready',
      upstreams: [{
        upstreamId: 'crm-main',
        installedServerName: 'installed-from-cli',
        installed: true,
        enabled: true
      }]
    });
    expect(JSON.stringify(response)).not.toContain('agent-mcp-secret');
  });

  it('installs an enterprise catalog entry through Codex native MCP config', async () => {
    const fixture = createFixture({ taskService: true });

    const response = await fixture.manager.updatePreference('crm-main', {
      installed: true,
      enabled: false
    });

    expect(fixture.mcpManager.addServer).toHaveBeenCalledWith({
      name: 'enterprise_crm',
      transport: 'http',
      url: endpoint
    });
    expect(fixture.mcpManager.setServerToolTimeout).toHaveBeenCalledWith(
      'enterprise_crm',
      7_500,
      false
    );
    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenCalledWith(
      'enterprise_crm',
      'agent-mcp-secret',
      agentId,
      false
    );
    expect(fixture.mcpManager.setServerEnabled).toHaveBeenCalledWith(
      'enterprise_crm',
      false,
      false
    );
    expect(response.upstreams[0]).toMatchObject({
      codexServerName: 'enterprise_crm',
      installedServerName: 'enterprise_crm',
      installed: true,
      enabled: false
    });
  });

  it('renames a legacy hash-based enterprise MCP without reinstalling it', async () => {
    const fixture = createFixture({
      nativeServers: [nativeServer({
        name: legacyNativeName,
        enabled: false,
        url: endpoint,
        hasSecrets: true
      })]
    });

    const response = await fixture.manager.listConnections();

    expect(fixture.mcpManager.renameServer).toHaveBeenCalledWith(
      legacyNativeName,
      nativeName,
      true
    );
    expect(fixture.mcpManager.addServer).not.toHaveBeenCalled();
    expect(fixture.mcpManager.removeServer).not.toHaveBeenCalled();
    expect(response.upstreams[0]).toMatchObject({
      codexServerName: nativeName,
      installedServerName: nativeName,
      installed: true,
      enabled: false
    });
  });

  it('renames an installed enterprise MCP when its catalog namespace changes', async () => {
    const fixture = createFixture({
      namespace: 'rose',
      nativeServers: [nativeServer({
        name: 'enterprise_linux',
        enabled: true,
        url: endpoint,
        hasSecrets: true
      })]
    });

    const response = await fixture.manager.listConnections();

    expect(fixture.mcpManager.renameServer).toHaveBeenCalledWith(
      'enterprise_linux',
      'enterprise_rose',
      true
    );
    expect(response.upstreams[0]).toMatchObject({
      codexServerName: 'enterprise_rose',
      installedServerName: 'enterprise_rose',
      installed: true,
      enabled: true
    });
  });

  it('uses a stable suffix when the renamed namespace is already occupied', async () => {
    const fixture = createFixture({
      namespace: 'rose',
      nativeServers: [
        nativeServer({ name: 'enterprise_linux', enabled: true, url: endpoint }),
        nativeServer({ name: 'enterprise_rose', url: 'https://custom.example/mcp' })
      ]
    });

    const response = await fixture.manager.listConnections();

    expect(fixture.mcpManager.renameServer).toHaveBeenCalledWith(
      'enterprise_linux',
      'enterprise_rose_b58032',
      true
    );
    expect(response.upstreams[0]).toMatchObject({
      installedServerName: 'enterprise_rose_b58032'
    });
  });

  it('adds a short stable suffix only when the semantic name is occupied', async () => {
    const fixture = createFixture({
      nativeServers: [nativeServer({
        name: nativeName,
        url: 'https://custom.example/mcp'
      })]
    });

    const response = await fixture.manager.updatePreference('crm-main', {
      installed: true,
      enabled: false
    });

    expect(fixture.mcpManager.addServer).toHaveBeenCalledWith({
      name: 'enterprise_crm_b58032',
      transport: 'http',
      url: endpoint
    });
    expect(response.upstreams[0]).toMatchObject({
      codexServerName: 'enterprise_crm_b58032',
      installedServerName: 'enterprise_crm_b58032',
      installed: true
    });
  });

  it('does not extend tool timeout for enterprise MCPs without the task tool', async () => {
    const fixture = createFixture();

    await fixture.manager.updatePreference('crm-main', {
      installed: true,
      enabled: true
    });

    expect(fixture.mcpManager.setServerToolTimeout).not.toHaveBeenCalled();
  });

  it('uses the matched native server name for enable and remove operations', async () => {
    const fixture = createFixture({
      nativeServers: [nativeServer({
        name: 'custom-cli-name',
        enabled: false,
        url: endpoint
      })]
    });

    await fixture.manager.updatePreference('crm-main', { enabled: true });
    await fixture.manager.updatePreference('crm-main', { installed: false });

    expect(fixture.mcpManager.setServerEnabled).toHaveBeenCalledWith(
      'custom-cli-name',
      true,
      false
    );
    expect(fixture.mcpManager.removeServer).toHaveBeenCalledWith(
      'custom-cli-name',
      false
    );
    expect(fixture.mcpManager.renameServer).not.toHaveBeenCalled();
  });

  it('migrates the legacy token env var into the Codex native config', async () => {
    const fixture = createFixture({
      taskService: true,
      nativeServers: [nativeServer({
        name: nativeName,
        enabled: true,
        url: endpoint,
        bearerTokenEnvVar: ENTERPRISE_MCP_TOKEN_ENV
      })]
    });
    await fixture.manager.listConnections();

    const injection = await fixture.manager.prepareRuntime({
      runId: 'run_1',
      thread: {} as never,
      createdBy: 'api'
    });

    expect(injection).toBeUndefined();
    expect(fixture.mcpManager.setServerToolTimeout).toHaveBeenCalledWith(
      nativeName,
      7_500,
      true
    );
    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenCalledWith(
      nativeName,
      'agent-mcp-secret',
      agentId,
      true
    );
  });

  it('migrates legacy installed preferences once into Codex native config', async () => {
    const fixture = createFixture({
      taskService: true,
      legacyPreference: {
        enterpriseOrigin: 'https://enterprise.example',
        agentId,
        upstreamId: 'crm-main',
        installed: true,
        enabled: false,
        updatedAt: '2026-08-07T00:00:00Z'
      }
    });

    const first = await fixture.manager.listConnections();
    const second = await fixture.manager.listConnections();

    expect(fixture.mcpManager.addServer).toHaveBeenCalledTimes(1);
    expect(fixture.mcpManager.addServer).toHaveBeenCalledWith({
      name: nativeName,
      transport: 'http',
      url: endpoint,
      confirmWriteToCodexHome: true
    });
    expect(fixture.mcpManager.setServerToolTimeout).toHaveBeenCalledWith(
      nativeName,
      7_500,
      true
    );
    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenCalledWith(
      nativeName,
      'agent-mcp-secret',
      agentId,
      true
    );
    expect(fixture.mcpManager.setServerEnabled).toHaveBeenCalledWith(
      nativeName,
      false,
      true
    );
    expect(fixture.legacyPreferences.delete).toHaveBeenCalledTimes(1);
    expect(first.upstreams[0]).toMatchObject({
      installed: true,
      enabled: false
    });
    expect(second.upstreams[0]).toMatchObject({
      installed: true,
      enabled: false
    });
  });

  it('does not migrate or install when the Codex native list is unavailable', async () => {
    const fixture = createFixture({
      runtimeAvailable: false,
      listDiagnostics: ['codex mcp list failed'],
      legacyPreference: {
        enterpriseOrigin: 'https://enterprise.example',
        agentId,
        upstreamId: 'crm-main',
        installed: true,
        enabled: false,
        updatedAt: '2026-08-07T00:00:00Z'
      }
    });

    await expect(fixture.manager.listConnections()).rejects.toMatchObject({
      code: 'ENTERPRISE_MCP_RUNTIME_UNAVAILABLE',
      statusCode: 503
    });
    expect(fixture.mcpManager.addServer).not.toHaveBeenCalled();
    expect(fixture.legacyPreferences.delete).not.toHaveBeenCalled();
  });

  it('keeps the enterprise catalog available when Codex returns an empty list with warnings', async () => {
    const fixture = createFixture({
      listDiagnostics: ['Codex PATH helper setup was skipped']
    });

    await expect(fixture.manager.listConnections()).resolves.toMatchObject({
      upstreams: [{
        upstreamId: 'crm-main',
        installed: false,
        enabled: false
      }]
    });
  });

  it('does not fetch or inject a token when no enabled native server needs it', async () => {
    const fixture = createFixture();

    await expect(fixture.manager.prepareRuntime({
      runId: 'run_1',
      thread: {} as never,
      createdBy: 'api'
    })).resolves.toBeUndefined();
    expect(fixture.revealAccountMcpToken).not.toHaveBeenCalled();
  });

  it('reports a missing MCP token without using the enterprise session token', async () => {
    const fixture = createFixture({
      revealAccountMcpToken: vi.fn(async () => {
        throw new EnterpriseHttpError(
          'ENTERPRISE_MCP_TOKEN_NOT_FOUND',
          'response',
          404,
          'not_found'
        );
      })
    });

    await expect(fixture.manager.listConnections()).resolves.toMatchObject({
      tokenStatus: 'missing'
    });
  });

  it('invalidates the runtime when the secure token fingerprint changes', async () => {
    const fixture = createFixture();
    await fixture.manager.listConnections();
    fixture.onRuntimeConfigurationChanged.mockClear();
    fixture.revealAccountMcpToken.mockResolvedValue({
      ...accountMcpToken(),
      token: 'rotated-agent-mcp-secret',
      fingerprint: 'fingerprint-2'
    });

    await fixture.manager.refreshConnections();

    expect(fixture.mcpManager.listServers).toHaveBeenCalledWith({
      forceRefresh: true
    });
    expect(fixture.onRuntimeConfigurationChanged).toHaveBeenCalledWith(
      'enterprise_mcp_token_changed'
    );
  });

  it('removes persisted enterprise MCP authorization on sign-out', async () => {
    const fixture = createFixture({
      nativeServers: [nativeServer({
        name: nativeName,
        enabled: true,
        url: endpoint
      })]
    });
    await fixture.manager.listConnections();
    vi.mocked(fixture.mcpManager.clearServerBearerTokens).mockClear();

    await fixture.manager.handleSessionSignedOut();

    expect(fixture.mcpManager.clearServerBearerTokens).toHaveBeenCalledWith(
      {
        names: [nativeName],
        urls: [endpoint],
        namePrefix: 'enterprise_',
        legacyBearerTokenEnvVar: ENTERPRISE_MCP_TOKEN_ENV
      },
      true
    );
  });

  it('clears a delayed old token before refreshing the next account', async () => {
    let releaseOldToken!: (token: ReturnType<typeof accountMcpToken>) => void;
    const oldToken = new Promise<ReturnType<typeof accountMcpToken>>(resolve => {
      releaseOldToken = resolve;
    });
    const fixture = createFixture({
      nativeServers: [nativeServer({ name: nativeName, url: endpoint })],
      revealAccountMcpToken: vi.fn()
        .mockImplementationOnce(async () => oldToken)
        .mockResolvedValue({ ...accountMcpToken(), token: 'next-account-secret' })
    });
    const oldRefresh = fixture.manager.refreshConnections();
    await vi.waitFor(() => expect(fixture.revealAccountMcpToken).toHaveBeenCalledTimes(1));
    vi.mocked(fixture.sessionManager.getSnapshot).mockReturnValue({
      status: 'signed_out', agentId, transportSecurity: 'secure_https'
    });
    const signOut = fixture.manager.handleSessionSignedOut();
    vi.mocked(fixture.sessionManager.getSnapshot).mockReturnValue({
      status: 'signed_in', agentId: 'clawee_next',
      account: { subjectId: 'usr_next', email: 'next@example.com', name: 'Next' },
      transportSecurity: 'secure_https'
    });
    vi.mocked(fixture.sessionManager.requireAccessToken).mockResolvedValue('next-session-token');
    const signedIn = fixture.manager.handleSessionAuthenticated();
    const nextRefresh = fixture.manager.refreshConnections();
    releaseOldToken(accountMcpToken());
    await Promise.all([oldRefresh, signOut, signedIn, nextRefresh]);

    expect(fixture.mcpManager.clearServerBearerTokens).toHaveBeenCalledOnce();
    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenLastCalledWith(
      nativeName, 'next-account-secret', 'clawee_next', true
    );
  });

  it('does not invalidate a new session when an old catalog request returns 401', async () => {
    let rejectOldCatalog!: (error: Error) => void;
    const oldCatalog = new Promise<never>((_resolve, reject) => { rejectOldCatalog = reject; });
    const fixture = createFixture();
    const client = fixture.manager;
    const oldRequest = vi.mocked(fixture.getMcpCatalog).mockImplementationOnce(async () => oldCatalog);
    const refresh = client.refreshConnections();
    await vi.waitFor(() => expect(oldRequest).toHaveBeenCalledOnce());
    vi.mocked(fixture.sessionManager.getSnapshot).mockReturnValue({
      status: 'signed_in', agentId: 'clawee_next',
      account: { subjectId: 'usr_next', email: 'next@example.com', name: 'Next' },
      transportSecurity: 'secure_https'
    });
    vi.mocked(fixture.sessionManager.requireAccessToken).mockResolvedValue('next-session-token');
    const signedIn = client.handleSessionAuthenticated();
    rejectOldCatalog(new EnterpriseHttpError('ENTERPRISE_UNAUTHORIZED', 'response', 401, 'unauthorized'));
    await expect(refresh).rejects.toMatchObject({ code: 'ENTERPRISE_UNAUTHORIZED' });
    await signedIn;
    expect(fixture.sessionManager.invalidateUnauthorized).not.toHaveBeenCalled();
    expect(fixture.sessionManager.getSnapshot().status).toBe('signed_in');
  });

  it('clears the previous account token on direct account switching', async () => {
    const fixture = createFixture({
      nativeServers: [nativeServer({ name: nativeName, url: endpoint })]
    });
    await fixture.manager.listConnections();
    vi.mocked(fixture.sessionManager.getSnapshot).mockReturnValue({
      status: 'signed_in', agentId: 'clawee_next',
      account: { subjectId: 'usr_next', email: 'next@example.com', name: 'Next' },
      transportSecurity: 'secure_https'
    });
    await fixture.manager.handleSessionAuthenticated();
    expect(fixture.mcpManager.clearServerBearerTokens).toHaveBeenCalledOnce();
    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenLastCalledWith(
      nativeName, 'agent-mcp-secret', agentId, true
    );
  });

  it('does not require an MCP runtime for initial authentication', async () => {
    const fixture = createFixture({ runtimeAvailable: false });
    await expect(fixture.manager.handleSessionAuthenticated()).resolves.toBeUndefined();
    expect(fixture.mcpManager.clearServerBearerTokens).not.toHaveBeenCalled();
  });

  it('refreshes the Agent header when the signed-in identity changes', async () => {
    const fixture = createFixture({
      nativeServers: [nativeServer({
        name: nativeName,
        enabled: true,
        url: endpoint
      })]
    });
    await fixture.manager.listConnections();
    fixture.onRuntimeConfigurationChanged.mockClear();
    vi.mocked(fixture.sessionManager.getSnapshot).mockReturnValue({
      status: 'signed_in',
      agentId: 'clawee_replaced',
      account: { subjectId: 'usr_2', email: 'other@example.com', name: 'Other' },
      transportSecurity: 'secure_https'
    });

    await fixture.manager.prepareRuntime({
      runId: 'run_2',
      thread: {} as never,
      createdBy: 'api'
    });

    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenLastCalledWith(
      nativeName,
      'agent-mcp-secret',
      'clawee_replaced',
      true
    );
    expect(fixture.onRuntimeConfigurationChanged).toHaveBeenCalledWith(
      'enterprise_mcp_token_changed'
    );
  });

  it('re-reveals and retries both headers after a configuration write fails', async () => {
    const fixture = createFixture({
      nativeServers: [nativeServer({
        name: nativeName,
        enabled: true,
        url: endpoint
      })]
    });
    await fixture.manager.listConnections();
    fixture.revealAccountMcpToken.mockResolvedValue({
      ...accountMcpToken(),
      token: 'rotated-agent-mcp-secret',
      fingerprint: 'fingerprint-2'
    });
    vi.mocked(fixture.mcpManager.setServerBearerToken)
      .mockRejectedValueOnce(new Error('CONFIG_WRITE_FAILED'));

    await expect(fixture.manager.refreshConnections()).rejects.toBeDefined();
    await expect(fixture.manager.prepareRuntime({
      runId: 'run_retry',
      thread: {} as never,
      createdBy: 'api'
    })).resolves.toBeUndefined();

    expect(fixture.revealAccountMcpToken).toHaveBeenCalledTimes(3);
    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenLastCalledWith(
      nativeName,
      'rotated-agent-mcp-secret',
      agentId,
      true
    );
  });

  it('retries both headers after installing a server fails to write them', async () => {
    const fixture = createFixture();
    await fixture.manager.listConnections();
    vi.mocked(fixture.mcpManager.setServerBearerToken)
      .mockRejectedValueOnce(new Error('CONFIG_WRITE_FAILED'));

    await expect(fixture.manager.updatePreference('crm-main', {
      installed: true,
      enabled: true
    })).rejects.toBeDefined();
    await expect(fixture.manager.prepareRuntime({
      runId: 'run_install_retry',
      thread: {} as never,
      createdBy: 'api'
    })).resolves.toBeUndefined();

    expect(fixture.revealAccountMcpToken).toHaveBeenCalledTimes(2);
    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenLastCalledWith(
      nativeName,
      'agent-mcp-secret',
      agentId,
      true
    );
  });

  it('retries both headers after legacy preference migration fails to write them', async () => {
    const fixture = createFixture({
      legacyPreference: {
        enterpriseOrigin: 'https://enterprise.example',
        agentId,
        upstreamId: 'crm-main',
        installed: true,
        enabled: true,
        updatedAt: '2026-08-07T00:00:00Z'
      }
    });
    vi.mocked(fixture.mcpManager.setServerBearerToken)
      .mockRejectedValueOnce(new Error('CONFIG_WRITE_FAILED'));

    await expect(fixture.manager.listConnections()).rejects.toBeDefined();
    await expect(fixture.manager.prepareRuntime({
      runId: 'run_legacy_migration_retry',
      thread: {} as never,
      createdBy: 'api'
    })).resolves.toBeUndefined();

    expect(fixture.revealAccountMcpToken).toHaveBeenCalledTimes(2);
    expect(fixture.mcpManager.setServerBearerToken).toHaveBeenLastCalledWith(
      nativeName,
      'agent-mcp-secret',
      agentId,
      true
    );
  });
});

function createFixture(options: {
  nativeServers?: CodexMcpServerResponse[];
  listDiagnostics?: string[];
  runtimeAvailable?: boolean;
  revealAccountMcpToken?: EnterpriseHttpClient['revealAccountMcpToken'];
  legacyPreference?: EnterpriseMcpPreference;
  taskService?: boolean;
  namespace?: string;
} = {}) {
  let nativeServers = [...(options.nativeServers ?? [])];
  let configuredAgentId: string | undefined;
  const sessionManager = {
    getSnapshot: vi.fn(() => ({
      status: 'signed_in' as const,
      agentId,
      account: { email: 'member@example.com', name: 'Member' },
      transportSecurity: 'secure_https' as const
    })),
    requireAccessToken: vi.fn(async () => 'enterprise-session-token'),
    invalidateUnauthorized: vi.fn(async () => undefined)
  } as unknown as EnterpriseSessionManager;
  const getMcpCatalog = vi.fn(async () => mcpCatalog(
    options.taskService === true,
    options.namespace
  ));
  const revealAccountMcpToken = vi.fn(
    options.revealAccountMcpToken ?? (async () => accountMcpToken())
  );
  const mcpManager = {
    listServers: vi.fn(async () => ({
      codexHome: '/tmp/codex',
      codexHomeMode: 'isolated' as const,
      requiresWriteConfirmation: false,
      runtimeAvailable: options.runtimeAvailable ?? true,
      servers: nativeServers,
      diagnostics: options.listDiagnostics ?? []
    })),
    getServer: vi.fn(async (name: string) => {
      const server = nativeServers.find(item => item.name === name);
      if (server === undefined) throw new Error('MCP_SERVER_NOT_FOUND');
      return server;
    }),
    addServer: vi.fn(async input => {
      const server = nativeServer({
        name: input.name,
        enabled: true,
        url: 'url' in input ? input.url : undefined,
        bearerTokenEnvVar: 'bearerTokenEnvVar' in input
          ? input.bearerTokenEnvVar
          : undefined
      });
      nativeServers = [...nativeServers, server];
      return { server, operation: operation('add') };
    }),
    removeServer: vi.fn(async (name: string) => {
      nativeServers = nativeServers.filter(server => server.name !== name);
      return { removed: true as const, operation: operation('remove') };
    }),
    renameServer: vi.fn(async (currentName: string, nextName: string) => {
      nativeServers = nativeServers.map(server => (
        server.name === currentName ? { ...server, name: nextName } : server
      ));
      const server = nativeServers.find(item => item.name === nextName);
      if (server === undefined) throw new Error('MCP_SERVER_NOT_FOUND');
      return server;
    }),
    setServerEnabled: vi.fn(async (name: string, enabled: boolean) => {
      nativeServers = nativeServers.map(server =>
        server.name === name ? { ...server, enabled } : server
      );
      return {
        server: nativeServers.find(server => server.name === name)!,
        operation: operation(enabled ? 'enable' : 'disable')
      };
    }),
    setServerBearerToken: vi.fn(async (
      name: string,
      token: string | undefined,
      headerAgentId: string | undefined
    ) => {
      const server = nativeServers.find(candidate => candidate.name === name);
      if (server === undefined) throw new Error('MCP_SERVER_NOT_FOUND');
      const changed =
        server.bearerTokenEnvVar !== undefined
        || server.hasSecrets !== (token !== undefined)
        || configuredAgentId !== headerAgentId;
      configuredAgentId = headerAgentId;
      nativeServers = nativeServers.map(candidate =>
        candidate.name === name
          ? {
              ...candidate,
              bearerTokenEnvVar: undefined,
              hasSecrets: token !== undefined
            }
          : candidate
      );
      return changed;
    }),
    setServerToolTimeout: vi.fn(async () => true),
    clearServerBearerTokens: vi.fn(async () => {
      const changed = nativeServers.some(server =>
        server.name.startsWith('enterprise_')
        && server.hasSecrets
      );
      nativeServers = nativeServers.map(server =>
        server.name.startsWith('enterprise_')
          ? {
              ...server,
              bearerTokenEnvVar: undefined,
              hasSecrets: false
            }
          : server
      );
      configuredAgentId = undefined;
      return changed;
    })
  } as unknown as Pick<
    McpManager,
    | 'listServers'
    | 'getServer'
    | 'addServer'
    | 'removeServer'
    | 'renameServer'
    | 'setServerEnabled'
    | 'setServerBearerToken'
    | 'setServerToolTimeout'
    | 'clearServerBearerTokens'
  >;
  const onRuntimeConfigurationChanged = vi.fn();
  let legacyPreference = options.legacyPreference;
  const legacyPreferences = {
    get: vi.fn(() => legacyPreference),
    list: vi.fn(() => (
      legacyPreference === undefined ? [] : [legacyPreference]
    )),
    upsert: vi.fn(),
    delete: vi.fn(() => {
      const existed = legacyPreference !== undefined;
      legacyPreference = undefined;
      return existed;
    })
  } as unknown as EnterpriseMcpPreferenceRepository;
  const manager = createEnterpriseMcpManager({
    enterpriseOrigin: 'https://enterprise.example',
    sessionManager,
    httpClient: {
      getMcpCatalog,
      revealAccountMcpToken
    } as unknown as EnterpriseHttpClient,
    mcpManager,
    legacyPreferences,
    onRuntimeConfigurationChanged,
    now: () => new Date('2026-08-12T10:00:00Z')
  });
  return {
    manager,
    mcpManager,
    legacyPreferences,
    onRuntimeConfigurationChanged,
    sessionManager,
    getMcpCatalog,
    revealAccountMcpToken
  };
}

function nativeServer(
  overrides: Partial<CodexMcpServerResponse>
): CodexMcpServerResponse {
  return {
    name: 'enterprise_crm',
    enabled: true,
    transport: 'http',
    status: 'configured',
    url: endpoint,
    envKeys: [],
    hasSecrets: false,
    codexHome: '/tmp/codex',
    codexHomeMode: 'isolated',
    diagnostics: [],
    ...overrides
  };
}

function mcpCatalog(taskService = false, namespace = 'crm') {
  return {
    upstreams: [{
      upstreamId: 'crm-main',
      name: 'CRM',
      domain: 'sales',
      endpoint,
      upstreamTransport: 'streamable_http',
      namespace,
      status: 'active',
      tools: taskService
        ? [{
            toolId: 'task_submit',
            upstreamName: 'clawee_submit_task',
            name: 'clawee_submit_task',
            exposedName: 'clawee_submit_task',
            title: '提交任务',
            description: '提交 Clawee 长任务',
            riskLevel: '',
            confirmRequired: false,
            status: 'active',
            authorized: true,
            authorizationExpiresAt: null
          }]
        : []
    }]
  };
}

function accountMcpToken() {
  return {
    userId: 'user_1',
    tokenId: 'token_1',
    token: 'agent-mcp-secret',
    fingerprint: 'fingerprint-1',
    expiresAt: null,
    scopes: ['mcp:call'],
    createdAt: '2026-08-12T00:00:00Z'
  };
}

function operation(
  type: 'add' | 'remove' | 'enable' | 'disable'
) {
  return {
    id: `operation-${type}`,
    operation: type,
    codexHome: '/tmp/codex',
    command: ['mcp', type],
    status: 'succeeded' as const,
    timedOut: false,
    createdAt: '2026-08-12T00:00:00Z'
  };
}
