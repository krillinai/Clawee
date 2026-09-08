import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexRuntimeDescriptor } from '@clawee/protocol';
import {
  resolveDevelopmentRuntime,
  resolveEmbeddedRuntime
} from '../src/main/runtime-resolver.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Desktop Runtime resolver', () => {
  it('packaged_runtime_ignores_path_code_bin_saved_path_and_local_apps', async () => {
    const fixture = createFixture();
    writeFixtureFile(
      join(fixture.homeDir, '.codex', 'sessions', 'legacy.jsonl'),
      '{"type":"legacy"}\n',
      0o600
    );
    const verifyDirectory = vi.fn(async () => ({
      entrypoint: 'bin/codex',
      contentSha256: fixture.contentSha256,
      fileCount: 2,
      files: ['bin/codex', 'codex-package.json']
    }));

    const result = await resolveEmbeddedRuntime({
      resourcesPath: fixture.resourcesPath,
      dataDir: fixture.dataDir,
      manifestPath: fixture.manifestPath,
      platform: 'darwin',
      arch: 'arm64',
      claweeVersion: '1.0.0',
      homeDir: fixture.homeDir,
      processEnv: {
        PATH: join(fixture.root, 'hostile-path'),
        CODEX_BIN: join(fixture.root, 'hostile-codex'),
        CLAWEE_CODEX_BIN: join(fixture.root, 'hostile-clawee-codex'),
        CODEX_HOME: join(fixture.root, 'hostile-home')
      },
      verifyDirectory
    });

    expect(result.launchContext.candidate).toMatchObject({
      source: 'embedded-package',
      entryPath: join(fixture.resourcesPath, 'codex-runtime', 'bin/codex'),
      homePath: join(
        fixture.homeDir,
        '.clawee',
        'codex'
      ),
      contentSha256: fixture.contentSha256,
      migrationSourceHome: null
    });
    expect(result.launchContext.previous).toBeNull();
    expect(verifyDirectory).toHaveBeenCalledWith(expect.objectContaining({
      directory: join(fixture.resourcesPath, 'codex-runtime')
    }));
    expect(verifyDirectory).toHaveBeenCalledTimes(1);
    expect(result.env.CODEX_BIN).toBeUndefined();
    expect(result.env.CLAWEE_CODEX_BIN).toBeUndefined();
    expect(result.env.CODEX_HOME).toBeUndefined();

    const repeated = await resolveEmbeddedRuntime({
      resourcesPath: fixture.resourcesPath,
      dataDir: fixture.dataDir,
      manifestPath: fixture.manifestPath,
      platform: 'darwin',
      arch: 'arm64',
      claweeVersion: '1.0.0',
      homeDir: fixture.homeDir,
      verifyDirectory
    });
    expect(repeated.verificationMode).toBe('cached');
    expect(verifyDirectory).toHaveBeenCalledTimes(1);

    writeFileSync(
      join(fixture.resourcesPath, 'codex-runtime', 'bin/codex'),
      'changed-codex'
    );
    const changed = await resolveEmbeddedRuntime({
      resourcesPath: fixture.resourcesPath,
      dataDir: fixture.dataDir,
      manifestPath: fixture.manifestPath,
      platform: 'darwin',
      arch: 'arm64',
      claweeVersion: '1.0.0',
      homeDir: fixture.homeDir,
      verifyDirectory
    });
    expect(changed.verificationMode).toBe('full');
    expect(verifyDirectory).toHaveBeenCalledTimes(2);
  });

  it('restarts the canonical Home without reopening a completed relocation journal', async () => {
    const fixture = createFixture();
    const runtimeId = 'codex-rust-v0.146.0-layout-1';
    const targetHome = join(fixture.homeDir, '.clawee', 'codex');
    const legacyHome = join(
      fixture.dataDir,
      'codex',
      'homes',
      runtimeId
    );
    writeFixtureFile(
      join(targetHome, 'config.toml'),
      'model = "canonical"\n',
      0o600
    );
    writeFixtureFile(
      join(targetHome, '.clawee', 'runtime-home-layout-1'),
      'managed-by-clawee\n',
      0o600
    );
    writeFixtureFile(
      join(legacyHome, 'config.toml'),
      'model = "legacy"\n',
      0o600
    );
    const activeDescriptor: CodexRuntimeDescriptor = {
      runtimeId,
      source: 'embedded-package',
      codexVersion: '0.146.0',
      releaseTag: 'rust-v0.146.0',
      target: 'aarch64-apple-darwin',
      layoutVersion: 1,
      entryPath: join(fixture.resourcesPath, 'codex-runtime', 'bin/codex'),
      homePath: targetHome,
      contentSha256: fixture.contentSha256,
      minimumClaweeVersion: '1.0.0',
      migrationSourceHome: null
    };
    writeFixtureFile(
      join(fixture.dataDir, 'codex', 'runtime-state.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        state: 'committed',
        active: activeDescriptor,
        previous: null,
        migrationManifestSha256: null,
        updatedAt: '2026-08-27T03:16:45.581Z'
      }, null, 2)}\n`,
      0o600
    );
    writeFixtureFile(
      join(fixture.dataDir, 'codex', 'runtime-commit.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        runtimeId,
        homePath: targetHome,
        minimumClaweeVersion: '1.0.0',
        committedAt: '2026-08-27T03:16:45.581Z'
      }, null, 2)}\n`,
      0o600
    );
    const journalPath = join(
      fixture.dataDir,
      'codex',
      'home-relocations',
      `${runtimeId}-${createHash('sha256')
        .update(targetHome)
        .digest('hex')
        .slice(0, 12)}.json`
    );
    writeFixtureFile(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 2,
        runtimeId,
        sourceHome: legacyHome,
        targetHome,
        backupHome: null,
        state: 'activated',
        entryCount: 1,
        contentSha256: 'a'.repeat(64),
        createdAt: '2026-08-27T03:16:45.398Z',
        updatedAt: '2026-08-27T03:16:45.581Z'
      }, null, 2)}\n`,
      0o600
    );
    const verifyDirectory = vi.fn(async () => ({
      entrypoint: 'bin/codex',
      contentSha256: fixture.contentSha256,
      fileCount: 2,
      files: ['bin/codex', 'codex-package.json']
    }));

    const result = await resolveEmbeddedRuntime({
      resourcesPath: fixture.resourcesPath,
      dataDir: fixture.dataDir,
      manifestPath: fixture.manifestPath,
      platform: 'darwin',
      arch: 'arm64',
      claweeVersion: '1.0.0',
      homeDir: fixture.homeDir,
      verifyDirectory
    });

    expect(result.launchContext.candidate.homePath).toBe(targetHome);
    expect(result.launchContext.candidate.migrationSourceHome).toBeNull();
    expect(result.launchContext.previous).toBeNull();
    expect(readFileSync(join(targetHome, 'config.toml'), 'utf8'))
      .toContain('canonical');
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
      sourceHome: legacyHome,
      targetHome,
      state: 'activated'
    });

    await expect(resolveEmbeddedRuntime({
      resourcesPath: fixture.resourcesPath,
      dataDir: fixture.dataDir,
      manifestPath: fixture.manifestPath,
      platform: 'darwin',
      arch: 'arm64',
      claweeVersion: '1.0.0',
      homeDir: fixture.homeDir,
      verifyDirectory
    })).resolves.toMatchObject({
      launchContext: { candidate: { homePath: targetHome } }
    });
  });

  it('ignores a legacy versioned Home and keeps the stable Home canonical', async () => {
    const fixture = createFixture();
    const runtimeId = 'codex-rust-v0.146.0-layout-1';
    const targetHome = join(fixture.homeDir, '.clawee', 'codex');
    const legacyHome = join(
      fixture.dataDir,
      'codex',
      'homes',
      runtimeId
    );
    writeFixtureFile(
      join(legacyHome, 'config.toml'),
      '[mcp_servers.legacy]\nenabled = true\n',
      0o600
    );
    const legacyDescriptor: CodexRuntimeDescriptor = {
      runtimeId,
      source: 'embedded-package',
      codexVersion: '0.146.0',
      releaseTag: 'rust-v0.146.0',
      target: 'aarch64-apple-darwin',
      layoutVersion: 1,
      entryPath: join(fixture.root, 'old-package', 'bin', 'codex'),
      homePath: legacyHome,
      contentSha256: 'b'.repeat(64),
      minimumClaweeVersion: '1.0.0',
      migrationSourceHome: null
    };
    const statePath = join(fixture.dataDir, 'codex', 'runtime-state.json');
    const commitPath = join(fixture.dataDir, 'codex', 'runtime-commit.json');
    writeFixtureFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        state: 'committed',
        active: legacyDescriptor,
        previous: null,
        migrationManifestSha256: null,
        updatedAt: '2026-08-25T12:00:00.000Z'
      }, null, 2)}\n`,
      0o600
    );
    writeFixtureFile(
      commitPath,
      `${JSON.stringify({
        schemaVersion: 1,
        runtimeId,
        homePath: legacyHome,
        minimumClaweeVersion: '1.0.0',
        committedAt: '2026-08-25T12:00:00.000Z'
      }, null, 2)}\n`,
      0o600
    );
    const verifyDirectory = vi.fn(async () => ({
      entrypoint: 'bin/codex',
      contentSha256: fixture.contentSha256,
      fileCount: 2,
      files: ['bin/codex', 'codex-package.json']
    }));

    const result = await resolveEmbeddedRuntime({
      resourcesPath: fixture.resourcesPath,
      dataDir: fixture.dataDir,
      manifestPath: fixture.manifestPath,
      platform: 'darwin',
      arch: 'arm64',
      claweeVersion: '1.0.0',
      homeDir: fixture.homeDir,
      verifyDirectory
    });

    expect(result.launchContext).toMatchObject({
      candidate: {
        homePath: targetHome,
        migrationSourceHome: null
      },
      previous: null
    });
    expect(readFileSync(join(legacyHome, 'config.toml'), 'utf8'))
      .toContain('[mcp_servers.legacy]');
    expect(existsSync(join(targetHome, 'config.toml'))).toBe(false);
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(commitPath)).toBe(true);
    expect(existsSync(join(
      fixture.dataDir,
      'codex',
      'home-relocations'
    ))).toBe(false);
  });

  it('development_runtime_ignores_external_overrides_and_uses_fixed_internal_paths', async () => {
    const fixture = createFixture();
    const runtimeDirectory = join(fixture.root, 'internal-runtime');
    const codexBin = join(runtimeDirectory, 'bin', 'codex');
    const codexHome = join(fixture.root, 'internal-home');
    writeFixtureFile(codexBin, 'internal-codex', 0o755);
    mkdirSync(codexHome, { recursive: true });
    const probeVersion = vi.fn(async () => '0.146.0');

    const result = await resolveDevelopmentRuntime({
      manifestPath: fixture.manifestPath,
      dataDir: fixture.dataDir,
      runtimeDirectory,
      homePath: codexHome,
      platform: 'darwin',
      arch: 'arm64',
      claweeVersion: '1.0.0',
      processEnv: {
        CODEX_BIN: join(fixture.root, 'hostile-codex'),
        CODEX_HOME: join(fixture.root, 'hostile-home'),
        CLAWEE_CODEX_DEV_BIN: join(fixture.root, 'hostile-dev-codex'),
        CLAWEE_CODEX_DEV_HOME: join(fixture.root, 'hostile-dev-home')
      },
      probeVersion
    });

    expect(result).toMatchObject({
      launchContext: {
        candidate: {
          source: 'external-development',
          entryPath: codexBin,
          homePath: codexHome,
          codexVersion: '0.146.0'
        },
        previous: null
      }
    });
    expect(probeVersion).toHaveBeenCalledWith(codexBin);
    expect(result.env.CODEX_BIN).toBeUndefined();
    expect(result.env.CODEX_HOME).toBeUndefined();
    expect(result.env.CLAWEE_CODEX_DEV_BIN).toBeUndefined();
    expect(result.env.CLAWEE_CODEX_DEV_HOME).toBeUndefined();
  });

});

