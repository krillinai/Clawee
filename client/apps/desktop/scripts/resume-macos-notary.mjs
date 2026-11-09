import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { notarytoolCredentialArgs } from './macos-notarization.mjs';
import { finalizeReleaseDmgArtifacts, verifyMacReleaseCommand } from './finalize-macos-release.mjs';
import {
  describeReleaseArtifacts, loadNotaryRecovery, notaryFailureDiagnostic,
  restoreVerificationContext, saveNotaryRecovery
} from './notary-recovery.mjs';
import { refreshUpdateMetadata } from './release-artifacts.mjs';
import { runStage } from './script-utils.mjs';

export async function resumeMacNotary({ directory, rootDir, manifestPath, expected }) {
  assert.equal(process.platform, 'darwin', '公证恢复必须在 macOS 上运行');
  assert.equal(process.arch, expected.arch, '公证恢复必须使用同架构 runner');
  const checkpoint = await loadNotaryRecovery(directory, expected);
  const head = verifyMacReleaseCommand('源码检出', 'git', ['-C', rootDir, 'rev-parse', 'HEAD']);
  assert.equal(head.stdout.trim(), expected.sha, '当前检出不是原标签 SHA');
  const releaseDir = join(rootDir, 'apps/desktop/release');
  const packageParent = join(releaseDir, `mac-${expected.arch}`);
  const packageRoot = join(packageParent, 'Clawee.app');
  mkdirSync(releaseDir, { recursive: true });
  rmSync(manifestPath, { force: true });
  rmSync(packageParent, { force: true, recursive: true });
  mkdirSync(packageParent, { recursive: true });
  const artifacts = checkpoint.files.map(file => {
    const path = join(releaseDir, file.name);
    cpSync(join(directory, file.name), path);
    return path;
  });
  await restoreVerificationContext(directory, rootDir);
  verifyMacReleaseCommand('原 App ZIP 解包', 'ditto', ['-x', '-k', artifacts.find(path => path.endsWith('.zip')), packageParent]);
  const manifest = {
    ...checkpoint.manifest,
    generatedAt: new Date().toISOString(),
    packageRoot,
    packageRootRelative: `apps/desktop/release/mac-${expected.arch}/Clawee.app`,
    recoveredFrom: checkpoint.source,
    artifacts: await describeReleaseArtifacts(artifacts, rootDir)
  };
  const recovery = {
    directory, rootDir, artifactPaths: artifacts,
    checkpoint: {
      ...checkpoint, manifest, failure: undefined,
      source: process.env.GITHUB_RUN_ID ? {
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT
      } : checkpoint.source
    }
  };
  try {
    await saveNotaryRecovery(recovery);
    verifyMacReleaseCommand('原 App 签名', 'codesign', ['--verify', '--deep', '--strict', packageRoot]);
    await finalizeReleaseDmgArtifacts(
      artifacts.filter(path => path.endsWith('.dmg')),
      notarytoolCredentialArgs(process.env, expected.teamId), recovery
    );
    refreshUpdateMetadata(artifacts);
    manifest.artifacts = await describeReleaseArtifacts(artifacts, rootDir);
    await saveNotaryRecovery(recovery, { stage: 'package' });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await runStage('验证恢复后的桌面包', process.execPath, [join(rootDir, 'apps/desktop/scripts/verify-package.mjs')], {
      cwd: rootDir,
      env: {
        ...process.env,
        CLAWEE_DESKTOP_BUILD_MANIFEST: manifestPath,
        CLAWEE_DESKTOP_PACKAGE_ROOT: packageRoot,
        CLAWEE_DESKTOP_TARGET_PLATFORM: 'mac',
        CLAWEE_DESKTOP_TARGET_ARCH: expected.arch,
        CLAWEE_REQUIRE_DISTRIBUTABLE_MAC: '1',
        CLAWEE_APPLE_TEAM_ID: expected.teamId
      },
      timeoutMs: 5 * 60_000
    });
    await saveNotaryRecovery(recovery, { stage: 'verified' });
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV,
        `CLAWEE_DESKTOP_BUILD_MANIFEST=${manifestPath}\nCLAWEE_DESKTOP_PACKAGE_ROOT=${packageRoot}\n`);
    }
  } catch (error) {
    rmSync(manifestPath, { force: true });
    await saveNotaryRecovery(recovery, { failure: notaryFailureDiagnostic(error) });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' } } });
  const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await resumeMacNotary({
    directory: resolve(values.directory ?? join(desktopDir, 'release/notary-recovery')),
    rootDir: resolve(desktopDir, '../..'),
    manifestPath: resolve(process.env.CLAWEE_DESKTOP_BUILD_MANIFEST
      ?? join(desktopDir, `release/clawee-desktop-build-manifest-mac-${process.arch}.json`)),
    expected: {
      sha: process.env.SOURCE_SHA,
      tag: process.env.RELEASE_TAG,
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.CLAWEE_NOTARY_SOURCE_RUN_ID,
      runAttempt: process.env.CLAWEE_NOTARY_SOURCE_RUN_ATTEMPT,
      arch: process.env.CLAWEE_DESKTOP_TARGET_ARCH ?? process.arch,
      teamId: process.env.CLAWEE_APPLE_TEAM_ID ?? process.env.APPLE_TEAM_ID
    }
  });
}
