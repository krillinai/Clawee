import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRuntimeLock } from '../../src/runtime-lock.js';

let tempDir = '';
const releases: Array<() => void | Promise<void>> = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const release of releases.splice(0)) await release();
  if (tempDir.length > 0) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Runtime data lock', () => {
  it('prevents two Runtime owners and releases cleanly', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    const release = await acquireRuntimeLock(tempDir);
    releases.push(release);
    await expect(Promise.resolve().then(() => acquireRuntimeLock(tempDir)))
      .rejects.toMatchObject({ code: 'DAEMON_DATA_DIR_IN_USE' });
    await release();
    const releaseAgain = await acquireRuntimeLock(tempDir);
    releases.push(releaseAgain);
    await releaseAgain();
  });

  it('removes a stale lock', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    writeFileSync(join(tempDir, 'clawee-runtime.lock'), '99999999\n');
    const release = await acquireRuntimeLock(tempDir);
    releases.push(release);
    await release();
  });

  it('recovers a legacy PID pointing at this unrelated test process without killing it', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    writeFileSync(join(tempDir, 'clawee-runtime.lock'), `${process.pid}\n`);
    const release = await acquireRuntimeLock(tempDir);
    releases.push(release);
    expect(process.kill(process.pid, 0)).toBe(true);
  });

  it('recovers a lease whose PID has been reused by an unrelated live process', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    const release = await acquireRuntimeLock(tempDir);
    releases.push(release);
    const identity = readFileSync(join(tempDir, 'clawee-runtime.lock.json'), 'utf8');
    await release();
    writeFileSync(join(tempDir, 'clawee-runtime.lock'), `${process.pid}\n`);
    writeFileSync(join(tempDir, 'clawee-runtime.lock.json'), identity);
    releases.push(await acquireRuntimeLock(tempDir));
    expect(process.kill(process.pid, 0)).toBe(true);
  });

  it('allows only one concurrent stale-lock recovery', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    writeFileSync(join(tempDir, 'clawee-runtime.lock'), '99999999\n');
    const results = await Promise.allSettled([
      Promise.resolve().then(() => acquireRuntimeLock(tempDir)),
      Promise.resolve().then(() => acquireRuntimeLock(tempDir))
    ]);
    for (const result of results) {
      if (result.status === 'fulfilled') releases.push(result.value);
    }
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects a real second process, then immediately reopens after the first exits', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    const owner = startOwner(tempDir);
    await owner.ready;
    await expect(acquireRuntimeLock(tempDir)).rejects.toMatchObject({ code: 'DAEMON_DATA_DIR_IN_USE' });
    const exited = new Promise<void>(resolve => owner.child.once('exit', () => resolve()));
    owner.child.send('release');
    await exited;
    releases.push(await acquireRuntimeLock(tempDir));
  });

  it('recovers a lock after its real owner is forcibly terminated', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    const owner = startOwner(tempDir);
    await owner.ready;
    const exited = new Promise<void>(resolve => owner.child.once('exit', () => resolve()));
    owner.child.kill('SIGKILL');
    await exited;
    releases.push(await acquireRuntimeLock(tempDir));
  });

  it('serializes stale recovery between real competing processes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    writeFileSync(join(tempDir, 'clawee-runtime.lock'), '99999999\n');
    const owners = [startOwner(tempDir), startOwner(tempDir)];
    const results = await Promise.allSettled(owners.map(owner => owner.ready));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('refuses an unrelated service on the lease port without deleting the stale lock', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-lock-'));
    const release = await acquireRuntimeLock(tempDir);
    releases.push(release);
    const identity = JSON.parse(readFileSync(join(tempDir, 'clawee-runtime.lock.json'), 'utf8'));
    await release();
    const path = join(tempDir, 'clawee-runtime.lock');
    writeFileSync(path, '99999999\n');
    const unrelated = createServer(socket => socket.end('null\n'));
    await new Promise<void>(resolve => unrelated.listen(identity.leasePort, '127.0.0.1', resolve));
    releases.push(() => new Promise<void>(resolve => unrelated.close(() => resolve())));
    await expect(acquireRuntimeLock(tempDir)).rejects.toMatchObject({
      code: 'DAEMON_DATA_DIR_LOCK_UNVERIFIED', details: { reason: 'lease-unavailable' }
    });
    expect(readFileSync(path, 'utf8')).toBe('99999999\n');
  });
});

function startOwner(dataDir: string): { child: ChildProcess; ready: Promise<void> } {
  const child = fork(fileURLToPath(new URL('../helpers/runtime-lock-owner.ts', import.meta.url)), [dataDir], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  children.push(child);
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Lock owner exited: ${String(code)}`)));
    child.once('message', message => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'ready') resolve();
      else reject(new Error(JSON.stringify(message)));
    });
  });
  return { child, ready };
}