function createFixture(): {
  root: string;
  resourcesPath: string;
  dataDir: string;
  homeDir: string;
  manifestPath: string;
  contentSha256: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'clawee-runtime-resolver-'));
  tempRoots.push(root);
  const resourcesPath = join(root, 'resources');
  const dataDir = join(root, 'data');
  const homeDir = join(root, 'home');
  const runtimeDirectory = join(resourcesPath, 'codex-runtime');
  const manifestPath = join(resourcesPath, 'deployment', 'codex-runtime.json');
  const packageDescriptorPath = join(
    resourcesPath,
    'deployment',
    'codex-runtime-package.json'
  );
  writeFixtureFile(join(runtimeDirectory, 'bin/codex'), 'codex', 0o755);
  writeFixtureFile(
    join(runtimeDirectory, 'codex-package.json'),
    `${JSON.stringify({
      layoutVersion: 1,
      version: '0.146.0',
      target: 'aarch64-apple-darwin',
      variant: 'codex',
      entrypoint: 'bin/codex',
      resourcesDir: 'codex-resources',
      pathDir: 'codex-path'
    })}\n`,
    0o644
  );
  const contentSha256 = hashRuntimeDirectory(runtimeDirectory);
  writeFixtureFile(packageDescriptorPath, `${JSON.stringify({
    schemaVersion: 1,
    runtimeId: 'codex-rust-v0.146.0-layout-1',
    codexVersion: '0.146.0',
    releaseTag: 'rust-v0.146.0',
    target: 'aarch64-apple-darwin',
    layoutVersion: 1,
    entrypoint: 'bin/codex',
    fileCount: 2,
    contentSha256,
    archiveSha256: 'a'.repeat(64)
  }, null, 2)}\n`, 0o644);
  writeFixtureFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    runtimeId: 'codex-rust-v0.146.0-layout-1',
    codexVersion: '0.146.0',
    releaseTag: 'rust-v0.146.0',
    sourceCommit: 'e363b08c9175ac1cbe5893615dd2cb9ddf95043b',
    variant: 'codex',
    layoutVersion: 1,
    minimumClaweeVersion: '1.0.0',
    previousSupportedReleaseTag: 'rust-v0.146.0',
    schemas: {},
    targets: {
      'aarch64-apple-darwin': {
        platform: 'darwin',
        arch: 'arm64',
        targetTriple: 'aarch64-apple-darwin',
        assetName: 'codex-package-aarch64-apple-darwin.tar.gz',
        archiveSha256: 'a'.repeat(64),
        expectedFiles: ['bin/codex', 'codex-package.json'],
        trust: {
          kind: 'apple-code-signing',
          signingIdentity: 'test',
          teamIdentifier: 'TEST',
          certificateSha256: 'b'.repeat(64),
          signedFiles: ['bin/codex'],
          entitlements: {}
        },
        formalRelease: true
      }
    }
  }, null, 2)}\n`, 0o644);
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    root,
    resourcesPath,
    dataDir,
    homeDir,
    manifestPath,
    contentSha256
  };
}

function writeFixtureFile(path: string, contents: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function hashRuntimeDirectory(directory: string): string {
  const files = ['bin/codex', 'codex-package.json'];
  const hash = createHash('sha256');
  for (const path of files) {
    const digest = createHash('sha256')
      .update(readFileSync(join(directory, path)))
      .digest('hex');
    hash.update(path).update('\0').update(digest).update('\0');
  }
  return hash.digest('hex');
}
