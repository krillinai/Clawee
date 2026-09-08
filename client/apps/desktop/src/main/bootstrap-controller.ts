import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  DesktopBootstrapState,
  DesktopConnectionConfig,
  DaemonConnection
} from '../shared/types.js';
import {
  DesktopRuntimeResolutionError,
  resolveDevelopmentRuntime,
  resolveEmbeddedRuntime,
  type ResolvedDesktopRuntime
} from './runtime-resolver.js';
import {
  DaemonStartError,
  DaemonManager,
  type DaemonStartInput
} from './daemon-manager.js';
import type { DesktopLogger } from './logger.js';

type BootstrapControllerEvents = {
  state: [DesktopBootstrapState];
  connection: [DesktopConnectionConfig | null];
  ready: [];
};

export class BootstrapController extends EventEmitter<BootstrapControllerEvents> {
  private state: DesktopBootstrapState = initialState();
  private runWork: Promise<void> | undefined;
  private resolvedRuntime: ResolvedDesktopRuntime | undefined;
  private verifiedFingerprint: string | undefined;
  private automaticRestarts = 0;
  private stableTimer: NodeJS.Timeout | undefined;
  private runAbortController: AbortController | undefined;

  constructor(private readonly input: {
    daemon: DaemonManager;
    logger: DesktopLogger;
    daemonEntryPath: string;
    dataDir: string;
    defaultProjectRoot: string;
    development: boolean;
    resourcesPath: string;
    runtimeManifestPath: string;
    developmentRuntimeDirectory: string;
    developmentCodexHome: string;
    runtimePackageDescriptorPath?: string;
    claweeVersion: string;
    homeDir?: string;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    processEnv?: NodeJS.ProcessEnv;
    enterpriseConfigPath: string;
    enterpriseE2ERunId?: string;
  }) {
    super();
    input.daemon.on('bootstrap', event => {
      if (event.type === 'clawee_daemon_bootstrap_error') {
        this.updateState({
          phase: 'failed',
          durationMs: event.durationMs,
          error: {
            code: event.code,
            message: event.message,
            details: event.details
          }
        });
        return;
      }
      if (event.phase === 'probing_codex') this.updateState({ phase: 'probing_codex' });
      if (event.phase === 'probe_succeeded') {
        this.updateState({
          phase: 'starting_runtime',
          durationMs: event.durationMs,
          probeTimings: event.probeTimings
        });
      }
      if (event.phase === 'starting_runtime') this.updateState({ phase: 'starting_runtime' });
    });
    input.daemon.on('connection', connection => {
      this.emit('connection', connection === null ? null : this.rendererConnection());
    });
    input.daemon.on('exit', event => {
      if (event.reason !== 'unexpected' || this.state.phase === 'failed') return;
      void this.recoverUnexpectedExit();
    });
  }

  get currentState(): DesktopBootstrapState {
    return structuredClone(this.state);
  }

  rendererConnection(): DesktopConnectionConfig | null {
    const connection = this.input.daemon.currentConnection;
    if (connection === undefined) return null;
    return createRendererConnection(connection, this.input.development);
  }

  start(): Promise<void> {
    if (this.runWork !== undefined) return this.runWork;
    const abortController = new AbortController();
    this.runAbortController = abortController;
    this.runWork = this.startInternal(abortController.signal).finally(() => {
      if (this.runAbortController === abortController) {
        this.runAbortController = undefined;
      }
      this.runWork = undefined;
    });
    return this.runWork;
  }

  async restartRuntime(): Promise<void> {
    if (this.resolvedRuntime === undefined) {
      await this.start();
      return;
    }
    await this.input.daemon.restart(this.daemonStartInput(
      this.resolvedRuntime,
      false,
      true
    ));
    this.updateState({ phase: 'starting_runtime', error: undefined });
    this.emit('ready');
  }

  markMigratingData(): void {
    this.updateState({ phase: 'migrating_data', error: undefined });
  }

  markWorkspaceReady(): void {
    this.updateState({ phase: 'ready', error: undefined });
  }

