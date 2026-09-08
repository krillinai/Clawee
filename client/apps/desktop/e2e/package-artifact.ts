import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const isolatedPackages = new Map<string, {
  packageRoot: string;
  temporaryRoot: string;
}>();
let cleanupRegistered = false;

export type DesktopBuildManifest = {
  version: number;
  commit: string;
  dirty: boolean;
  generatedAt: string;
  platform: string;
  arch: string;
  mode: string;
  packageRoot: string;
  codexRuntimeId: string;
  codexRuntimeVersion: string;
  codexRuntimeReleaseTag: string;
  codexRuntimeTarget: string;
  codexRuntimeLayoutVersion: number;
  codexRuntimeEntrypoint: string;
  codexRuntimeFileCount: number;
  codexRuntimeContentSha256: string;
};

export function packagedExecutable(desktopDir: string): string {
  const packageRoot = packagedPackageRoot(desktopDir);
  if (process.platform === 'darwin') {
    return join(packageRoot, 'Contents', 'MacOS', 'Clawee');
  }
  return join(
    packageRoot,
    process.platform === 'win32' ? 'Clawee.exe' : 'clawee'
  );
}

export function readDesktopPackageVersion(desktopDir: string): string {
  const manifest = JSON.parse(
    readFileSync(join(desktopDir, 'package.json'), 'utf8')
  ) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('Desktop package version is missing');
  }
  return manifest.version;
}

export function packagedPackageRoot(desktopDir: string): string {
  return isolatePackageRoot(readDesktopBuildManifest(desktopDir).packageRoot);
}

export function packagedResourcesRoot(desktopDir: string): string {
  const packageRoot = packagedPackageRoot(desktopDir);
  return process.platform === 'darwin'
    ? join(packageRoot, 'Contents', 'Resources')
    : join(packageRoot, 'resources');
}

export function readDesktopBuildManifest(
  desktopDir: string
): DesktopBuildManifest {
  const manifestPath = resolveBuildManifestPath(desktopDir);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Desktop 构建清单不存在：${manifestPath}。`
      + '请先执行 package，或设置 CLAWEE_DESKTOP_PACKAGE_ROOT。'
    );
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8')
  ) as Partial<DesktopBuildManifest>;
  if (
    typeof manifest.packageRoot !== 'string'
    || typeof manifest.codexRuntimeId !== 'string'
    || typeof manifest.codexRuntimeVersion !== 'string'
    || typeof manifest.codexRuntimeReleaseTag !== 'string'
    || typeof manifest.codexRuntimeTarget !== 'string'
    || typeof manifest.codexRuntimeLayoutVersion !== 'number'
    || typeof manifest.codexRuntimeEntrypoint !== 'string'
    || typeof manifest.codexRuntimeFileCount !== 'number'
    || typeof manifest.codexRuntimeContentSha256 !== 'string'
  ) {
    throw new Error(`Desktop 构建清单缺少 Codex Runtime 字段：${manifestPath}`);
  }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(
      `Desktop 构建产物不是当前原生平台：`
      + `${String(manifest.platform)}/${String(manifest.arch)}，`
      + `当前为 ${process.platform}/${process.arch}`
    );
  }
  return manifest as DesktopBuildManifest;
}

function isolatePackageRoot(sourceRoot: string): string {
  const existing = isolatedPackages.get(sourceRoot);
  if (existing !== undefined) return existing.packageRoot;

  const temporaryRoot = mkdtempSync(
    join(tmpdir(), 'clawee-packaged-e2e-')
  );
  const packageRoot = join(temporaryRoot, basename(sourceRoot));
  cpSync(sourceRoot, packageRoot, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  isolatedPackages.set(sourceRoot, { packageRoot, temporaryRoot });
  registerCleanup();
  console.log(
    `[desktop-e2e] 已隔离打包产物：${sourceRoot} -> ${packageRoot}`
  );
  return packageRoot;
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    for (const isolated of isolatedPackages.values()) {
      try {
        rmSync(isolated.temporaryRoot, { recursive: true, force: true });
      } catch {
        // The operating system can reclaim a leftover test directory.
      }
    }
  });
}

function resolveBuildManifestPath(desktopDir: string): string {
  const explicit = process.env.CLAWEE_DESKTOP_PACKAGE_ROOT;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const packageRoot = resolve(explicit);
    const manifestPath = process.env.CLAWEE_DESKTOP_BUILD_MANIFEST;
    if (manifestPath !== undefined && manifestPath.trim().length > 0) {
      return resolve(manifestPath);
    }
    const fallback = join(
      desktopDir,
      'release',
      'clawee-desktop-build-manifest.json'
    );
    if (existsSync(fallback)) return fallback;
    throw new Error(
      `设置 CLAWEE_DESKTOP_PACKAGE_ROOT=${packageRoot} 时还必须提供有效的 `
      + 'CLAWEE_DESKTOP_BUILD_MANIFEST'
    );
  }
  return resolve(
    process.env.CLAWEE_DESKTOP_BUILD_MANIFEST
      ?? join(desktopDir, 'release', 'clawee-desktop-build-manifest.json')
  );
}
