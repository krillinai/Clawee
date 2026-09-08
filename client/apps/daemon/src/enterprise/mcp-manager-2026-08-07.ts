import type {
  CodexMcpServerResponse,
  EnterpriseMcpCatalogResponse,
  EnterpriseMcpPreferenceUpdateRequest,
  EnterpriseMcpTokenStatus,
  RuntimeErrorCode
} from '@clawee/protocol';
import { createHash } from 'node:crypto';
import type { AgentToolRunInjection } from '../agent-tools/run-injection.js';
import type { McpManager } from '../codex/mcp/manager.js';
import { MCP_TOOL_TIMEOUT_SEC } from '../task-mcp/constants.js';
import type { RuntimeThread } from '../threads/types.js';
import type {
  EnterpriseAgentIdentityStore
} from './agent-identity-2026-08-02.js';
import type {
  EnterpriseAccountMcpToken,
  EnterpriseHttpClient,
  EnterpriseRemoteMcpCatalog
} from './http-client-2026-07-30.js';
import { EnterpriseHttpError } from './http-client-2026-07-30.js';
import type {
  EnterpriseMcpPreferenceRepository
} from './mcp-preferences-2026-08-07.js';
import type {
  EnterpriseSessionManager
} from './session-manager-2026-07-30.js';

// Used only to migrate MCP entries created by older Clawee releases.
export const ENTERPRISE_MCP_TOKEN_ENV = 'CLAWEE_ENTERPRISE_MCP_TOKEN';

export type EnterpriseMcpManager = {
  listConnections(): Promise<EnterpriseMcpCatalogResponse>;
  refreshConnections(): Promise<EnterpriseMcpCatalogResponse>;
  updatePreference(
    upstreamId: string,
    update: EnterpriseMcpPreferenceUpdateRequest
  ): Promise<EnterpriseMcpCatalogResponse>;
  prepareRuntime(input: {
    runId: string;
    thread: RuntimeThread;
    createdBy: 'api' | 'schedule';
  }): Promise<AgentToolRunInjection | undefined>;
  handleSessionAuthenticated(): void;
  handleSessionSignedOut(): Promise<void>;
};

export class EnterpriseMcpManagerError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly statusCode: number
  ) {
    super(`${code}: enterprise MCP operation failed`);
    this.name = 'EnterpriseMcpManagerError';
  }
}

type CatalogCache = {
  agentId: string;
  catalog: EnterpriseRemoteMcpCatalog;
  tokenStatus: EnterpriseMcpTokenStatus;
  refreshedAt: string;
};

type TokenRefreshResult = {
  status: EnterpriseMcpTokenStatus;
  runtimeConfigurationChanged: boolean;
};

