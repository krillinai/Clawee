import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexMcpServerResponse } from '@clawee/protocol';
import { parse, stringify } from '@iarna/toml';

type TomlRecord = Record<string, unknown>;
type TomlDocument = ReturnType<typeof parse>;

export async function getCodexMcpConfigurationFingerprint(
  codexHome: string
): Promise<string> {
  const config = await readCodexConfig(join(codexHome, 'config.toml'));
  const configRecord = config as unknown as TomlRecord;
  const servers = isRecord(configRecord.mcp_servers)
    ? configRecord.mcp_servers
    : {};
  return createHash('sha256')
    .update(JSON.stringify(normalizeForHash(servers)))
    .digest('hex');
}

export async function setCodexMcpServerEnabled(input: {
  codexHome: string;
  name: string;
  enabled: boolean;
  fallbackServer?: CodexMcpServerResponse;
}): Promise<void> {
  const configPath = join(input.codexHome, 'config.toml');
  let mode = 0o600;
  try {
    mode = (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const config = await readCodexConfig(configPath);
  const configRecord = config as unknown as TomlRecord;
  const servers = isRecord(configRecord.mcp_servers)
    ? configRecord.mcp_servers
    : {};
  const configuredServer = servers[input.name];
  let server: TomlRecord;
  if (isRecord(configuredServer)) {
    server = configuredServer;
  } else {
    if (input.fallbackServer === undefined) {
      throw new Error('MCP_SERVER_NOT_FOUND: MCP server not found');
    }
    server = createCodexMcpServerOverride(
      input.name,
      input.fallbackServer
    );
    servers[input.name] = server;
    configRecord.mcp_servers = servers;
  }
  server.enabled = input.enabled;

  await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
  const temporaryPath =
    `${configPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporaryPath, stringify(config), { mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, configPath);
}

export async function renameCodexMcpServer(input: {
  codexHome: string;
  currentName: string;
  nextName: string;
}): Promise<boolean> {
  if (input.currentName === input.nextName) return false;
  const configPath = join(input.codexHome, 'config.toml');
  const config = await readCodexConfig(configPath);
  const configRecord = config as unknown as TomlRecord;
  const servers = isRecord(configRecord.mcp_servers)
    ? configRecord.mcp_servers
    : undefined;
  if (servers === undefined || !isRecord(servers[input.currentName])) {
    throw new Error('MCP_SERVER_NOT_FOUND: MCP server not found');
  }
  if (servers[input.nextName] !== undefined) {
    throw new Error('MCP_SERVER_ALREADY_EXISTS: MCP server already exists');
  }

  servers[input.nextName] = servers[input.currentName];
  delete servers[input.currentName];
  await writeCodexConfig(configPath, input.codexHome, config, 0o600);
  return true;
}

export async function setCodexMcpServerToolTimeout(input: {
  codexHome: string;
  name: string;
  timeoutSec: number;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.timeoutSec) || input.timeoutSec <= 0) {
    throw new Error('MCP_SERVER_INVALID: MCP tool timeout is invalid');
  }

  const configPath = join(input.codexHome, 'config.toml');
  let mode = 0o600;
  try {
    mode = (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const config = await readCodexConfig(configPath);
  const configRecord = config as unknown as TomlRecord;
  const servers = isRecord(configRecord.mcp_servers)
    ? configRecord.mcp_servers
    : undefined;
  const server = servers?.[input.name];
  if (!isRecord(server)) {
    throw new Error('MCP_SERVER_NOT_FOUND: MCP server not found');
  }
  if (server.tool_timeout_sec === input.timeoutSec) return false;

  server.tool_timeout_sec = input.timeoutSec;
  await writeCodexConfig(configPath, input.codexHome, config, mode);
  return true;
}

function createCodexMcpServerOverride(
  expectedName: string,
  server: CodexMcpServerResponse
): TomlRecord {
  if (
    server.status !== 'configured'
    || server.hasSecrets
    || server.name !== expectedName
  ) {
    throw new Error(
      'MCP_SERVER_INVALID: MCP server cannot be safely persisted'
    );
  }

  if (server.transport === 'http' && server.url !== undefined) {
    return {
      url: server.url,
      ...(server.bearerTokenEnvVar === undefined
        ? {}
        : { bearer_token_env_var: server.bearerTokenEnvVar })
    };
  }

  if (
    server.transport === 'stdio'
    && server.command !== undefined
    && server.envKeys.length === 0
  ) {
    return {
      command: server.command,
      ...(server.args === undefined ? {} : { args: server.args })
    };
  }

  throw new Error(
    'MCP_SERVER_INVALID: MCP server cannot be safely persisted'
  );
}

export async function setCodexMcpServerBearerToken(input: {
  codexHome: string;
  name: string;
  token?: string;
  agentId?: string;
}): Promise<boolean> {
  if (
    (input.token === undefined) !== (input.agentId === undefined)
    || input.token !== undefined
    && (
      input.token.trim().length === 0
      || input.token.includes('\r')
      || input.token.includes('\n')
    )
    || input.agentId !== undefined
    && (
      input.agentId.trim().length === 0
      || input.agentId !== input.agentId.trim()
      || input.agentId.includes('\r')
      || input.agentId.includes('\n')
    )
  ) {
    throw new Error('MCP_SERVER_INVALID: MCP authorization is invalid');
  }
  const configPath = join(input.codexHome, 'config.toml');
  const config = await readCodexConfig(configPath);
  const configRecord = config as unknown as TomlRecord;
  const servers = isRecord(configRecord.mcp_servers)
    ? configRecord.mcp_servers
    : undefined;
  const server = servers?.[input.name];
  if (!isRecord(server)) {
    throw new Error('MCP_SERVER_NOT_FOUND: MCP server not found');
  }

  const headers = isRecord(server.http_headers)
    ? server.http_headers
    : {};
  const managedHeaderNames = new Set(['authorization', 'x-claw-agent-id']);
  const existingManagedKeys = Object.keys(headers)
    .filter(key => managedHeaderNames.has(key.toLowerCase()));
  const nextAuthorization = input.token === undefined
    ? undefined
    : `Bearer ${input.token}`;
  const nextAgentId = input.agentId;
  const managedHeadersUnchanged = managedHeaderValueUnchanged(
    headers,
    'authorization',
    nextAuthorization
  ) && managedHeaderValueUnchanged(
    headers,
    'x-claw-agent-id',
    nextAgentId
  );
  const bearerEnvUnchanged = server.bearer_token_env_var === undefined;
  if (managedHeadersUnchanged && bearerEnvUnchanged) return false;

  for (const key of existingManagedKeys) delete headers[key];
  if (nextAuthorization === undefined) {
    if (Object.keys(headers).length === 0) delete server.http_headers;
  } else {
    headers.Authorization = nextAuthorization;
    headers['X-Claw-Agent-ID'] = nextAgentId;
    server.http_headers = headers;
  }
  delete server.bearer_token_env_var;

  await writeCodexConfig(configPath, input.codexHome, config, 0o600);
  return true;
}

export async function clearCodexMcpServerBearerTokens(input: {
  codexHome: string;
  names?: string[];
  urls?: string[];
  namePrefix?: string;
  legacyBearerTokenEnvVar?: string;
}): Promise<boolean> {
  const configPath = join(input.codexHome, 'config.toml');
  const config = await readCodexConfig(configPath);
  const configRecord = config as unknown as TomlRecord;
  const servers = isRecord(configRecord.mcp_servers)
    ? configRecord.mcp_servers
    : undefined;
  if (servers === undefined) return false;

  const names = new Set(input.names ?? []);
  const urls = new Set(input.urls ?? []);
  let changed = false;
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) continue;
    if (
      !names.has(name)
      && !urls.has(typeof server.url === 'string' ? server.url : '')
      && !(input.namePrefix && name.startsWith(input.namePrefix))
      && !(
        input.legacyBearerTokenEnvVar
        && server.bearer_token_env_var === input.legacyBearerTokenEnvVar
      )
    ) {
      continue;
    }
    changed = clearBearerToken(server) || changed;
  }
  if (!changed) return false;

  await writeCodexConfig(configPath, input.codexHome, config, 0o600);
  return true;
}

async function readCodexConfig(configPath: string): Promise<TomlDocument> {
  let source = '';
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  try {
    return source.trim().length === 0
      ? {} as TomlDocument
      : parse(source);
  } catch {
    throw new Error('MCP_SERVER_INVALID: Codex config.toml is invalid');
  }
}

function clearBearerToken(server: TomlRecord): boolean {
  const headers = isRecord(server.http_headers)
    ? server.http_headers
    : undefined;
  let changed = false;
  if (headers !== undefined) {
    for (const key of Object.keys(headers)) {
      if (
        key.toLowerCase() !== 'authorization'
        && key.toLowerCase() !== 'x-claw-agent-id'
      ) continue;
      delete headers[key];
      changed = true;
    }
    if (Object.keys(headers).length === 0) delete server.http_headers;
  }
  if (server.bearer_token_env_var !== undefined) {
    delete server.bearer_token_env_var;
    changed = true;
  }
  return changed;
}

function managedHeaderValueUnchanged(
  headers: TomlRecord,
  headerName: string,
  expected: string | undefined
): boolean {
  const keys = Object.keys(headers)
    .filter(key => key.toLowerCase() === headerName);
  return keys.length === (expected === undefined ? 0 : 1)
    && (
      expected === undefined
      || headers[keys[0]!] === expected
    );
}

async function writeCodexConfig(
  configPath: string,
  codexHome: string,
  config: TomlDocument,
  mode: number
): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const temporaryPath =
    `${configPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporaryPath, stringify(config), { mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, configPath);
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForHash);
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map(key => [key, normalizeForHash(value[key])])
  );
}

function isRecord(value: unknown): value is TomlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
