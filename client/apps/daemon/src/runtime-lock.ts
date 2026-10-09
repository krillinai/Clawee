import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';

type LockIdentity = {
  version: 2;
  pid: number;
  instanceId: string;
  dataDir: string;
  leasePort: number;
};

export class RuntimeLockError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown>) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = 'RuntimeLockError';
  }
}

export async function acquireRuntimeLock(dataDir: string): Promise<() => Promise<void>> {
  const canonicalPath = realpathSync(dataDir);
  const canonicalDir = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  const leasePort = 20_000 + createHash('sha256').update(canonicalDir).digest().readUInt32BE(0) % 40_000;
  const path = join(dataDir, 'clawee-runtime.lock');
  const identityPath = `${path}.json`;
  const identity: LockIdentity = {
    version: 2, pid: process.pid, instanceId: randomUUID(), dataDir: canonicalDir, leasePort
  };
  const lease = createServer(socket => {
    socket.on('error', () => undefined);
    socket.setTimeout(1_000, () => socket.destroy());
    socket.end(`${JSON.stringify(identity)}\n`);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      lease.once('error', reject);
      lease.listen({ host: '127.0.0.1', port: leasePort, exclusive: true }, resolve);
    });
  } catch (error) {
    const owner = readIdentity(identityPath);
    const live = errorCode(error) === 'EADDRINUSE' ? await readLease(leasePort) : undefined;
    const verified = owner !== undefined && live !== undefined
      && owner.instanceId === live.instanceId && owner.pid === live.pid
      && owner.dataDir === canonicalDir && owner.leasePort === leasePort;
    throw new RuntimeLockError(verified ? 'DAEMON_DATA_DIR_IN_USE' : 'DAEMON_DATA_DIR_LOCK_UNVERIFIED', {
      dataDir, lockPath: path, ownerPid: owner?.pid, leasePort,
      reason: verified ? 'verified-owner-lease' : 'lease-unavailable', systemCode: errorCode(error)
    });
  }
  lease.unref();
  let claimed = false;
  try {
    const pid = readLockPid(path);
    if (pid !== undefined) {
      const previous = readIdentity(identityPath);
      const staleLease = previous?.pid === pid && previous.dataDir === canonicalDir
        && previous.leasePort === leasePort;
      if (!staleLease) verifyLegacyOwner(pid, dataDir, path);
      rmSync(path);
    }
    const descriptor = openSync(path, 'wx', 0o600);
    claimed = true;
    try {
      writeFileSync(descriptor, `${process.pid}\n`);
    } finally {
      closeSync(descriptor);
    }
    const temporary = `${identityPath}.${identity.instanceId}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
      renameSync(temporary, identityPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    try {
      if (claimed) rmSync(path, { force: true });
    } finally {
      await closeLease(lease);
    }
    if (error instanceof RuntimeLockError) throw error;
    throw new RuntimeLockError('DAEMON_DATA_DIR_LOCK_IO_FAILED', {
      dataDir, lockPath: path, systemCode: errorCode(error)
    });
  }
  let releaseWork: Promise<void> | undefined;
  return () => {
    if (releaseWork !== undefined) return releaseWork;
    try {
      if (readIdentity(identityPath)?.instanceId === identity.instanceId && readLockPid(path) === process.pid) {
        rmSync(path, { force: true });
        rmSync(identityPath, { force: true });
      }
    } catch (error) {
      console.error(`Runtime lock release failed: ${path}: ${errorCode(error)}`);
    }
    releaseWork = closeLease(lease);
    return releaseWork;
  };
}

function readLockPid(path: string): number | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const pid = Number(contents);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RuntimeLockError('DAEMON_DATA_DIR_LOCK_UNVERIFIED', { lockPath: path, reason: 'invalid-lock-pid' });
  }
  return pid;
}

function readIdentity(path: string): LockIdentity | undefined {
  try {
    return parseIdentity(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseIdentity(contents: string): LockIdentity | undefined {
  try {
    const record = JSON.parse(contents) as Partial<LockIdentity> | null;
    if (record?.version !== 2 || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0
      || typeof record.instanceId !== 'string' || record.instanceId.length !== 36
      || typeof record.dataDir !== 'string' || !Number.isInteger(record.leasePort)) return undefined;
    return record as LockIdentity;
  } catch {
    return undefined;
  }
}

function readLease(port: number): Promise<LockIdentity | undefined> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let contents = '';
    const timer = setTimeout(() => finish(undefined), 1_000);
    const finish = (identity: LockIdentity | undefined) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(identity);
    };
    socket.on('error', () => finish(undefined));
    socket.on('data', chunk => {
      contents += chunk.toString();
      if (contents.length > 4_096) finish(undefined);
    });
    socket.on('end', () => finish(parseIdentity(contents)));
  });
}

function verifyLegacyOwner(pid: number, dataDir: string, path: string): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return;
    throw new RuntimeLockError('DAEMON_DATA_DIR_LOCK_UNVERIFIED', {
      dataDir, lockPath: path, ownerPid: pid, reason: 'owner-query-denied', systemCode: errorCode(error)
    });
  }
  const command = readProcessCommand(pid);
  const daemon = command !== undefined && /daemon[/\\](?:dist|src)[/\\]main\.(?:js|ts)\b/i.test(command);
  const uncertain = command === undefined || command.length === 0
    || /--utility-sub-type=node\.mojom\.NodeService/i.test(command);
  if (!daemon && !uncertain) return;
  throw new RuntimeLockError(daemon ? 'DAEMON_DATA_DIR_IN_USE' : 'DAEMON_DATA_DIR_LOCK_UNVERIFIED', {
    dataDir, lockPath: path, ownerPid: pid,
    reason: daemon ? 'legacy-daemon-command' : 'legacy-owner-identity-unavailable'
  });
}

function readProcessCommand(pid: number): string | undefined {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine | ConvertTo-Json -Compress`
      ], { encoding: 'utf8', windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024 })
    : spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024
      });
  if (result.error !== undefined || result.status !== 0) return undefined;
  if (process.platform !== 'win32') return result.stdout.trim();
  try {
    const command: unknown = JSON.parse(result.stdout.trim());
    return typeof command === 'string' ? command : undefined;
  } catch {
    return undefined;
  }
}

function closeLease(lease: Server): Promise<void> {
  return new Promise(resolve => lease.close(() => resolve()));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}
