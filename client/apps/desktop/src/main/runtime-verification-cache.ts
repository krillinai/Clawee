import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  CodexRuntimePackageDescriptor,
  RuntimeDirectoryVerification
} from './runtime-verification.js';

export type RuntimeFileMetadata = {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
};

type EmbeddedRuntimeVerificationCache = {
  schemaVersion: 1;
  runtimeId: string;
  target: string;
  directory: string;
  entrypoint: string;
  fileCount: number;
  contentSha256: string;
  files: RuntimeFileMetadata[];
  verifiedAt: string;
};

export function readEmbeddedRuntimeVerificationCache(input: {
  path: string;
  directory: string;
  runtimeId: string;
  target: string;
  packageDescriptor: CodexRuntimePackageDescriptor;
  expectedFiles: readonly string[];
}): RuntimeDirectoryVerification | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(input.path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  const directory = resolve(input.directory);
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.runtimeId !== input.runtimeId
    || value.target !== input.target
    || value.directory !== directory
    || value.entrypoint !== input.packageDescriptor.entrypoint
    || value.fileCount !== input.packageDescriptor.fileCount
    || value.contentSha256 !== input.packageDescriptor.contentSha256
    || typeof value.verifiedAt !== 'string'
    || !isRuntimeFileMetadataArray(value.files)
    || !runtimeFileMetadataMatches(
      directory,
      input.expectedFiles,
      value.files
    )
  ) {
    return undefined;
  }
  return {
    entrypoint: value.entrypoint,
    fileCount: value.fileCount,
    contentSha256: value.contentSha256,
    files: value.files.map(file => file.path)
  };
}

export function writeEmbeddedRuntimeVerificationCache(input: {
  path: string;
  directory: string;
  runtimeId: string;
  target: string;
  verification: RuntimeDirectoryVerification;
  expectedFiles: readonly string[];
}): void {
  const directory = resolve(input.directory);
  const files = inspectRuntimeFileMetadata(directory);
  if (
    !samePaths(files.map(file => file.path), input.expectedFiles)
    || !samePaths(input.verification.files, input.expectedFiles)
    || files.length !== input.verification.fileCount
  ) {
    throw new Error('CODEX_RUNTIME_VERIFICATION_CACHE_FILE_LIST_MISMATCH');
  }
  const cache: EmbeddedRuntimeVerificationCache = {
    schemaVersion: 1,
    runtimeId: input.runtimeId,
    target: input.target,
    directory,
    entrypoint: input.verification.entrypoint,
    fileCount: input.verification.fileCount,
    contentSha256: input.verification.contentSha256,
    files,
    verifiedAt: new Date().toISOString()
  };
  writeJsonAtomic(input.path, cache);
}

export function inspectRuntimeFileMetadata(
  root: string,
  current = resolve(root)
): RuntimeFileMetadata[] {
  const resolvedRoot = resolve(root);
  const files: RuntimeFileMetadata[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(resolvedRoot, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      throw new Error(`CODEX_RUNTIME_UNSUPPORTED_ENTRY: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...inspectRuntimeFileMetadata(resolvedRoot, path));
      continue;
    }
    if (
      !entry.isFile()
      || relativePath.startsWith('../')
      || isAbsolute(relativePath)
    ) {
      throw new Error(`CODEX_RUNTIME_UNSUPPORTED_ENTRY: ${relativePath}`);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`CODEX_RUNTIME_UNSUPPORTED_ENTRY: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function runtimeFileMetadataMatches(
  directory: string,
  expectedFiles: readonly string[],
  cachedFiles: readonly RuntimeFileMetadata[] | undefined
): boolean {
  if (cachedFiles === undefined) return false;
  let actualFiles: RuntimeFileMetadata[];
  try {
    actualFiles = inspectRuntimeFileMetadata(directory);
  } catch {
    return false;
  }
  if (
    !samePaths(actualFiles.map(file => file.path), expectedFiles)
    || actualFiles.length !== cachedFiles.length
  ) {
    return false;
  }
  return actualFiles.every((actual, index) => {
    const cached = cachedFiles[index];
    return cached !== undefined
      && actual.path === cached.path
      && actual.size === cached.size
      && actual.mtimeMs === cached.mtimeMs
      && actual.ctimeMs === cached.ctimeMs
      && actual.dev === cached.dev
      && actual.ino === cached.ino
      && actual.mode === cached.mode;
  });
}

export function isRuntimeFileMetadataArray(
  value: unknown
): value is RuntimeFileMetadata[] {
  return Array.isArray(value) && value.every(file => (
    isRecord(file)
    && typeof file.path === 'string'
    && file.path.length > 0
    && !file.path.includes('\\')
    && !isAbsolute(file.path)
    && !file.path.split('/').some(segment => (
      segment.length === 0 || segment === '.' || segment === '..'
    ))
    && finiteNumber(file.size)
    && finiteNumber(file.mtimeMs)
    && finiteNumber(file.ctimeMs)
    && finiteNumber(file.dev)
    && finiteNumber(file.ino)
    && finiteNumber(file.mode)
  ));
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function samePaths(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  const normalizedActual = [...actual].sort((left, right) =>
    left.localeCompare(right)
  );
  const normalizedExpected = [...expected].sort((left, right) =>
    left.localeCompare(right)
  );
  return normalizedActual.length === normalizedExpected.length
    && normalizedActual.every((path, index) => path === normalizedExpected[index]);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
