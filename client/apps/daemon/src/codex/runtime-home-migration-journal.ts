import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  CodexHomeMigrationError,
  type CodexRuntimeMigrationJournalRecord,
  type CodexRuntimeMigrationManifest,
  type CodexRuntimeMigrationState,
  type CodexRuntimeMigrationThread,
  type ParsedCodexRuntimeMigrationJournal
} from './runtime-home-migration-types.js';
import { flushRuntimeFileDescriptor } from './runtime-fsync.js';

const COPY_STATUSES = new Set([
  'pending',
  'copied',
  'not_recoverable',
  'failed'
]);
const VERIFICATION_STATUSES = new Set([
  'pending',
  'verified',
  'not_applicable',
  'failed'
]);

export function readCodexRuntimeMigrationJournals(
  directory: string
): ParsedCodexRuntimeMigrationJournal[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.journal.jsonl'))
    .map(entry => parseJournal(join(directory, entry.name)))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function appendCodexRuntimeMigrationTransition(
  path: string,
  from: CodexRuntimeMigrationState,
  to: Exclude<CodexRuntimeMigrationState, 'planned'>,
  errorCode: string | null
): void {
  appendCodexRuntimeMigrationJournalRecord(path, {
    type: 'transition',
    from,
    to,
    at: new Date().toISOString(),
    errorCode
  });
}

export function appendCodexRuntimeMigrationJournalRecord(
  path: string,
  record: CodexRuntimeMigrationJournalRecord
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, existsSync(path) ? 'r+' : 'w+', 0o600);
  try {
    truncatePartialTail(descriptor);
    writeSync(
      descriptor,
      `${JSON.stringify(record)}\n`,
      fstatSync(descriptor).size,
      'utf8'
    );
    flushRuntimeFileDescriptor(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function truncatePartialTail(descriptor: number): void {
  const size = fstatSync(descriptor).size;
  if (size === 0) return;
  const bytesToRead = Math.min(size, 64 * 1024);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  readSync(descriptor, buffer, 0, bytesToRead, size - bytesToRead);
  if (buffer[bytesToRead - 1] === 0x0a) return;
  const lastNewline = buffer.lastIndexOf(0x0a);
  ftruncateSync(
    descriptor,
    lastNewline < 0 ? 0 : size - bytesToRead + lastNewline + 1
  );
}

export function hashCodexRuntimeMigrationManifest(
  manifest: Omit<
    CodexRuntimeMigrationManifest,
    'type' | 'sourceManifestSha256' | 'createdAt'
  >
): string {
  return createHash('sha256')
    .update(canonicalJson(manifest))
    .digest('hex');
}

export function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (
      !isRecord(error)
      || !['EINVAL', 'EPERM', 'EISDIR'].includes(String(error.code))
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJournal(path: string): ParsedCodexRuntimeMigrationJournal {
  const contents = readFileSync(path, 'utf8');
  const complete = contents.endsWith('\n')
    ? contents
    : contents.slice(0, contents.lastIndexOf('\n') + 1);
  const lines = complete.split('\n').filter(line => line.length > 0);
  if (lines.length === 0) throw journalCorrupt(path, 'manifest is missing');
  let records: unknown[];
  try {
    records = lines.map(line => JSON.parse(line) as unknown);
  } catch {
    throw journalCorrupt(path, 'journal contains invalid JSON');
  }
  const manifest = parseManifest(records[0], path);
  if (
    basename(path) !== `${manifest.sourceManifestSha256}.journal.jsonl`
    || hashCodexRuntimeMigrationManifest({
      schemaVersion: manifest.schemaVersion,
      runtimeId: manifest.runtimeId,
      sourceHome: manifest.sourceHome,
      targetHome: manifest.targetHome,
      threads: manifest.threads
    }) !== manifest.sourceManifestSha256
  ) {
    throw journalCorrupt(path, 'manifest hash does not match the journal');
  }
  let state: CodexRuntimeMigrationState = 'planned';
  for (const record of records.slice(1)) {
    if (
      !isRecord(record)
      || record.type !== 'transition'
      || record.from !== state
      || typeof record.at !== 'string'
      || (record.errorCode !== null && typeof record.errorCode !== 'string')
      || !validTransition(state, record.to)
    ) {
      throw journalCorrupt(path, 'journal contains an invalid state transition');
    }
    state = record.to;
  }
  return { path, manifest, state };
}

function parseManifest(
  value: unknown,
  path: string
): CodexRuntimeMigrationManifest {
  if (
    !isRecord(value)
    || value.type !== 'manifest'
    || value.schemaVersion !== 1
    || typeof value.runtimeId !== 'string'
    || typeof value.sourceManifestSha256 !== 'string'
    || typeof value.sourceHome !== 'string'
    || typeof value.targetHome !== 'string'
    || typeof value.createdAt !== 'string'
    || !Array.isArray(value.threads)
    || !value.threads.every(isMigrationThread)
  ) {
    throw journalCorrupt(path, 'journal manifest is invalid');
  }
  return value as CodexRuntimeMigrationManifest;
}

function isMigrationThread(value: unknown): value is CodexRuntimeMigrationThread {
  return (
    isRecord(value)
    && typeof value.claweeThreadId === 'string'
    && typeof value.codexThreadId === 'string'
    && typeof value.recoverableBeforeMigration === 'boolean'
    && nullableString(value.sourceRelativePath)
    && nullableNumber(value.sourceSize)
    && nullableNumber(value.sourceMtimeMs)
    && nullableString(value.sourceSha256)
    && Array.isArray(value.companionFiles)
    && value.companionFiles.every(companion => (
      isRecord(companion)
      && typeof companion.relativePath === 'string'
      && typeof companion.size === 'number'
      && typeof companion.sha256 === 'string'
    ))
    && typeof value.copyStatus === 'string'
    && COPY_STATUSES.has(value.copyStatus)
    && typeof value.verificationStatus === 'string'
    && VERIFICATION_STATUSES.has(value.verificationStatus)
    && nullableString(value.errorCode)
  );
}

function validTransition(
  from: CodexRuntimeMigrationState,
  to: unknown
): to is CodexRuntimeMigrationState {
  return (
    (from === 'planned' && (to === 'copied' || to === 'failed'))
    || (from === 'copied' && (to === 'verified' || to === 'failed'))
    || (from === 'verified' && (to === 'activated' || to === 'failed'))
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function journalCorrupt(path: string, message: string): CodexHomeMigrationError {
  return new CodexHomeMigrationError(
    'CODEX_RUNTIME_MIGRATION_JOURNAL_CORRUPT',
    `${path}: ${message}`
  );
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function nullableNumber(value: unknown): boolean {
  return value === null || typeof value === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
