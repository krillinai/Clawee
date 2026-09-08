import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  win32
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export type CodexRuntimeTrust = {
  kind: 'apple-code-signing' | 'authenticode' | 'sigstore';
  signedFiles: string[];
  unsignedFiles?: Record<string, string>;
};

export type CodexRuntimeTarget = {
  platform: 'darwin' | 'win32' | 'linux';
  arch: 'x64' | 'arm64';
  targetTriple: string;
  archiveSha256: string;
  expectedFiles: string[];
  trust: CodexRuntimeTrust;
  formalRelease: boolean;
};

export type CodexRuntimeManifest = {
  schemaVersion: 1;
  runtimeId: string;
  codexVersion: string;
  releaseTag: string;
  sourceCommit: string;
  variant: 'codex';
  layoutVersion: number;
  minimumClaweeVersion: string;
  previousSupportedReleaseTag: string;
  targets: Record<string, CodexRuntimeTarget>;
};

export type CodexRuntimePackageDescriptor = {
  schemaVersion: 1;
  runtimeId: string;
  codexVersion: string;
  releaseTag: string;
  target: string;
  layoutVersion: number;
  entrypoint: string;
  fileCount: number;
  contentSha256: string;
  archiveSha256: string;
};

export type RuntimeDirectoryVerification = {
  entrypoint: string;
  contentSha256: string;
  fileCount: number;
  files: string[];
};

export type RuntimeDirectoryVerifier = (
  input: {
    directory: string;
    manifest: CodexRuntimeManifest;
    target: CodexRuntimeTarget;
    packageDescriptor: CodexRuntimePackageDescriptor;
  }
) => Promise<RuntimeDirectoryVerification>;

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[]
) => Promise<CommandResult>;

export function readCodexRuntimeManifest(
  path: string
): CodexRuntimeManifest {
  const value = readJsonObject(path, 'Codex Runtime manifest');
  if (
    value.schemaVersion !== 1
    || typeof value.runtimeId !== 'string'
    || typeof value.codexVersion !== 'string'
    || typeof value.releaseTag !== 'string'
    || typeof value.sourceCommit !== 'string'
    || value.variant !== 'codex'
    || !Number.isSafeInteger(value.layoutVersion)
    || typeof value.minimumClaweeVersion !== 'string'
    || typeof value.previousSupportedReleaseTag !== 'string'
    || !isRecord(value.targets)
  ) {
    throw new Error('CODEX_RUNTIME_MANIFEST_INVALID');
  }
  return value as unknown as CodexRuntimeManifest;
}

export function readCodexRuntimePackageDescriptor(
  path: string
): CodexRuntimePackageDescriptor {
  const value = readJsonObject(path, 'Codex Runtime package descriptor');
  if (
    value.schemaVersion !== 1
    || typeof value.runtimeId !== 'string'
    || typeof value.codexVersion !== 'string'
    || typeof value.releaseTag !== 'string'
    || typeof value.target !== 'string'
    || !Number.isSafeInteger(value.layoutVersion)
    || typeof value.entrypoint !== 'string'
    || !Number.isSafeInteger(value.fileCount)
    || typeof value.contentSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.contentSha256)
    || typeof value.archiveSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.archiveSha256)
  ) {
    throw new Error('CODEX_RUNTIME_PACKAGE_DESCRIPTOR_INVALID');
  }
  return value as unknown as CodexRuntimePackageDescriptor;
}

export function resolveCodexRuntimeTarget(
  manifest: CodexRuntimeManifest,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): CodexRuntimeTarget {
  const matches = Object.values(manifest.targets).filter(
    target => target.platform === platform && target.arch === arch
  );
  if (matches.length !== 1) {
    throw new Error(
      `CODEX_RUNTIME_TARGET_NOT_FOUND: ${platform}/${arch}`
    );
  }
  const target = matches[0]!;
  if (
    target.targetTriple.length === 0
    || !Array.isArray(target.expectedFiles)
    || target.expectedFiles.length === 0
    || !isRecord(target.trust)
    || !Array.isArray(target.trust.signedFiles)
  ) {
    throw new Error('CODEX_RUNTIME_TARGET_INVALID');
  }
  return target;
}

