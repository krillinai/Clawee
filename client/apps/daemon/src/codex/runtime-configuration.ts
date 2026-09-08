import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ModelServiceConfiguration } from '@clawee/protocol';
import {
  createCodexAppServerClient,
  type CodexAppServerRequestClient,
  type CreateCodexAppServerClientInput
} from './app-server-client.js';
import {
  listCodexRuntimeModelProviderIdsV0146
} from './runtime-home-layout.js';
import { ensureCurrentModelCatalog } from './current-model-catalog.js';

const DISABLED_MULTI_AGENT_FEATURES = [
  'multi_agent',
  'multi_agent_v2'
] as const;
const DISABLED_MULTI_AGENT_SETTINGS = [
  'agents.enabled',
  'features.multi_agent',
  'features.multi_agent_v2'
] as const;
export const CLAWEE_MODEL_PROVIDER_ID = 'clawee';
export const CLAWEE_MODEL_API_KEY_ENV = 'CLAWEE_MODEL_API_KEY';

type DisabledMultiAgentFeature =
  typeof DISABLED_MULTI_AGENT_FEATURES[number];

type RuntimeConfigurationWrite = {
  version: string;
  filePath: string;
};

type RuntimeConfigurationCache = {
  schemaVersion: 1;
  fingerprint: string;
  codexBinFingerprint: string;
  modelService: ModelServiceConfiguration | null;
  write: RuntimeConfigurationWrite;
  verifiedAt: string;
};

type RuntimeConfigurationEdit = {
  keyPath: string;
  value: unknown;
  mergeStrategy: 'upsert';
};

export type CodexRuntimeConfigurationVerification = {
  configFilePath: string;
  version: string;
  agents: {
    enabled: false;
  };
  features: Record<DisabledMultiAgentFeature, false>;
  modelService?: ModelServiceConfiguration;
  modelProviderAliases?: string[];
};

export type PreparedCodexRuntimeConfiguration = {
  client: CodexAppServerRequestClient;
  verification: CodexRuntimeConfigurationVerification;
};

export type CodexRuntimeConfigurationErrorCode =
  | 'CODEX_RUNTIME_CONFIGURATION_WRITE_INVALID'
  | 'CODEX_RUNTIME_CONFIGURATION_OVERRIDDEN'
  | 'CODEX_RUNTIME_CONFIGURATION_READ_INVALID'
  | 'CODEX_RUNTIME_CONFIGURATION_FEATURE_ENABLED'
  | 'CODEX_RUNTIME_CONFIGURATION_ORIGIN_CONFLICT';

export class CodexRuntimeConfigurationError extends Error {
  constructor(
    readonly code: CodexRuntimeConfigurationErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'CodexRuntimeConfigurationError';
  }
}

export function mergeCodexEnvironment(
  base: Record<string, string> | undefined,
  injected: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (base === undefined && injected === undefined) return undefined;
  const modelApiKey = base?.[CLAWEE_MODEL_API_KEY_ENV];
  return {
    ...base,
    ...injected,
    ...(modelApiKey === undefined
      ? {}
      : { [CLAWEE_MODEL_API_KEY_ENV]: modelApiKey })
  };
}

export function readCachedCodexModelServiceConfiguration(input: {
  codexBin: string;
  codexHome: string;
}): {
  cached: boolean;
  configuration?: ModelServiceConfiguration;
} {
  const cache = readRuntimeConfigurationCacheRecord(join(
    input.codexHome,
    '.clawee',
    'runtime-configuration.json'
  ));
  if (
    cache === undefined
    || cache.codexBinFingerprint !== codexBinaryFingerprint(input.codexBin)
  ) {
    return { cached: false };
  }
  return cache.modelService === null
    ? { cached: true }
    : { cached: true, configuration: cache.modelService };
}

