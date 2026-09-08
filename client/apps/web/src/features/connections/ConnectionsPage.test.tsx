import type {
  CodexMcpListResponse,
  EnterpriseMcpCatalogResponse,
  EnterpriseSessionResponse
} from '@clawee/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../runtime/errors.js';
import {
  ConnectionsPage,
  type EnterpriseMcpConnectionService
} from './ConnectionsPage.js';
import type { McpSettingsService } from '../settings/McpSettingsView.js';

describe('ConnectionsPage', () => {
  it('shows and toggles native Codex MCP while signed out', async () => {
    const user = userEvent.setup();
    let native = nativeData();
    const mcpService = createMcpService({
      listServers: vi.fn(async () => native),
      setServerEnabled: vi.fn(async (name, enabled) => {
        native = {
          ...native,
          servers: native.servers.map(server =>
            server.name === name ? { ...server, enabled } : server
          )
        };
        return {
          server: native.servers[0]!,
          operation: operation(enabled ? 'enable' : 'disable')
        };
      })
    });
    const enterpriseService = createEnterpriseService();

    render(
      <ConnectionsPage
        connected
        session={signedOutSession()}
        service={enterpriseService}
        mcpService={mcpService}
        mcpCapabilities={allCapabilities()}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedOutSession())}
        onSessionExpired={vi.fn()}
      />
    );

    expect(await screen.findByRole('heading', { name: 'github' }))
      .toBeInTheDocument();
    expect(document.querySelector('[data-mcp-icon="source"]'))
      .toHaveAttribute('data-tone', 'violet');
    expect(enterpriseService.listMcpConnections).not.toHaveBeenCalled();
    const toggle = screen.getByRole('switch', { name: 'github MCP' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
    expect(mcpService.setServerEnabled).toHaveBeenCalledWith(
      'github',
      false,
      false
    );
  });

  it('merges an enterprise catalog entry with a native server by endpoint', async () => {
    const enterpriseService = createEnterpriseService();

    render(
      <ConnectionsPage
        connected
        session={signedInSession()}
        service={enterpriseService}
        mcpService={createMcpService()}
        mcpCapabilities={allCapabilities()}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedInSession())}
        onSessionExpired={vi.fn()}
      />
    );

    expect(await screen.findByRole('heading', { name: 'CRM' }))
      .toBeInTheDocument();
    expect(screen.getAllByTestId('mcp-card')).toHaveLength(1);
    expect(screen.getByText(/github/)).toBeInTheDocument();
    expect(screen.getByText('按条件查询客户资料')).toBeInTheDocument();
    expect(screen.queryByText('企业授权：1/2 项工具'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '安装' }))
      .not.toBeInTheDocument();
  });

  it('refreshes a cached enterprise catalog when the page opens', async () => {
    const staleCatalog = enterpriseCatalog({
      upstreamId: 'knowledge-adapter',
      name: '企业知识库',
      domain: 'knowledge',
      namespace: 'knowledge',
      endpoint: 'https://enterprise.example/mcp/servers/knowledge-adapter'
    });
    const freshCatalog: EnterpriseMcpCatalogResponse = {
      ...staleCatalog,
      refreshedAt: '2026-09-03T10:00:00.000Z',
      upstreams: [
        ...staleCatalog.upstreams,
        {
          ...staleCatalog.upstreams[0]!,
          upstreamId: 'business-data',
          name: '业务数据',
          domain: 'business',
          namespace: 'business_data',
          endpoint: 'https://enterprise.example/mcp/servers/business-data',
          tools: staleCatalog.upstreams[0]!.tools.map(tool => ({
            ...tool,
            toolId: `business-${tool.toolId}`,
            name: `business.${tool.name}`,
            exposedName: `business.${tool.exposedName}`
          }))
        }
      ]
    };
    const refreshMcpConnections = vi.fn(async () => freshCatalog);
    const onMcpCatalogChange = vi.fn();

    render(
      <ConnectionsPage
        connected
        session={signedInSession()}
        service={createEnterpriseService({ refreshMcpConnections })}
        mcpService={createMcpService({
          listServers: vi.fn(async () => nativeData({
            servers: [],
            presets: []
          }))
        })}
        mcpCatalog={staleCatalog}
        mcpCapabilities={allCapabilities()}
        onMcpCatalogChange={onMcpCatalogChange}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedInSession())}
        onSessionExpired={vi.fn()}
      />
    );

    expect(await screen.findByRole('heading', { name: '业务数据' }))
      .toBeInTheDocument();
    expect(screen.getAllByTestId('mcp-card')).toHaveLength(2);
    expect(refreshMcpConnections).toHaveBeenCalledTimes(1);
    expect(onMcpCatalogChange).toHaveBeenLastCalledWith(freshCatalog);
  });

  it('installs an enterprise-only catalog entry through the enterprise adapter', async () => {
    const user = userEvent.setup();
    const onMcpCatalogChange = vi.fn();
    let catalog = enterpriseCatalog({
      endpoint: 'https://enterprise.example/mcp/servers/other'
    });
    const enterpriseService = createEnterpriseService({
      listMcpConnections: vi.fn(async () => catalog),
      refreshMcpConnections: vi.fn(async () => catalog),
      updateMcpPreference: vi.fn(async (_upstreamId, update) => {
        catalog = {
          ...catalog,
          upstreams: catalog.upstreams.map(upstream => ({
            ...upstream,
            installed: update.installed ?? upstream.installed,
            enabled: update.enabled ?? upstream.enabled
          }))
        };
        return catalog;
      })
    });

    render(
      <ConnectionsPage
        connected
        session={signedInSession()}
        service={enterpriseService}
        mcpService={createMcpService()}
        mcpCapabilities={allCapabilities()}
        onMcpCatalogChange={onMcpCatalogChange}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedInSession())}
        onSessionExpired={vi.fn()}
      />
    );

    await user.click(await screen.findByRole('button', { name: '安装' }));

    expect(enterpriseService.updateMcpPreference).toHaveBeenCalledWith(
      'crm-main',
      { installed: true, enabled: false }
    );
    await waitFor(() => {
      expect(onMcpCatalogChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          upstreams: [expect.objectContaining({ installed: true })]
        })
      );
    });
  });

  it('installs a local Computer Use preset through the native MCP service', async () => {
    const user = userEvent.setup();
    const preset = {
      name: 'computer-use',
      displayName: 'Computer Use',
      description: '使用 OpenAI Computer Use 客户端操作这台 Mac 上的应用。',
      provider: 'OpenAI',
      platform: 'macOS',
      transport: 'stdio' as const,
      command: '/Users/test/.codex/computer-use/SkyComputerUseClient',
      args: ['mcp']
    };
    let native = nativeData({ servers: [], presets: [preset] });
    const addServer = vi.fn(async () => {
      native = nativeData({
        presets: [preset],
        servers: [{
          name: preset.name,
          enabled: true,
          transport: preset.transport,
          status: 'configured',
          command: preset.command,
          args: preset.args,
          envKeys: [],
          hasSecrets: false,
          codexHome: '/tmp/codex',
          codexHomeMode: 'isolated',
          diagnostics: []
        }]
      });
      return { operation: operation('add') };
    });
    const mcpService = createMcpService({
      listServers: vi.fn(async () => native),
      addServer
    });

    render(
      <ConnectionsPage
        connected
        session={signedOutSession()}
        service={createEnterpriseService()}
        mcpService={mcpService}
        mcpCapabilities={allCapabilities()}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedOutSession())}
        onSessionExpired={vi.fn()}
      />
    );

    expect(await screen.findByRole('heading', { name: 'Computer Use' }))
      .toBeInTheDocument();
    expect(screen.getByText(preset.description)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '安装' }));

    expect(addServer).toHaveBeenCalledWith({
      name: 'computer-use',
      transport: 'stdio',
      command: preset.command,
      args: ['mcp']
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('mcp-card')).toHaveLength(1);
      expect(screen.getByRole('switch', { name: 'Computer Use MCP' }))
        .toHaveAttribute('aria-checked', 'true');
    });
  });

  it('does not brand a mismatched same-name server as an OpenAI preset', async () => {
    const preset = {
      name: 'computer-use',
      displayName: 'Computer Use',
      description: '使用 OpenAI Computer Use 客户端操作这台 Mac 上的应用。',
      provider: 'OpenAI',
      platform: 'macOS',
      transport: 'stdio' as const,
      command: '/Users/test/.codex/computer-use/SkyComputerUseClient',
      args: ['mcp']
    };

    render(
      <ConnectionsPage
        connected
        session={signedOutSession()}
        service={createEnterpriseService()}
        mcpService={createMcpService({
          listServers: vi.fn(async () => nativeData({
            presets: [preset],
            servers: [{
              name: 'computer-use',
              enabled: true,
              transport: 'stdio',
              status: 'configured',
              command: '/tmp/untrusted-computer-use',
              args: ['mcp'],
              envKeys: [],
              hasSecrets: false,
              codexHome: '/tmp/codex',
              codexHomeMode: 'isolated',
              diagnostics: []
            }]
          }))
        })}
        mcpCapabilities={allCapabilities()}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedOutSession())}
        onSessionExpired={vi.fn()}
      />
    );

    expect(await screen.findByRole('heading', { name: 'computer-use' }))
      .toBeInTheDocument();
    expect(screen.getAllByTestId('mcp-card')).toHaveLength(1);
    expect(screen.getByText('Codex 原生配置')).toBeInTheDocument();
    expect(screen.queryByText(preset.description)).not.toBeInTheDocument();
  });

  it('offers recovery actions when connector search has no results', async () => {
    const user = userEvent.setup();

    render(
      <ConnectionsPage
        connected
        session={signedOutSession()}
        service={createEnterpriseService()}
        mcpService={createMcpService()}
        mcpCapabilities={allCapabilities()}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedOutSession())}
        onSessionExpired={vi.fn()}
      />
    );

    const search = screen.getByRole('searchbox', { name: '搜索连接器' });
    await screen.findByRole('heading', { name: 'github' });
    await user.type(search, 'missing connector');

    expect(screen.getByText('没有找到匹配的 MCP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清除搜索' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增自定义 MCP' }))
      .toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(await screen.findByRole('heading', { name: 'github' }))
      .toBeInTheDocument();

    await user.type(search, 'still missing');
    await user.click(screen.getByRole('button', { name: '新增自定义 MCP' }));
    expect(screen.getByRole('form', { name: '新增 MCP' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本机命令' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('localizes a stale enterprise MCP catalog error', async () => {
    render(
      <ConnectionsPage
        connected
        session={signedInSession()}
        service={createEnterpriseService({
          refreshMcpConnections: vi.fn(async () => {
            throw new ApiClientError({
              status: 404,
              code: 'ENTERPRISE_MCP_UPSTREAM_NOT_FOUND',
              message: 'Enterprise MCP upstream was not found'
            });
          })
        })}
        mcpService={createMcpService()}
        mcpCapabilities={allCapabilities()}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedInSession())}
        onSessionExpired={vi.fn()}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '企业 MCP 目录已更新，请刷新连接器后重试'
    );
    expect(screen.queryByText('Enterprise MCP upstream was not found'))
      .not.toBeInTheDocument();
  });

  it('disables unsupported native MCP operations by capability', async () => {
    render(
      <ConnectionsPage
        connected
        session={signedOutSession()}
        service={createEnterpriseService()}
        mcpService={createMcpService()}
        mcpCapabilities={{
          ...allCapabilities(),
          mcpLogin: false,
          mcpLogout: false,
          mcpRemove: false
        }}
        onOpenAccount={vi.fn()}
        onRefreshSession={vi.fn(async () => signedOutSession())}
        onSessionExpired={vi.fn()}
      />
    );

    expect(await screen.findByRole('button', { name: '登录 github' }))
      .toBeDisabled();
    expect(screen.getByRole('button', { name: '退出 github' }))
      .toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 github' }))
      .toBeDisabled();
    expect(screen.getByRole('switch', { name: 'github MCP' }))
      .toBeEnabled();
  });
});

