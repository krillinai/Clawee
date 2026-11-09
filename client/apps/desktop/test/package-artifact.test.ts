import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDesktopPackageVersion } from '../e2e/package-artifact.js';

describe('Packaged Desktop version', () => {
  let root: string;
  let desktopDir: string;
  let manifestPath: string;
  let manifest: Record<string, unknown>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clawee-package-version-'));
    desktopDir = join(root, 'client', 'apps', 'desktop');
    mkdirSync(join(desktopDir, 'release'), { recursive: true });
    writeFileSync(join(root, 'VERSION'), '1.0.3\n');
    writeFileSync(join(desktopDir, 'package.json'), JSON.stringify({ version: '0.1.8' }));
    manifestPath = join(desktopDir, 'release', 'clawee-desktop-build-manifest.json');
    manifest = {
      releaseVersion: '1.0.6',
      packageRoot: join(root, 'Clawee.app'),
      platform: process.platform,
      arch: process.arch,
      codexRuntimeId: 'test-runtime',
      codexRuntimeVersion: '0.151.0',
      codexRuntimeReleaseTag: 'test-runtime-tag',
      codexRuntimeTarget: 'test-target',
      codexRuntimeLayoutVersion: 1,
      codexRuntimeEntrypoint: 'codex',
      codexRuntimeFileCount: 1,
      codexRuntimeContentSha256: 'a'.repeat(64)
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    vi.stubEnv('CLAWEE_VERSION', undefined);
    vi.stubEnv('CLAWEE_DESKTOP_PACKAGE_ROOT', undefined);
    vi.stubEnv('CLAWEE_DESKTOP_BUILD_MANIFEST', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['1.0.6', '1.1.0', '2.0.0-rc.1'])('reads the tested build version %s instead of source versions', version => {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, releaseVersion: version }));
    expect(readDesktopPackageVersion(desktopDir)).toBe(version);
  });

  it('uses an explicitly selected artifact manifest even when the environment requests another version', () => {
    const selectedManifest = join(root, 'selected-build.json');
    writeFileSync(selectedManifest, JSON.stringify({ ...manifest, releaseVersion: '2.0.0-rc.2' }));
    vi.stubEnv('CLAWEE_VERSION', 'v9.0.0');
    vi.stubEnv('CLAWEE_DESKTOP_PACKAGE_ROOT', join(root, 'selected-app'));
    vi.stubEnv('CLAWEE_DESKTOP_BUILD_MANIFEST', selectedManifest);
    expect(readDesktopPackageVersion(desktopDir)).toBe('2.0.0-rc.2');
  });

  it.each([undefined, '', ' ', 123])('rejects a missing or invalid build version %s', version => {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, releaseVersion: version }));
    expect(() => readDesktopPackageVersion(desktopDir)).toThrow('Desktop 构建清单缺少产品版本');
  });
});
