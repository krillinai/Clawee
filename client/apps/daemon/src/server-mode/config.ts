import { parse } from '@iarna/toml';
import {
  chmodSync,
  lstatSync,
  readFileSync,
  type Stats
} from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { readEnterpriseClientConfig } from '../enterprise/client-config-2026-08-06.js';

const SERVER_FIELDS = new Set([
  'host',
  'port',
  'data_dir',
  'default_project_root',
  'token',
  'token_file'
]);
const ENTERPRISE_FIELDS = new Set(['config_file']);
const HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

export type PackagedServerConfiguration = {
  configPath: string;
  host: string;
  port: number;
  dataDir: string;
  defaultProjectRoot: string;
  tokenSource: 'config' | 'file';
  token?: string;
  tokenFile?: string;
  enterpriseConfigFile: string;
};

export function readPackagedServerConfiguration(
  inputPath: string
): PackagedServerConfiguration {
  const configPath = resolve(inputPath);
  const info = lstatConfig(configPath);
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch {
    throw new Error('SERVER_CONFIG_INVALID');
  }
  if (!isRecord(parsed) || hasUnknownFields(parsed, new Set(['server', 'enterprise']))) {
    throw new Error('SERVER_CONFIG_INVALID');
  }
  const server = parsed.server;
  const enterprise = parsed.enterprise;
  if (
    !isRecord(server)
    || hasUnknownFields(server, SERVER_FIELDS)
    || !isRecord(enterprise)
    || hasUnknownFields(enterprise, ENTERPRISE_FIELDS)
  ) {
    throw new Error('SERVER_CONFIG_INVALID');
  }

  const configDirectory = dirname(configPath);
  const host = optionalString(server.host, '127.0.0.1');
  const port = server.port ?? 19_860;
  if (
    !isValidHost(host)
    || host.includes('..')
    || !Number.isSafeInteger(port)
    || Number(port) < 1
    || Number(port) > 65_535
  ) {
    throw new Error('SERVER_LISTEN_CONFIG_INVALID');
  }
  const dataDir = resolveConfigPath(
    configDirectory,
    server.data_dir,
    '../data'
  );
  const defaultProjectRoot = resolveConfigPath(
    configDirectory,
    server.default_project_root,
    resolve(dataDir, 'projects')
  );
  const enterpriseConfigFile = resolveConfigPath(
    configDirectory,
    enterprise.config_file
  );
  readEnterpriseClientConfig(enterpriseConfigFile);

  if (Object.hasOwn(server, 'token')) {
    if (typeof server.token !== 'string' || server.token.trim().length === 0) {
      throw new Error('SERVER_CONFIG_TOKEN_INVALID');
    }
    secureDirectTokenConfig(configPath, info);
    return {
      configPath,
      host,
      port: Number(port),
      dataDir,
      defaultProjectRoot,
      tokenSource: 'config',
      token: server.token.trim(),
      enterpriseConfigFile
    };
  }

  return {
    configPath,
    host,
    port: Number(port),
    dataDir,
    defaultProjectRoot,
    tokenSource: 'file',
    tokenFile: resolveConfigPath(
      configDirectory,
      server.token_file,
      resolve(dataDir, 'server-token')
    ),
    enterpriseConfigFile
  };
}

function isValidHost(host: string): boolean {
  const ipVersion = isIP(host);
  if (host.includes(':')) return ipVersion === 6;
  if (ipVersion === 4) return true;
  if (host.length > 253 || /^[0-9.]+$/.test(host)) return false;
  return host.split('.').every(label => (
    label.length <= 63 && HOST_LABEL_PATTERN.test(label)
  ));
}

function lstatConfig(path: string): Stats {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    throw new Error('SERVER_CONFIG_INVALID');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new Error('SERVER_CONFIG_INVALID');
  }
  return info;
}

function secureDirectTokenConfig(
  path: string,
  info: Stats
): void {
  if (process.platform === 'win32') return;
  if ((info.mode & 0o200) === 0) {
    throw new Error('SERVER_CONFIG_TOKEN_INVALID');
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    throw new Error('SERVER_CONFIG_TOKEN_INVALID');
  }
}

function resolveConfigPath(
  base: string,
  value: unknown,
  fallback?: string
): string {
  const normalized = value === undefined
    ? fallback
    : requiredString(value);
  if (normalized === undefined) throw new Error('SERVER_CONFIG_INVALID');
  return resolve(base, normalized);
}

function optionalString(value: unknown, fallback: string): string {
  return value === undefined ? fallback : requiredString(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('SERVER_CONFIG_INVALID');
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error('SERVER_CONFIG_INVALID');
  return normalized;
}

function hasUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>
): boolean {
  return Object.keys(value).some(key => !allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
