import {
  accessSync,
  appendFileSync,
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
import { installGracefulShutdown, installParentPortShutdown } from './shutdown.js';
import {
  createProductionServerInput,
  resolveEnterpriseStartupArguments,
  resolveProductionServerEnvironment,
  resolveServerModeArguments
} from './startup.js';
import { checkServerReadiness } from './server-mode/readiness.js';
import { acquireRuntimeLock, RuntimeLockError } from './runtime-lock.js';
import { createEnterpriseCredentialStore } from './enterprise/credential-store-2026-07-30.js';
import {
  createPrivateCredentialFileStore,
  resolvePrivateCredentialFilePath
} from './security/private-credential-file.js';
import { openRuntimeDatabase } from './storage/database.js';

type BootstrapPhase = 'starting_runtime';

let server: FastifyInstance | undefined;
let closeWork: Promise<void> | undefined;
let releaseRuntimeLock: (() => Promise<void>) | undefined;
let cancelCapabilityRefresh: (() => void) | undefined;
let cancelModelCatalogRefresh: (() => void) | undefined;
let serverModeDatabase: ReturnType<typeof openRuntimeDatabase> | undefined;
let lifecycleLogPath: string | undefined;

const MODEL_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const parentPort = (process as NodeJS.Process & {
  parentPort?: {
    on(event: 'message', listener: (event: unknown) => void): unknown;
    off(event: 'message', listener: (event: unknown) => void): unknown;
  };
}).parentPort;
let startupWork = Promise.resolve();
let shutdownRequested = false;
const closeAfterStartup = async () => {
  shutdownRequested = true;
  await startupWork;
  await closeServer();
};
installGracefulShutdown({
  close: closeAfterStartup,
  onError(error) {
    console.error(`Failed to close daemon cleanly: ${String(error)}`);
    process.exitCode = 1;
  }
});
installParentPortShutdown({
  parentPort,
  close: closeAfterStartup,
  onShutdown(reason) {
    recordLifecycle({ event: 'DAEMON_SHUTDOWN_STARTED', reason });
  },
  onError(error) {
    recordLifecycle({ event: 'DAEMON_SHUTDOWN_FAILED', code: error instanceof Error
      && error.message === 'DAEMON_SHUTDOWN_TIMEOUT' ? 'DAEMON_SHUTDOWN_TIMEOUT' : 'DAEMON_CLOSE_FAILED' });
    console.error(`Failed to close daemon after parent shutdown: ${String(error)}`);
    process.exitCode = 1;
  },
  finish: () => {
    recordLifecycle({ event: 'DAEMON_EXIT_REQUESTED', exitCode: process.exitCode ?? 0 });
    process.exit();
  }
});

startupWork = main().catch(async error => {
  await closeServer().catch(closeError => {
    console.error(`Failed to close daemon after startup failure: ${
      closeError instanceof Error ? closeError.message : String(closeError)
    }`);
  });
  emitBootstrapError({
    code: startupErrorCode(error),
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof RuntimeLockError ? { details: error.details } : {})
  });
  process.exitCode = 1;
});
await startupWork;
if (parentPort !== undefined && process.exitCode === 1) process.exit(1);

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
  releaseRuntimeLock = await acquireRuntimeLock(dataDir);
  lifecycleLogPath = join(dataDir, 'daemon-lifecycle.log');
  process.once('exit', () => { void releaseRuntimeLock?.(); });
  assertStartupActive();
  const runtimeState = createCodexRuntimeStateStore({
    dataDir,
    runtime
  });
  await runtimeState.reconcileStartup();
  assertStartupActive();
  const versionProbe = await probeCodexVersionAsync({
    codexBin,
    timeoutMs: 3_000
  });
  assertStartupActive();
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
  assertStartupActive();
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
      const modelCatalogPath = context.modelCatalogPath
        ?? (await serializeCatalogOperation(async () => installFallbackModelCatalog({
          codexBin,
          codexHome,
          defaultModel: configuration.model
        }))).path;
      prepared = await preparePlatformClientWithFallback(
        configuration,
        modelCatalogPath
      );
      codexAppServerClient.activate(prepared.client);
      stopModelCatalogRefresh();
      activePlatformCatalog = {
        configuration,
        apiKey,
        credentialVersion: context.credentialVersion ?? 1
      };
      if (context.mode === 'platform_managed') {
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
      void refreshPlatformCatalog().catch(() => undefined);
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
    async preparePlatformCatalog(configuration) {
      const installed = await serializeCatalogOperation(async () => installFallbackModelCatalog({
        codexBin,
        codexHome,
        defaultModel: configuration.model
      }));
      return { modelCatalogPath: installed.path };
    },
    async activate(configuration, apiKey, context) {
      await activateModelService(configuration, apiKey, context);
    },
    onAvailabilityChange(probe) {
      availabilityProbe = probe;
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
  assertStartupActive();
  let address: string;
  let readinessChecks: Awaited<ReturnType<typeof checkServerReadiness>> | undefined;
  if (serverMode !== undefined) {
    serverModeDatabase = openRuntimeDatabase(join(dataDir, 'app.sqlite'));
  }
  try {
    server = await buildServer(createProductionServerInput({
      token,
      autoInstallUpdateSkills: serverMode?.autoInstallUpdateSkills ?? false,
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
    assertStartupActive();
    address = await server.listen(serverMode === undefined
      ? { host: '127.0.0.1', port: 0 }
      : { host: serverMode.host, port: serverMode.port });
    assertStartupActive();
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
  if (firstError !== undefined) throw firstError;
  await releaseRuntimeLock?.();
}

function assertStartupActive(): void {
  if (shutdownRequested) throw new Error('DAEMON_START_CANCELLED');
}

function recordLifecycle(details: Record<string, unknown>): void {
  const line = JSON.stringify({ ...details, pid: process.pid, at: new Date().toISOString() });
  console.error(line);
  if (lifecycleLogPath === undefined) return;
  try {
    appendFileSync(lifecycleLogPath, `${line}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`Failed to record daemon lifecycle: ${String(error)}`);
  }
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