function createMcpService(
  overrides: Partial<McpSettingsService> = {}
): McpSettingsService {
  return {
    listServers: vi.fn(async () => nativeData()),
    getServer: vi.fn(async () => ({ server: nativeData().servers[0]! })),
    addServer: vi.fn(async () => ({ operation: operation('add') })),
    setServerEnabled: vi.fn(async (_name, enabled) => ({
      server: { ...nativeData().servers[0]!, enabled },
      operation: operation(enabled ? 'enable' : 'disable')
    })),
    removeServer: vi.fn(async () => ({ removed: true as const })),
    loginServer: vi.fn(async () => ({ operation: operation('login') })),
    logoutServer: vi.fn(async () => ({ operation: operation('logout') })),
    ...overrides
  };
}

function createEnterpriseService(
  overrides: Partial<EnterpriseMcpConnectionService> = {}
): EnterpriseMcpConnectionService {
  return {
    listMcpConnections: vi.fn(async () => enterpriseCatalog()),
    refreshMcpConnections: vi.fn(async () => enterpriseCatalog()),
    updateMcpPreference: vi.fn(async () => enterpriseCatalog()),
    ...overrides
  };
}

function nativeData(
  overrides: Partial<CodexMcpListResponse> = {}
): CodexMcpListResponse {
  return {
    codexHome: '/tmp/codex',
    codexHomeMode: 'isolated',
    requiresWriteConfirmation: false,
    servers: [{
      name: 'github',
      enabled: true,
      transport: 'http',
      status: 'configured',
      url: 'https://enterprise.example/mcp/servers/crm-main',
      envKeys: ['GITHUB_TOKEN'],
      hasSecrets: true,
      codexHome: '/tmp/codex',
      codexHomeMode: 'isolated',
      diagnostics: []
    }],
    presets: [],
    diagnostics: [],
    ...overrides
  };
}

