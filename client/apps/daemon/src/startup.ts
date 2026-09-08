import type { BuildServerInput } from './api/server.js';
import {
  parseCodexRuntimeLaunchContextJson
} from '@clawee/protocol';
import type {
  ScheduleBindingRepairResult,
  ScheduleCoordinator
} from './scheduler/coordinator.js';
import { createLocalMcpPresetProvider } from './codex/mcp/presets.js';
import { readEnterpriseClientConfig } from './enterprise/client-config-2026-08-06.js';
import { resolve } from 'node:path';
import {
  readPackagedServerConfiguration
} from './server-mode/config.js';

const ENTERPRISE_CONFIG_ARGUMENT = '--clawee-enterprise-config';
const ENTERPRISE_E2E_RUN_ID_ARGUMENT = '--clawee-enterprise-e2e-run-id';
const ENTERPRISE_E2E_AUTHORIZED_ARGUMENT =
  '--clawee-enterprise-e2e-authorized';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ServerModeConfiguration = {
  host: string;
  port: number;
  dataDir: string;
  defaultProjectRoot: string;
  tokenSource: 'config' | 'file';
  token?: string;
  tokenFile?: string;
  webDistDir: string;
  enterpriseConfigFile?: string;
};

const SERVER_MODE_ARGUMENTS = [
  '--host',
  '--port',
  '--data-dir',
  '--default-project-root',
  '--token-file',
  '--web-dist-dir',
  '--server-config'
] as const;

export function resolveServerModeArguments(
  argv: readonly string[] = process.argv,
  cwd = process.cwd()
): ServerModeConfiguration | undefined {
  const serverFlags = argv.filter(argument => argument === '--server');
  if (serverFlags.length > 1) {
    throw new Error('SERVER_MODE_ARGUMENT_INVALID: --server');
  }
  const enabled = serverFlags.length === 1;
  const providedServerArguments = SERVER_MODE_ARGUMENTS.filter(name =>
    argv.some(argument => argument === name || argument.startsWith(`${name}=`))
  );
  if (!enabled) {
    if (providedServerArguments.length > 0) {
      throw new Error(`SERVER_MODE_REQUIRED: ${providedServerArguments[0]}`);
    }
    return undefined;
  }

  const serverConfigPath = readServerArgument(argv, '--server-config');
  if (serverConfigPath !== undefined) {
    const mixedArgument = SERVER_MODE_ARGUMENTS.find(name => (
      name !== '--server-config'
      && name !== '--web-dist-dir'
      && argv.some(argument => argument === name || argument.startsWith(`${name}=`))
    ));
    if (mixedArgument !== undefined) {
      throw new Error(`SERVER_MODE_ARGUMENT_INVALID: ${mixedArgument}`);
    }
    const config = readPackagedServerConfiguration(resolve(cwd, serverConfigPath));
    return {
      ...config,
      webDistDir: resolve(
        cwd,
        readServerArgument(argv, '--web-dist-dir') ?? 'apps/web/dist'
      )
    };
  }

  const dataDir = resolve(
    cwd,
    readServerArgument(argv, '--data-dir') ?? '.runtime'
  );
  const host = readServerArgument(argv, '--host') ?? '127.0.0.1';
  const rawPort = readServerArgument(argv, '--port') ?? '19860';
  if (!/^\d+$/.test(rawPort)) {
    throw new Error('SERVER_MODE_ARGUMENT_INVALID: --port');
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SERVER_MODE_ARGUMENT_INVALID: --port');
  }

  return {
    host,
    port,
    dataDir,
    defaultProjectRoot: resolve(
      cwd,
      readServerArgument(argv, '--default-project-root') ?? resolve(dataDir, 'projects')
    ),
    tokenSource: 'file',
    tokenFile: resolve(
      cwd,
      readServerArgument(argv, '--token-file') ?? resolve(dataDir, 'server-token')
    ),
    webDistDir: resolve(
      cwd,
      readServerArgument(argv, '--web-dist-dir') ?? 'apps/web/dist'
    )
  };
}

export function resolveProductionServerEnvironment(
  env: NodeJS.ProcessEnv = process.env
): Pick<
  BuildServerInput,
  'dataDir' | 'defaultCwd' | 'defaultProjectRoot'
> & Required<Pick<
  BuildServerInput,
  'codexBin' | 'codexHome' | 'runtime'