  markWorkspaceFailed(error: unknown): void {
    this.updateState({
      phase: 'workspace_failed',
      error: {
        code: error instanceof DaemonStartError
          ? error.code
          : isWorkspaceError(error)
            ? error.code
            : 'WORKSPACE_LOAD_FAILED',
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }

  setStartupMetrics(
    startupMetrics: DesktopBootstrapState['startupMetrics']
  ): void {
    this.updateState({ startupMetrics });
  }

  async stop(): Promise<void> {
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer);
    this.runAbortController?.abort();
    const runWork = this.runWork;
    await Promise.all([
      this.input.daemon.stop(),
      runWork?.catch(() => undefined) ?? Promise.resolve()
    ]);
    await this.input.daemon.stop();
  }

  private async startInternal(signal?: AbortSignal): Promise<void> {
    const attempt = this.state.attempt + 1;
    const startedAt = new Date().toISOString();
    this.state = {
      phase: 'resolving_codex',
      startedAt,
      updatedAt: startedAt,
      attempt,
      startupMetrics: this.state.startupMetrics
    };
    this.emit('state', this.currentState);
    const runtimeResolutionStartedAt = Date.now();
    let resolvedRuntime: ResolvedDesktopRuntime;
    try {
      resolvedRuntime = this.input.development
        ? await resolveDevelopmentRuntime({
            manifestPath: this.input.runtimeManifestPath,
            dataDir: this.input.dataDir,
            runtimeDirectory: this.input.developmentRuntimeDirectory,
            homePath: this.input.developmentCodexHome,
            claweeVersion: this.input.claweeVersion,
            processEnv: this.input.processEnv ?? process.env,
            ...(this.input.platform === undefined
              ? {}
              : { platform: this.input.platform }),
            ...(this.input.arch === undefined
              ? {}
              : { arch: this.input.arch })
          })
        : await resolveEmbeddedRuntime({
            resourcesPath: this.input.resourcesPath,
            dataDir: this.input.dataDir,
            manifestPath: this.input.runtimeManifestPath,
            claweeVersion: this.input.claweeVersion,
            processEnv: this.input.processEnv ?? process.env,
            ...(this.input.runtimePackageDescriptorPath === undefined
              ? {}
              : {
                  packageDescriptorPath:
                    this.input.runtimePackageDescriptorPath
                }),
            ...(this.input.homeDir === undefined
              ? {}
              : { homeDir: this.input.homeDir }),
            ...(this.input.platform === undefined
              ? {}
              : { platform: this.input.platform }),
            ...(this.input.arch === undefined
              ? {}
              : { arch: this.input.arch })
          });
    } catch (error) {
      if (isAbortRequested(signal)) return;
      this.input.logger.error('Codex Runtime resolution failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      this.updateState({
        phase: 'failed',
        error: parseBootstrapError(error)
      });
      return;
    }
    if (isAbortRequested(signal)) return;
    const candidate = resolvedRuntime.launchContext.candidate;
    this.input.logger.info('Resolved Codex Runtime', {
      runtimeId: candidate.runtimeId,
      source: candidate.source,
      target: candidate.target,
      entryPath: candidate.entryPath,
      homePath: candidate.homePath,
      contentSha256: candidate.contentSha256,
      verificationMode: resolvedRuntime.verificationMode,
      durationMs: Date.now() - runtimeResolutionStartedAt
    });
    this.resolvedRuntime = resolvedRuntime;
    const fingerprint = runtimeFingerprint(resolvedRuntime);
    const requireProbe = this.verifiedFingerprint !== fingerprint;
    this.updateState({
      phase: 'starting_daemon',
      runtimeId: candidate.runtimeId,
      runtimeSource: candidate.source === 'external-development'
        ? 'external-development'
        : 'embedded-package',
      runtimeTarget: candidate.target,
      runtimeContentSha256: candidate.contentSha256,
      codexEntryPath: candidate.entryPath,
      codexHome: candidate.homePath,
      error: undefined
    });
    try {
      if (isAbortRequested(signal)) return;
      await this.input.daemon.start(this.daemonStartInput(
        resolvedRuntime,
        requireProbe,
        !requireProbe
      ));
      if (isAbortRequested(signal)) {
        await this.input.daemon.stop();
        return;
      }
      this.verifiedFingerprint = fingerprint;
      this.automaticRestarts = 0;
      this.updateState({ phase: 'starting_runtime', error: undefined });
      this.emit('ready');
      this.armStableTimer();
    } catch (error) {
      if (isAbortRequested(signal)) return;
      if (this.state.phase === 'failed') return;
      this.input.logger.error('Desktop bootstrap failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      this.updateState({
        phase: 'failed',
        error: parseBootstrapError(error)
      });
    }
  }

