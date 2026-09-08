import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  createReadStream,
  statSync
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  join,
  resolve
} from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {
  CodexRuntimeDescriptor,
  CodexRuntimeLaunchContext
} from '@clawee/protocol';
import {
  compareSemanticVersions,
  parseCodexRuntimeDescriptor,
  parseCodexRuntimeLaunchContext
} from '@clawee/protocol';
import {
  assertPackageDescriptorMatches,
  readCodexRuntimeManifest,
  readCodexRuntimePackageDescriptor,
  resolveCodexRuntimeTarget,
  verifyDesktopRuntimeDirectory,
  type RuntimeDirectoryVerifier
} from './runtime-verification.js';
import {
  readEmbeddedRuntimeVerificationCache,
  writeEmbeddedRuntimeVerificationCache
} from './runtime-verification-cache.js';

const LEGACY_RUNTIME_ENVIRONMENT_KEYS = new Set([
  'CODEX_BIN',
  'CLAWEE_CODEX_BIN',
  'CODEX_HOME',
  'CLAWEE_CODEX_HOME',
  'CLAWEE_CODEX_RUNTIME_DESCRIPTOR',
  'CLAWEE_CODEX_DEV_BIN',
  'CLAWEE_CODEX_DEV_HOME'
]);

export type ResolvedDesktopRuntime = {
  launchContext: CodexRuntimeLaunchContext;
  env: NodeJS.ProcessEnv;
  defaultCwd: string;
  verificationMode?: 'cached' | 'full' | 'development';
};

export class DesktopRuntimeResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DesktopRuntimeResolutionError';
  }
}

export async function resolveEmbeddedRuntime(input: {
  resourcesPath: string;
  dataDir: string;
  manifestPath?: string;
  packageDescriptorPath?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  claweeVersion: string;
  homeDir?: string;
  processEnv?: NodeJS.ProcessEnv;
  verifyDirectory?: RuntimeDirectoryVerifier;
}): Promise<ResolvedDesktopRuntime> {
  const resourcesPath = resolve(input.resourcesPath);
  const manifestPath = resolve(
    input.manifestPath
      ?? join(resourcesPath, 'deployment', 'codex-runtime.json')
  );
  const packageDescriptorPath = resolve(
    input.packageDescriptorPath
      ?? join(
        dirname(manifestPath),
        'codex-runtime-package.json'
      )
  );
  const manifest = readCodexRuntimeManifest(manifestPath);
  const target = resolveCodexRuntimeTarget(
    manifest,
    input.platform ?? process.platform,
    input.arch ?? process.arch
  );
  if (!target.formalRelease) {
    throw new DesktopRuntimeResolutionError(
      'CODEX_RUNTIME_TARGET_NOT_FORMAL',
      `当前 Codex Runtime 目标未启用正式发布：${target.targetTriple}`
    );
  }
  const packageDescriptor = readCodexRuntimePackageDescriptor(
    packageDescriptorPath
  );
  assertPackageDescriptorMatches(manifest, target, packageDescriptor);
  const runtimeDirectory = join(resourcesPath, 'codex-runtime');
  const verifyDirectory =
    input.verifyDirectory ?? verifyDesktopRuntimeDirectory;
  const verificationInput = {
    manifest,
    target,
    packageDescriptor
  };
  const verificationCachePath = join(
    resolve(input.dataDir),
    'codex',
    'runtime-verification.json'
  );
  const cachedVerification = readEmbeddedRuntimeVerificationCache({
    path: verificationCachePath,
    directory: runtimeDirectory,
    runtimeId: manifest.runtimeId,
    target: target.targetTriple,
    packageDescriptor,
    expectedFiles: target.expectedFiles
  });
  const verification = cachedVerification ?? await verifyDirectory({
    directory: runtimeDirectory,
    ...verificationInput
  });
  if (
    verification.contentSha256 !== packageDescriptor.contentSha256
    || verification.fileCount !== packageDescriptor.fileCount
    || verification.entrypoint !== packageDescriptor.entrypoint
  ) {
    throw new DesktopRuntimeResolutionError(
      'CODEX_RUNTIME_PACKAGE_INTEGRITY_MISMATCH',
      '包内 Codex Runtime 与固定构建描述不一致'
    );
  }
  if (cachedVerification === undefined) {
    writeEmbeddedRuntimeVerificationCache({
      path: verificationCachePath,
      directory: runtimeDirectory,
      runtimeId: manifest.runtimeId,
      target: target.targetTriple,
      verification,
      expectedFiles: target.expectedFiles
    });
  }
  const homeDir = resolve(input.homeDir ?? homedir());
  const homePath = join(homeDir, '.clawee', 'codex');
  const candidate = parseCodexRuntimeDescriptor({
    runtimeId: manifest.runtimeId,
    source: 'embedded-package',
    codexVersion: manifest.codexVersion,
    releaseTag: manifest.releaseTag,
    target: target.targetTriple,
    layoutVersion: manifest.layoutVersion,
    entryPath: join(runtimeDirectory, packageDescriptor.entrypoint),
    homePath,
    contentSha256: verification.contentSha256,
    minimumClaweeVersion: manifest.minimumClaweeVersion,
    migrationSourceHome: null
  });
  assertClaweeVersionSupported(
    input.claweeVersion,
    candidate.minimumClaweeVersion
  );
  return {
    launchContext: parseCodexRuntimeLaunchContext({
      candidate,
      previous: null,
      claweeVersion: input.claweeVersion
    }),
    env: withoutRuntimeOverrides(input.processEnv ?? process.env),
    defaultCwd: homeDir,
    verificationMode: cachedVerification === undefined ? 'full' : 'cached'
  };
}