>> {
  assertEnterpriseEnvironmentUnused(env);
  assertLegacyRuntimeEnvironmentUnused(env);
  const serializedRuntime = normalizedValue(
    env.CLAWEE_CODEX_RUNTIME_DESCRIPTOR
  );
  if (serializedRuntime === undefined) {
    throw new Error('CODEX_RUNTIME_DESCRIPTOR_REQUIRED');
  }
  let runtime;
  try {
    runtime = parseCodexRuntimeLaunchContextJson(serializedRuntime);
  } catch (error) {
    throw new Error(
      `CODEX_RUNTIME_DESCRIPTOR_INVALID: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return {
    ...optionalEnvironmentValue('dataDir', env.CLAWEE_DATA_DIR),
    codexBin: runtime.candidate.entryPath,
    codexHome: runtime.candidate.homePath,
    runtime,
    ...optionalEnvironmentValue('defaultCwd', env.CLAWEE_DEFAULT_CWD),
    ...optionalEnvironmentValue(
      'defaultProjectRoot',
      env.CLAWEE_DEFAULT_PROJECT_ROOT
    )
  };
}

export function resolveEnterpriseStartupArguments(
  argv: readonly string[] = process.argv,
  readConfig: (path: string) => string = path =>
    readEnterpriseClientConfig(path).gateway
): Pick<
  BuildServerInput,
  'enterpriseConfigPath' | 'enterpriseOrigin' | 'enterpriseE2ERunId'
> {
  const configPath = singleArgumentValue(argv, ENTERPRISE_CONFIG_ARGUMENT);
  if (configPath === undefined) {
    throw new Error('ENTERPRISE_CONFIG_REQUIRED');
  }
  const enterpriseOrigin = readConfig(configPath);
  const runId = singleArgumentValue(argv, ENTERPRISE_E2E_RUN_ID_ARGUMENT);
  const authorized = singleArgumentValue(
    argv,
    ENTERPRISE_E2E_AUTHORIZED_ARGUMENT
  );
  const hasE2EConfiguration = runId !== undefined || authorized !== undefined;
  if (!hasE2EConfiguration) {
    return {
      enterpriseConfigPath: configPath,
      enterpriseOrigin
    };
  }
  if (
    runId === undefined
    || authorized !== 'packaged-app'
    || !UUID_PATTERN.test(runId)
    || !isLoopbackOrigin(enterpriseOrigin)
  ) {
    throw new Error('ENTERPRISE_E2E_CONFIG_FORBIDDEN');
  }
  return {
    enterpriseConfigPath: configPath,
    enterpriseOrigin,
    enterpriseE2ERunId: runId
  };
}

export function createProductionServerInput(
  input: Omit<BuildServerInput, 'schedulerAutostart'>
): BuildServerInput {
  return {
    ...input,
    schedulerAutostart: true,
    agentToolsEnabled: true,
    mcpPresetProvider:
      input.mcpPresetProvider ?? createLocalMcpPresetProvider(),
    persistentAppServerEnabled: input.persistentAppServerEnabled ?? true
  };
}

export function prepareSchedulerStartup(input: {
  coordinator: Pick<ScheduleCoordinator, 'ensureBindings'>;
  classifySessions?(): void;
}): ScheduleBindingRepairResult {
  const result = input.coordinator.ensureBindings();
  input.classifySessions?.();
  return result;
}

function optionalEnvironmentValue<Key extends keyof BuildServerInput>(
  key: Key,
  value: string | undefined
): Partial<Record<Key, string>> {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? {}
    : { [key]: normalized } as Record<Key, string>;
}

function assertEnterpriseEnvironmentUnused(env: NodeJS.ProcessEnv): void {
  const forbiddenKeys = [
    'CLAWEE_ENTERPRISE_ORIGIN',
    'CLAWEE_ENTERPRISE_E2E_AUTHORIZED',
    'CLAWEE_ENTERPRISE_E2E_RUN_ID',
    'CLAWEE_ENTERPRISE_KEYRING_SERVICE',
    'CLAWEE_ENTERPRISE_KEYRING_ACCOUNT',
    'CLAWEE_ENTERPRISE_CREDENTIAL_PERSISTENCE'
  ];
  if (forbiddenKeys.some(key => hasValue(env[key]))) {
    throw new Error('ENTERPRISE_ENV_CONFIG_FORBIDDEN');
  }
}

function assertLegacyRuntimeEnvironmentUnused(
  env: NodeJS.ProcessEnv
): void {
  const forbiddenKeys = [
    'CODEX_BIN',
    'CLAWEE_CODEX_BIN',
    'CODEX_HOME',
    'CLAWEE_CODEX_HOME',
    'CLAWEE_CODEX_DEV_BIN',
    'CLAWEE_CODEX_DEV_HOME'
  ];
  if (forbiddenKeys.some(key => hasValue(env[key]))) {
    throw new Error('CODEX_RUNTIME_LEGACY_ENV_FORBIDDEN');
  }
}

function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname.toLowerCase();
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function hasValue(value: string | undefined): boolean {
  return normalizedValue(value) !== undefined;
}

function singleArgumentValue(
  argv: readonly string[],
  name: string
): string | undefined {
  const matches = argv.filter(argument => (
    argument === name || argument.startsWith(`${name}=`)
  ));
  if (matches.length > 1 || matches[0] === name) {
    throw new Error(
      name === ENTERPRISE_CONFIG_ARGUMENT
        ? 'ENTERPRISE_CONFIG_INVALID'
        : 'ENTERPRISE_E2E_CONFIG_FORBIDDEN'
    );
  }
  if (matches.length === 0) return undefined;
  const value = normalizedValue(matches[0]!.slice(name.length + 1));
  if (value !== undefined) return value;
  throw new Error(
    name === ENTERPRISE_CONFIG_ARGUMENT
      ? 'ENTERPRISE_CONFIG_INVALID'
      : 'ENTERPRISE_E2E_CONFIG_FORBIDDEN'
  );
}

function readServerArgument(
  argv: readonly string[],
  name: typeof SERVER_MODE_ARGUMENTS[number]
): string | undefined {
  const matches = argv.filter(argument => (
    argument === name || argument.startsWith(`${name}=`)
  ));
  if (matches.length > 1 || matches[0] === name) {
    throw new Error(`SERVER_MODE_ARGUMENT_INVALID: ${name}`);
  }
  if (matches.length === 0) return undefined;
  const value = normalizedValue(matches[0]!.slice(name.length + 1));
  if (value === undefined) {
    throw new Error(`SERVER_MODE_ARGUMENT_INVALID: ${name}`);
  }
  return value;
}

function normalizedValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}