export function createEnterpriseMcpManager(input: {
  enterpriseOrigin?: string;
  agentIdentityStore: EnterpriseAgentIdentityStore;
  sessionManager: EnterpriseSessionManager;
  httpClient: EnterpriseHttpClient;
  mcpManager: Pick<
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
  legacyPreferences?: EnterpriseMcpPreferenceRepository;
  onRuntimeConfigurationChanged?(reason: string): void;
  now?: () => Date;
}): EnterpriseMcpManager {
  const now = input.now ?? (() => new Date());
  let cache: CatalogCache | undefined;
  let refreshWork: Promise<CatalogCache> | undefined;
  let legacyMigrationWork: Promise<CodexMcpServerResponse[]> | undefined;
  let sessionSignOutWork: Promise<void> | undefined;
  let currentToken: EnterpriseAccountMcpToken | undefined;
  let currentAgentId: string | undefined;
  let tokenSynchronizationRequired = false;

  async function refreshRemote(forceNativeRefresh = false): Promise<CatalogCache> {
    refreshWork ??= (async () => {
      const accessToken = await input.sessionManager.requireAccessToken();
      const agentId = await input.agentIdentityStore.getOrCreate();
      const previousCatalog = cache?.catalog;
      try {
        const catalog = await input.httpClient.getMcpCatalog(accessToken);
        const tokenRefresh = await refreshToken(
          accessToken,
          agentId,
          catalog,
          forceNativeRefresh
        );
        const next = {
          agentId,
          catalog,
          tokenStatus: tokenRefresh.status,
          refreshedAt: now().toISOString()
        };
        cache = next;
        if (tokenRefresh.runtimeConfigurationChanged) {
          input.onRuntimeConfigurationChanged?.('enterprise_mcp_token_changed');
        } else if (
          previousCatalog !== undefined
          && runtimeCatalogChanged(previousCatalog, catalog)
        ) {
          input.onRuntimeConfigurationChanged?.('enterprise_mcp_catalog_changed');
        }
        return next;
      } catch (error) {
        await handleRemoteFailure(error);
        throw mapManagerError(error);
      }
    })().finally(() => {
      refreshWork = undefined;
    });
    return refreshWork;
  }

  async function refreshToken(
    accessToken: string,
    expectedAgentId: string,
    catalog: EnterpriseRemoteMcpCatalog,
    forceNativeRefresh = false
  ): Promise<TokenRefreshResult> {
    const previous = currentToken;
    const previousAgentId = currentAgentId;
    try {
      const token = await input.httpClient.revealAccountMcpToken(accessToken);
      let codexConfigurationChanged: boolean;
      try {
        codexConfigurationChanged = await syncBearerToken(
          catalog,
          token.token,
          expectedAgentId,
          forceNativeRefresh
        );
      } catch (error) {
        tokenSynchronizationRequired = true;
        throw error;
      }
      currentToken = token;
      currentAgentId = expectedAgentId;
      tokenSynchronizationRequired = false;
      return {
        status: 'ready',
        runtimeConfigurationChanged:
          codexConfigurationChanged
          || (
            previous !== undefined
            && previous.fingerprint !== token.fingerprint
          )
          || (
            previousAgentId !== undefined
            && previousAgentId !== expectedAgentId
          )
      };
    } catch (error) {
      if (
        error instanceof EnterpriseHttpError
        && error.code === 'ENTERPRISE_MCP_TOKEN_NOT_FOUND'
      ) {
        currentToken = undefined;
        let codexConfigurationChanged: boolean;
        try {
          codexConfigurationChanged = await syncBearerToken(
            catalog,
            undefined,
            undefined,
            forceNativeRefresh
          );
        } catch (syncError) {
          tokenSynchronizationRequired = true;
          throw syncError;
        }
        currentAgentId = expectedAgentId;
        tokenSynchronizationRequired = false;
        return {
          status: 'missing',
          runtimeConfigurationChanged:
            previous !== undefined || codexConfigurationChanged
        };
      }
      throw error;
    }
  }

  async function currentCache(): Promise<CatalogCache> {
    return cache ?? refreshRemote();
  }

  async function responseFrom(current: CatalogCache) {
    const nativeServers = await listNativeServersWithLegacyMigration(current);
    return {
      agentId: current.agentId,
      tokenStatus: current.tokenStatus,
      upstreams: current.catalog.upstreams.map(upstream => {
        const codexServerName = chooseMcpServerName(upstream, nativeServers);
        const installed = findInstalledServer(
          nativeServers,
          codexServerName,
          upstream.endpoint
        );
        return {
          ...upstream,
          codexServerName,
          ...(installed === undefined
            ? {}
            : { installedServerName: installed.name }),
          installed: installed !== undefined,
          enabled: installed?.enabled ?? false
        };
      }),
      refreshedAt: current.refreshedAt
    } satisfies EnterpriseMcpCatalogResponse;
  }

  async function listNativeServersWithLegacyMigration(
    current: CatalogCache
  ): Promise<CodexMcpServerResponse[]> {
    let nativeServers = await requireNativeServers();
    legacyMigrationWork ??= (async () => {
      let changed = false;
      if (
        input.legacyPreferences !== undefined
        && input.enterpriseOrigin !== undefined
      ) {
        const preferences = input.legacyPreferences.list(
          input.enterpriseOrigin,
          current.agentId
        );
        for (const preference of preferences) {
          const upstream = current.catalog.upstreams.find(
            candidate => candidate.upstreamId === preference.upstreamId
          );
          if (!preference.installed || upstream === undefined) {
            input.legacyPreferences.delete(
              input.enterpriseOrigin,
              current.agentId,
              preference.upstreamId
            );
            continue;
          }
          const existing = findInstalledServer(
            nativeServers,
            semanticMcpServerName(upstream),
            upstream.endpoint
          );
          if (existing !== undefined) {
            input.legacyPreferences.delete(
              input.enterpriseOrigin,
              current.agentId,
              preference.upstreamId
            );
            continue;
          }
          try {
            const serverName = chooseMcpServerName(upstream, nativeServers);
            const installed = await input.mcpManager.addServer({
              name: serverName,
              transport: 'http',
              url: upstream.endpoint,
              confirmWriteToCodexHome: true
            });
            const server = installed.server
              ?? await input.mcpManager.getServer(serverName);
            if (isTaskServiceUpstream(upstream)) {
              await input.mcpManager.setServerToolTimeout(
                server.name,
                MCP_TOOL_TIMEOUT_SEC,
                true
              );
            }
            if (server.enabled !== preference.enabled) {
              await input.mcpManager.setServerEnabled(
                server.name,
                preference.enabled,
                true
              );
            }
            if (currentToken !== undefined) {
              await input.mcpManager.setServerBearerToken(
                server.name,
                currentToken.token,
                current.agentId,
                true
              );
            }
            input.legacyPreferences.delete(
              input.enterpriseOrigin,
              current.agentId,
              preference.upstreamId
            );
            changed = true;
          } catch (error) {
            tokenSynchronizationRequired = currentToken !== undefined;
            throw mapCodexManagerError(error);
          }
        }
      }

      if (changed) nativeServers = await requireNativeServers();
      for (const upstream of current.catalog.upstreams) {
        const installed = nativeServers.find(server => (
          server.url === upstream.endpoint
          && server.name.startsWith('enterprise_')
        ));
        if (installed === undefined) continue;
        const nextName = chooseMcpServerName(
          upstream,
          nativeServers.filter(server => server.name !== installed.name)
        );
        if (installed.name === nextName) continue;
        try {
          await input.mcpManager.renameServer(installed.name, nextName, true);
          changed = true;
          nativeServers = nativeServers.map(server => (
            server.name === installed.name ? { ...server, name: nextName } : server
          ));
        } catch (error) {
          throw mapCodexManagerError(error);
        }
      }
      return changed
        ? await requireNativeServers()
        : nativeServers;
    })().finally(() => {
      legacyMigrationWork = undefined;
    });
    nativeServers = await legacyMigrationWork;
    return nativeServers;
  }

  async function requireNativeServers(
    forceRefresh = false
  ): Promise<CodexMcpServerResponse[]> {
    let result;
    try {
      result = await input.mcpManager.listServers(
        forceRefresh ? { forceRefresh: true } : undefined
      );
    } catch (error) {
      throw mapCodexManagerError(error);
    }
    if (result.runtimeAvailable === false) {
      throw new EnterpriseMcpManagerError(
        'ENTERPRISE_MCP_RUNTIME_UNAVAILABLE',
        503
      );
    }
    return result.servers;
  }

  async function syncBearerToken(
    catalog: EnterpriseRemoteMcpCatalog,
    token: string | undefined,
    agentId: string | undefined,
    forceNativeRefresh = false
  ): Promise<boolean> {
    const nativeServers = await requireNativeServers(forceNativeRefresh);
    let changed = false;
    for (const upstream of catalog.upstreams) {
      const installed = findInstalledServer(
        nativeServers,
        semanticMcpServerName(upstream),
        upstream.endpoint
      );
      if (installed === undefined) continue;
      try {
        changed = await input.mcpManager.setServerBearerToken(
          installed.name,
          token,
          agentId,
          true
        ) || changed;
      } catch (error) {
        throw mapCodexManagerError(error);
      }
    }
    return changed;
  }

  async function clearManagedBearerTokens(
    catalog?: EnterpriseRemoteMcpCatalog
  ): Promise<boolean> {
    try {
      return await input.mcpManager.clearServerBearerTokens({
        names: catalog?.upstreams.map(upstream =>
          semanticMcpServerName(upstream)
        ),
        urls: catalog?.upstreams.map(upstream => upstream.endpoint),
        namePrefix: 'enterprise_',
        legacyBearerTokenEnvVar: ENTERPRISE_MCP_TOKEN_ENV
      }, true);
    } catch (error) {
      throw mapCodexManagerError(error);
    }
  }

  async function ensureRuntimeToken(current: CatalogCache): Promise<void> {
    const agentId = await input.agentIdentityStore.getOrCreate();
    const token = currentToken;
    if (
      token !== undefined
      && currentAgentId === agentId
      && !tokenSynchronizationRequired
      && !isExpired(token.expiresAt, now())
    ) {
      return;
    }
    if (
      token !== undefined
      && !tokenSynchronizationRequired
      && !isExpired(token.expiresAt, now())
    ) {
      let changed: boolean;
      try {
        changed = await syncBearerToken(
          current.catalog,
          token.token,
          agentId
        );
      } catch (error) {
        tokenSynchronizationRequired = true;
        throw error;
      }
      current.agentId = agentId;
      currentAgentId = agentId;
      tokenSynchronizationRequired = false;
      if (changed) {
        input.onRuntimeConfigurationChanged?.('enterprise_mcp_token_changed');
      }
      return;
    }
    try {
      const accessToken = await input.sessionManager.requireAccessToken();
      const refresh = await refreshToken(
        accessToken,
        agentId,
        current.catalog
      );
      current.agentId = agentId;
      current.tokenStatus = refresh.status;
      current.refreshedAt = now().toISOString();
      if (refresh.runtimeConfigurationChanged) {
        input.onRuntimeConfigurationChanged?.('enterprise_mcp_token_changed');
      }
      if (refresh.status === 'missing') {
        throw new EnterpriseMcpManagerError(
          'ENTERPRISE_MCP_TOKEN_NOT_FOUND',
          404
        );
      }
    } catch (error) {
      await handleRemoteFailure(error);
      throw mapManagerError(error);
    }
  }

  async function handleRemoteFailure(error: unknown): Promise<void> {
    if (
      !(error instanceof EnterpriseHttpError)
      || error.code !== 'ENTERPRISE_UNAUTHORIZED'
    ) {
      return;
    }
    const previousCatalog = cache?.catalog;
    cache = undefined;
    currentToken = undefined;
    currentAgentId = undefined;
    tokenSynchronizationRequired = false;
    await input.sessionManager.invalidateUnauthorized().catch(() => undefined);
    await clearManagedBearerTokens(previousCatalog).catch(() => undefined);
    input.onRuntimeConfigurationChanged?.('enterprise_session_expired');
  }

  return {
    async listConnections() {
      return responseFrom(await currentCache());
    },
    async refreshConnections() {
      return responseFrom(await refreshRemote(true));
    },
    async updatePreference(upstreamId, update) {
      const current = await currentCache();
      const upstream = current.catalog.upstreams.find(
        candidate => candidate.upstreamId === upstreamId
      );
      if (upstream === undefined) {
        throw new EnterpriseMcpManagerError(
          'ENTERPRISE_MCP_UPSTREAM_NOT_FOUND',
          404
        );
      }
      const confirmation = update.confirmWriteToCodexHome === true;
      const nativeServers = await requireNativeServers();
      const codexServerName = chooseMcpServerName(upstream, nativeServers);
      let installed = findInstalledServer(
        nativeServers,
        codexServerName,
        upstream.endpoint
      );

      if (
        update.enabled === true
        && installed === undefined
        && update.installed !== true
      ) {
        throw new EnterpriseMcpManagerError(
          'ENTERPRISE_INVALID_REQUEST',
          400
        );
      }

      if (update.installed === true && installed === undefined) {
        try {
          const result = await input.mcpManager.addServer({
            name: codexServerName,
            transport: 'http',
            url: upstream.endpoint,
            ...(confirmation
              ? { confirmWriteToCodexHome: true }
              : {})
          });
          installed = result.server
            ?? await input.mcpManager.getServer(codexServerName)
            ?? findInstalledServer(
              await requireNativeServers(),
              codexServerName,
              upstream.endpoint
            );
          if (installed === undefined) {
            throw new Error('MCP_SERVER_NOT_FOUND: installed MCP was not found');
          }
          if (isTaskServiceUpstream(upstream)) {
            await input.mcpManager.setServerToolTimeout(
              installed.name,
              MCP_TOOL_TIMEOUT_SEC,
              confirmation
            );
          }
          if (currentToken !== undefined) {
            try {
              await input.mcpManager.setServerBearerToken(
                installed.name,
                currentToken.token,
                current.agentId,
                confirmation
              );
            } catch (error) {
              tokenSynchronizationRequired = true;
              throw error;
            }
          }
          if (update.enabled !== true && installed.enabled) {
            const result = await input.mcpManager.setServerEnabled(
              installed.name,
              false,
              confirmation
            );
            installed = result.server;
          }
        } catch (error) {
          throw mapCodexManagerError(error);
        }
      }

      if (update.installed === false && installed !== undefined) {
        try {
          await input.mcpManager.removeServer(installed.name, confirmation);
          installed = undefined;
        } catch (error) {
          throw mapCodexManagerError(error);
        }
      } else if (
        update.enabled !== undefined
        && installed !== undefined
        && installed.enabled !== update.enabled
      ) {
        try {
          const result = await input.mcpManager.setServerEnabled(
            installed.name,
            update.enabled,
            confirmation
          );
          installed = result.server;
        } catch (error) {
          throw mapCodexManagerError(error);
        }
      }

      if (update.enabled === true && installed === undefined) {
        throw new EnterpriseMcpManagerError(
          'ENTERPRISE_INVALID_REQUEST',
          400
        );
      }
      return responseFrom(current);
    },
    async prepareRuntime(run) {
      void run;
      if (input.sessionManager.getSnapshot().status !== 'signed_in') {
        return undefined;
      }
      const enterpriseServers = (await requireNativeServers())
        .filter(server =>
          server.enabled
          && (
            server.name.startsWith('enterprise_')
            || server.bearerTokenEnvVar === ENTERPRISE_MCP_TOKEN_ENV
            || cache?.catalog.upstreams.some(upstream =>
              upstream.endpoint === server.url
            ) === true
          )
        );
      if (enterpriseServers.length === 0) return undefined;

      const current = await currentCache();
      for (const server of enterpriseServers) {
        const upstream = current.catalog.upstreams.find(candidate =>
          candidate.endpoint === server.url
          || semanticMcpServerName(candidate) === server.name
        );
        if (upstream === undefined || !isTaskServiceUpstream(upstream)) continue;
        await input.mcpManager.setServerToolTimeout(
          server.name,
          MCP_TOOL_TIMEOUT_SEC,
          true
        );
      }

      await ensureRuntimeToken(current);
      return undefined;
    },
    handleSessionAuthenticated() {
      cache = undefined;
      currentToken = undefined;
      currentAgentId = undefined;
      tokenSynchronizationRequired = false;
      input.onRuntimeConfigurationChanged?.('enterprise_session_changed');
    },
    async handleSessionSignedOut() {
      sessionSignOutWork ??= (async () => {
        const previousCatalog = cache?.catalog;
        const hadCachedConfiguration = cache !== undefined;
        const hadToken = currentToken !== undefined;
        cache = undefined;
        currentToken = undefined;
        currentAgentId = undefined;
        tokenSynchronizationRequired = false;
        const codexConfigurationChanged = await clearManagedBearerTokens(
          previousCatalog
        );
        if (
          hadCachedConfiguration
          || hadToken
          || codexConfigurationChanged
        ) {
          input.onRuntimeConfigurationChanged?.('enterprise_session_signed_out');
        }
      })().finally(() => {
        sessionSignOutWork = undefined;
      });
      return sessionSignOutWork;
    }
  };
}

