import { randomUUID } from 'node:crypto';
import {
  existsSync
} from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  CodexRuntimeCommitMarker,
  CodexRuntimeDescriptor,
  CodexRuntimeLaunchContext,
  CodexRuntimeStatus,
  PersistedCodexRuntimeState
} from '@clawee/protocol';
import {
  compareSemanticVersions,
  parseCodexRuntimeCommitMarker,
  parseCodexRuntimeLaunchContext,
  parsePersistedCodexRuntimeState
} from '@clawee/protocol';
import { flushRuntimeFileHandle } from './runtime-fsync.js';

export type CodexRuntimeStateErrorCode =
  | 'CODEX_RUNTIME_STATE_INVALID'
  | 'CODEX_RUNTIME_COMMIT_INVALID'
  | 'CODEX_RUNTIME_STATE_CONFLICT'
  | 'CODEX_RUNTIME_TRANSITION_INVALID'
  | 'CODEX_RUNTIME_CLAWEE_VERSION_UNSUPPORTED'
  | 'CODEX_RUNTIME_DOWNGRADE_FORBIDDEN';

export class CodexRuntimeStateError extends Error {
  constructor(
    readonly code: CodexRuntimeStateErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'CodexRuntimeStateError';
  }
}

type PersistedFileKind = 'state' | 'commit';

type StoreInput = {
  dataDir: string;
  runtime: CodexRuntimeLaunchContext;
  now?: () => Date;
  beforeWrite?(
    kind: PersistedFileKind,
    value: PersistedCodexRuntimeState | CodexRuntimeCommitMarker
  ): void | Promise<void>;
};

type PersistedFiles = {
  state: PersistedCodexRuntimeState | null;
  marker: CodexRuntimeCommitMarker | null;
  partialCommit: boolean;
};

