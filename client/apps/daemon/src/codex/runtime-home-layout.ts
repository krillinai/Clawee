import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync
} from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const CODEX_RUNTIME_HOME_COLLECTIONS = [
  'sessions',
  'archived_sessions'
] as const;

export const CODEX_RUNTIME_HOME_EXCLUDED_ENTRIES = new Set([
  'config.toml',
  'auth.json',
  'plugins',
  'skills',
  'agents',
  'mcp-oauth-locks',
  'rules',
  'models_cache.json',
  'version.json'
]);

export type CodexRuntimeRolloutSource = {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  codexThreadId: string;
  historyMode: 'legacy' | 'paginated';
  historyBaseThreadId: string | null;
};

export type CodexRuntimeRolloutIssue = {
  relativePath: string;
  filenameThreadId: string | null;
  code: 'corrupt' | 'changed' | 'unsupported';
  message: string;
};

export type CodexRuntimeHomeScan = {
  sources: CodexRuntimeRolloutSource[];
  issues: CodexRuntimeRolloutIssue[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_UUID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const MAX_JSONL_LINE_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

export function scanCodexRuntimeHomeV0146(
  sourceHome: string
): CodexRuntimeHomeScan {
  const sources: CodexRuntimeRolloutSource[] = [];
  const issues: CodexRuntimeRolloutIssue[] = [];
  for (const collection of CODEX_RUNTIME_HOME_COLLECTIONS) {
    for (const path of listFiles(join(sourceHome, collection))) {
      const relativePath = portableRelativePath(sourceHome, path);
      const filenameThreadId = threadIdFromFilename(path);
      if (path.endsWith('.jsonl.zst')) {
        issues.push({
          relativePath,
          filenameThreadId,
          code: 'unsupported',
          message: 'compressed rollout files are not supported by the 0.146.0 migration adapter'
        });
        continue;
      }
      if (!path.endsWith('.jsonl')) continue;
      try {
        const source = readRolloutSource(path, relativePath);
        if (
          filenameThreadId !== null
          && filenameThreadId !== source.codexThreadId
        ) {
          issues.push({
            relativePath,
            filenameThreadId,
            code: 'corrupt',
            message: 'rollout filename and session metadata identify different threads'
          });
          continue;
        }
        sources.push(source);
      } catch (error) {
        issues.push({
          relativePath,
          filenameThreadId,
          code: error instanceof SourceChangedWhileScanningError
            ? 'changed'
            : 'corrupt',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return {
    sources: sources.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    ),
    issues: issues.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )
  };
}

export function listCodexRuntimeModelProviderIdsV0146(
  home: string
): string[] {
  const providers = new Set<string>();
  for (const collection of CODEX_RUNTIME_HOME_COLLECTIONS) {
    for (const path of listFiles(join(home, collection))) {
      if (!path.endsWith('.jsonl')) continue;
      const provider = readRolloutModelProvider(path);
      if (provider !== undefined) providers.add(provider);
    }
  }
  return [...providers].sort((left, right) => left.localeCompare(right));
}

export function targetPathForRuntimeFile(
  home: string,
  relativePath: string
): string {
  return join(home, ...relativePath.split('/'));
}

export function inspectCodexRuntimeRolloutFileV0146(
  home: string,
  relativePath: string
): CodexRuntimeRolloutSource {
  return readRolloutSource(
    targetPathForRuntimeFile(home, relativePath),
    relativePath
  );
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function readRolloutSource(
  absolutePath: string,
  relativePath: string
): CodexRuntimeRolloutSource {
  const before = lstatSync(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('rollout source is not a regular file');
  }
  const hash = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let pending = '';
  let sessionMeta: Record<string, unknown> | undefined;
  let recordsSeen = 0;
  const accept = (entry: Record<string, unknown>) => {
    recordsSeen += 1;
    if (recordsSeen === 1) {
      sessionMeta = parseSessionMeta(entry);
      if (sessionMeta === undefined) {
        throw new Error('rollout does not start with session metadata');
      }
    }
  };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, 'r');
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      pending += decoder.write(bytes);
      pending = consumeLines(pending, accept);
      if (Buffer.byteLength(pending, 'utf8') > MAX_JSONL_LINE_BYTES) {
        throw new Error('rollout contains an oversized JSONL record');
      }
    }
    pending += decoder.end();
    if (pending.length > 0) {
      parseLine(pending, accept);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const after = statSync(absolutePath);
  if (
    before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.dev !== after.dev
    || before.ino !== after.ino
  ) {
    throw new SourceChangedWhileScanningError();
  }
  if (sessionMeta === undefined) {
    throw new Error('rollout does not start with session metadata');
  }
  const id = stringField(sessionMeta, 'id');
  if (id === undefined || !UUID_PATTERN.test(id)) {
    throw new Error('rollout session metadata has an invalid thread id');
  }
  const historyMode = sessionMeta.history_mode === 'paginated'
    ? 'paginated'
    : 'legacy';
  const historyBase = recordValue(sessionMeta.history_base);
  const historyBaseThreadId = historyBase === undefined
    ? null
    : stringField(historyBase, 'thread_id') ?? null;
  if (
    historyBaseThreadId !== null
    && !UUID_PATTERN.test(historyBaseThreadId)
  ) {
    throw new Error('rollout session metadata has an invalid history base');
  }
  return {
    absolutePath,
    relativePath,
    size: after.size,
    mtimeMs: after.mtimeMs,
    sha256: hash.digest('hex'),
    codexThreadId: id,
    historyMode,
    historyBaseThreadId
  };
}

function readRolloutModelProvider(path: string): string | undefined {
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let pending = '';
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      const newline = pending.indexOf('\n');
      if (newline >= 0) {
        return modelProviderFromSessionMetaLine(pending.slice(0, newline));
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_JSONL_LINE_BYTES) {
        return undefined;
      }
    }
    pending += decoder.end();
    return modelProviderFromSessionMetaLine(pending);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function modelProviderFromSessionMetaLine(line: string): string | undefined {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (normalized.trim().length === 0) return undefined;
  try {
    const entry = JSON.parse(normalized) as unknown;
    if (!isRecord(entry)) return undefined;
    const sessionMeta = parseSessionMeta(entry);
    return sessionMeta === undefined
      ? undefined
      : stringField(sessionMeta, 'model_provider');
  } catch {
    return undefined;
  }
}

function consumeLines(
  value: string,
  accept: (entry: Record<string, unknown>) => void
): string {
  let start = 0;
  while (true) {
    const newline = value.indexOf('\n', start);
    if (newline < 0) return value.slice(start);
    parseLine(value.slice(start, newline), accept);
    start = newline + 1;
  }
}

function parseLine(
  line: string,
  accept: (entry: Record<string, unknown>) => void
): void {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (normalized.trim().length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    throw new Error('rollout contains invalid JSON');
  }
  if (!isRecord(parsed)) throw new Error('rollout JSONL record is not an object');
  accept(parsed);
}

function parseSessionMeta(
  entry: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (entry.type !== 'session_meta') return undefined;
  const payload = recordValue(entry.payload);
  if (payload === undefined) throw new Error('session metadata payload is invalid');
  return payload;
}

function threadIdFromFilename(path: string): string | null {
  return ROLLOUT_UUID_PATTERN.exec(basename(path))?.[1]?.toLowerCase() ?? null;
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function stringField(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class SourceChangedWhileScanningError extends Error {
  constructor() {
    super('rollout source changed while it was being scanned');
  }
}