function isExpired(expiresAt: string | null, now: Date): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= now.getTime();
}

function semanticMcpServerName(
  upstream: EnterpriseRemoteMcpCatalog['upstreams'][number]
): string {
  const readable = [upstream.namespace, upstream.name, upstream.upstreamId]
    .map(value => value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64)
    )
    .find(Boolean) ?? 'upstream';
  return `enterprise_${readable}`;
}

function chooseMcpServerName(
  upstream: EnterpriseRemoteMcpCatalog['upstreams'][number],
  servers: CodexMcpServerResponse[]
): string {
  const semanticName = semanticMcpServerName(upstream);
  const occupied = servers.find(server => server.name === semanticName);
  if (occupied === undefined || occupied.url === upstream.endpoint) {
    return semanticName;
  }
  const suffix = createHash('sha256')
    .update(upstream.upstreamId)
    .digest('hex')
    .slice(0, 6);
  return `${semanticName.slice(0, 73)}_${suffix}`;
}

function isTaskServiceUpstream(
  upstream: EnterpriseRemoteMcpCatalog['upstreams'][number]
): boolean {
  return upstream.tools.some(tool =>
    tool.name === 'clawee_submit_task'
    || tool.upstreamName === 'clawee_submit_task'
    || tool.exposedName === 'clawee_submit_task'
  );
}

