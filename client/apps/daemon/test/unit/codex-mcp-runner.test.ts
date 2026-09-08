import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMcpCommand } from '../../src/codex/mcp/runner.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFakeCodex(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-runner-'));
  tmpDirs.push(dir);
  const codexBin = join(dir, 'fake-codex.js');
  writeFileSync(codexBin, `#!/usr/bin/env node\n${source}`);
  chmodSync(codexBin, 0o755);
  return codexBin;
}

describe('codex mcp runner', () => {
  it('launches Windows command shims', async () => {
    if (process.platform !== 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'clawee-codex-mcp-runner-cmd-'));
    tmpDirs.push(dir);
    const codexBin = join(dir, 'codex.cmd');
    writeFileSync(
      codexBin,
      `@echo off\r\n"${process.execPath}" -e "process.stdout.write(process.argv[1])" %1\r\n`
    );

    const result = await runMcpCommand({
      codexBin,
      codexHome: dir,
      args: ['mcp-list-ok']
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('mcp-list-ok');
  });

  it('passes CODEX_HOME to the codex process', async () => {
    const codexBin = makeFakeCodex(`
process.stdout.write('CODEX_HOME=' + process.env.CODEX_HOME + '\\n');
`);
    const codexHome = mkdtempSync(join(tmpdir(), 'clawee-codex-home-'));
    tmpDirs.push(codexHome);

    const result = await runMcpCommand({
      codexBin,
      codexHome,
      args: ['mcp', 'list']
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe(`CODEX_HOME=${codexHome}\n`);
  });

  it('returns raw stdout and stderr with redacted variants', async () => {
    const codexBin = makeFakeCodex(`
process.stdout.write('GITHUB_TOKEN=secret\\n');
process.stderr.write('Authorization: Bearer abc123\\n');
`);
    const codexHome = mkdtempSync(join(tmpdir(), 'clawee-codex-home-'));
    tmpDirs.push(codexHome);

    const result = await runMcpCommand({
      codexBin,
      codexHome,
      args: ['mcp', 'get', 'github']
    });

    expect(result.stdout).toBe('GITHUB_TOKEN=secret\n');
    expect(result.stderr).toBe('Authorization: Bearer abc123\n');
    expect(result.redactedStdout).toBe('GITHUB_TOKEN=[REDACTED]\n');
    expect(result.redactedStderr).toBe('Authorization: Bearer [REDACTED]\n');
  });

  it('marks timed out commands and includes a redacted diagnostic', async () => {
    const codexBin = makeFakeCodex(`
setTimeout(() => {}, 1000);
`);
    const codexHome = mkdtempSync(join(tmpdir(), 'clawee-codex-home-'));
    tmpDirs.push(codexHome);

    const result = await runMcpCommand({
      codexBin,
      codexHome,
      args: ['mcp', 'list'],
      timeoutMs: 10
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.redactedStderr).toContain('[codex-mcp] timed out after 10ms');
  });

  it('preserves raw stderr when timed out while redacting stderr diagnostics', async () => {
    const codexBin = makeFakeCodex(`
require('node:fs').writeSync(2, 'GITHUB_TOKEN=secret\\n');
setTimeout(() => {}, 30_000);
`);
    const codexHome = mkdtempSync(join(tmpdir(), 'clawee-codex-home-'));
    tmpDirs.push(codexHome);

    const result = await runMcpCommand({
      codexBin,
      codexHome,
      args: ['mcp', 'list'],
      timeoutMs: 5_000
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toBe('GITHUB_TOKEN=secret\n');
    expect(result.redactedStderr).toContain('GITHUB_TOKEN=[REDACTED]');
    expect(result.redactedStderr).toContain('[codex-mcp] timed out after 5000ms');
  }, 10_000);

  it('does not treat a process SIGTERM as a timeout', async () => {
    const codexBin = makeFakeCodex(`
process.kill(process.pid, 'SIGTERM');
`);
    const codexHome = mkdtempSync(join(tmpdir(), 'clawee-codex-home-'));
    tmpDirs.push(codexHome);

    const result = await runMcpCommand({
      codexBin,
      codexHome,
      args: ['mcp', 'list'],
      timeoutMs: 10_000
    });

    expect(result.timedOut).toBe(false);
    if (process.platform === 'win32') {
      expect(result.exitCode).toBe(1);
    } else {
      expect(result.exitCode).toBeNull();
      expect(result.redactedStderr).toContain('[codex-mcp] termination signal: SIGTERM');
    }
    expect(result.redactedStderr).not.toContain('timed out');
  }, 15_000);

  it('does not block the daemon event loop while codex is running', async () => {
    const codexBin = makeFakeCodex(`
setTimeout(() => process.stdout.write('done\\n'), 250);
`);
    const codexHome = mkdtempSync(join(tmpdir(), 'clawee-codex-home-'));
    tmpDirs.push(codexHome);

    const startedAt = Date.now();
    const resultWork = runMcpCommand({
      codexBin,
      codexHome,
      args: ['mcp', 'list']
    });

    expect(Date.now() - startedAt).toBeLessThan(100);
    await expect(resultWork).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'done\n'
    });
  });
});
