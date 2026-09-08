import {
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import { redactText } from '../security/redaction.js';
import {
  spawnCodexProcess,
  terminateCodexProcess
} from './process.js';
import {
  BoundedFrameBuffer,
  BoundedTextBuffer
} from './bounded-buffer.js';

export type CodexAppServerRequestClient = {
  request<Result>(method: string, params: unknown): Promise<Result>;
  close(): Promise<void>;
};

export type CreateCodexAppServerClientInput = {
  codexBin: string;
  codexHome: string;
  cwd?: string;
  requestTimeoutMs?: number;
  env?: Record<string, string>;
};

type PendingRequest = {
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type AppServerProcessState = {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  initialize: Promise<void>;
  nextRequestId: number;
  stdoutFrames: BoundedFrameBuffer;
  stderr: BoundedTextBuffer;
  settled: boolean;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 2_000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDERR_SUMMARY_CHARS = 8 * 1024;

export function createCodexAppServerClient(
  input: CreateCodexAppServerClientInput
): CodexAppServerRequestClient {
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let processState: AppServerProcessState | undefined;
  let closing = false;

  return {
    async request<Result>(method: string, params: unknown): Promise<Result> {
      if (closing) throw new Error('Codex app-server client is closed');
      const state = ensureProcess();
      await state.initialize;
      return sendRequest(state, method, params) as Promise<Result>;
    },

    async close(): Promise<void> {
      closing = true;
      const state = processState;
      processState = undefined;
      if (state === undefined || state.settled) return;

      const closed = new Promise<void>(resolve => {
        state.child.once('close', () => resolve());
      });
      terminateCodexProcess(state.child, 'SIGTERM');
      const forceKill = setTimeout(() => {
        if (!state.settled) terminateCodexProcess(state.child, 'SIGKILL');
      }, CLOSE_GRACE_MS);
      forceKill.unref();
      await closed;
      clearTimeout(forceKill);
    }
  };

  function ensureProcess(): AppServerProcessState {
    if (processState !== undefined && !processState.settled) return processState;

    const child = spawnCodexProcess(input.codexBin, ['app-server', '--stdio'], {
      cwd: input.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...input.env,
        CODEX_HOME: input.codexHome
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const state = {
      child,
      pending: new Map<string, PendingRequest>(),
      initialize: Promise.resolve(),
      nextRequestId: 0,
      stdoutFrames: new BoundedFrameBuffer(1024 * 1024),
      stderr: new BoundedTextBuffer(MAX_STDERR_BYTES),
      settled: false
    } satisfies AppServerProcessState;
    processState = state;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of state.stdoutFrames.push(chunk)) {
        if (line.trim().length === 0) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          failProcess(state, new Error('Codex app-server emitted invalid JSON'));
          return;
        }
        handleMessage(state, message);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => state.stderr.append(chunk));
    child.stdin.on('error', error => handleWriteFailure(state, error));
    child.on('error', error => failProcess(state, error));
    child.on('close', (code, signal) => {
      const reason = code === null
        ? `signal ${signal ?? 'unknown'}`
        : `exit code ${code}`;
      const stderr = stderrSummary(state);
      failProcess(
        state,
        new Error(
          `Codex app-server closed with ${reason}${
            stderr.length === 0 ? '' : `: ${stderr}`
          }`
        ),
        false
      );
    });

    state.initialize = sendRequest(state, 'initialize', {
      clientInfo: {
        name: 'clawee-agent',
        title: 'Clawee Agent',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    }).then(() => {
      sendNotification(state, 'initialized');
    });
    return state;
  }

  function sendRequest(
    state: AppServerProcessState,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (state.settled || state.child.stdin.destroyed) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    const id = `clawee_sessions_${++state.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failProcess(
          state,
          new Error(`Codex app-server request timed out: ${method}`)
        );
      }, requestTimeoutMs);
      timer.unref();
      state.pending.set(id, { timer, resolve, reject });
      try {
        state.child.stdin.write(
          `${JSON.stringify({ id, method, params })}\n`,
          error => {
            if (error === null || error === undefined) return;
            handleWriteFailure(state, error);
          }
        );
      } catch (error) {
        handleWriteFailure(state, toError(error));
      }
    });
  }

  function sendNotification(state: AppServerProcessState, method: string): void {
    if (state.settled || state.child.stdin.destroyed) return;
    try {
      state.child.stdin.write(
        `${JSON.stringify({ method })}\n`,
        error => {
          if (error === null || error === undefined) return;
          handleWriteFailure(state, error);
        }
      );
    } catch (error) {
      handleWriteFailure(state, toError(error));
    }
  }

  function handleWriteFailure(
    state: AppServerProcessState,
    error: Error
  ): void {
    if (isBrokenPipeError(error)) return;
    failProcess(state, error);
  }

  function handleMessage(state: AppServerProcessState, value: unknown): void {
    if (!isRecord(value)) return;
    const id = value.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const pending = state.pending.get(String(id));
    if (pending === undefined) {
      if (typeof value.method === 'string') {
        state.child.stdin.write(`${JSON.stringify({
          id,
          error: {
            code: -32601,
            message: `Unsupported server request: ${value.method}`
          }
        })}\n`);
      }
      return;
    }

    clearTimeout(pending.timer);
    state.pending.delete(String(id));
    if (isRecord(value.error)) {
      pending.reject(new CodexAppServerResponseError(
        typeof value.error.message === 'string'
          ? value.error.message
          : 'Codex app-server request failed',
        typeof value.error.code === 'number' ? value.error.code : undefined
      ));
      return;
    }
    pending.resolve(value.result);
  }

  function failProcess(
    state: AppServerProcessState,
    error: Error,
    kill = true
  ): void {
    if (state.settled) return;
    state.settled = true;
    if (processState === state) processState = undefined;
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pending.clear();
    if (kill && !state.child.killed) {
      terminateCodexProcess(state.child, 'SIGTERM');
      const forceKill = setTimeout(() => {
        if (state.child.exitCode === null && state.child.signalCode === null) {
          terminateCodexProcess(state.child, 'SIGKILL');
        }
      }, CLOSE_GRACE_MS);
      forceKill.unref();
    }
  }
}

function stderrSummary(state: AppServerProcessState): string {
  return redactText(state.stderr.text())
    .trim()
    .slice(-MAX_STDERR_SUMMARY_CHARS);
}

export class CodexAppServerResponseError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
    this.name = 'CodexAppServerResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBrokenPipeError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'EPIPE';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
