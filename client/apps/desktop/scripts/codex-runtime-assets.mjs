import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { t as listTar, x as extractTar } from 'tar';

import {
  CodexRuntimeAssetError,
  failCodexRuntimeAsset as fail
} from './codex-runtime-errors.mjs';
import {
  runCodexRuntimeCommand,
  verifyCodexRuntimeTrust
} from './codex-runtime-trust.mjs';
import {
  hashFile,
  inspectDirectory
} from './directory-integrity.mjs';
import {
  resolveCodexRuntimeTarget
} from '../../../scripts/codex-runtime/manifest.mjs';
import {
  codexRuntimeTargetTriple,
  normalizeDesktopPlatform
} from './release-platform.mjs';

const GITHUB_RELEASE_ROOT =
  'https://github.com/openai/codex/releases/download';
const GITHUB_RELEASE_HEADERS = {
  'User-Agent': 'Clawee-Runtime-Builder'
};
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;
const EXECUTABLE_MODE = 0o111;
const MACHO_CPU_TYPES = {
  arm64: 0x0100000c,
  x64: 0x01000007
};
const PE_MACHINE_TYPES = {
  arm64: 0xaa64,
  x64: 0x8664
};
const ELF_MACHINE_TYPES = {
  arm64: 183,
  x64: 62
};

export { CodexRuntimeAssetError };

export function codexRuntimeReleaseUrl(manifest, target) {
  return `${GITHUB_RELEASE_ROOT}/${encodeURIComponent(manifest.releaseTag)}`
    + `/${encodeURIComponent(target.assetName)}`;
}

export async function prepareCodexRuntime(input) {
  const platform = normalizeDesktopPlatform(input.platform);
  const targetTriple = codexRuntimeTargetTriple(platform, input.arch);
  const target = resolveCodexRuntimeTarget(input.manifest, {
    platform,
    arch: input.arch
  });
  if (target.targetTriple !== targetTriple) {
    fail(
      'CODEX_RUNTIME_TARGET_MISMATCH',
      `Manifest target ${target.targetTriple} does not match ${targetTriple}`
    );
  }
  if (!target.formalRelease && input.testMode !== true) {
    fail(
      'CODEX_RUNTIME_TARGET_NOT_FORMAL',
      `Codex Runtime target ${targetTriple} is not enabled for formal release`
    );
  }
  if (input.archivePath !== undefined && input.testMode !== true) {
    fail(
      'CODEX_RUNTIME_LOCAL_SOURCE_FORBIDDEN',
      'Local Codex Runtime archives require explicit test mode'
    );
  }

  const stagingDirectory = resolve(input.stagingDirectory);
  const cacheDirectory = resolve(input.cacheDirectory);
  assertSafeStagingPath(stagingDirectory);
  mkdirSync(cacheDirectory, { recursive: true });
  mkdirSync(dirname(stagingDirectory), { recursive: true });

  const workRoot = mkdtempSync(join(
    dirname(stagingDirectory),
    `.${basename(stagingDirectory)}-prepare-`
  ));
  const extractionDirectory = join(workRoot, 'runtime');
  mkdirSync(extractionDirectory, { recursive: true });

  try {
    const archivePath = await acquireArchive({
      archivePath: input.archivePath,
      cacheDirectory,
      download: input.download ?? downloadFile,
      manifest: input.manifest,
      target
    });
    await verifyArchiveHash(archivePath, target.archiveSha256);
    await inspectArchive(archivePath, target.expectedFiles);
    await extractTar({
      cwd: extractionDirectory,
      file: archivePath,
      noChmod: false,
      preservePaths: false,
      strict: true
    });
    const verification = await verifyCodexRuntimeDirectory({
      directory: extractionDirectory,
      manifest: input.manifest,
      target,
      commandRunner: input.commandRunner ?? runCodexRuntimeCommand,
      sigstoreVerifier: input.sigstoreVerifier
    });
    atomicReplaceDirectory(extractionDirectory, stagingDirectory);
    return {
      runtimeId: input.manifest.runtimeId,
      target: target.targetTriple,
      entrypoint: verification.entrypoint,
      archiveSha256: target.archiveSha256,
      contentSha256: verification.contentSha256,
      fileCount: verification.fileCount,
      files: verification.files,
      directory: stagingDirectory
    };
  } finally {
    rmSync(workRoot, { force: true, recursive: true });
  }
}

