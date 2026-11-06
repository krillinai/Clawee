import { readFile, stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { UpdateInstallReceipt } from './customer-update-record.js';

export type WindowsInstallState = {
  schemaVersion: 1;
  state: 'installing' | 'complete';
  installerPid: number;
  targetVersion: string;
  elapsedMs?: number;
};

const INSTALL_WAIT_TIMEOUT_MS = 10 * 60_000;

export function windowsUpdateNeedsRelaunch(state: (WindowsInstallState & { waited: boolean }) | undefined, version: string, alreadyRelaunched: boolean): boolean {
  if (!state || state.targetVersion === version) return false;
  const target = state.targetVersion.split('.').map(part => Number.parseInt(part, 10));
  const current = version.split('.').map(part => Number.parseInt(part, 10));
  const different = target.findIndex((part, index) => part !== current[index]);
  if (different < 0 || target[different]! < current[different]!) return false;
  if (state.waited && !alreadyRelaunched) return true;
  throw new Error('重启后仍在运行旧版本，已停止自动重启，请使用官方安装包修复');
}

export function windowsInstallStatePath(installDirectory: string): string {
  return `${installDirectory}.clawee-update.json`;
}

// 复用 NSIS 完成记录；同版本复测必须看到本次安装写入的新记录。
export function readWindowsInstallReceipt(installDirectory: string): UpdateInstallReceipt | undefined {
  const path = windowsInstallStatePath(installDirectory);
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 4096) return undefined;
    const text = readFileSync(path, 'utf8');
    const state = parseInstallState(text);
    if (state.state !== 'complete') return undefined;
    return { targetVersion: state.targetVersion,
      fingerprint: createHash('sha256').update(`${metadata.ino}:${metadata.mtimeMs}:${metadata.ctimeMs}:${text}`).digest('hex') };
  } catch { return undefined; }
}

export async function waitForWindowsInstall(input: {
  installDirectory: string;
  signal?: AbortSignal;
  onWaiting?(state: WindowsInstallState): void | Promise<void>;
}): Promise<(WindowsInstallState & { waited: boolean }) | undefined> {
  const path = windowsInstallStatePath(input.installDirectory);
  let state = await readInstallState(path);
  if (state === undefined) return undefined;
  const targetVersion = state.targetVersion;
  const startedAt = Date.now();
  let waited = false;
  while (state.state === 'installing') {
    if (input.signal?.aborted) throw new Error('已取消等待更新安装');
    if (!installerAlive(state.installerPid)) {
      // 安装器可能在上一次读取后写入完成状态并立即退出。
      const completed = await readInstallState(path);
      if (completed?.state === 'complete' && completed.targetVersion === targetVersion) {
        state = completed;
        break;
      }
      throw new Error('客户端更新安装未完成，请重新运行安装包修复');
    }
    if (!waited) {
      waited = true;
      await input.onWaiting?.(state);
    }
    if (input.signal?.aborted) throw new Error('已取消等待更新安装');
    if (Date.now() - startedAt >= INSTALL_WAIT_TIMEOUT_MS) throw new Error('客户端更新安装等待超时，请检查安装进程后重试');
    state = await readInstallState(path);
    if (state === undefined || state.targetVersion !== targetVersion) throw new Error('客户端安装状态已变化，请重新打开客户端');
    if (state.state === 'installing') {
      try { await delay(1000, undefined, { signal: input.signal }); }
      catch (error) {
        if (input.signal?.aborted) throw new Error('已取消等待更新安装');
        throw error;
      }
    }
  }
  return { ...state, waited };
}

async function readInstallState(path: string): Promise<WindowsInstallState | undefined> {
  let text: string;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 4096) throw new Error('客户端安装状态无效');
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseInstallState(text);
}

function parseInstallState(text: string): WindowsInstallState {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('客户端安装状态无效'); }
  if (typeof value !== 'object' || value === null) throw new Error('客户端安装状态无效');
  const state = value as Partial<WindowsInstallState>;
  if (state.schemaVersion !== 1 || !['installing', 'complete'].includes(state.state ?? '')
    || !Number.isSafeInteger(state.installerPid) || (state.installerPid ?? 0) <= 0
    || typeof state.targetVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(state.targetVersion)
    || (state.elapsedMs !== undefined && (!Number.isSafeInteger(state.elapsedMs) || state.elapsedMs < 0))) {
    throw new Error('客户端安装状态无效');
  }
  return state as WindowsInstallState;
}

function installerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}