export function assertPackageDescriptorMatches(
  manifest: CodexRuntimeManifest,
  target: CodexRuntimeTarget,
  descriptor: CodexRuntimePackageDescriptor
): void {
  const expected = {
    runtimeId: manifest.runtimeId,
    codexVersion: manifest.codexVersion,
    releaseTag: manifest.releaseTag,
    target: target.targetTriple,
    layoutVersion: manifest.layoutVersion,
    entrypoint: target.platform === 'win32'
      ? 'bin/codex.exe'
      : 'bin/codex',
    archiveSha256: target.archiveSha256
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (descriptor[key as keyof CodexRuntimePackageDescriptor] !== expectedValue) {
      throw new Error(
        `CODEX_RUNTIME_PACKAGE_DESCRIPTOR_MISMATCH: ${key}`
      );
    }
  }
}

export async function verifyDesktopRuntimeDirectory(
  input: {
    directory: string;
    manifest: CodexRuntimeManifest;
    target: CodexRuntimeTarget;
    packageDescriptor: CodexRuntimePackageDescriptor;
    commandRunner?: CommandRunner;
  }
): Promise<RuntimeDirectoryVerification> {
  assertPackageDescriptorMatches(
    input.manifest,
    input.target,
    input.packageDescriptor
  );
  const root = resolve(input.directory);
  const inspection = await inspectDirectory(root);
  const expectedFiles = [...input.target.expectedFiles].sort();
  if (!isDeepStrictEqual(inspection.files, expectedFiles)) {
    throw new Error('CODEX_RUNTIME_FILE_LIST_MISMATCH');
  }
  if (
    inspection.fileCount !== input.packageDescriptor.fileCount
    || inspection.contentSha256 !== input.packageDescriptor.contentSha256
  ) {
    throw new Error('CODEX_RUNTIME_CONTENT_HASH_MISMATCH');
  }
  for (const entry of inspection.entries) {
    if (
      input.target.platform !== 'win32'
      && entry.path !== 'codex-package.json'
      && (entry.mode & 0o111) !== 0o111
    ) {
      throw new Error(`CODEX_RUNTIME_NOT_EXECUTABLE: ${entry.path}`);
    }
  }

  const packageMetadata = readJsonObject(
    join(root, 'codex-package.json'),
    'codex-package.json'
  );
  const expectedMetadata = {
    layoutVersion: input.manifest.layoutVersion,
    version: input.manifest.codexVersion,
    target: input.target.targetTriple,
    variant: input.manifest.variant,
    entrypoint: input.packageDescriptor.entrypoint,
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path'
  };
  if (!isDeepStrictEqual(packageMetadata, expectedMetadata)) {
    throw new Error('CODEX_RUNTIME_METADATA_MISMATCH');
  }

  const commandRunner = input.commandRunner ?? runCommand;
  await verifyVersion(
    join(root, input.packageDescriptor.entrypoint),
    input.manifest.codexVersion,
    commandRunner
  );
  await verifyPlatformTrust(root, input.target, commandRunner);
  return {
    entrypoint: input.packageDescriptor.entrypoint,
    contentSha256: inspection.contentSha256,
    fileCount: inspection.fileCount,
    files: inspection.files
  };
}

async function inspectDirectory(root: string): Promise<{
  files: string[];
  entries: Array<{ path: string; sha256: string; mode: number }>;
  fileCount: number;
  contentSha256: string;
}> {
  const files = listRelativeFiles(root);
  const entries: Array<{ path: string; sha256: string; mode: number }> = [];
  const aggregate = createHash('sha256');
  for (const path of files) {
    const absolutePath = join(root, path);
    const sha256 = await hashFile(absolutePath);
    entries.push({
      path,
      sha256,
      mode: lstatSync(absolutePath).mode & 0o777
    });
    aggregate.update(path).update('\0').update(sha256).update('\0');
  }
  return {
    files,
    entries,
    fileCount: files.length,
    contentSha256: aggregate.digest('hex')
  };
}

