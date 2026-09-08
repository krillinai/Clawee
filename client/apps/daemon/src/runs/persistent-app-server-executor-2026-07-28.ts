import type { RuntimeThread } from '../threads/types.js';
import type {
  AgentScheduleProcessInjector,
  AgentToolProcessInjection,
  AgentToolRunInjection,
  RunMcpInjector
} from '../agent-tools/run-injection.js';
import {
  createCodexAppServerHost,
  normalizeAppServerProfile,
  type CodexAppServerHost,
  type CodexAppServerHostInput,
  type CodexAppServerProcess,
  type CodexAppServerResult,
  type CodexAppServerTurnInput
} from '../codex/app-server-host-2026-07-28.js';
import { mergeCodexEnvironment } from '../codex/runtime-configuration.js';

export type PersistentAppServerLifecycleEvent = {
  source: 'persistent_app_server';
  event:
    | 'process_started'
    | 'process_initialized'
    | 'process_reused'
    | 'mcp_refreshed'
    | 'mcp_startup_wait_timed_out'
    | 'profile_restarted'
    | 'process_exited'
    | 'run_assigned'
    | 'run_cleared';
  at: string;
  runId?: string;
  pid?: number;
  profile: string;
  generation?: number;
  reason?: string;
};

export type PersistentAppServerExecutionInput = CodexAppServerTurnInput & {
  runId: string;
  thread: RuntimeThread;
  profile: string;
  spawnTimeoutMs?: number;
  forceKillGraceMs?: number;
  onLifecycle?(event: PersistentAppServerLifecycleEvent): void;
};

export type PersistentAppServerExecution = CodexAppServerProcess & {
  started: Promise<{
    pid: number;
    reused: boolean;
  }>;
};

export type PersistentAppServerExecutor = {
  readonly maxConcurrency: number;
  start(input: PersistentAppServerExecutionInput): PersistentAppServerExecution;
  isBusy(): boolean;
  invalidate(reason: string): Promise<void>;
  close(input?: {
    interruptGraceMs?: number;
    terminateGraceMs?: number;
  }): Promise<void>;
};

export type PersistentAppServerExecutorInput = {
  codexBin: string;
  codexHome: string;
  env?: Record<string, string>;
  processInjector?: AgentScheduleProcessInjector;
  runtimeInjector?: RunMcpInjector;
  createHost?(input: CodexAppServerHostInput): CodexAppServerHost;
  onLifecycle?(event: PersistentAppServerLifecycleEvent): void;
  maxConcurrency?: number;
};

export const DEFAULT_PERSISTENT_APP_SERVER_MAX_CONCURRENCY = 10;
export const MAX_PERSISTENT_APP_SERVER_MAX_CONCURRENCY = 10;

export function createPersistentAppServerExecutor(
  input: PersistentAppServerExecutorInput
): PersistentAppServerExecutor {
  const maxConcurrency = normalizeMaxConcurrency(input.maxConcurrency);
  if (maxConcurrency === 1) {
    return createPersistentAppServerSlotExecutor(input);
  }

  type Slot = {
    executor: PersistentAppServerExecutor;
    busy: boolean;
  };
  const slots: Slot[] = [];
  let closing = false;
  let closeWork: Promise<void> | undefined;

  function createSlot(): Slot {
    const slot = {
      executor: createPersistentAppServerSlotExecutor(input),
      busy: false
    };
    slots.push(slot);
    return slot;
  }

  return {
    maxConcurrency,
    start(run) {
      if (closing) throw new Error('Persistent app-server executor is closing');
      const slot = slots.find(candidate => !candidate.busy)
        ?? (slots.length < maxConcurrency ? createSlot() : undefined);
      if (slot === undefined) {
        throw new Error('Persistent app-server executor is busy');
      }

      slot.busy = true;
      let execution: PersistentAppServerExecution;
      try {
        execution = slot.executor.start(run);
      } catch (error) {
        slot.busy = false;
        throw error;
      }
      return {
        cancel: execution.cancel,
        started: execution.started,
        result: execution.result.finally(() => {
          slot.busy = false;
        })
      };
    },
    isBusy() {
      return closing
        || (slots.length >= maxConcurrency && slots.every(slot => slot.busy));
    },
    async invalidate(reason) {
      if (closing) return;
      await Promise.all(slots.map(slot => slot.executor.invalidate(reason)));
    },
    async close(options = {}) {
      if (closeWork !== undefined) return closeWork;
      closing = true;
      closeWork = (async () => {
        const results = await Promise.allSettled(
          slots.map(slot => slot.executor.close(options))
        );
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (failed !== undefined) throw failed.reason;
      })();
      await closeWork;
    }
  };
}