export async function prepareCodexRuntimeConfiguration(input: {
  codexBin: string;
  codexHome: string;
  cwd?: string;
  requestTimeoutMs?: number;
  env?: Record<string, string>;
  modelService?: ModelServiceConfiguration;
  modelCatalogPath?: string;
  createClient?(
    input: CreateCodexAppServerClientInput
  ): CodexAppServerRequestClient;
}): Promise<PreparedCodexRuntimeConfiguration> {
  mkdirSync(input.codexHome, { recursive: true, mode: 0o700 });
  const modelProviderAliases = input.modelService === undefined
    ? []
    : compatibilityModelProviderIds(input.codexHome);
  const modelCatalogPath = input.modelService === undefined
    ? undefined
    : input.modelCatalogPath ?? ensureCurrentModelCatalog({
      codexBin: input.codexBin,
      codexHome: input.codexHome,
      model: input.modelService.model
    });
  const edits = runtimeConfigurationEdits(
    input.modelService,
    modelProviderAliases,
    modelCatalogPath
  );
  const cachePath = join(
    input.codexHome,
    '.clawee',
    'runtime-configuration.json'
  );
  const fingerprint = runtimeConfigurationFingerprint(input.codexBin, edits);
  const createClient = input.createClient ?? createCodexAppServerClient;
  const clientInput = {
    codexBin: input.codexBin,
    codexHome: input.codexHome,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: input.requestTimeoutMs }),
    ...(input.env === undefined ? {} : { env: input.env })
  };
  const cachedWrite = readRuntimeConfigurationCache(cachePath, fingerprint);
  if (cachedWrite !== undefined) {
    const cachedClient = createClient(clientInput);
    try {
      const response = await cachedClient.request<unknown>('config/read', {
        includeLayers: false,
        cwd: null
      });
      return {
        client: cachedClient,
        verification: parseConfigurationRead(
          response,
          cachedWrite,
          input.modelService,
          modelProviderAliases,
          modelCatalogPath
        )
      };
    } catch (error) {
      await cachedClient.close();
      if (!(error instanceof CodexRuntimeConfigurationError)) throw error;
    }
  }
  const configurationClient = createClient(clientInput);
  let write: RuntimeConfigurationWrite;
  try {
    const response = await configurationClient.request<unknown>(
      'config/batchWrite',
      {
        edits,
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: false
      }
    );
    write = parseConfigurationWrite(response);
  } finally {
    await configurationClient.close();
  }

  const businessClient = createClient(clientInput);
  try {
    const response = await businessClient.request<unknown>('config/read', {
      includeLayers: false,
      cwd: null
    });
    const verification = parseConfigurationRead(
      response,
      write,
      input.modelService,
      modelProviderAliases,
      modelCatalogPath
    );
    writeRuntimeConfigurationCache(cachePath, {
      schemaVersion: 1,
      fingerprint,
      codexBinFingerprint: codexBinaryFingerprint(input.codexBin),
      modelService: input.modelService ?? null,
      write,
      verifiedAt: new Date().toISOString()
    });
    return {
      client: businessClient,
      verification
    };
  } catch (error) {
    await businessClient.close();
    throw error;
  }
}

function parseConfigurationWrite(value: unknown): RuntimeConfigurationWrite {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw configurationError(
      'CODEX_RUNTIME_CONFIGURATION_WRITE_INVALID',
      'config/batchWrite returned an invalid response'
    );
  }
  if (value.status === 'okOverridden') {
    throw configurationError(
      'CODEX_RUNTIME_CONFIGURATION_OVERRIDDEN',
      'multi-agent settings were overridden by a higher-precedence layer'
    );
  }
  if (
    value.status !== 'ok'
    || typeof value.version !== 'string'
    || value.version.length === 0
    || typeof value.filePath !== 'string'
    || !isAbsolute(value.filePath)
    || value.overriddenMetadata !== null
  ) {
    throw configurationError(
      'CODEX_RUNTIME_CONFIGURATION_WRITE_INVALID',
      'config/batchWrite did not confirm an atomic user-config write'
    );
  }
  return {
    version: value.version,
    filePath: value.filePath
  };
}

function parseConfigurationRead(
  value: unknown,
  write: RuntimeConfigurationWrite,
  modelService: ModelServiceConfiguration | undefined,
  modelProviderAliases: readonly string[],
  modelCatalogPath: string | undefined
): CodexRuntimeConfigurationVerification {
  if (
    !isRecord(value)
    || !isRecord(value.config)
    || !isRecord(value.config.agents)
    || !isRecord(value.config.features)
    || !isRecord(value.origins)
  ) {
    throw configurationError(
      'CODEX_RUNTIME_CONFIGURATION_READ_INVALID',
      'config/read returned an invalid response'
    );
  }

  if (value.config.agents.enabled !== false) {
    throw configurationError(
      'CODEX_RUNTIME_CONFIGURATION_FEATURE_ENABLED',
      'agents.enabled must resolve to false'
    );
  }
  assertWrittenUserOrigin(
    value.origins['agents.enabled'],
    'agents.enabled',
    write
  );

  for (const feature of DISABLED_MULTI_AGENT_FEATURES) {
    if (value.config.features[feature] !== false) {
      throw configurationError(
        'CODEX_RUNTIME_CONFIGURATION_FEATURE_ENABLED',
        `features.${feature} must resolve to false`
      );
    }
    const keyPath = `features.${feature}`;
    assertWrittenUserOrigin(
      value.origins[keyPath]
        ?? value.origins[`${keyPath}.enabled`],
      keyPath,
      write
    );
  }

  if (modelService !== undefined) {
    assertModelServiceConfiguration(
      value.config,
      value.origins,
      write,
      modelService,
      modelCatalogPath
    );
    for (const providerId of modelProviderAliases) {
      assertModelProviderAlias(
        value.config,
        value.origins,
        write,
        modelService,
        providerId
      );
    }
  }

  return {
    configFilePath: write.filePath,
    version: write.version,
    agents: {
      enabled: false
    },
    features: {
      multi_agent: false,
      multi_agent_v2: false
    },
    ...(modelService === undefined ? {} : { modelService }),
    ...(modelProviderAliases.length === 0
      ? {}
      : { modelProviderAliases: [...modelProviderAliases] })
  };
}

