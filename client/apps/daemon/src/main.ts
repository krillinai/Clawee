import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync
} from 'node:fs';
import {
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CodexAvailabilityProbe } from '@clawee/protocol';
import type { FastifyInstance } from 'fastify';
import {
  applyCapabilityMatrix,
  collectCodexCapabilityMatrixAsync,
  collectStartupCapabilityMatrixAsync,
  probeCodexVersionAsync,
  withRuntimeSkillCapabilities,
  type RuntimeCapabilityMatrix
} from './codex/capabilities.js';
import { resolveCodexHome } from './codex/home.js';
import {
  CLAWEE_MODEL_API_KEY_ENV,
  prepareCodexRuntimeConfiguration
} from './codex/runtime-configuration.js';
import {
  createModelServiceRuntime,
  resolveStoredModelServiceConfiguration,
  validateModelServiceConfiguration
} from './codex/model-service-configuration.js';
import {
  createModelServiceCredentialStore
} from './codex/model-service-credential-store.js';
import {
  createCodexAppServerClient
} from './codex/app-server-client.js';
import {
  createDeferredCodexAppServerClient
} from './codex/deferred-app-server-client.js';
import {
  assertConfiguredModelAvailable
} from './codex/model-catalog-2026-08-05.js';
import {
  installFallbackModelCatalog,
  installModelCatalog
} from './codex/remote-model-catalog.js';
import {
  createCodexRuntimeStateStore
} from './codex/runtime-state.js';
import { createRuntimeToken } from './security/token.js';
import { resolveServerToken } from './security/server-token.js';
import { installGracefulShutdown } from './shutdown.js';
import {
  createProductionServerInput,
  resolveEnterpriseStartupArguments,
  resolveProductionServerEnvironment,
  resolveServerModeArguments
} from './startup.js';
import { checkServerReadiness } from './server-mode/readiness.js';
import { acquireRuntimeLock } from './runtime-lock.js';
import { createEnterpriseCredentialStore } from './enterprise/credential-store-2026-07-30.js';
import {
  createPrivateCredentialFileStore,
  resolvePrivateCredentialFilePath
} from './security/private-credential-file.js';
import { openRuntimeDatabase } from './storage/database.js';

type BootstrapPhase = 'starting_runtime';

let server: FastifyInstance | undefined;
let closeWork: Promise<void> | undefined;
let releaseRuntimeLock: (() => void) | undefined;
let cancelCapabilityRefresh: (() => void) | undefined;
let cancelModelCatalogRefresh: (() => void) | undefined;
let serverModeDatabase: ReturnType<typeof openRuntimeDatabase> | undefined;

const MODEL_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;