function findInstalledServer(
  servers: CodexMcpServerResponse[],
  expectedName: string,
  endpoint: string
): CodexMcpServerResponse | undefined {
  return servers.find(server => server.url === endpoint)
    ?? servers.find(server => server.name === expectedName);
}

function mapCodexManagerError(error: unknown): EnterpriseMcpManagerError {
  if (!(error instanceof Error)) {
    return new EnterpriseMcpManagerError(
      'ENTERPRISE_MCP_RUNTIME_UNAVAILABLE',
      503
    );
  }
  const code = error.message.split(':', 1)[0];
  if (code === 'MCP_WRITE_CONFIRMATION_REQUIRED') {
    return new EnterpriseMcpManagerError('MCP_WRITE_CONFIRMATION_REQUIRED', 409);
  }
  if (code === 'MCP_SERVER_NOT_FOUND') {
    return new EnterpriseMcpManagerError(
      'ENTERPRISE_MCP_UPSTREAM_NOT_FOUND',
      404
    );
  }
  if (code === 'CODEX_INCOMPATIBLE') {
    return new EnterpriseMcpManagerError('CODEX_INCOMPATIBLE', 501);
  }
  return new EnterpriseMcpManagerError(
    'ENTERPRISE_MCP_RUNTIME_UNAVAILABLE',
    503
  );
}

