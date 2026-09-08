import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CodexRuntimeDescriptor,
  CodexRuntimeLaunchContext,
  PersistedCodexRuntimeState
} from '@clawee/protocol';
import {
  createCodexRuntimeStateStore
} from '../../src/codex/runtime-state.js';

let tempDir = '';

afterEach(() => {
  if (tempDir.length > 0) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Codex Runtime activation state', () => {
  it('persists prepared, active and committed in strict order', async () => {
    const setup = createSetup();
    const store = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current),
      now: () => new Date('2026-08-21T08:00:00.000Z')
    });

    await expect(store.reconcileStartup()).resolves.toBe('continue');
    expect(store.getStatus()).toEqual({
      runtimeId: setup.current.runtimeId,
      source: setup.current.source,
      version: setup.current.codexVersion,
      releaseTag: setup.current.releaseTag,
      target: setup.current.target,
      layoutVersion: setup.current.layoutVersion,
      entryPath: setup.current.entryPath,
      homePath: setup.current.homePath,
      contentSha256: setup.current.contentSha256,
      activationState: 'prepared',
      minimumClaweeVersion: setup.current.minimumClaweeVersion,
      committedAt: null
    });
    await store.markPrepared('b'.repeat(64));
    expect(readState(setup.dataDir)).toMatchObject({
      state: 'prepared',
      active: setup.current,
      previous: null,
      migrationManifestSha256: 'b'.repeat(64)
    });
    await store.markActive();
    expect(readState(setup.dataDir).state).toBe('active_uncommitted');
    expect(store.getStatus()).toMatchObject({
      runtimeId: setup.current.runtimeId,
      activationState: 'active_uncommitted',
      committedAt: null
    });

    await store.commitBeforeThreadWrite();

    expect(readJson(commitPath(setup.dataDir))).toEqual({
      schemaVersion: 1,
      runtimeId: setup.current.runtimeId,
      homePath: setup.current.homePath,
      minimumClaweeVersion: setup.current.minimumClaweeVersion,
      committedAt: '2026-08-21T08:00:00.000Z'
    });
    expect(readState(setup.dataDir)).toMatchObject({
      state: 'committed',
      active: setup.current,
      previous: null
    });
    expect(store.getStatus()).toMatchObject({
      runtimeId: setup.current.runtimeId,
      activationState: 'committed',
      committedAt: '2026-08-21T08:00:00.000Z'
    });
    await expect(store.commitBeforeThreadWrite()).resolves.toBeUndefined();
  });

  it('upgrades in place without retaining a previous Runtime', async () => {
    const setup = createSetup();
    await commitRuntime(setup.dataDir, setup.current);
    const next = descriptor({
      runtimeId: 'codex-rust-v0.147.0-layout-1',
      codexVersion: '0.147.0',
      releaseTag: 'rust-v0.147.0',
      entryPath: join(setup.root, 'next', 'bin', 'codex'),
      homePath: setup.current.homePath,
      contentSha256: 'c'.repeat(64),
      minimumClaweeVersion: '1.1.0'
    });
    const upgrade = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(next, null, '1.1.0')
    });

    await expect(upgrade.reconcileStartup()).resolves.toBe('continue');
    await upgrade.markPrepared('d'.repeat(64));
    expect(existsSync(commitPath(setup.dataDir))).toBe(false);
    expect(readState(setup.dataDir)).toMatchObject({
      state: 'prepared',
      active: next,
      previous: null
    });
    await upgrade.markActive();
    await upgrade.commitBeforeThreadWrite();

    expect(readState(setup.dataDir)).toMatchObject({
      state: 'committed',
      active: next,
      previous: null
    });
    const downgrade = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current, null, '1.1.0')
    });
    await expect(downgrade.reconcileStartup()).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_DOWNGRADE_FORBIDDEN'
    });
  });

  it('recovers an interrupted older activation by preparing the bundled Runtime', async () => {
    const setup = createSetup();
    const next = descriptor({
      runtimeId: 'codex-rust-v0.147.0-layout-1',
      codexVersion: '0.147.0',
      releaseTag: 'rust-v0.147.0',
      entryPath: join(setup.root, 'next', 'bin', 'codex'),
      homePath: setup.current.homePath,
      contentSha256: 'c'.repeat(64)
    });
    const interrupted = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current)
    });
    await interrupted.reconcileStartup();
    await interrupted.markPrepared(null);
    await interrupted.markActive();

    const store = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(next)
    });

    await expect(store.reconcileStartup()).resolves.toBe('continue');
    await store.markPrepared(null);
    expect(readState(setup.dataDir)).toMatchObject({
      state: 'prepared',
      active: next,
      previous: null
    });
  });

  it('blocks low Clawee versions, corrupt state and failed commit writes', async () => {
    const setup = createSetup();
    const lowVersion = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current, null, '0.9.0')
    });
    await expect(lowVersion.reconcileStartup()).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_CLAWEE_VERSION_UNSUPPORTED'
    });

    mkdirSync(join(setup.dataDir, 'codex'), { recursive: true });
    writeFileSync(statePath(setup.dataDir), '{broken', 'utf8');
    const corrupt = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current)
    });
    await expect(corrupt.reconcileStartup()).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_STATE_INVALID'
    });

    rmSync(statePath(setup.dataDir), { force: true });
    const failing = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current),
      beforeWrite(kind) {
        if (kind === 'commit') throw new Error('simulated commit failure');
      }
    });
    await failing.reconcileStartup();
    await failing.markPrepared(null);
    await failing.markActive();
    await expect(failing.commitBeforeThreadWrite()).rejects.toThrow(
      'simulated commit failure'
    );
    expect(existsSync(commitPath(setup.dataDir))).toBe(false);
    expect(readState(setup.dataDir).state).toBe('active_uncommitted');
  });

  it('recovers a commit marker written before the committed state update', async () => {
    const setup = createSetup();
    let failCommittedState = true;
    const interrupted = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current),
      beforeWrite(kind, value) {
        if (
          failCommittedState
          && kind === 'state'
          && 'state' in value
          && value.state === 'committed'
        ) {
          throw new Error('simulated state write crash');
        }
      }
    });
    await interrupted.reconcileStartup();
    await interrupted.markPrepared('b'.repeat(64));
    await interrupted.markActive();

    await expect(interrupted.commitBeforeThreadWrite()).rejects.toThrow(
      'simulated state write crash'
    );
    expect(readJson(commitPath(setup.dataDir))).toMatchObject({
      runtimeId: setup.current.runtimeId
    });
    expect(readState(setup.dataDir).state).toBe('active_uncommitted');

    failCommittedState = false;
    const recovered = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current)
    });
    await expect(recovered.reconcileStartup()).resolves.toBe('continue');
    expect(readState(setup.dataDir).state).toBe('committed');
    await expect(recovered.commitBeforeThreadWrite()).resolves.toBeUndefined();
  });

  it('backfills a migration manifest for an uncommitted Runtime created by an older build', async () => {
    const setup = createSetup();
    const original = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(setup.current)
    });
    await original.reconcileStartup();
    await original.markPrepared(null);
    await original.markActive();

    const recoveredDescriptor = {
      ...setup.current,
      migrationSourceHome: join(setup.root, 'legacy-codex-home')
    };
    const recovered = createCodexRuntimeStateStore({
      dataDir: setup.dataDir,
      runtime: launchContext(recoveredDescriptor),
      now: () => new Date('2026-08-21T09:00:00.000Z')
    });

    await expect(recovered.reconcileStartup()).resolves.toBe('continue');
    await recovered.markPrepared('c'.repeat(64));

    expect(readState(setup.dataDir)).toMatchObject({
      state: 'active_uncommitted',
      active: recoveredDescriptor,
      migrationManifestSha256: 'c'.repeat(64),
      updatedAt: '2026-08-21T09:00:00.000Z'
    });
  });
});