export async function verifyCodexRuntimeDirectory(input) {
  const root = resolve(input.directory);
  const commandRunner = input.commandRunner ?? runCodexRuntimeCommand;
  const files = listRelativeFiles(root);
  const expectedFiles = [...input.target.expectedFiles].sort();
  if (!isDeepStrictEqual(files, expectedFiles)) {
    fail(
      'CODEX_RUNTIME_FILE_LIST_MISMATCH',
      'Codex Runtime file list does not match the manifest',
      { actual: files, expected: expectedFiles }
    );
  }

  const metadataPath = join(root, 'codex-package.json');
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    fail(
      'CODEX_RUNTIME_METADATA_INVALID',
      `Unable to read codex-package.json: ${errorMessage(error)}`
    );
  }
  const expectedMetadata = expectedPackageMetadata(input.manifest, input.target);
  if (!isDeepStrictEqual(metadata, expectedMetadata)) {
    fail(
      'CODEX_RUNTIME_METADATA_MISMATCH',
      'codex-package.json does not match the selected Runtime target',
      { actual: metadata, expected: expectedMetadata }
    );
  }

  const binaryFiles = files.filter(path => path !== 'codex-package.json');
  for (const relativePath of binaryFiles) {
    const path = join(root, relativePath);
    if (
      input.target.platform !== 'win32'
      && (lstatSync(path).mode & EXECUTABLE_MODE) !== EXECUTABLE_MODE
    ) {
      fail(
        'CODEX_RUNTIME_NOT_EXECUTABLE',
        `Codex Runtime executable bits are missing: ${relativePath}`
      );
    }
    const detected = inspectBinaryArchitecture(path);
    if (
      detected.platform !== input.target.platform
      || detected.arch !== input.target.arch
    ) {
      fail(
        'CODEX_RUNTIME_ARCHITECTURE_MISMATCH',
        `Unexpected binary target for ${relativePath}: `
        + `${detected.platform}/${detected.arch}`,
        {
          actual: detected,
          expected: {
            platform: input.target.platform,
            arch: input.target.arch
          }
        }
      );
    }
  }

  const entrypoint = metadata.entrypoint;
  await verifyCodexVersion(
    join(root, entrypoint),
    input.manifest.codexVersion,
    commandRunner
  );
  await verifyCodexRuntimeTrust({
    root,
    target: input.target,
    commandRunner,
    sigstoreVerifier: input.sigstoreVerifier,
    hashFile
  });
  const contents = await inspectDirectory(root);
  return {
    entrypoint,
    contentSha256: contents.hash,
    fileCount: files.length,
    files
  };
}

async function acquireArchive(input) {
  if (input.archivePath !== undefined) {
    if (!existsSync(input.archivePath)) {
      fail(
        'CODEX_RUNTIME_ARCHIVE_MISSING',
        `Local Codex Runtime archive is missing: ${input.archivePath}`
      );
    }
    return resolve(input.archivePath);
  }

  const cacheName = [
    input.manifest.releaseTag,
    input.target.assetName,
    input.target.archiveSha256
  ].join('-');
  pruneCodexRuntimeArchiveCache(input.cacheDirectory, cacheName);
  const cachePath = join(input.cacheDirectory, cacheName);
  if (existsSync(cachePath)) {
    try {
      await verifyArchiveHash(cachePath, input.target.archiveSha256);
      return cachePath;
    } catch (error) {
      if (!(error instanceof CodexRuntimeAssetError)) throw error;
      rmSync(cachePath, { force: true });
    }
  }

  const temporaryPath = `${cachePath}.download-${randomUUID()}`;
  try {
    await input.download(
      codexRuntimeReleaseUrl(input.manifest, input.target),
      temporaryPath
    );
    await verifyArchiveHash(temporaryPath, input.target.archiveSha256);
    renameSync(temporaryPath, cachePath);
    return cachePath;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function pruneCodexRuntimeArchiveCache(cacheDirectory, keepName) {
  for (const entry of readdirSync(cacheDirectory, { withFileTypes: true })) {
    if (entry.name === keepName) continue;
    rmSync(join(cacheDirectory, entry.name), {
      recursive: entry.isDirectory(),
      force: true
    });
  }
}

export async function downloadCodexRuntimeAsset(url, destination) {
  try {
    assertReleaseAssetUrl(url);
    await downloadGithubAsset(url, destination);
  } catch (error) {
    if (error instanceof CodexRuntimeAssetError) throw error;
    fail(
      'CODEX_RUNTIME_DOWNLOAD_FAILED',
      `Unable to download Codex Runtime asset: ${errorMessage(error)}`
    );
  }
}

const downloadFile = downloadCodexRuntimeAsset;

function assertReleaseAssetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(
      'CODEX_RUNTIME_RELEASE_URL_INVALID',
      `Invalid Codex Runtime Release URL: ${url}`
    );
  }
  const match = parsed.pathname.match(
    /^\/openai\/codex\/releases\/download\/([^/]+)\/([^/]+)$/
  );
  if (
    parsed.origin !== 'https://github.com'
    || parsed.search !== ''
    || parsed.hash !== ''
    || match === null
  ) {
    fail(
      'CODEX_RUNTIME_RELEASE_URL_INVALID',
      `Unexpected Codex Runtime Release URL: ${url}`
    );
  }
}