export async function resolveDevelopmentRuntime(input: {
  manifestPath: string;
  dataDir: string;
  runtimeDirectory: string;
  homePath: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  claweeVersion: string;
  processEnv?: NodeJS.ProcessEnv;
  probeVersion?: (entryPath: string) => Promise<string>;
}): Promise<ResolvedDesktopRuntime> {
  const env = input.processEnv ?? process.env;
  const runtimeDirectory = resolve(input.runtimeDirectory);
  const entryPath = join(
    runtimeDirectory,
    (input.platform ?? process.platform) === 'win32'
      ? 'bin/codex.exe'
      : 'bin/codex'
  );
  const homePath = resolve(input.homePath);
  assertExecutable(entryPath, input.platform ?? process.platform);
  assertDirectory(homePath);

  const manifest = readCodexRuntimeManifest(resolve(input.manifestPath));
  const target = resolveCodexRuntimeTarget(
    manifest,
    input.platform ?? process.platform,
    input.arch ?? process.arch
  );
  const actualVersion = await (
    input.probeVersion ?? probeCodexVersion
  )(entryPath);
  if (actualVersion !== manifest.codexVersion) {
    throw new DesktopRuntimeResolutionError(
      'CODEX_RUNTIME_VERSION_MISMATCH',
      `开发 Codex 版本为 ${actualVersion}，要求 ${manifest.codexVersion}`
    );
  }
  const candidate: CodexRuntimeDescriptor = parseCodexRuntimeDescriptor({
    runtimeId: manifest.runtimeId,
    source: 'external-development',
    codexVersion: actualVersion,
    releaseTag: manifest.releaseTag,
    target: target.targetTriple,
    layoutVersion: manifest.layoutVersion,
    entryPath,
    homePath,
    contentSha256: await hashFile(entryPath),
    minimumClaweeVersion: manifest.minimumClaweeVersion,
    migrationSourceHome: null
  });
  assertClaweeVersionSupported(
    input.claweeVersion,
    candidate.minimumClaweeVersion
  );
  return {
    launchContext: parseCodexRuntimeLaunchContext({
      candidate,
      previous: null,
      claweeVersion: input.claweeVersion
    }),
    env: withoutRuntimeOverrides(env),
    defaultCwd: homedir(),
    verificationMode: 'development'
  };
}

function assertClaweeVersionSupported(
  actual: string,
  minimum: string
): void {
  if (compareSemanticVersions(actual, minimum) >= 0) return;
  throw runtimeResolutionError(
    'CODEX_RUNTIME_CLAWEE_VERSION_UNSUPPORTED',
    `Clawee ${actual} 低于 Runtime 要求的最低版本 ${minimum}`
  );
}

function runtimeResolutionError(
  code: string,
  message: string
): DesktopRuntimeResolutionError {
  return new DesktopRuntimeResolutionError(code, `${code}: ${message}`);
}

function withoutRuntimeOverrides(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) {
    if (LEGACY_RUNTIME_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function assertExecutable(
  path: string,
  platform: NodeJS.Platform
): void {
  try {
    accessSync(
      path,
      platform === 'win32' ? constants.F_OK : constants.X_OK
    );
    if (!statSync(path).isFile()) throw new Error('not a file');
  } catch {
    throw new DesktopRuntimeResolutionError(
      'CODEX_RUNTIME_DEVELOPMENT_ENTRY_INVALID',
      `开发 Codex 入口不可执行：${path}`
    );
  }
}

function assertDirectory(path: string): void {
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new DesktopRuntimeResolutionError(
      'CODEX_RUNTIME_DEVELOPMENT_HOME_INVALID',
      `开发 Codex Home 不可用：${path}`
    );
  }
}

async function probeCodexVersion(entryPath: string): Promise<string> {
  const result = spawnSync(entryPath, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new DesktopRuntimeResolutionError(
      'CODEX_RUNTIME_VERSION_CHECK_FAILED',
      `无法读取开发 Codex 版本：${result.error?.message ?? result.stderr}`
    );
  }
  const match = `${result.stdout}\n${result.stderr}`
    .match(/(?:^|\n)codex-cli\s+([0-9A-Za-z.-]+)(?:\n|$)/);
  if (match?.[1] === undefined) {
    throw new DesktopRuntimeResolutionError(
      'CODEX_RUNTIME_VERSION_CHECK_FAILED',
      '开发 Codex 未返回有效版本'
    );
  }
  return match[1];
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