export function runtimeConfigurationEdits(
  modelService?: ModelServiceConfiguration,
  modelProviderAliases: readonly string[] = [],
  modelCatalogPath?: string
): RuntimeConfigurationEdit[] {
  const edits = DISABLED_MULTI_AGENT_SETTINGS.map(keyPath => ({
    keyPath,
    value: false,
    mergeStrategy: 'upsert' as const
  }));
  if (modelService === undefined) return edits;
  if (modelCatalogPath === undefined) {
    throw new Error('Codex model catalog path is required for a configured model');
  }
  return [
    ...edits,
    {
      keyPath: 'model',
      value: modelService.model,
      mergeStrategy: 'upsert'
    },
    {
      keyPath: 'model_catalog_json',
      value: modelCatalogPath,
      mergeStrategy: 'upsert'
    },
    {
      keyPath: 'model_provider',
      value: CLAWEE_MODEL_PROVIDER_ID,
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.name`,
      value: 'Clawee',
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.base_url`,
      value: modelService.baseUrl,
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.wire_api`,
      value: 'responses',
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.requires_openai_auth`,
      value: false,
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.env_key`,
      value: CLAWEE_MODEL_API_KEY_ENV,
      mergeStrategy: 'upsert'
    },
    ...modelProviderAliases.flatMap(providerId =>
      modelProviderEdits(providerId, modelService)
    )
  ];
}

function compatibilityModelProviderIds(codexHome: string): string[] {
  return listCodexRuntimeModelProviderIdsV0146(codexHome).filter(providerId =>
    providerId !== CLAWEE_MODEL_PROVIDER_ID
    && /^[A-Za-z0-9_-]{1,64}$/u.test(providerId)
  );
}

function modelProviderEdits(
  providerId: string,
  modelService: ModelServiceConfiguration
): RuntimeConfigurationEdit[] {
  return [
    {
      keyPath: `model_providers.${providerId}.name`,
      value: 'Clawee',
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${providerId}.base_url`,
      value: modelService.baseUrl,
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${providerId}.wire_api`,
      value: 'responses',
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${providerId}.requires_openai_auth`,
      value: false,
      mergeStrategy: 'upsert'
    },
    {
      keyPath: `model_providers.${providerId}.env_key`,
      value: CLAWEE_MODEL_API_KEY_ENV,
      mergeStrategy: 'upsert'
    }
  ];
}

function assertModelServiceConfiguration(
  config: Record<string, unknown>,
  origins: Record<string, unknown>,
  write: RuntimeConfigurationWrite,
  expected: ModelServiceConfiguration,
  expectedCatalogPath: string | undefined
): void {
  const providers = isRecord(config.model_providers)
    ? config.model_providers
    : undefined;
  const provider = isRecord(providers?.[CLAWEE_MODEL_PROVIDER_ID])
    ? providers[CLAWEE_MODEL_PROVIDER_ID]
    : undefined;
  if (
    config.model !== expected.model
    || config.model_catalog_json !== expectedCatalogPath
    || config.model_provider !== CLAWEE_MODEL_PROVIDER_ID
    || provider?.name !== 'Clawee'
    || provider.base_url !== expected.baseUrl
    || provider.wire_api !== 'responses'
    || provider.requires_openai_auth !== false
    || provider.env_key !== CLAWEE_MODEL_API_KEY_ENV
  ) {
    throw configurationError(
      'CODEX_RUNTIME_CONFIGURATION_READ_INVALID',
      'model service configuration did not resolve to the written values'
    );
  }
  for (const keyPath of [
    'model',
    'model_catalog_json',
    'model_provider',
    `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.name`,
    `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.base_url`,
    `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.wire_api`,
    `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.requires_openai_auth`,
    `model_providers.${CLAWEE_MODEL_PROVIDER_ID}.env_key`
  ]) {
    assertWrittenUserOrigin(origins[keyPath], keyPath, write);
  }
}