async function downloadGithubAsset(assetUrl, destination) {
  const downloadUrl = await resolveGithubAssetDownloadUrl(assetUrl);
  const size = await resolveGithubAssetSize(downloadUrl);
  const descriptor = openSync(destination, 'wx');
  try {
    ftruncateSync(descriptor, size);
  } finally {
    closeSync(descriptor);
  }
  const chunks = [];
  for (let start = 0; start < size; start += DOWNLOAD_CHUNK_BYTES) {
    chunks.push({
      start,
      end: Math.min(size - 1, start + DOWNLOAD_CHUNK_BYTES - 1)
    });
  }
  let nextChunk = 0;
  const workers = Array.from(
    { length: Math.min(DOWNLOAD_CONCURRENCY, chunks.length) },
    async () => {
      while (nextChunk < chunks.length) {
        const chunk = chunks[nextChunk];
        nextChunk += 1;
        await downloadGithubAssetChunk({
          destination,
          downloadUrl,
          size,
          ...chunk
        });
      }
    }
  );
  const results = await Promise.allSettled(workers);
  const failure = results.find(result => result.status === 'rejected');
  if (failure !== undefined) throw failure.reason;
}

async function resolveGithubAssetDownloadUrl(assetUrl) {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(assetUrl, {
        headers: {
          ...GITHUB_RELEASE_HEADERS,
          Accept: 'application/octet-stream'
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(2 * 60_000)
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        throw new Error(
          `Expected a GitHub asset redirect, received HTTP ${response.status}`
        );
      }
      const location = response.headers.get('location');
      const parsed = location === null ? undefined : new URL(location);
      if (
        parsed?.protocol !== 'https:'
        || parsed.hostname !== 'release-assets.githubusercontent.com'
      ) {
        throw new Error('GitHub asset redirect has an unexpected destination');
      }
      return parsed.href;
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) await delay(attempt * 2_000);
    }
  }
  throw new Error(
    `Unable to resolve GitHub Release asset redirect: `
    + errorMessage(lastError),
    { cause: lastError }
  );
}

async function resolveGithubAssetSize(downloadUrl) {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(downloadUrl, {
        headers: {
          Range: 'bytes=0-0'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(2 * 60_000)
      });
      const contentRange = response.headers.get('content-range');
      const match = contentRange?.match(/^bytes 0-0\/([1-9]\d*)$/);
      if (response.status !== 206 || match === undefined || match === null) {
        throw new Error(
          'Unable to determine GitHub Release asset size: '
          + `HTTP ${response.status} ${String(contentRange)}`
        );
      }
      const contents = Buffer.from(await response.arrayBuffer());
      const size = Number(match[1]);
      if (contents.length !== 1 || !Number.isSafeInteger(size) || size < 1) {
        throw new Error('GitHub Release asset size probe is invalid');
      }
      return size;
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) await delay(attempt * 2_000);
    }
  }
  throw new Error(
    `Unable to determine GitHub Release asset size: `
    + errorMessage(lastError),
    { cause: lastError }
  );
}