export function createCodexRuntimeStateStore(input: StoreInput): {
  reconcileStartup(): Promise<'continue'>;
  markPrepared(
    migrationManifestSha256: string | null
  ): Promise<void>;
  markActive(): Promise<void>;
  commitBeforeThreadWrite(): Promise<void>;
  getStatus(): CodexRuntimeStatus;
} {
  const runtime = parseCodexRuntimeLaunchContext(input.runtime);
  const runtimeDirectory = join(resolve(input.dataDir), 'codex');
  const statePath = join(runtimeDirectory, 'runtime-state.json');
  const commitPath = join(runtimeDirectory, 'runtime-commit.json');
  const stateEnabled = runtime.candidate.source !== 'external-development';
  let commitWork: Promise<void> | undefined;
  let currentStatus = runtimeStatus(
    runtime.candidate,
    'prepared',
    /* committedAt */ null
  );

  async function reconcileStartup(): Promise<'continue'> {
    assertVersionSupported(
      runtime.claweeVersion,
      runtime.candidate.minimumClaweeVersion
    );
    if (!stateEnabled) return 'continue';
    const files = await readPersistedFiles(statePath, commitPath);
    if (files.marker !== null) {
      assertVersionSupported(
        runtime.claweeVersion,
        files.marker.minimumClaweeVersion
      );
    }
    if (files.state === null) {
      if (files.marker !== null) {
        throw stateError(
          'CODEX_RUNTIME_COMMIT_INVALID',
          'commit marker exists without Runtime state'
        );
      }
      return 'continue';
    }
    if (files.partialCommit) {
      const promoted = {
        ...files.state,
        state: 'committed',
        active: runtime.candidate,
        previous: null,
        updatedAt: nowIso(input.now)
      } satisfies PersistedCodexRuntimeState;
      await writeState(promoted);
      currentStatus = runtimeStatus(
        runtime.candidate,
        'committed',
        files.marker?.committedAt ?? null
      );
      return 'continue';
    }

    const state = files.state;
    if (sameCommittedForwardIdentity(state.active, runtime.candidate)) {
      if (
        state.state !== 'committed'
        && !sameRuntimeContract(state.active, runtime.candidate)
      ) {
        throw stateError(
          'CODEX_RUNTIME_STATE_CONFLICT',
          'an uncommitted Runtime changed before activation completed'
        );
      }
      const active = state.state === 'committed'
        ? runtime.candidate
        : state.active;
      const normalized = (
        state.previous === null
        && descriptorEquals(state.active, active)
      )
        ? state
        : {
            ...state,
            active,
            previous: null,
            updatedAt: nowIso(input.now)
          } satisfies PersistedCodexRuntimeState;
      if (normalized !== state) await writeState(normalized);
      currentStatus = runtimeStatus(
        active,
        state.state,
        state.state === 'committed'
          ? files.marker?.committedAt ?? null
          : null
      );
      return 'continue';
    }

    assertNotDowngrade(runtime.candidate, state.active);
    currentStatus = runtimeStatus(
      runtime.candidate,
      'prepared',
      /* committedAt */ null
    );
    return 'continue';
  }

  async function markPrepared(
    migrationManifestSha256: string | null
  ): Promise<void> {
    if (!stateEnabled) return;
    const files = await readPersistedFiles(statePath, commitPath);
    const state = files.state;
    if (state === null) {
      await writeState(preparedState(migrationManifestSha256));
      currentStatus = runtimeStatus(
        runtime.candidate,
        'prepared',
        /* committedAt */ null
      );
      return;
    }
    if (sameCommittedForwardIdentity(state.active, runtime.candidate)) {
      if (state.state === 'committed') {
        currentStatus = runtimeStatus(
          runtime.candidate,
          state.state,
          files.marker?.committedAt ?? null
        );
        return;
      }
      if (
        state.migrationManifestSha256 === null
        && migrationManifestSha256 !== null
        && sameRuntimeContract(state.active, runtime.candidate)
      ) {
        const repairedState = {
          ...state,
          active: runtime.candidate,
          previous: null,
          migrationManifestSha256,
          updatedAt: nowIso(input.now)
        } satisfies PersistedCodexRuntimeState;
        await writeState(repairedState);
        currentStatus = runtimeStatus(
          repairedState.active,
          repairedState.state,
          /* committedAt */ null
        );
        return;
      }
      assertPreparedStateMatches(
        state,
        migrationManifestSha256,
        runtime
      );
      if (state.previous !== null) {
        await writeState({
          ...state,
          previous: null,
          updatedAt: nowIso(input.now)
        });
      }
      currentStatus = runtimeStatus(
        state.active,
        state.state,
        /* committedAt */ null
      );
      return;
    }

    assertNotDowngrade(runtime.candidate, state.active);
    await writeState(preparedState(migrationManifestSha256));
    await rm(commitPath, { force: true });
    currentStatus = runtimeStatus(
      runtime.candidate,
      'prepared',
      /* committedAt */ null
    );
  }

  async function markActive(): Promise<void> {
    if (!stateEnabled) {
      currentStatus = runtimeStatus(
        runtime.candidate,
        'active_uncommitted',
        /* committedAt */ null
      );
      return;
    }
    const files = await readPersistedFiles(statePath, commitPath);
    const state = requireCandidateState(
      files.state,
      runtime.candidate
    );
    if (state.state === 'committed' || state.state === 'active_uncommitted') {
      currentStatus = runtimeStatus(
        state.active,
        state.state,
        state.state === 'committed'
          ? files.marker?.committedAt ?? null
          : null
      );
      return;
    }
    const activeState = {
      ...state,
      state: 'active_uncommitted',
      previous: null,
      updatedAt: nowIso(input.now)
    } satisfies PersistedCodexRuntimeState;
    await writeState(activeState);
    currentStatus = runtimeStatus(
      activeState.active,
      activeState.state,
      /* committedAt */ null
    );
  }

  async function commitBeforeThreadWrite(): Promise<void> {
    if (!stateEnabled) return;
    commitWork ??= commit().finally(() => {
      commitWork = undefined;
    });
    return await commitWork;
  }

  async function commit(): Promise<void> {
    const files = await readPersistedFiles(statePath, commitPath);
    const state = requireCandidateState(
      files.state,
      runtime.candidate
    );
    if (files.partialCommit) {
      const committedState = {
        ...state,
        state: 'committed',
        active: runtime.candidate,
        previous: null,
        updatedAt: nowIso(input.now)
      } satisfies PersistedCodexRuntimeState;
      await writeState(committedState);
      currentStatus = runtimeStatus(
        committedState.active,
        committedState.state,
        files.marker?.committedAt ?? null
      );
      return;
    }
    if (state.state === 'committed') {
      currentStatus = runtimeStatus(
        state.active,
        state.state,
        files.marker?.committedAt ?? null
      );
      return;
    }
    if (state.state !== 'active_uncommitted') {
      throw stateError(
        'CODEX_RUNTIME_TRANSITION_INVALID',
        'Runtime must be active_uncommitted before the first writable request'
      );
    }
    const marker: CodexRuntimeCommitMarker = {
      schemaVersion: 1,
      runtimeId: runtime.candidate.runtimeId,
      homePath: runtime.candidate.homePath,
      minimumClaweeVersion: runtime.candidate.minimumClaweeVersion,
      committedAt: nowIso(input.now)
    };
    await input.beforeWrite?.('commit', marker);
    await writeAtomicJson(commitPath, marker);
    const committedState = {
      ...state,
      state: 'committed',
      active: runtime.candidate,
      previous: null,
      updatedAt: nowIso(input.now)
    } satisfies PersistedCodexRuntimeState;
    await writeState(committedState);
    currentStatus = runtimeStatus(
      committedState.active,
      committedState.state,
      marker.committedAt
    );
  }

  function preparedState(
    migrationManifestSha256: string | null
  ): PersistedCodexRuntimeState {
    return {
      schemaVersion: 1,
      state: 'prepared',
      active: runtime.candidate,
      previous: null,
      migrationManifestSha256,
      updatedAt: nowIso(input.now)
    };
  }

  async function writeState(
    state: PersistedCodexRuntimeState
  ): Promise<void> {
    await input.beforeWrite?.('state', state);
    await writeAtomicJson(statePath, state);
  }

  return {
    reconcileStartup,
    markPrepared,
    markActive,
    commitBeforeThreadWrite,
    getStatus: () => ({ ...currentStatus })
  };
}

