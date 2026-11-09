import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import type { DesktopBootstrapState, DesktopHostResult } from '../shared/types.js';
import { redactText, redactValue } from './redaction.js';

const MAX_LOG_TAIL_BYTES = 256 * 1024;

export async function exportDesktopDiagnostics(input: {
  state: DesktopBootstrapState;
  dataDir: string;
  logDir: string;
  daemonPid?: number;
  dependencies?: {
    showSaveDialog(options: Electron.SaveDialogOptions): Promise<{
      canceled: boolean;
      filePath?: string;
    }>;
    getAppVersion(): string;
    writeFile(
      path: string,
      contents: string,
      options: { mode: number }
    ): Promise<unknown>;
    now(): Date;
  };
}): Promise<DesktopHostResult> {
  const dependencies = input.dependencies ?? {
    showSaveDialog: options => dialog.showSaveDialog(options),
    getAppVersion: () => app.getVersion(),
    writeFile,
    now: () => new Date()
  };
  const now = dependencies.now();
  const result = await dependencies.showSaveDialog({
    title: '导出 Clawee 诊断',
    defaultPath: `clawee-diagnostics-${now.toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || result.filePath === undefined) {
    return { ok: false, code: 'FAILED', message: '已取消导出' };
  }
  const payload = redactValue({
    generatedAt: now.toISOString(),
    appVersion: dependencies.getAppVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    state: input.state,
    dataDir: input.dataDir,
    logDir: input.logDir,
    daemonPid: input.daemonPid ?? null,
    logs: await Promise.all([
      readDiagnosticLog(join(input.dataDir, 'daemon-lifecycle.log'), 'daemon-lifecycle.log'),
      readDiagnosticLog(join(input.logDir, 'desktop-main.log'), 'desktop-main.log'),
      readDiagnosticLog(join(input.logDir, 'desktop-main.log.1'), 'desktop-main.log.1')
    ])
  });
  await dependencies.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600
  });
  return { ok: true };
}

async function readDiagnosticLog(path: string, source: string) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('not_regular_file');
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_LOG_TAIL_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    const truncated = stat.size > buffer.length;
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (truncated) {
      const newline = content.indexOf('\n');
      content = newline < 0 ? '' : content.slice(newline + 1);
    }
    return { source, content: redactText(content), totalBytes: stat.size, truncated, missing: false };
  } catch {
    return { source, content: '', totalBytes: 0, truncated: false, missing: true };
  } finally {
    await file?.close();
  }
}