function runtimeCatalogChanged(
  previous: EnterpriseRemoteMcpCatalog,
  next: EnterpriseRemoteMcpCatalog
): boolean {
  const runtimeShape = (catalog: EnterpriseRemoteMcpCatalog) => (
    catalog.upstreams
      .map(upstream => ({
        endpoint: upstream.endpoint,
        upstreamId: upstream.upstreamId
      }))
      .sort((left, right) => left.upstreamId.localeCompare(right.upstreamId))
  );
  return JSON.stringify(runtimeShape(previous)) !== JSON.stringify(runtimeShape(next));
}

function mapManagerError(error: unknown): EnterpriseMcpManagerError {
  if (error instanceof EnterpriseMcpManagerError) return error;
  if (error instanceof EnterpriseHttpError) {
    return new EnterpriseMcpManagerError(
      error.code,
      managerHttpStatus(error)
    );
  }
  return new EnterpriseMcpManagerError(
    'ENTERPRISE_MCP_RUNTIME_UNAVAILABLE',
    503
  );
}

function managerHttpStatus(error: EnterpriseHttpError): number {
  if (error.statusCode !== undefined && error.statusCode >= 400) {
    return error.statusCode;
  }
  switch (error.code) {
    case 'ENTERPRISE_INVALID_REQUEST':
      return 400;
    case 'ENTERPRISE_UNAUTHORIZED':
    case 'ENTERPRISE_SESSION_EXPIRED':
      return 401;
    case 'ENTERPRISE_FORBIDDEN':
    case 'ENTERPRISE_AGENT_FORBIDDEN':
      return 403;
    case 'ENTERPRISE_MCP_TOKEN_NOT_FOUND':
    case 'ENTERPRISE_MCP_UPSTREAM_NOT_FOUND':
      return 404;
    case 'ENTERPRISE_RATE_LIMITED':
      return 429;
    case 'ENTERPRISE_SERVICE_UNAVAILABLE':
      return 503;
    case 'ENTERPRISE_PROTOCOL_ERROR':
      return 502;
    default:
      return 500;
  }
}