  private async recoverUnexpectedExit(): Promise<void> {
    const runtime = this.resolvedRuntime;
    if (runtime === undefined || this.automaticRestarts >= 1) {
      this.updateState({
        phase: 'failed',
        error: {
          code: 'DAEMON_RESTART_EXHAUSTED',
          message: '本地运行服务连续退出，请导出诊断后重新检测'
        }
      });
      return;
    }
    this.automaticRestarts += 1;
    this.updateState({
      phase: 'starting_daemon',
      error: undefined
    });
    try {
      await this.input.daemon.start(this.daemonStartInput(runtime, false, true));
      this.updateState({ phase: 'starting_runtime' });
      this.emit('ready');
      this.armStableTimer();
    } catch (error) {
      this.updateState({
        phase: 'failed',
        error: parseBootstrapError(error)
      });
    }
  }

  private daemonStartInput(
    runtime: ResolvedDesktopRuntime,
    requireProbe: boolean,
    probeVerified: boolean
  ): DaemonStartInput {
    return {
      entryPath: this.input.daemonEntryPath,
      cwd: runtime.defaultCwd,
      env: runtime.env,
      runtime: runtime.launchContext,
      dataDir: this.input.dataDir,
      defaultCwd: runtime.defaultCwd,
      defaultProjectRoot: this.input.defaultProjectRoot,
      requireProbe,
      probeVerified,
      enterpriseConfigPath: this.input.enterpriseConfigPath,
      ...(this.input.enterpriseE2ERunId === undefined
        ? {}
        : { enterpriseE2ERunId: this.input.enterpriseE2ERunId })
    };
  }

  private updateState(patch: Partial<DesktopBootstrapState>): void {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.emit('state', this.currentState);
  }

  private armStableTimer(): void {
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.automaticRestarts = 0;
    }, 5 * 60 * 1_000);
    this.stableTimer.unref();
  }
}

export function createRendererConnection(
  connection: DaemonConnection,
  development: boolean
): DesktopConnectionConfig {
  if (development) {
    return {
      baseUrl: connection.address,
      token: connection.token
    };
  }
  return { baseUrl: '/.clawee/runtime' };
}

function isWorkspaceError(
  error: unknown
): error is Error & { code: string } {
  return error instanceof Error
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string';
}

function initialState(): DesktopBootstrapState {
  const now = new Date().toISOString();
  return {
    phase: 'idle',
    startedAt: now,
    updatedAt: now,
    attempt: 0
  };
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function runtimeFingerprint(runtime: ResolvedDesktopRuntime): string {
  const candidate = runtime.launchContext.candidate;
  return createHash('sha256')
    .update(candidate.runtimeId)
    .update('\0')
    .update(candidate.source)
    .update('\0')
    .update(candidate.entryPath)
    .update('\0')
    .update(candidate.homePath)
    .update('\0')
    .update(candidate.contentSha256)
    .digest('hex');
}

function parseBootstrapError(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof DaemonStartError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  if (error instanceof DesktopRuntimeResolutionError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'DAEMON_START_FAILED',
    message
  };
}

export function createRendererConnectionConfig(
  connection: DaemonConnection,
  development: boolean
): DesktopConnectionConfig {
  return createRendererConnection(connection, development);
}