function runtimeStatus(
  descriptor: CodexRuntimeDescriptor,
  activationState: CodexRuntimeStatus['activationState'],
  committedAt: string | null
): CodexRuntimeStatus {
  return {
    runtimeId: descriptor.runtimeId,
    source: descriptor.source,
    version: descriptor.codexVersion,
    releaseTag: descriptor.releaseTag,
    target: descriptor.target,
    layoutVersion: descriptor.layoutVersion,
    entryPath: descriptor.entryPath,
    homePath: descriptor.homePath,
    contentSha256: descriptor.contentSha256,
    activationState,
    minimumClaweeVersion: descriptor.minimumClaweeVersion,
    committedAt
  };
}

async function readPersistedFiles(
  statePath: string,
  commitPath: string
): Promise<PersistedFiles> {
  const state = await readOptionalJson(
    statePath,
    parsePersistedCodexRuntimeState,
    'CODEX_RUNTIME_STATE_INVALID'
  );
  const marker = await readOptionalJson(
    commitPath,
    parseCodexRuntimeCommitMarker,
    'CODEX_RUNTIME_COMMIT_INVALID'
  );
  if (state === null) {
    return { state, marker, partialCommit: false };
  }
  if (state.state === 'committed') {
    if (marker === null || !markerMatches(marker, state.active)) {
      throw stateError(
        'CODEX_RUNTIME_COMMIT_INVALID',
        'committed state does not match the commit marker'
      );
    }
    return { state, marker, partialCommit: false };
  }
  return {
    state,
    marker,
    partialCommit:
      state.state === 'active_uncommitted'
      && marker !== null
      && markerMatches(marker, state.active)
  };
}