async function downloadGithubAssetChunk(input) {
  let lastError;
  const expectedBytes = input.end - input.start + 1;
  const expectedContentRange =
    `bytes ${input.start}-${input.end}/${input.size}`;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(input.downloadUrl, {
        headers: {
          Range: `bytes=${input.start}-${input.end}`
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10 * 60_000)
      });
      if (
        response.status !== 206
        || response.headers.get('content-range') !== expectedContentRange
      ) {
        throw new Error(
          `Invalid Range response for ${input.start}-${input.end}: `
          + `HTTP ${response.status} `
          + `${String(response.headers.get('content-range'))}`
        );
      }
      const contents = Buffer.from(await response.arrayBuffer());
      if (contents.length !== expectedBytes) {
        throw new Error(
          `Range ${input.start}-${input.end} returned `
          + `${contents.length} bytes instead of ${expectedBytes}`
        );
      }
      writeBufferAt(input.destination, contents, input.start);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) await delay(attempt * 2_000);
    }
  }
  throw new Error(
    `Unable to download GitHub Release asset range `
    + `${input.start}-${input.end}: ${errorMessage(lastError)}`,
    { cause: lastError }
  );
}

function writeBufferAt(path, contents, position) {
  const descriptor = openSync(path, 'r+');
  try {
    let offset = 0;
    while (offset < contents.length) {
      offset += writeSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        position + offset
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

async function verifyArchiveHash(path, expected) {
  const actual = await hashFile(path);
  if (actual !== expected) {
    fail(
      'CODEX_RUNTIME_ARCHIVE_HASH_MISMATCH',
      `Codex Runtime archive hash mismatch: ${actual} !== ${expected}`,
      { actual, expected }
    );
  }
}

async function inspectArchive(archivePath, expectedFiles) {
  const files = [];
  const entries = new Set();
  try {
    await listTar({
      file: archivePath,
      strict: true,
      onentry(entry) {
        const path = normalizeArchivePath(entry.path);
        if (entries.has(path)) {
          fail(
            'CODEX_RUNTIME_ARCHIVE_ENTRY_INVALID',
            `Codex Runtime archive contains a duplicate entry: ${path}`
          );
        }
        entries.add(path);
        if (entry.type === 'Directory') return;
        if (entry.type !== 'File' && entry.type !== 'OldFile') {
          fail(
            'CODEX_RUNTIME_ARCHIVE_ENTRY_INVALID',
            `Codex Runtime archive contains unsupported ${entry.type}: ${path}`
          );
        }
        files.push(path);
      }
    });
  } catch (error) {
    if (error instanceof CodexRuntimeAssetError) throw error;
    fail(
      'CODEX_RUNTIME_ARCHIVE_INVALID',
      `Unable to inspect Codex Runtime archive: ${errorMessage(error)}`
    );
  }
  const actual = files.sort();
  const expected = [...expectedFiles].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      'CODEX_RUNTIME_FILE_LIST_MISMATCH',
      'Codex Runtime archive file list does not match the manifest',
      { actual, expected }
    );
  }
}

function normalizeArchivePath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || value.includes('\\')
    || isAbsolute(value)
    || posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
  ) {
    fail(
      'CODEX_RUNTIME_ARCHIVE_PATH_INVALID',
      `Unsafe Codex Runtime archive path: ${String(value)}`
    );
  }
  const trimmed = value.replace(/^\.\/+/, '').replace(/\/+$/, '');
  const segments = trimmed.split('/');
  if (
    trimmed.length === 0
    || segments.some(segment =>
      segment.length === 0 || segment === '.' || segment === '..'
    )
  ) {
    fail(
      'CODEX_RUNTIME_ARCHIVE_PATH_INVALID',
      `Unsafe Codex Runtime archive path: ${value}`
    );
  }
  return segments.join('/');
}

function expectedPackageMetadata(manifest, target) {
  return {
    layoutVersion: manifest.layoutVersion,
    version: manifest.codexVersion,
    target: target.targetTriple,
    variant: manifest.variant,
    entrypoint: target.platform === 'win32'
      ? 'bin/codex.exe'
      : 'bin/codex',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path'
  };
}