function createPersistentAppServerSlotExecutor(
  input: PersistentAppServerExecutorInput
): PersistentAppServerExecutor {
  const createHost = input.createHost ?? createCodexAppServerHost;
  let host: CodexAppServerHost | undefined;
  let injection: AgentToolProcessInjection | undefined;
  let profile: string | undefined;
  let runtimeConfigurationFingerprint: string | undefined;
  let activeRunId: string | undefined;
  let activeExecution: PersistentAppServerExecution | undefined;
  let activeLifecycle:
    | PersistentAppServerExecutionInput['onLifecycle']
    | undefined;
  let busy = false;
  let closing = false;
  let closeWork: Promise<void> | undefined;
  let idleInvalidationWork: Promise<void> | undefined;
  let staleReason: string | undefined;

  function start(
    run: PersistentAppServerExecutionInput
  ): PersistentAppServerExecution {
    if (closing) throw new Error('Persistent app-server executor is closing');
    if (busy) throw new Error('Persistent app-server executor is busy');
    busy = true;
    activeRunId = run.runId;
    activeLifecycle = run.onLifecycle;
    const lifecycleProfile = normalizeAppServerProfile(run.profile);
    let process: CodexAppServerProcess | undefined;
    let cancelRequested = false;

    const startedWork = prepareExecution(run).then(prepared => {
      process = prepared.process;
      if (cancelRequested) process.cancel();
      return {
        pid: prepared.pid,
        reused: prepared.reused
      };
    });
    const result = startedWork
      .then(() => process!.result)
      .finally(async () => {
        injection?.deactivate(run.runId);
        if (host !== undefined && !host.isReusable()) {
          await clearHost('host_not_reusable', run.forceKillGraceMs);
        }
        if (host !== undefined && staleReason !== undefined) {
          const reason = staleReason;
          staleReason = undefined;
          await clearHost(reason, run.forceKillGraceMs);
        }
        emitLifecycle('run_cleared', lifecycleProfile, {
          runId: run.runId,
          pid: host?.pid
        });
        activeExecution = undefined;
        activeRunId = undefined;
        activeLifecycle = undefined;
        busy = false;
      });
    const execution: PersistentAppServerExecution = {
      cancel() {
        cancelRequested = true;
        process?.cancel();
      },
      result,
      started: startedWork
    };
    activeExecution = execution;
    return execution;
  }

  async function prepareExecution(
    run: PersistentAppServerExecutionInput
  ): Promise<{
    process: CodexAppServerProcess;
    pid: number;
    reused: boolean;
  }> {
    assertOpen();
    if (idleInvalidationWork !== undefined) {
      await idleInvalidationWork;
      assertOpen();
    }
    const nextProfile = normalizeAppServerProfile(run.profile);
    const runtimeInjection = await input.runtimeInjector?.prepare({
      runId: run.runId,
      thread: run.thread,
      createdBy: 'api'
    });
    const nextRuntimeConfigurationFingerprint =
      runtimeInjection?.configurationFingerprint ?? '';
    if (host !== undefined && staleReason !== undefined) {
      const reason = staleReason;
      staleReason = undefined;
      await clearHost(reason, run.forceKillGraceMs);
      assertOpen();
    }
    let reused = host !== undefined
      && host.isReusable()
      && profile === nextProfile
      && runtimeConfigurationFingerprint
        === nextRuntimeConfigurationFingerprint;
    if (host !== undefined && !reused) {
      const previousProfile = profile;
      const reason = previousProfile !== nextProfile
        ? 'profile_changed'
        : 'runtime_configuration_changed';
      await clearHost(reason, run.forceKillGraceMs);
      assertOpen();
      if (previousProfile !== undefined && previousProfile !== nextProfile) {
        emitLifecycle('profile_restarted', nextProfile, {
          runId: run.runId,
          reason: `${previousProfile}->${nextProfile}`
        });
      }
    }

    if (host === undefined) {
      assertOpen();
      injection = input.processInjector?.create();
      const activation = injection?.activate({
        runId: run.runId,
        thread: run.thread,
        createdBy: 'api'
      });
      try {
        profile = nextProfile;
        runtimeConfigurationFingerprint =
          nextRuntimeConfigurationFingerprint;
        const processConfiguration = mergeInjections(
          injection,
          runtimeInjection
        );
        host = createHost({
          codexBin: input.codexBin,
          codexHome: input.codexHome,
          cwd: run.cwd,
          profile: nextProfile,
          mcpServers: processConfiguration?.mcpServers,
          env: mergeCodexEnvironment(input.env, processConfiguration?.env),
          spawnTimeoutMs: run.spawnTimeoutMs,
          forceKillGraceMs: run.forceKillGraceMs,
          onLifecycle(event) {
            emitLifecycle(event.event, nextProfile, {
              runId: activeRunId,
              pid: event.pid,
              generation: event.generation,
              reason: event.reason
            });
          }
        });
        const currentHost = host;
        const pid = await currentHost.started;
        assertOpen();
        const process = currentHost.run({
          ...turnInput(run),
          manifestKey: activation?.manifestKey
        });
        emitLifecycle('run_assigned', nextProfile, {
          runId: run.runId,
          pid
        });
        return { process, pid, reused: false };
      } catch (error) {
        injection?.deactivate(run.runId);
        await clearHost('start_failed', run.forceKillGraceMs);
        throw error;
      }
    }

    const activation = injection?.activate({
      runId: run.runId,
      thread: run.thread,
      createdBy: 'api'
    });
    try {
      const currentHost = host;
      const pid = await currentHost.started;
      assertOpen();
      const process = currentHost.run({
        ...turnInput(run),
        manifestKey: activation?.manifestKey
      });
      emitLifecycle('process_reused', nextProfile, {
        runId: run.runId,
        pid
      });
      emitLifecycle('run_assigned', nextProfile, {
        runId: run.runId,
        pid
      });
      reused = true;
      return { process, pid, reused };
    } catch (error) {
      injection?.deactivate(run.runId);
      throw error;
    }
  }

  function assertOpen(): void {
    if (closing) {
      throw new Error('Persistent app-server executor is closing');
    }
  }

  async function clearHost(
    reason: string,
    forceKillGraceMs?: number
  ): Promise<void> {
    const currentHost = host;
    const currentInjection = injection;
    host = undefined;
    injection = undefined;
    profile = undefined;
    runtimeConfigurationFingerprint = undefined;
    try {
      await currentHost?.close(reason, forceKillGraceMs);
    } finally {
      currentInjection?.close();
    }
  }

  function emitLifecycle(
    event: PersistentAppServerLifecycleEvent['event'],
    eventProfile: string,
    details: Omit<
      PersistentAppServerLifecycleEvent,
      'source' | 'event' | 'at' | 'profile'
    > = {}
  ): void {
    input.onLifecycle?.({
      source: 'persistent_app_server',
      event,
      at: new Date().toISOString(),
      profile: eventProfile,
      ...details
    });
    activeLifecycle?.({
      source: 'persistent_app_server',
      event,
      at: new Date().toISOString(),
      profile: eventProfile,
      ...details
    });
  }

  return {
    maxConcurrency: 1,
    start,
    isBusy() {
      return busy;
    },
    async invalidate(reason) {
      if (closing) return;
      if (busy) {
        staleReason = reason;
        return;
      }
      if (idleInvalidationWork !== undefined) {
        await idleInvalidationWork;
        return;
      }
      if (host === undefined) return;
      const work = clearHost(reason).finally(() => {
        if (idleInvalidationWork === work) {
          idleInvalidationWork = undefined;
        }
      });
      idleInvalidationWork = work;
      await work;
    },
    async close(options = {}) {
      if (closeWork !== undefined) return closeWork;
      closing = true;
      closeWork = (async () => {
        let firstError: unknown;
        const execution = activeExecution;
        if (execution !== undefined) {
          execution.cancel();
          await settleWithin(
            execution.result,
            options.interruptGraceMs ?? 1_000
          );
        }
        if (host !== undefined) {
          try {
            await clearHost(
              'executor_closed',
              options.terminateGraceMs ?? 2_000
            );
          } catch (error) {
            firstError = error;
          }
        }
        if (idleInvalidationWork !== undefined) {
          try {
            await idleInvalidationWork;
          } catch (error) {
            firstError ??= error;
          }
        }
        if (execution !== undefined) {
          await execution.result.catch(() => undefined);
        }
        if (firstError !== undefined) throw firstError;
      })();
      await closeWork;
    }
  };
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_PERSISTENT_APP_SERVER_MAX_CONCURRENCY);
}