async function readOptionalJson<T>(
  path: string,
  parse: (value: unknown) => T,
  code: 'CODEX_RUNTIME_STATE_INVALID' | 'CODEX_RUNTIME_COMMIT_INVALID'
): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    throw stateError(
      code,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function writeAtomicJson(
  path: string,
  value: PersistedCodexRuntimeState | CodexRuntimeCommitMarker
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await flushRuntimeFileHandle(handle);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertVersionSupported(
  actual: string,
  minimum: string
): void {
  if (compareSemanticVersions(actual, minimum) >= 0) return;
  throw stateError(
    'CODEX_RUNTIME_CLAWEE_VERSION_UNSUPPORTED',
    `Clawee ${actual} is older than required ${minimum}`
  );
}

function assertNotDowngrade(
  candidate: CodexRuntimeDescriptor,
  previous: CodexRuntimeDescriptor
): void {
  if (
    compareSemanticVersions(
      candidate.codexVersion,
      previous.codexVersion
    ) >= 0
  ) {
    return;
  }
  throw stateError(
    'CODEX_RUNTIME_DOWNGRADE_FORBIDDEN',
    'a committed Codex Runtime cannot be downgraded'
  );
}

function requireCandidateState(
  state: PersistedCodexRuntimeState | null,
  candidate: CodexRuntimeDescriptor
): PersistedCodexRuntimeState {
  if (
    state === null
    || (
      state.state === 'committed'
        ? !sameCommittedForwardIdentity(state.active, candidate)
        : !sameRuntimeContract(state.active, candidate)
    )
  ) {
    throw stateError(
      'CODEX_RUNTIME_TRANSITION_INVALID',
      'Runtime state is unavailable'
    );
  }
  return state;
}

function assertPreparedStateMatches(
  state: PersistedCodexRuntimeState,
  migrationManifestSha256: string | null,
  runtime: CodexRuntimeLaunchContext
): void {
  if (
    !sameRuntimeContract(state.active, runtime.candidate)
    || state.migrationManifestSha256 !== migrationManifestSha256
  ) {
    throw stateError(
      'CODEX_RUNTIME_STATE_CONFLICT',
      'persisted activation state does not match the current Runtime'
    );
  }
}

function markerMatches(
  marker: CodexRuntimeCommitMarker,
  descriptor: CodexRuntimeDescriptor
): boolean {
  return (
    marker.runtimeId === descriptor.runtimeId
    && resolve(marker.homePath) === resolve(descriptor.homePath)
    && marker.minimumClaweeVersion === descriptor.minimumClaweeVersion
  );
}

function sameCommittedForwardIdentity(
  left: CodexRuntimeDescriptor,
  right: CodexRuntimeDescriptor
): boolean {
  return (
    left.runtimeId === right.runtimeId
    && resolve(left.homePath) === resolve(right.homePath)
    && left.target === right.target
    && left.codexVersion === right.codexVersion
    && left.releaseTag === right.releaseTag
    && left.layoutVersion === right.layoutVersion
    && left.minimumClaweeVersion === right.minimumClaweeVersion
  );
}

function sameRuntimeContract(
  left: CodexRuntimeDescriptor,
  right: CodexRuntimeDescriptor
): boolean {
  return (
    sameCommittedForwardIdentity(left, right)
    && left.contentSha256 === right.contentSha256
  );
}

function descriptorEquals(
  left: CodexRuntimeDescriptor,
  right: CodexRuntimeDescriptor
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nowIso(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString();
}

function stateError(
  code: CodexRuntimeStateErrorCode,
  message: string
): CodexRuntimeStateError {
  return new CodexRuntimeStateError(code, message);
}
