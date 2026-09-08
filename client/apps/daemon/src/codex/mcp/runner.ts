import { BoundedTextBuffer } from '../bounded-buffer.js';
import {
  spawnCodexProcess,
  terminateCodexProcess
} from '../process.js';
import { redactMcpArgv, redactMcpText } from './redaction.js';

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const DEFAULT_FORCE_KILL_GRACE_MS = 500;

export type McpCommandResult = {
  command: string[];
  redactedCommand: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  redactedStdout: string;
  redactedStderr: string;
  timedOut: boolean;
  errorMessage: string | null;
};

export type RunMcpCommandInput = {
  codexBin: string;
  codexHome: string;
  args: string[];
  timeoutMs?: number;
  forceKillGraceMs?: number;
  sensitiveValues?: string[];
};

export function runMcpCommand(input: RunMcpCommandInput): Promise<McpCommandResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const forceKillGraceMs =
    input.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS;
  return new Promise(resolve => {
    const child = spawnCodexProcess(input.codexBin, input.args, {
      // Codex CLI expects the daemon environment (PATH/HOME/SHELL); env is not recorded, and argv/output are redacted.
      env: { ...process.env, CODEX_HOME: input.codexHome },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = new BoundedTextBuffer(MAX_STDOUT_BYTES);
    const stderr = new BoundedTextBuffer(MAX_STDERR_BYTES);
    let settled = false;
    let timedOut = false;
    let errorMessage: string | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
      timeout = undefined;
      forceKillTimeout = undefined;
    };

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null
    ) => {
      if (settled) return;
      settled = true;
      clearTimers();

      const rawStdout = stdout.text();
      const rawStderr = stderr.text();
      let diagnosticStderr = rawStderr;
      if (timedOut) {
        diagnosticStderr = appendDiagnostic(
          diagnosticStderr,
          `[codex-mcp] timed out after ${timeoutMs}ms`
        );
      } else if (errorMessage !== null) {
        diagnosticStderr = appendDiagnostic(
          diagnosticStderr,
          `[codex-mcp] process error: ${errorMessage}`
        );
      }
      if (signal !== null) {
        diagnosticStderr = appendDiagnostic(
          diagnosticStderr,
          `[codex-mcp] termination signal: ${signal}`
        );
      }

      const sensitiveValues = input.sensitiveValues ?? [];
      resolve({
        command: input.args,
        redactedCommand: redactMcpArgv(input.args),
        exitCode: timedOut ? null : exitCode,
        stdout: rawStdout,
        stderr: rawStderr,
        redactedStdout: redactMcpText(rawStdout, sensitiveValues),
        redactedStderr: redactMcpText(diagnosticStderr, sensitiveValues),
        timedOut,
        errorMessage
      });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.append(chunk));
    child.stderr.on('data', (chunk: string) => stderr.append(chunk));
    child.once('error', error => {
      errorMessage = error.message;
    });
    child.once('close', finish);

    timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void terminateCodexProcess(child, 'SIGTERM');
      forceKillTimeout = setTimeout(() => {
        if (!settled) void terminateCodexProcess(child, 'SIGKILL');
      }, forceKillGraceMs);
      forceKillTimeout.unref();
    }, timeoutMs);
    timeout.unref();
  });
}

function appendDiagnostic(stderr: string, diagnostic: string): string {
  if (stderr.length === 0) {
    return `${diagnostic}\n`;
  }
  return stderr.endsWith('\n') ? `${stderr}${diagnostic}\n` : `${stderr}\n${diagnostic}\n`;
}