await main().catch(async error => {
  await closeServer().catch(closeError => {
    console.error(`Failed to close daemon after startup failure: ${
      closeError instanceof Error ? closeError.message : String(closeError)
    }`);
  });
  emitBootstrapError({
    code: startupErrorCode(error),
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const serverMode = resolveServerModeArguments();
  const productionEnvironment = resolveProductionServerEnvironment();
  const environment = serverMode === undefined
    ? productionEnvironment
    : {
        ...productionEnvironment,
        dataDir: serverMode.dataDir,
        defaultProjectRoot: serverMode.defaultProjectRoot
      };
  const token = serverMode === undefined
    ? createRuntimeToken()
    : resolveServerToken(serverMode);
  const runtime = environment.runtime;
  const enterprise = serverMode?.enterpriseConfigFile === undefined
    ? resolveEnterpriseStartupArguments()
    : resolveEnterpriseStartupArguments([
        ...process.argv,
        `--clawee-enterprise-config=${serverMode.enterpriseConfigFile}`
      ]);
  const codexBin = environment.codexBin;
  const dataDir = resolve(environment.dataDir ?? '.runtime');
  const codexHome = resolveCodexHome({
    isolatedHome: environment.codexHome
  }).path;
  if (serverMode === undefined) {
    mkdirSync(dataDir, { recursive: true });
  } else {
    prepareServerDirectories(dataDir, serverMode.defaultProjectRoot);
  }
  releaseRuntimeLock = acquireRuntimeLock(dataDir);
  process.once('exit', () => releaseRuntimeLock?.());
  const runtimeState = createCodexRuntimeStateStore({
    dataDir,
    runtime
  });
  await runtimeState.reconcileStartup();
  const versionProbe = await probeCodexVersionAsync({
    codexBin,
    timeoutMs: 3_000
  });
  if (!versionProbe.ready) {
    if (serverMode === undefined) {
      emitBootstrapError({
        code: 'CODEX_VERSION_CHECK_FAILED',
        message: 'Codex CLI 无法正常启动，请重新安装或选择其他 Codex 可执行文件',
        details: {
          codexBin,
          version: versionProbe.version,
          warning: versionProbe.warning
        }
      });
      process.exitCode = 1;
      return;
    }
    throw new Error('CODEX_VERSION_CHECK_FAILED');
  }

  emitBootstrap('starting_runtime');
  const capabilityResolution = await resolveCapabilities(
    codexBin,
    dataDir,
    versionProbe.version
  );
  const capabilities = capabilityResolution.state;
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  await runtimeState.markPrepared(null);
  await runtimeState.markActive();
  const credentialFile = createPrivateCredentialFileStore({
    path: resolvePrivateCredentialFilePath({
      dataDir,
      e2eRunId: enterprise.enterpriseE2ERunId
    })
  });
  const enterpriseCredentialStore = createEnterpriseCredentialStore({
    file: credentialFile
  });
  const modelCredentialStore = createModelServiceCredentialStore({
    file: credentialFile
  });
  let availabilityProbe: CodexAvailabilityProbe = {
    status: 'skipped',
    checkedAt: new Date().toISOString()
  };
  const codexEnv: Record<string, string> = {};
  const codexAppServerClient = createDeferredCodexAppServerClient();
  const modelCatalogChangeListeners = new Set<(reason: string) => void>();
  let activePlatformCatalog: {
    configuration: import('@clawee/protocol').ModelServiceConfiguration;
    apiKey: string;
    credentialVersion: number;
  } | undefined;
  let catalogRefreshTimer: NodeJS.Timeout | undefined;
  let catalogOperation = Promise.resolve();

  const serializeCatalogOperation = async <T>(operation: () => Promise<T>) => {
    const previous = catalogOperation;
    let release!: () => void;
    catalogOperation = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const stopModelCatalogRefresh = () => {
    activePlatformCatalog = undefined;
    if (catalogRefreshTimer !== undefined) clearInterval(catalogRefreshTimer);
    catalogRefreshTimer = undefined;
  };
  cancelModelCatalogRefresh = stopModelCatalogRefresh;

  const notifyModelRuntimeChanged = (reason: string) => {
    for (const listener of modelCatalogChangeListeners) listener(reason);
  };

  const prepareActivatedClient = async (
    configuration: import('@clawee/protocol').ModelServiceConfiguration,
    modelCatalogPath?: string
  ) => prepareCodexRuntimeConfiguration({
    codexBin,
    codexHome,
    env: codexEnv,
    modelService: configuration,
    ...(modelCatalogPath === undefined ? {} : { modelCatalogPath })
  });

  const prepareVerifiedPlatformClient = async (
    configuration: import('@clawee/protocol').ModelServiceConfiguration,
    modelCatalogPath: string
  ) => {
    const prepared = await prepareActivatedClient(
      configuration,
      modelCatalogPath
    );
    try {
      await assertConfiguredModelAvailable(
        prepared.client,
        configuration.model
      );
      return prepared;
    } catch (error) {
      await prepared.client.close();
      throw error;
    }
  };

  const preparePlatformClientWithFallback = async (
    configuration: import('@clawee/protocol').ModelServiceConfiguration,
    modelCatalogPath: string
  ) => {
    try {
      return await prepareVerifiedPlatformClient(
        configuration,
        modelCatalogPath
      );
    } catch {
      const fallback = installFallbackModelCatalog({
        codexBin,
        codexHome,
        defaultModel: configuration.model
      });
      return await prepareVerifiedPlatformClient(
        configuration,
        fallback.path
      );
    }
  };

  const refreshPlatformCatalog = () => serializeCatalogOperation(async () => {
    const active = activePlatformCatalog;
    if (active === undefined) return;
    const installed = await installModelCatalog({
      codexBin,
      codexHome,
      codexVersion: versionProbe.version,
      baseUrl: active.configuration.baseUrl,
      apiKey: active.apiKey,
      defaultModel: active.configuration.model,
      credentialVersion: active.credentialVersion
    });
    if (!installed.changed || activePlatformCatalog !== active) return;
    const prepared = await preparePlatformClientWithFallback(
      active.configuration,
      installed.path
    );
    if (activePlatformCatalog !== active) {
      await prepared.client.close();
      return;
    }
    await codexAppServerClient.deactivate();
    codexAppServerClient.activate(prepared.client);
    notifyModelRuntimeChanged('model_catalog_changed');
  });

  const activateModelService = async (
    configuration: import('@clawee/protocol').ModelServiceConfiguration,
    apiKey: string,
    context: import('./codex/model-service-configuration.js').ModelServiceActivationContext
  ): Promise<void> => {
    codexEnv[CLAWEE_MODEL_API_KEY_ENV] = apiKey;
    try {
      let prepared;
      if (context.mode === 'platform_managed') {
        const modelCatalogPath = context.modelCatalogPath
          ?? (await serializeCatalogOperation(
            () => installModelCatalog({
              codexBin,
              codexHome,
              codexVersion: versionProbe.version,
              baseUrl: configuration.baseUrl,
              apiKey,
              defaultModel: configuration.model,
              credentialVersion: context.credentialVersion ?? 1
            })
          )).path
        prepared = await preparePlatformClientWithFallback(
          configuration,
          modelCatalogPath
        );
      } else {
        prepared = await prepareActivatedClient(configuration);
      }
      codexAppServerClient.activate(prepared.client);
      stopModelCatalogRefresh();
      if (context.mode === 'platform_managed') {
        activePlatformCatalog = {
          configuration,
          apiKey,
          credentialVersion: context.credentialVersion ?? 1
        };
        catalogRefreshTimer = setInterval(() => {
          void refreshPlatformCatalog().catch(error => {
            console.warn(`Remote model catalog refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`);
          });
        }, MODEL_CATALOG_REFRESH_INTERVAL_MS);
        catalogRefreshTimer.unref();
      }
      notifyModelRuntimeChanged('model_service_reactivated');
    } catch (error) {
      delete codexEnv[CLAWEE_MODEL_API_KEY_ENV];
      throw error;
    }
  };
  const modelServiceRuntime = createModelServiceRuntime({
    credentialStore: modelCredentialStore,
    loadStored: () => resolveStoredModelServiceConfiguration({
      codexBin,
      codexHome,
      credentialStore: modelCredentialStore,
      createClient: createCodexAppServerClient
    }),
    validate: request => validateModelServiceConfiguration({
      codexBin,
      dataDir,
      request
    }),
    async preparePlatformCatalog(configuration, apiKey, credentialVersion) {
      const installed = await serializeCatalogOperation(
        () => installModelCatalog({
          codexBin,
          codexHome,
          codexVersion: versionProbe.version,
          baseUrl: configuration.baseUrl,
          apiKey,
          defaultModel: configuration.model,
          credentialVersion
        })
      );
      return { modelCatalogPath: installed.path };
    },
    async activate(configuration, apiKey, context) {
      await activateModelService(configuration, apiKey, context);
      availabilityProbe = {
        status: 'succeeded',
        checkedAt: new Date().toISOString(),
        responseReceived: true
      };
    },
    async deactivate() {
      stopModelCatalogRefresh();
      try {
        await codexAppServerClient.deactivate();
      } finally {
        delete codexEnv[CLAWEE_MODEL_API_KEY_ENV];
      }
    }
  });
  const { buildServer } = await import('./api/server.js');
  let address: string;
  let readinessChecks: Awaited<ReturnType<typeof checkServerReadiness>> | undefined;
  if (serverMode !== undefined) {
    serverModeDatabase = openRuntimeDatabase(join(dataDir, 'app.sqlite'));
  }
  try {
    server = await buildServer(createProductionServerInput({
      token,
      capabilities,
      codexAppServerClient,
      codexEnv,
      modelServiceRuntime,
      enterpriseCredentialStore,
      getCodexAvailabilityProbe: () => availabilityProbe,
      getCodexRuntimeStatus: runtimeState.getStatus,
      persistentAppServerEnabled:
        process.env.CLAWEE_PERSISTENT_APP_SERVER !== '0',
      serverDeployment: serverMode !== undefined,
      onBeforeCodexWritableRequest:
        runtimeState.commitBeforeThreadWrite,
      subscribeModelCatalogChanges(listener) {
        modelCatalogChangeListeners.add(listener);
        return () => modelCatalogChangeListeners.delete(listener);
      },
      ...(serverMode === undefined
        ? {}
        : {
            taskMcpEnabled: true,
            webDistDir: serverMode.webDistDir,
            db: serverModeDatabase
          }),
      ...environment,
      ...enterprise
    }));
    address = await server.listen(serverMode === undefined
      ? { host: '127.0.0.1', port: 0 }
      : { host: serverMode.host, port: serverMode.port });
    if (serverMode !== undefined) {
      readinessChecks = await checkServerReadiness({ address, token });
    }
  } catch (error) {
    if (server === undefined) {
      await codexAppServerClient.close();
    } else {
      try {
        await server.close();
        server = undefined;
      } catch (closeError) {
        console.error(`Failed to close daemon after startup failure: ${
          closeError instanceof Error ? closeError.message : String(closeError)
        }`);
      }
    }
    throw error;
  }
  capabilityResolution.startBackgroundRefresh();

  installGracefulShutdown({
    close: closeServer,
    onError(error) {
      console.error(`Failed to close daemon cleanly: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });
  installParentPortShutdown();
  if (serverMode === undefined) {
    console.log(JSON.stringify({ address, token }));
    return;
  }
  console.log(JSON.stringify({
    event: 'SERVER_READY',
    address,
    dataDir,
    tokenSource: serverMode.tokenSource,
    ...(serverMode.tokenSource === 'file'
      ? { tokenFile: serverMode.tokenFile }
      : {}),
    checks: readinessChecks
  }));
}

async function closeServer(): Promise<void> {
  cancelCapabilityRefresh?.();
  cancelModelCatalogRefresh?.();
  closeWork ??= server?.close() ?? Promise.resolve();
  let firstError: unknown;
  try {
    await closeWork;
  } catch (error) {
    firstError = error;
  }
  try {
    if (serverModeDatabase?.open) serverModeDatabase.close();
  } catch (error) {
    firstError ??= error;
  }
  releaseRuntimeLock?.();
  if (firstError !== undefined) throw firstError;
}

function installParentPortShutdown(): void {
  const parentPort = (
    process as NodeJS.Process & {
      parentPort?: {
        on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): void;
      };
    }
  ).parentPort;
  parentPort?.on('message', event => {
    const payload = isRecord(event) && 'data' in event ? event.data : event;
    if (!isRecord(payload) || payload.type !== 'shutdown') return;
    void closeServer().catch(error => {
      console.error(`Failed to close daemon after parent request: ${String(error)}`);
      process.exitCode = 1;
    });
  });
}

async function resolveCapabilities(
  codexBin: string,
  dataDir: string,
  codexVersion: string
): Promise<{
  state: RuntimeCapabilityMatrix;
  startBackgroundRefresh(): void;
}> {
  const cachePath = join(dataDir, 'codex-capabilities.json');
  const fingerprint = codexFingerprint(codexBin);
  const cached = readCapabilityCache(cachePath, fingerprint, codexVersion);
  if (cached !== undefined) {
    return {
      state: cached,
      startBackgroundRefresh() {}
    };
  }
  const state = await collectStartupCapabilityMatrixAsync({
    codexBin,
    timeoutMs: 500
  });
  let started = false;
  return {
    state,
    startBackgroundRefresh() {
      if (started) return;
      started = true;
      const controller = new AbortController();
      cancelCapabilityRefresh = () => controller.abort();
      void collectCodexCapabilityMatrixAsync({
        codexBin,
        timeoutMs: 5_000,
        signal: controller.signal
      }).then(async matrix => {
        if (controller.signal.aborted) return;
        applyCapabilityMatrix(state, matrix);
        withRuntimeSkillCapabilities(state);
        await writeCapabilityCache(cachePath, fingerprint, matrix);
      }).catch(error => {
        if (!controller.signal.aborted) {
          console.warn(`Codex capability refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }
      });
    }
  };
}

async function writeCapabilityCache(
  path: string,
  fingerprint: string,
  matrix: RuntimeCapabilityMatrix
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ fingerprint, matrix }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function codexFingerprint(codexBin: string): string {
  try {
    const stat = statSync(codexBin);
    return `${resolve(codexBin)}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return codexBin;
  }
}

function readCapabilityCache(
  path: string,
  fingerprint: string,
  codexVersion: string
): RuntimeCapabilityMatrix | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      !isRecord(parsed)
      || parsed.fingerprint !== fingerprint
      || !isRecord(parsed.matrix)
      || parsed.matrix.codexVersion !== codexVersion
    ) {
      return undefined;
    }
    return parsed.matrix as RuntimeCapabilityMatrix;
  } catch {
    return undefined;
  }
}

function emitBootstrap(
  phase: BootstrapPhase,
  extra: Record<string, unknown> = {}
): void {
  console.log(JSON.stringify({
    type: 'clawee_daemon_bootstrap',
    phase,
    at: new Date().toISOString(),
    ...extra
  }));
}

function emitBootstrapError(input: {
  code: string;
  message: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}): void {
  console.log(JSON.stringify({
    type: 'clawee_daemon_bootstrap_error',
    at: new Date().toISOString(),
    ...input
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function prepareServerDirectories(
  dataDir: string,
  defaultProjectRoot: string
): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(defaultProjectRoot, { recursive: true });
    accessSync(dataDir, constants.R_OK | constants.W_OK);
    accessSync(defaultProjectRoot, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error('SERVER_DATA_DIR_UNAVAILABLE');
  }
}

function startupErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([A-Z][A-Z0-9_]+)/)?.[1] ?? 'DAEMON_START_FAILED';
}
