import type {
  CodexMcpListResponse,
  CodexMcpOperationResponse,
  CodexMcpOperationType,
  CodexMcpServerResponse
} from '@clawee/protocol';
import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeCapabilityMatrix } from '../capabilities.js';
import type { ResolvedCodexHome } from '../home.js';
import {
  buildMcpAddArgs,
  buildMcpGetArgs,
  buildMcpListArgs,
  buildMcpLoginArgs,
  buildMcpLogoutArgs,
  buildMcpRemoveArgs
} from './argv.js';
import {
  clearCodexMcpServerBearerTokens,
  renameCodexMcpServer,
  setCodexMcpServerBearerToken,
  setCodexMcpServerEnabled,
  setCodexMcpServerToolTimeout
} from './config-store-2026-08-12.js';
import { createMcpOperationRepository } from './operations.js';
import { isMcpNotFoundOutput, parseMcpGetOutput, parseMcpListOutput } from './parser.js';
import type { McpPresetProvider } from './presets.js';
import { runMcpCommand, type McpCommandResult } from './runner.js';
import type { AddMcpServerInput, McpAddCapabilityFlags } from './types.js';
import { assertMcpAddRequestSupported } from './validator.js';

const DEFAULT_LIST_CACHE_TTL_MS = 30_000;

export type ListMcpServersOptions = {
  forceRefresh?: boolean;
};

export type McpPerformanceEvent =
  | {
      component: 'codex_mcp';
      event: 'command_completed';
      operation: CodexMcpOperationType;
      serverName: string | null;
      durationMs: number;
      exitCode: number | null;
      timedOut: boolean;
    }
  | {
      component: 'codex_mcp';
      event: 'list_cache';
      outcome: 'hit' | 'miss' | 'joined';
      reason?: 'empty' | 'expired' | 'config_changed' | 'forced';
      ageMs?: number;
    };

export type McpManager = {
  listServers(options?: ListMcpServersOptions): Promise<CodexMcpListResponse>;
  getServer(name: string): Promise<CodexMcpServerResponse>;
  addServer(input: AddMcpServerInput): Promise<{
    server?: CodexMcpServerResponse;
    operation: CodexMcpOperationResponse;
  }>;
  removeServer(
    name: string,
    confirmed: boolean
  ): Promise<{ removed: true; operation: CodexMcpOperationResponse }>;
  renameServer(
    currentName: string,
    nextName: string,
    confirmed: boolean
  ): Promise<CodexMcpServerResponse>;
  setServerEnabled(
    name: string,
    enabled: boolean,
    confirmed: boolean
  ): Promise<{
    server: CodexMcpServerResponse;
    operation: CodexMcpOperationResponse;
  }>;
  setServerBearerToken(
    name: string,
    token: string | undefined,
    agentId: string | undefined,
    confirmed: boolean
  ): Promise<boolean>;
  setServerToolTimeout(
    name: string,
    timeoutSec: number,
    confirmed: boolean
  ): Promise<boolean>;
  clearServerBearerTokens(
    input: {
      names?: string[];
      urls?: string[];
      namePrefix?: string;
      legacyBearerTokenEnvVar?: string;
    },
    confirmed: boolean
  ): Promise<boolean>;
  loginServer(name: string, confirmed: boolean): Promise<{ operation: CodexMcpOperationResponse }>;
  logoutServer(name: string, confirmed: boolean): Promise<{ operation: CodexMcpOperationResponse }>;
  listOperations(limit?: number): CodexMcpOperationResponse[];
};