function listRelativeFiles(root, current = root) {
  if (!existsSync(root)) {
    fail(
      'CODEX_RUNTIME_DIRECTORY_MISSING',
      `Codex Runtime directory is missing: ${root}`
    );
  }
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      fail(
        'CODEX_RUNTIME_UNSUPPORTED_ENTRY',
        `Codex Runtime contains a symbolic link: ${relativePath}`
      );
    }
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(root, path));
      continue;
    }
    if (!entry.isFile()) {
      fail(
        'CODEX_RUNTIME_UNSUPPORTED_ENTRY',
        `Codex Runtime contains an unsupported entry: ${relativePath}`
      );
    }
    files.push(relativePath);
  }
  return files.sort();
}

function inspectBinaryArchitecture(path) {
  const header = readHeader(path, 4096);
  if (header.length >= 8 && header.readUInt32BE(0) === 0xcffaedfe) {
    return {
      platform: 'darwin',
      arch: archForValue(
        header.readUInt32LE(4),
        MACHO_CPU_TYPES,
        'Mach-O'
      )
    };
  }
  if (
    header.length >= 64
    && header[0] === 0x4d
    && header[1] === 0x5a
  ) {
    const peOffset = header.readUInt32LE(0x3c);
    if (
      peOffset + 6 > header.length
      || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
    ) {
      fail(
        'CODEX_RUNTIME_BINARY_INVALID',
        `Invalid PE header: ${path}`
      );
    }
    return {
      platform: 'win32',
      arch: archForValue(
        header.readUInt16LE(peOffset + 4),
        PE_MACHINE_TYPES,
        'PE'
      )
    };
  }
  if (
    header.length >= 20
    && header[0] === 0x7f
    && header.toString('ascii', 1, 4) === 'ELF'
  ) {
    const littleEndian = header[5] === 1;
    const machine = littleEndian
      ? header.readUInt16LE(18)
      : header.readUInt16BE(18);
    return {
      platform: 'linux',
      arch: archForValue(machine, ELF_MACHINE_TYPES, 'ELF')
    };
  }
  fail(
    'CODEX_RUNTIME_BINARY_INVALID',
    `Unsupported executable format: ${path}`
  );
}

function readHeader(path, maximumBytes) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(maximumBytes);
    const bytesRead = readSync(
      descriptor,
      buffer,
      /*offset*/ 0,
      buffer.length,
      /*position*/ 0
    );
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function archForValue(value, values, label) {
  for (const [arch, expected] of Object.entries(values)) {
    if (value === expected) return arch;
  }
  fail(
    'CODEX_RUNTIME_ARCHITECTURE_UNKNOWN',
    `Unsupported ${label} architecture value: 0x${value.toString(16)}`
  );
}

async function verifyCodexVersion(entrypoint, expectedVersion, commandRunner) {
  const result = await commandRunner(entrypoint, ['--version']);
  assertCommandSucceeded('Codex Runtime version', result);
  const lines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.includes(`codex-cli ${expectedVersion}`)) {
    fail(
      'CODEX_RUNTIME_VERSION_MISMATCH',
      `Codex Runtime version output does not contain codex-cli ${expectedVersion}`,
      { output: lines }
    );
  }
}

function assertCommandSucceeded(label, result) {
  if (result?.status !== 0) {
    fail(
      'CODEX_RUNTIME_COMMAND_FAILED',
      `${label} failed: ${result?.stderr || result?.stdout || 'unknown error'}`
    );
  }
}

function atomicReplaceDirectory(source, destination) {
  const backup = `${destination}.previous-${randomUUID()}`;
  const hadDestination = existsSync(destination);
  if (hadDestination) renameSync(destination, backup);
  try {
    renameSync(source, destination);
  } catch (error) {
    if (hadDestination && existsSync(backup) && !existsSync(destination)) {
      renameSync(backup, destination);
    }
    throw error;
  }
  if (hadDestination) rmSync(backup, { force: true, recursive: true });
}

function assertSafeStagingPath(path) {
  const parent = dirname(path);
  if (path === parent || basename(path).length === 0) {
    fail(
      'CODEX_RUNTIME_STAGING_PATH_INVALID',
      `Unsafe Codex Runtime staging path: ${path}`
    );
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
