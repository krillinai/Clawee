export type CodexRuntimeSource =
  | 'embedded-package'
  | 'embedded-rollback-cache'
  | 'external-development';

export type CodexRuntimeActivationState =
  | 'prepared'
  | 'active_uncommitted'
  | 'committed';

export type CodexRuntimeDescriptor = {
  runtimeId: string;
  source: CodexRuntimeSource;
  codexVersion: string;
  releaseTag: string;
  target: string;
  layoutVersion: number;
  entryPath: string;
  homePath: string;
  contentSha256: string;
  minimumClaweeVersion: string;
  migrationSourceHome: string | null;
};

export type CodexRuntimeLaunchContext = {
  candidate: CodexRuntimeDescriptor;
  previous: CodexRuntimeDescriptor | null;
  claweeVersion: string;
};

export type PersistedCodexRuntimeState = {
  schemaVersion: 1;
  state: CodexRuntimeActivationState;
  active: CodexRuntimeDescriptor;
  previous: CodexRuntimeDescriptor | null;
  migrationManifestSha256: string | null;
  updatedAt: string;
};

export type CodexRuntimeCommitMarker = {
  schemaVersion: 1;
  runtimeId: string;
  homePath: string;
  minimumClaweeVersion: string;
  committedAt: string;
};

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_TAG_PATTERN = /^rust-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TARGET_PATTERN = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+$/;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const RUNTIME_SOURCES = new Set<CodexRuntimeSource>([
  'embedded-package',
  'embedded-rollback-cache',
  'external-development'
]);
const ACTIVATION_STATES = new Set<CodexRuntimeActivationState>([
  'prepared',
  'active_uncommitted',
  'committed'
]);

export class CodexRuntimeProtocolError extends Error {
  readonly code = 'CODEX_RUNTIME_DESCRIPTOR_INVALID';

  constructor(message: string) {
    super(`Codex Runtime descriptor is invalid: ${message}`);
    this.name = 'CodexRuntimeProtocolError';
  }
}

export function parseCodexRuntimeLaunchContext(
  value: unknown
): CodexRuntimeLaunchContext {
  const record = requireRecord(value, 'launch context');
  const candidate = parseCodexRuntimeDescriptor(record.candidate, 'candidate');
  const previous = record.previous === null
    ? null
    : parseCodexRuntimeDescriptor(record.previous, 'previous');
  const claweeVersion = requirePattern(
    record.claweeVersion,
    VERSION_PATTERN,
    'claweeVersion'
  );
  if (
    previous !== null
    && previous.source !== 'embedded-rollback-cache'
  ) {
    fail('previous.source must be embedded-rollback-cache');
  }
  if (
    candidate.source === 'external-development'
    && previous !== null
  ) {
    fail('external-development cannot declare a previous Runtime');
  }
  return { candidate, previous, claweeVersion };
}

export function parseCodexRuntimeLaunchContextJson(
  value: string
): CodexRuntimeLaunchContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('environment value is not valid JSON');
  }
  return parseCodexRuntimeLaunchContext(parsed);
}

export function parseCodexRuntimeDescriptor(
  value: unknown,
  label = 'descriptor'
): CodexRuntimeDescriptor {
  const record = requireRecord(value, label);
  const source = requireString(record.source, `${label}.source`);
  if (!RUNTIME_SOURCES.has(source as CodexRuntimeSource)) {
    fail(`${label}.source is unsupported`);
  }
  const migrationSourceHome = record.migrationSourceHome === null
    ? null
    : requireAbsolutePath(
        record.migrationSourceHome,
        `${label}.migrationSourceHome`
      );
  return {
    runtimeId: requirePattern(
      record.runtimeId,
      RUNTIME_ID_PATTERN,
      `${label}.runtimeId`
    ),
    source: source as CodexRuntimeSource,
    codexVersion: requirePattern(
      record.codexVersion,
      VERSION_PATTERN,
      `${label}.codexVersion`
    ),
    releaseTag: requirePattern(
      record.releaseTag,
      RELEASE_TAG_PATTERN,
      `${label}.releaseTag`
    ),
    target: requirePattern(
      record.target,
      TARGET_PATTERN,
      `${label}.target`
    ),
    layoutVersion: requirePositiveInteger(
      record.layoutVersion,
      `${label}.layoutVersion`
    ),
    entryPath: requireAbsolutePath(record.entryPath, `${label}.entryPath`),
    homePath: requireAbsolutePath(record.homePath, `${label}.homePath`),
    contentSha256: requirePattern(
      record.contentSha256,
      SHA256_PATTERN,
      `${label}.contentSha256`
    ),
    minimumClaweeVersion: requirePattern(
      record.minimumClaweeVersion,
      VERSION_PATTERN,
      `${label}.minimumClaweeVersion`
    ),
    migrationSourceHome
  };
}