function mergeInjections(
  processInjection: AgentToolProcessInjection | undefined,
  runtimeInjection: AgentToolRunInjection | undefined
): AgentToolRunInjection | undefined {
  if (processInjection === undefined) return runtimeInjection;
  if (runtimeInjection === undefined) return processInjection;
  return {
    mcpServers: [
      ...processInjection.mcpServers,
      ...runtimeInjection.mcpServers
    ],
    env: {
      ...processInjection.env,
      ...runtimeInjection.env
    },
    configurationFingerprint: runtimeInjection.configurationFingerprint
  };
}

function turnInput(
  input: PersistentAppServerExecutionInput
): CodexAppServerTurnInput {
  return {
    cwd: input.cwd,
    sandbox: input.sandbox,
    model: input.model,
    reasoning: input.reasoning,
    prompt: input.prompt,
    imagePaths: input.imagePaths,
    codexThreadId: input.codexThreadId,
    timeoutMs: input.timeoutMs,
    inactivityTimeoutMs: input.inactivityTimeoutMs,
    mcpStartupWaitTimeoutMs: input.mcpStartupWaitTimeoutMs,
    serverDeployment: input.serverDeployment,
    onBeforeWritableRequest: input.onBeforeWritableRequest,
    onNotification: input.onNotification,
    onThreadStarted: input.onThreadStarted,
    onTurnStartWritten: input.onTurnStartWritten,
    onApprovalRequest: input.onApprovalRequest,
    onStderrChunk: input.onStderrChunk
  };
}

async function settleWithin(
  work: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