function enterpriseCatalog(
  overrides: Partial<EnterpriseMcpCatalogResponse['upstreams'][number]> = {}
): EnterpriseMcpCatalogResponse {
  return {
    agentId: 'clawee_550e8400-e29b-41d4-a716-446655440000',
    tokenStatus: 'ready',
    refreshedAt: '2026-08-12T10:00:00.000Z',
    upstreams: [{
      upstreamId: 'crm-main',
      name: 'CRM',
      domain: 'sales',
      endpoint: 'https://enterprise.example/mcp/servers/crm-main',
      upstreamTransport: 'streamable_http',
      namespace: 'crm',
      status: 'active',
      installed: false,
      enabled: false,
      tools: [{
        toolId: 'cap_customer_search',
        upstreamName: 'customer.search',
        name: 'customer.search',
        exposedName: 'crm.customer.search',
        title: '查询客户',
        description: '按条件查询客户资料',
        riskLevel: 'low',
        confirmRequired: false,
        status: 'active',
        authorized: true,
        authorizationExpiresAt: null
      }, {
        toolId: 'cap_customer_delete',
        upstreamName: 'customer.delete',
        name: 'customer.delete',
        exposedName: 'crm.customer.delete',
        title: '删除客户',
        description: '删除客户资料',
        riskLevel: 'high',
        confirmRequired: true,
        status: 'active',
        authorized: false,
        authorizationExpiresAt: null
      }],
      ...overrides
    }]
  };
}

function signedInSession(): EnterpriseSessionResponse {
  return {
    status: 'signed_in',
    account: {
      subjectId: 'acct_01JZ8W6A2M4S',
      email: 'member@example.com',
      name: 'Enterprise Member'
    },
    transportSecurity: 'secure_https'
  };
}

function signedOutSession(): EnterpriseSessionResponse {
  return {
    status: 'signed_out',
    transportSecurity: 'secure_https'
  };
}

function allCapabilities() {
  return {
    mcpAdd: true,
    mcpRemove: true,
    mcpLogin: true,
    mcpLogout: true,
    mcpAddEnv: true,
    mcpAddUrl: true,
    mcpAddBearerTokenEnvVar: true,
    mcpAddOAuth: true
  };
}

function operation(
  type: 'add' | 'enable' | 'disable' | 'login' | 'logout'
) {
  return {
    id: `operation-${type}`,
    operation: type,
    codexHome: '/tmp/codex',
    command: ['mcp', type],
    status: 'succeeded' as const,
    timedOut: false,
    createdAt: '2026-08-12T00:00:00.000Z'
  };
}