function listRelativeFiles(root: string, current = root): string[] {
  if (!existsSync(root)) {
    throw new Error(`CODEX_RUNTIME_DIRECTORY_MISSING: ${root}`);
  }
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      throw new Error(
        `CODEX_RUNTIME_UNSUPPORTED_ENTRY: ${relativePath}`
      );
    }
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(root, path));
      continue;
    }
    if (
      !entry.isFile()
      || relativePath.startsWith('../')
      || isAbsolute(relativePath)
    ) {
      throw new Error(
        `CODEX_RUNTIME_UNSUPPORTED_ENTRY: ${relativePath}`
      );
    }
    files.push(relativePath);
  }
  return files.sort();
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function verifyVersion(
  entrypoint: string,
  expectedVersion: string,
  commandRunner: CommandRunner
): Promise<void> {
  const result = await commandRunner(entrypoint, ['--version']);
  if (
    result.status !== 0
    || !`${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map(line => line.trim())
      .includes(`codex-cli ${expectedVersion}`)
  ) {
    throw new Error('CODEX_RUNTIME_VERSION_MISMATCH');
  }
}

async function verifyPlatformTrust(
  root: string,
  target: CodexRuntimeTarget,
  commandRunner: CommandRunner
): Promise<void> {
  const binaryFiles = target.expectedFiles
    .filter(path => path !== 'codex-package.json')
    .sort();
  const coveredFiles = [
    ...target.trust.signedFiles,
    ...Object.keys(target.trust.unsignedFiles ?? {})
  ].sort();
  if (!isDeepStrictEqual(binaryFiles, coveredFiles)) {
    throw new Error('CODEX_RUNTIME_TRUST_COVERAGE_INVALID');
  }
  if (target.trust.kind === 'apple-code-signing') {
    for (const relativePath of target.trust.signedFiles) {
      assertCommandSucceeded(
        await commandRunner('codesign', [
          '--verify',
          '--strict',
          '--verbose=4',
          join(root, relativePath)
        ]),
        `CODEX_RUNTIME_SIGNATURE_INVALID: ${relativePath}`
      );
    }
    return;
  }
  if (target.trust.kind === 'authenticode') {
    for (const relativePath of target.trust.signedFiles) {
      const path = join(root, relativePath).replaceAll("'", "''");
      const result = await commandRunner(windowsPowerShellCommand(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `(Get-AuthenticodeSignature -LiteralPath '${path}').Status`
      ]);
      if (result.status !== 0 || result.stdout.trim() !== 'Valid') {
        throw new Error(
          `CODEX_RUNTIME_SIGNATURE_INVALID: ${relativePath}`
        );
      }
    }
    return;
  }
  throw new Error('CODEX_RUNTIME_SIGSTORE_RUNTIME_VERIFIER_UNAVAILABLE');
}

function assertCommandSucceeded(
  result: CommandResult,
  error: string
): void {
  if (result.status !== 0) throw new Error(error);
}

async function runCommand(
  command: string,
  args: string[]
): Promise<CommandResult> {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...(command.toLowerCase().endsWith('powershell.exe')
      ? { env: windowsPowerShellEnvironment() }
      : {}),
    shell: false,
    timeout: 2 * 60_000,
    windowsHide: true
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.error?.message ?? result.stderr ?? ''
  };
}

export function windowsPowerShellEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key.toLowerCase() !== 'psmodulepath'
    )
  );
}

export function windowsPowerShellCommand(
  env: NodeJS.ProcessEnv = process.env
): string {
  for (const key of ['systemroot', 'windir']) {
    const root = Object.entries(env).find(
      ([name]) => name.toLowerCase() === key
    )?.[1]?.trim();
    if (root !== undefined && root.length > 0) {
      return win32.join(
        root,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
    }
  }
  return 'powershell.exe';
}

function readJsonObject(
  path: string,
  label: string
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