export function parsePersistedCodexRuntimeState(
  value: unknown
): PersistedCodexRuntimeState {
  const record = requireRecord(value, 'persisted Runtime state');
  if (record.schemaVersion !== 1) {
    fail('persisted Runtime state.schemaVersion must be 1');
  }
  const state = requireString(
    record.state,
    'persisted Runtime state.state'
  );
  if (!ACTIVATION_STATES.has(state as CodexRuntimeActivationState)) {
    fail('persisted Runtime state.state is unsupported');
  }
  const previous = record.previous === null
    ? null
    : parseCodexRuntimeDescriptor(
        record.previous,
        'persisted Runtime state.previous'
      );
  if (
    previous !== null
    && previous.source !== 'embedded-rollback-cache'
  ) {
    fail('persisted Runtime state.previous.source must be embedded-rollback-cache');
  }
  const migrationManifestSha256 =
    record.migrationManifestSha256 === null
      ? null
      : requirePattern(
          record.migrationManifestSha256,
          SHA256_PATTERN,
          'persisted Runtime state.migrationManifestSha256'
        );
  return {
    schemaVersion: 1,
    state: state as CodexRuntimeActivationState,
    active: parseCodexRuntimeDescriptor(
      record.active,
      'persisted Runtime state.active'
    ),
    previous,
    migrationManifestSha256,
    updatedAt: requireIsoTimestamp(
      record.updatedAt,
      'persisted Runtime state.updatedAt'
    )
  };
}

export function parseCodexRuntimeCommitMarker(
  value: unknown
): CodexRuntimeCommitMarker {
  const record = requireRecord(value, 'Runtime commit marker');
  if (record.schemaVersion !== 1) {
    fail('Runtime commit marker.schemaVersion must be 1');
  }
  return {
    schemaVersion: 1,
    runtimeId: requirePattern(
      record.runtimeId,
      RUNTIME_ID_PATTERN,
      'Runtime commit marker.runtimeId'
    ),
    homePath: requireAbsolutePath(
      record.homePath,
      'Runtime commit marker.homePath'
    ),
    minimumClaweeVersion: requirePattern(
      record.minimumClaweeVersion,
      VERSION_PATTERN,
      'Runtime commit marker.minimumClaweeVersion'
    ),
    committedAt: requireIsoTimestamp(
      record.committedAt,
      'Runtime commit marker.committedAt'
    )
  };
}

export function compareSemanticVersions(left: string, right: string): number {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (parsedLeft[key] !== parsedRight[key]) {
      return parsedLeft[key] < parsedRight[key] ? -1 : 1;
    }
  }
  return comparePrerelease(
    parsedLeft.prerelease,
    parsedRight.prerelease
  );
}

function requireRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || value.includes('\0')
  ) {
    fail(`${label} must be a non-empty normalized string`);
  }
  return value;
}

function requirePattern(
  value: unknown,
  pattern: RegExp,
  label: string
): string {
  const parsed = requireString(value, label);
  if (!pattern.test(parsed)) fail(`${label} has an invalid format`);
  return parsed;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (
    !path.startsWith('/')
    && !/^[A-Za-z]:[\\/]/.test(path)
    && !/^\\\\[^\\]/.test(path)
  ) {
    fail(`${label} must be absolute`);
  }
  return path;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  const parsed = new Date(timestamp);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.toISOString() !== timestamp
  ) {
    fail(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

function parseSemanticVersion(value: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
} {
  const normalized = requirePattern(
    value,
    VERSION_PATTERN,
    'semantic version'
  );
  const [release, prereleaseValue] = normalized.split('-', 2);
  const [majorValue, minorValue, patchValue] = release!.split('.');
  const prerelease = prereleaseValue === undefined
    ? null
    : prereleaseValue.split('.');
  if (prerelease?.some(identifier => identifier.length === 0)) {
    fail('semantic version prerelease identifiers must not be empty');
  }
  return {
    major: Number(majorValue),
    minor: Number(minorValue),
    patch: Number(patchValue),
    prerelease
  };
}

function comparePrerelease(
  left: string[] | null,
  right: string[] | null
): number {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === rightIdentifier) continue;
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftIdentifier) - Number(rightIdentifier);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function fail(message: string): never {
  throw new CodexRuntimeProtocolError(message);
}