function assertModelProviderAlias(
  config: Record<string, unknown>,
  origins: Record<string, unknown>,
  write: RuntimeConfigurationWrite,
  expected: ModelServiceConfiguration,
  providerId: string
): void {
  const providers = isRecord(config.model_providers)
    ? config.model_providers
    : undefined;
  const provider = isRecord(providers?.[providerId])
    ? providers[providerId]
    : undefined;
  if (
    provider?.name !== 'Clawee'
    || provider.base_url !== expected.baseUrl
    || provider.wire_api !== 'responses'
    || provider.requires_openai_auth !== false
    || provider.env_key !== CLAWEE_MODEL_API_KEY_ENV
  ) {
    throw configurationError(
      'CODEX_RUNTIME_CONFIGURATION_READ_INVALID',
      `model provider alias ${providerId} did not resolve to the current model service`
    );
  }
  for (const keyPath of [
    `model_providers.${providerId}.name`,
    `model_providers.${providerId}.base_url`,
    `model_providers.${providerId}.wire_api`,
    `model_providers.${providerId}.requires_openai_auth`,
    `model_providers.${providerId}.env_key`
  ]) {
    assertWrittenUserOrigin(origins[keyPath], keyPath, write);
  }
}

function assertWrittenUserOrigin(
  value: unknown,
  feature: string,
  write: RuntimeConfigurationWrite
): void {
  if (
    !isRecord(value)
    || value.version !== write.version
    || !isRecord(value.name)
    || value.name.type !== 'user'
    || value.name.file !== write.filePath
    || value.name.profile !== null
  ) {
    throw configurationError(
      'CODEX_RUNTIME_CONFIGURATION_ORIGIN_CONFLICT',
      `${feature} did not originate from the written Runtime user config`
    );
  }
}

function runtimeConfigurationFingerprint(
  codexBin: string,
  edits: readonly RuntimeConfigurationEdit[]
): string {
  return createHash('sha256').update(JSON.stringify({
    codexBin: codexBinaryFingerprint(codexBin),
    edits
  })).digest('hex');
}

function codexBinaryFingerprint(codexBin: string): string {
  try {
    const stat = statSync(codexBin);
    return `${resolve(codexBin)}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return codexBin;
  }
}

function readRuntimeConfigurationCache(
  path: string,
  fingerprint: string
): RuntimeConfigurationWrite | undefined {
  const value = readRuntimeConfigurationCacheRecord(path);
  return value?.fingerprint === fingerprint ? value.write : undefined;
}

function readRuntimeConfigurationCacheRecord(
  path: string
): RuntimeConfigurationCache | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      !isRecord(value)
      || value.schemaVersion !== 1
      || typeof value.fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.fingerprint)
      || typeof value.codexBinFingerprint !== 'string'
      || !validCachedModelService(value.modelService)
      || typeof value.verifiedAt !== 'string'
      || !isRecord(value.write)
      || typeof value.write.version !== 'string'
      || value.write.version.length === 0
      || typeof value.write.filePath !== 'string'
      || !isAbsolute(value.write.filePath)
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      fingerprint: value.fingerprint,
      codexBinFingerprint: value.codexBinFingerprint,
      modelService: value.modelService,
      write: {
        version: value.write.version,
        filePath: value.write.filePath
      },
      verifiedAt: value.verifiedAt
    };
  } catch {
    return undefined;
  }
}

function validCachedModelService(
  value: unknown
): value is ModelServiceConfiguration | null {
  if (value === null) return true;
  return isRecord(value)
    && typeof value.baseUrl === 'string'
    && value.baseUrl.length > 0
    && typeof value.model === 'string'
    && value.model.length > 0;
}

function writeRuntimeConfigurationCache(
  path: string,
  cache: RuntimeConfigurationCache
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
      mode: 0o600
    });
    renameSync(temporary, path);
  } catch (error) {
    console.warn(`Codex Runtime configuration cache write failed: ${
      error instanceof Error ? error.message : String(error)
    }`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function configurationError(
  code: CodexRuntimeConfigurationErrorCode,
  message: string
): CodexRuntimeConfigurationError {
  return new CodexRuntimeConfigurationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
