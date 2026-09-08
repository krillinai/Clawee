import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export async function cleanupLegacyEnterpriseCollector(input: {
  platform?: NodeJS.Platform;
  collectorRoot?: string;
  markerPath?: string;
  spawn?: typeof spawn;
  timeoutMs?: number;
} = {}): Promise<void> {
  const platform = input.platform ?? process.platform;
  const collectorRoot = resolve(input.collectorRoot ?? join(homedir(), '.clawee', 'collector'));
  const markerPath = resolve(input.markerPath ?? join(dirname(collectorRoot), 'collector-direct-cleanup-v1.done'));
  if (existsSync(markerPath)) return;

  const extension = platform === 'win32' ? '.exe' : '';
  const binary = join(collectorRoot, 'bin', `clawee-collector${extension}`);
  const config = join(collectorRoot, 'config.toml');
  if (!existsSync(binary) || !existsSync(config)) return;

  const args = platform === 'win32'
    ? [
        'setup', 'windows-user', 'cleanup-runtime',
        '--binary', binary,
        '--runner-binary', join(collectorRoot, 'bin', `clawee-collector-runner${extension}`),
        '--config', config
      ]
    : platform === 'darwin' || platform === 'linux'
      ? ['setup', 'unix-user', 'cleanup-runtime', '--binary', binary, '--config', config]
      : undefined;
  if (args === undefined) {
    console.warn('Legacy Collector cleanup skipped [COLLECTOR_PLATFORM_UNSUPPORTED]');
    return;
  }

  try {
    await runChild(input.spawn ?? spawn, binary, args, input.timeoutMs ?? 30_000);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    console.warn(`Legacy Collector cleanup failed [COLLECTOR_CLEANUP_FAILED]; run manually: ${binary} ${args.join(' ')}`);
  }
}

function runChild(
  spawnProcess: typeof spawn,
  command: string,
  args: string[],
  timeoutMs: number
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, args, {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('collector cleanup timed out'));
    }, timeoutMs);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`collector cleanup exited ${code ?? 'unknown'}`));
    });
  });
}