function createSetup(): {
  root: string;
  dataDir: string;
  current: CodexRuntimeDescriptor;
} {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-state-'));
  const dataDir = join(tempDir, 'data');
  return {
    root: tempDir,
    dataDir,
    current: descriptor({
      entryPath: join(tempDir, 'current', 'bin', 'codex'),
      homePath: join(dataDir, 'codex-home')
    })
  };
}

function descriptor(
  overrides: Partial<CodexRuntimeDescriptor> = {}
): CodexRuntimeDescriptor {
  return {
    runtimeId: 'codex-rust-v0.146.0-layout-1',
    source: 'embedded-package',
    codexVersion: '0.146.0',
    releaseTag: 'rust-v0.146.0',
    target: 'aarch64-apple-darwin',
    layoutVersion: 1,
    entryPath: '/tmp/current/bin/codex',
    homePath: '/tmp/data/codex/homes/runtime-current',
    contentSha256: 'a'.repeat(64),
    minimumClaweeVersion: '1.0.0',
    migrationSourceHome: null,
    ...overrides
  };
}

function launchContext(
  candidate: CodexRuntimeDescriptor,
  previous: CodexRuntimeDescriptor | null = null,
  claweeVersion = '1.0.0'
): CodexRuntimeLaunchContext {
  return { candidate, previous, claweeVersion };
}

async function commitRuntime(
  dataDir: string,
  runtime: CodexRuntimeDescriptor
): Promise<void> {
  const store = createCodexRuntimeStateStore({
    dataDir,
    runtime: launchContext(runtime)
  });
  await store.reconcileStartup();
  await store.markPrepared('b'.repeat(64));
  await store.markActive();
  await store.commitBeforeThreadWrite();
}

function statePath(dataDir: string): string {
  return join(dataDir, 'codex', 'runtime-state.json');
}

function commitPath(dataDir: string): string {
  return join(dataDir, 'codex', 'runtime-commit.json');
}

function readState(dataDir: string): PersistedCodexRuntimeState {
  return readJson(statePath(dataDir)) as PersistedCodexRuntimeState;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