export function createMcpManager(input: {
  codexBin: string;
  codexHome: ResolvedCodexHome;
  db: Database.Database;
  capabilities: Pick<RuntimeCapabilityMatrix, keyof McpAddCapabilityFlags>;
  timeoutMs?: number;
  listCacheTtlMs?: number;
  now?: () => number;
  onPerformanceEvent?(event: McpPerformanceEvent): void;
  onConfigurationChanged?(reason: string): void;
  presetProvider?: McpPresetProvider;
}): McpManager {
  const operations = createMcpOperationRepository(input.db);
  const now = input.now ?? Date.now;
  const listCacheTtlMs = input.listCacheTtlMs ?? DEFAULT_LIST_CACHE_TTL_MS;
  let configWriteQueue = Promise.resolve();
  let listCache:
    | {
        response: CodexMcpListResponse;
        fingerprint: string;
        loadedAt: number;
      }
    | undefined;
  let listWork: Promise<CodexMcpListResponse> | undefined;
  let listCacheGeneration = 0;
  const reportPerformance = (event: McpPerformanceEvent) => {
    try {
      input.onPerformanceEvent?.(event);
    } catch {
      // Diagnostics must not change MCP command behavior.
    }
  };

  const run = async (
    operation: CodexMcpOperationType,
    serverName: string | null,
    args: string[],
    sensitiveValues: string[] = []
  ) => {
    const startedAt = performance.now();
    const result = await runMcpCommand({
      codexBin: input.codexBin,
      codexHome: input.codexHome.path,
      args,
      timeoutMs: input.timeoutMs,
      sensitiveValues
    });
    reportPerformance({
      component: 'codex_mcp',
      event: 'command_completed',
      operation,
      serverName,
      durationMs: Math.round(performance.now() - startedAt),
      exitCode: result.exitCode,
      timedOut: result.timedOut
    });
    const operationResponse = operations.insertOperation({
      operation,
      serverName,
      codexHome: input.codexHome.path,
      command: result.redactedCommand,
      status: result.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ...(result.exitCode === 0
        ? {}
        : {
            errorCode: getMcpErrorCode(result),
            errorMessage: getMcpErrorMessage(result)
          })
    });
    return { result, operation: operationResponse };
  };

  const invalidateListCache = () => {
    listCache = undefined;
    listCacheGeneration += 1;
  };

  const listServers = async (
    options: ListMcpServersOptions = {}
  ): Promise<CodexMcpListResponse> => {
    const fingerprint = await getConfigFingerprint(input.codexHome.path);
    if (
      options.forceRefresh !== true
      && listCache !== undefined
      && listCache.fingerprint === fingerprint
      && now() - listCache.loadedAt < listCacheTtlMs
    ) {
      reportPerformance({
        component: 'codex_mcp',
        event: 'list_cache',
        outcome: 'hit',
        ageMs: Math.max(0, now() - listCache.loadedAt)
      });
      return listCache.response;
    }
    if (listWork !== undefined) {
      reportPerformance({
        component: 'codex_mcp',
        event: 'list_cache',
        outcome: 'joined'
      });
      return listWork;
    }
    reportPerformance({
      component: 'codex_mcp',
      event: 'list_cache',
      outcome: 'miss',
      reason: options.forceRefresh === true
        ? 'forced'
        : listCache === undefined
          ? 'empty'
          : listCache.fingerprint !== fingerprint
            ? 'config_changed'
            : 'expired'
    });

    const generation = listCacheGeneration;
    listWork = (async () => {
      const [{ result }, presets] = await Promise.all([
        run('list', null, buildMcpListArgs()),
        input.presetProvider?.().catch(() => []) ?? Promise.resolve([])
      ]);
      const response = result.exitCode !== 0
        ? {
            codexHome: input.codexHome.path,
            codexHomeMode: input.codexHome.mode,
            requiresWriteConfirmation: input.codexHome.mode === 'global',
            runtimeAvailable: false,
            servers: [],
            presets,
            diagnostics: [getMcpErrorMessage(result)]
          }
        : {
            ...parseMcpListOutput({
              codexHome: input.codexHome.path,
              codexHomeMode: input.codexHome.mode,
              stdout: result.stdout,
              stderr: result.redactedStderr,
              exitCode: result.exitCode
            }),
            presets,
            runtimeAvailable: true
          };
      if (generation === listCacheGeneration) {
        listCache = {
          response,
          fingerprint: await getConfigFingerprint(input.codexHome.path),
          loadedAt: now()
        };
      }
      return response;
    })().finally(() => {
      listWork = undefined;
    });
    return listWork;
  };

  const getServer = async (name: string): Promise<CodexMcpServerResponse> => {
    const { result } = await run('get', name, buildMcpGetArgs(name));
    assertCommandSucceeded(result);
    return parseMcpGetOutput({
      name,
      codexHome: input.codexHome.path,
      codexHomeMode: input.codexHome.mode,
      stdout: result.stdout,
      stderr: result.redactedStderr,
      exitCode: result.exitCode
    });
  };

  const addServer: McpManager['addServer'] = async (request) => {
    requireWriteConfirmation(input.codexHome, request.confirmWriteToCodexHome === true);
    const supported = assertMcpAddRequestSupported(request, input.capabilities);
    if (!supported.ok) {
      throw new Error(`${supported.code}: ${supported.message}`);
    }
    const { result, operation } = await run(
      'add',
      request.name,
      buildMcpAddArgs(request),
      Object.values(request.env ?? {})
    );
    assertCommandSucceeded(result);
    invalidateListCache();
    input.onConfigurationChanged?.('codex_mcp_added');

    let server: CodexMcpServerResponse | undefined;
    try {
      server = await getServer(request.name);
    } catch {
      server = undefined;
    }
    return { server, operation };
  };

  const removeServer: McpManager['removeServer'] = async (name, confirmed) => {
    requireWriteConfirmation(input.codexHome, confirmed);
    const { result, operation } = await run(
      'remove',
      name,
      buildMcpRemoveArgs(name)
    );
    assertCommandSucceeded(result);
    invalidateListCache();
    input.onConfigurationChanged?.('codex_mcp_removed');
    return { removed: true, operation };
  };

  const renameServer: McpManager['renameServer'] = async (
    currentName,
    nextName,
    confirmed
  ) => {
    requireWriteConfirmation(input.codexHome, confirmed);
    const write = configWriteQueue.then(() =>
      renameCodexMcpServer({
        codexHome: input.codexHome.path,
        currentName,
        nextName
      })
    );
    configWriteQueue = write.then(() => undefined, () => undefined);
    const changed = await write;
    if (changed) {
      invalidateListCache();
      input.onConfigurationChanged?.('codex_mcp_renamed');
    }
    return await getServer(nextName);
  };

  const setServerEnabled: McpManager['setServerEnabled'] = async (
    name,
    enabled,
    confirmed
  ) => {
    requireWriteConfirmation(input.codexHome, confirmed);
    const operationType = enabled ? 'enable' : 'disable';
    const command = [
      'config',
      'set',
      `mcp_servers.${name}.enabled=${String(enabled)}`
    ];
    let operation: CodexMcpOperationResponse;
    try {
      const write = configWriteQueue.then(async () => {
        try {
          await setCodexMcpServerEnabled({
            codexHome: input.codexHome.path,
            name,
            enabled
          });
        } catch (error) {
          if (getConfigWriteErrorCode(error) !== 'MCP_SERVER_NOT_FOUND') {
            throw error;
          }
          const discoveredServer = await getServer(name);
          await setCodexMcpServerEnabled({
            codexHome: input.codexHome.path,
            name,
            enabled,
            fallbackServer: discoveredServer
          });
        }
      });
      configWriteQueue = write.catch(() => undefined);
      await write;
      operation = operations.insertOperation({
        operation: operationType,
        serverName: name,
        codexHome: input.codexHome.path,
        command,
        status: 'succeeded',
        exitCode: 0,
        timedOut: false
      });
      invalidateListCache();
      input.onConfigurationChanged?.(
        enabled ? 'codex_mcp_enabled' : 'codex_mcp_disabled'
      );
    } catch (error) {
      operations.insertOperation({
        operation: operationType,
        serverName: name,
        codexHome: input.codexHome.path,
        command,
        status: 'failed',
        exitCode: 1,
        timedOut: false,
        errorCode: getConfigWriteErrorCode(error),
        errorMessage: getConfigWriteErrorMessage(error)
      });
      throw error;
    }
    return {
      server: await getServer(name),
      operation
    };
  };

  const loginServer: McpManager['loginServer'] = async (name, confirmed) => {
    requireWriteConfirmation(input.codexHome, confirmed);
    const { result, operation } = await run(
      'login',
      name,
      buildMcpLoginArgs(name)
    );
    assertCommandSucceeded(result);
    invalidateListCache();
    input.onConfigurationChanged?.('codex_mcp_login_changed');
    return { operation };
  };

  const logoutServer: McpManager['logoutServer'] = async (name, confirmed) => {
    requireWriteConfirmation(input.codexHome, confirmed);
    const { result, operation } = await run(
      'logout',
      name,
      buildMcpLogoutArgs(name)
    );
    assertCommandSucceeded(result);
    invalidateListCache();
    input.onConfigurationChanged?.('codex_mcp_login_changed');
    return { operation };
  };

  const setServerBearerToken: McpManager['setServerBearerToken'] = async (
    name,
    token,
    agentId,
    confirmed
  ) => {
    requireWriteConfirmation(input.codexHome, confirmed);
    const write = configWriteQueue.then(() =>
      setCodexMcpServerBearerToken({
        codexHome: input.codexHome.path,
        name,
        token,
        agentId
      })
    );
    configWriteQueue = write.then(() => undefined, () => undefined);
    const changed = await write;
    if (changed) {
      invalidateListCache();
      input.onConfigurationChanged?.(
        token === undefined
          ? 'codex_mcp_bearer_token_removed'
          : 'codex_mcp_bearer_token_changed'
      );
    }
    return changed;
  };

  const setServerToolTimeout: McpManager['setServerToolTimeout'] = async (
    name,
    timeoutSec,
    confirmed
  ) => {
    requireWriteConfirmation(input.codexHome, confirmed);
    const write = configWriteQueue.then(() =>
      setCodexMcpServerToolTimeout({
        codexHome: input.codexHome.path,
        name,
        timeoutSec
      })
    );
    configWriteQueue = write.then(() => undefined, () => undefined);
    const changed = await write;
    if (changed) {
      invalidateListCache();
      input.onConfigurationChanged?.('codex_mcp_tool_timeout_changed');
    }
    return changed;
  };

  const clearServerBearerTokens: McpManager['clearServerBearerTokens'] = async (
    request,
    confirmed
  ) => {
    requireWriteConfirmation(input.codexHome, confirmed);
    const write = configWriteQueue.then(() =>
      clearCodexMcpServerBearerTokens({
        codexHome: input.codexHome.path,
        ...request
      })
    );
    configWriteQueue = write.then(() => undefined, () => undefined);
    const changed = await write;
    if (changed) {
      invalidateListCache();
      input.onConfigurationChanged?.('codex_mcp_bearer_tokens_removed');
    }
    return changed;
  };

  return {
    listServers,
    getServer,
    addServer,
    removeServer,
    renameServer,
    setServerEnabled,
    setServerBearerToken,
    setServerToolTimeout,
    clearServerBearerTokens,
    loginServer,
    logoutServer,
    listOperations(limit) {
      return operations.listOperations(limit);
    }
  };
}

async function getConfigFingerprint(codexHome: string): Promise<string> {
  try {
    const info = await stat(join(codexHome, 'config.toml'));
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (isMissingFile(error)) return 'missing';
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
  );
}

function getConfigWriteErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'MCP_COMMAND_FAILED';
  return error.message.split(':', 1)[0] || 'MCP_COMMAND_FAILED';
}

function getConfigWriteErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Codex MCP config write failed';
  const separator = error.message.indexOf(':');
  return separator < 0
    ? error.message
    : error.message.slice(separator + 1).trim();
}

function requireWriteConfirmation(codexHome: ResolvedCodexHome, confirmed: boolean): void {
  if (codexHome.mode === 'global' && !confirmed) {
    throw new Error(
      'MCP_WRITE_CONFIRMATION_REQUIRED: global CODEX_HOME MCP write requires confirmation'
    );
  }
}

function assertCommandSucceeded(result: McpCommandResult): void {
  if (result.exitCode === 0) return;
  throw new Error(`${getMcpErrorCode(result)}: ${getMcpErrorMessage(result)}`);
}

function getMcpErrorCode(result: McpCommandResult): 'MCP_SERVER_NOT_FOUND' | 'MCP_COMMAND_FAILED' {
  return isMcpNotFoundOutput(`${result.stdout}\n${result.stderr}`) ? 'MCP_SERVER_NOT_FOUND' : 'MCP_COMMAND_FAILED';
}

function getMcpErrorMessage(result: McpCommandResult): string {
  const output = `${result.redactedStderr}${result.redactedStdout}`.trim();
  if (output.length > 0) {
    return output;
  }
  if (result.errorMessage !== null) {
    return result.errorMessage;
  }
  if (result.timedOut) {
    return 'codex mcp command timed out';
  }
  return 'codex mcp command failed';
}
