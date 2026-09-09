import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readEnterpriseGatewayPackageConfig,
  serializeEnterpriseGatewayPackageConfig
} from './enterprise-package-contract.mjs';
import {
  inspectDirectory
} from './directory-integrity.mjs';
import { ensureElectronBuilderCacheScope } from './desktop-cache-contract.mjs';
import {
  verifyCodexRuntimeDirectory
} from './codex-runtime-assets.mjs';
import {
  assertFormalReleasePlatform,
  assertWindowsSigningConfigured,
  desktopReleaseTag,
  isStableReleaseVersion,
  installerExtension,
  normalizeDesktopPlatform,
  resolveDesktopBuildManifestPath,
  windowsPowerShellEnvironment,
  windowsSignatureVerificationCommand
} from './release-platform.mjs';
import { runStage } from './script-utils.mjs';
import { collectUpdateArtifacts, refreshUpdateMetadata } from './release-artifacts.mjs';
import {
  readCodexRuntimeManifest,
  resolveCodexRuntimeTarget
} from '../../../scripts/codex-runtime/manifest.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const rootDir = resolve(desktopDir, '../..');
const releaseDir = resolve(desktopDir, 'release');
const enterpriseGatewayConfigFilename = 'config.toml';
const enterpriseGatewayConfigSource = resolve(
  rootDir,
  'config',
  enterpriseGatewayConfigFilename
);
const enterpriseGatewayConfigStage = resolve(
  desktopDir,
  '.pack',
  'deployment',
  enterpriseGatewayConfigFilename
);
const codexRuntimeManifestSource = resolve(
  rootDir,
  'config',
  'codex-runtime.json'
);
const codexRuntimeManifestStage = resolve(
  desktopDir,
  '.pack',
  'deployment',
  'codex-runtime.json'
);
const codexRuntimePackageDescriptorStage = resolve(
  desktopDir,
  '.pack',
  'deployment',
  'codex-runtime-package.json'
);
const desktopRuntimeStage = resolve(
  desktopDir,
  '.pack',
  'desktop-runtime'
);
const desktopRuntimeDeployStage = resolve(
  desktopDir,
  '.pack',
  'desktop-runtime-deploy'
);
const codexRuntimeStage = resolve(desktopDir, '.pack', 'codex-runtime');
const codexRuntimeManifest = readCodexRuntimeManifest(
  codexRuntimeManifestSource
);
const expectedAppleTeamId =
  process.env.CLAWEE_APPLE_TEAM_ID?.trim() || process.env.APPLE_TEAM_ID?.trim();
const defaultNotaryKeychainProfile = 'clawee-notary';
const manifestPath = resolveDesktopBuildManifestPath(
  rootDir,
  releaseDir,
  process.env.CLAWEE_DESKTOP_BUILD_MANIFEST
);
const mode = parseMode(process.argv.slice(2));
const platform = normalizeDesktopPlatform(
  process.env.CLAWEE_DESKTOP_TARGET_PLATFORM ?? process.platform
);
const arch = process.env.CLAWEE_DESKTOP_TARGET_ARCH ?? process.arch;
const codexRuntimeTarget = resolveCodexRuntimeTarget(codexRuntimeManifest, {
  platform,
  arch
});
const hasConfiguredCacheDir = hasValue(process.env.CLAWEE_DESKTOP_CACHE_DIR);
const cacheDir = resolve(
  process.env.CLAWEE_DESKTOP_CACHE_DIR
    ?? resolve(desktopDir, '.cache')
);
const env = {
  ...process.env,
  CLAWEE_DESKTOP_TARGET_PLATFORM: platform,
  CLAWEE_DESKTOP_TARGET_ARCH: arch,
  CLAWEE_DESKTOP_CACHE_DIR: cacheDir,
  ELECTRON_CACHE: process.env.ELECTRON_CACHE
    ?? (hasConfiguredCacheDir
      ? resolve(cacheDir, 'electron')
      : defaultElectronCache()),
  ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE
    ?? (hasConfiguredCacheDir
      ? resolve(cacheDir, 'electron-builder')
      : defaultElectronBuilderCache())
};
const releaseContext = prepareReleaseContext({
  mode,
  platform,
  env,
  expectedAppleTeamId
});

mkdirSync(releaseDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
ensureElectronBuilderCacheScope(env.ELECTRON_BUILDER_CACHE);
rmSync(manifestPath, { force: true });
const enterpriseRelease = readEnterpriseGatewayPackageConfig(
  enterpriseGatewayConfigSource,
  mode
);
rmSync(dirname(enterpriseGatewayConfigStage), {
  force: true,
  recursive: true
});
mkdirSync(dirname(enterpriseGatewayConfigStage), { recursive: true });
writeFileSync(
  enterpriseGatewayConfigStage,
  serializeEnterpriseGatewayPackageConfig(enterpriseRelease.gateway)
);
const desktopVersion = JSON.parse(
  readFileSync(join(desktopDir, 'package.json'), 'utf8')
).version;
const officialRelease = isStableReleaseVersion(desktopVersion)
  && process.env.CLAWEE_OFFICIAL_RELEASE === '1'
  && process.env.GITHUB_REPOSITORY === 'krillinai/Clawee'
  && process.env.GITHUB_REF_NAME === `v${desktopVersion}`;
if (officialRelease) {
  writeFileSync(join(dirname(enterpriseGatewayConfigStage), 'official-release.json'), '{"channel":"stable"}\n');
}
console.log(
  `[desktop-package] 企业网关：`
  + `${enterpriseRelease.transportSecurity} ${enterpriseRelease.gateway}`
);

await runStage('构建 Desktop', 'pnpm', ['--filter', '@clawee/desktop', 'build'], {
  cwd: rootDir,
  env,
  timeoutMs: 5 * 60_000
});
await runStage('准备 Codex Runtime', process.execPath, [
  resolve(scriptDir, 'prepare-codex-runtime.mjs')
], {
  cwd: rootDir,
  env,
  timeoutMs: 30 * 60_000
});
const codexRuntimeBuild = await verifyCodexRuntimeDirectory({
  directory: codexRuntimeStage,
  manifest: codexRuntimeManifest,
  target: codexRuntimeTarget
});
const codexRuntimeIntegrity = await inspectDirectory(codexRuntimeStage);
if (
  codexRuntimeIntegrity.fileCount !== codexRuntimeBuild.fileCount
  || codexRuntimeIntegrity.hash !== codexRuntimeBuild.contentSha256
) {
  throw new Error(
    'Codex Runtime directory inspection does not match verification'
  );
}
await runStage('验证 Codex app-server 发布契约', process.execPath, [
  resolve(
    rootDir,
    'scripts/codex-runtime/app-server-release-contract.mjs'
  ),
  `--runtime-dir=${codexRuntimeStage}`
], {
  cwd: rootDir,
  env,
  timeoutMs: 2 * 60_000
});
cpSync(codexRuntimeManifestSource, codexRuntimeManifestStage);
writeFileSync(
  codexRuntimePackageDescriptorStage,
  `${JSON.stringify({
    schemaVersion: 1,
    runtimeId: codexRuntimeManifest.runtimeId,
    codexVersion: codexRuntimeManifest.codexVersion,
    releaseTag: codexRuntimeManifest.releaseTag,
    target: codexRuntimeTarget.targetTriple,
    layoutVersion: codexRuntimeManifest.layoutVersion,
    entrypoint: codexRuntimeBuild.entrypoint,
    fileCount: codexRuntimeBuild.fileCount,
    contentSha256: codexRuntimeBuild.contentSha256,
    archiveSha256: codexRuntimeTarget.archiveSha256
  }, null, 2)}\n`
);
await runStage('准备打包 Daemon 与 Web', process.execPath, [
  resolve(scriptDir, 'prepare-daemon.mjs')
], {
  cwd: rootDir,
  env,
  timeoutMs: 25 * 60_000
});
rmSync(desktopRuntimeDeployStage, { force: true, recursive: true });
await runStage('部署 Desktop 主进程生产依赖', 'pnpm', [
  '--frozen-lockfile',
  '--prefer-offline',
  '--config.ignore-scripts=true',
  '--filter',
  '@clawee/desktop',
  'deploy',
  '--legacy',
  '--prod',
  desktopRuntimeDeployStage
], {
  cwd: rootDir,
  env,
  timeoutMs: 5 * 60_000
});
materializeDesktopRuntimeDependencies();
assertDesktopRuntimeDependencies();
await runStage('准备 Electron Runtime 与许可文件', process.execPath, [
  resolve(desktopDir, 'node_modules/electron/install.js')
], {
  cwd: desktopDir,
  env: {
    ...env,
    ELECTRON_INSTALL_PLATFORM: platform,
    ELECTRON_INSTALL_ARCH: arch,
    electron_config_cache: env.ELECTRON_CACHE
  },
  timeoutMs: 20 * 60_000
});
const candidates = packageRootCandidates(platform, arch);
for (const path of candidates) rmSync(path, { recursive: true, force: true });

const packageStartedAt = Date.now();
const { args, builderEnv } = electronBuilderArguments(mode, platform, arch, env);
await runStage(
  mode === 'dir' ? '生成可运行目录' : '生成桌面安装包',
  'electron-builder',
  args,
  {
    cwd: desktopDir,
    env: builderEnv,
    timeoutMs: mode === 'dir' ? 20 * 60_000 : 50 * 60_000
  }
);

const packageRoot = findFreshPackageRoot(candidates);
const artifacts = findFreshArtifacts(packageStartedAt, mode);
if (releaseContext.distributableMac) {
  finalizeReleaseDmgArtifacts(
    artifacts.filter(path => path.endsWith('.dmg')),
    releaseContext.notarytoolCredentialArgs
  );
}
if (releaseContext.distributableWindows) {
  finalizeReleaseWindowsArtifacts(artifacts.filter(path => path.endsWith('.exe')));
}
if (mode !== 'dir') refreshUpdateMetadata(artifacts);
const webBuild = await inspectDirectory(resolve(rootDir, 'apps/web/dist'));
const manifest = {
  version: 2,
  commit: gitOutput(['rev-parse', 'HEAD']) || 'unknown',
  dirty: gitOutput(['status', '--porcelain', '--untracked-files=all']).length > 0,
  generatedAt: new Date().toISOString(),
  platform,
  arch,
  mode,
  releaseVersion: desktopVersion,
  releaseChannel: isStableReleaseVersion(desktopVersion)
    ? 'stable'
    : 'prerelease',
  officialRelease,
  enterpriseOrigin: enterpriseRelease.gateway,
  enterpriseTransportSecurity: enterpriseRelease.transportSecurity,
  enterpriseGatewayConfigHash: createHash('sha256')
    .update(readFileSync(enterpriseGatewayConfigStage))
    .digest('hex'),
  packageRoot,
  packageRootRelative: relative(rootDir, packageRoot),
  webBuildHash: webBuild.hash,
  webFileCount: webBuild.fileCount,
  codexRuntimeId: codexRuntimeManifest.runtimeId,
  codexRuntimeVersion: codexRuntimeManifest.codexVersion,
  codexRuntimeReleaseTag: codexRuntimeManifest.releaseTag,
  codexRuntimeTarget: codexRuntimeTarget.targetTriple,
  codexRuntimeLayoutVersion: codexRuntimeManifest.layoutVersion,
  codexRuntimeEntrypoint: codexRuntimeBuild.entrypoint,
  codexRuntimeFileCount: codexRuntimeBuild.fileCount,
  codexRuntimeContentSha256: codexRuntimeBuild.contentSha256,
  codexRuntimeArchiveSha256: codexRuntimeTarget.archiveSha256,
  artifacts: artifacts.map(path => ({
    path,
    relativePath: relative(rootDir, path),
    bytes: statSync(path).size,
    sha256: hashFile(path)
  }))
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[desktop-package] 构建清单：${manifestPath}`);
console.log(`[desktop-package] 包根目录：${packageRoot}`);
if (process.env.GITHUB_ENV) {
  appendFileSync(
    process.env.GITHUB_ENV,
    `CLAWEE_DESKTOP_BUILD_MANIFEST=${manifestPath}\n`
    + `CLAWEE_DESKTOP_PACKAGE_ROOT=${packageRoot}\n`
  );
}

await runStage('验证桌面包', process.execPath, [
  resolve(scriptDir, 'verify-package.mjs')
], {
  cwd: rootDir,
  env: {
    ...builderEnv,
    CLAWEE_DESKTOP_BUILD_MANIFEST: manifestPath,
    CLAWEE_DESKTOP_PACKAGE_ROOT: packageRoot,
    ...(releaseContext.distributableMac
      ? {
          CLAWEE_REQUIRE_DISTRIBUTABLE_MAC: '1',
          CLAWEE_APPLE_TEAM_ID: expectedAppleTeamId
        }
      : {}),
    ...(releaseContext.distributableWindows
      ? { CLAWEE_REQUIRE_DISTRIBUTABLE_WINDOWS: '1' }
      : {})
  },
  timeoutMs: 5 * 60_000
});
for (const artifact of manifest.artifacts) {
  console.log(
    `[desktop-package] 产物：${artifact.path} `
    + `sha256=${artifact.sha256}`
  );
}

function parseMode(args) {
  if (args.includes('--dir')) return 'dir';
  if (args.includes('--dist')) return 'dist';
  if (args.includes('--release') || args.length === 0) return 'release';
  throw new Error(`Unsupported Desktop package mode: ${args.join(' ')}`);
}

function electronBuilderArguments(packageMode, targetPlatform, targetArch, baseEnv) {
  const args = ['--publish', 'never'];
  const nextEnv = { ...baseEnv };
  if (packageMode === 'dir') {
    args.push('--dir', platformFlag(targetPlatform), `--${targetArch}`);
    disableImplicitMacSigning(targetPlatform, nextEnv, args);
  } else if (targetPlatform === 'darwin') {
    args.push('--mac', 'dmg', 'zip', `--${targetArch}`);
    args.push(`--config.publish.channel=${targetArch === 'arm64' ? 'latest-arm64' : 'latest'}`);
    if (packageMode !== 'release') {
      disableImplicitMacSigning(targetPlatform, nextEnv, args);
    }
  } else if (targetPlatform === 'win32') {
    args.push('--win', 'nsis', `--${targetArch}`);
    if (hasValue(nextEnv.WIN_CSC_LINK)) {
      nextEnv.CSC_LINK = nextEnv.WIN_CSC_LINK;
      nextEnv.CSC_KEY_PASSWORD = nextEnv.WIN_CSC_KEY_PASSWORD;
    }
    if (!hasValue(nextEnv.CSC_LINK)) {
      nextEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    }
  } else if (packageMode === 'dist') {
    args.push('--linux', `--${targetArch}`);
  } else {
    throw new Error(`Release artifacts are unsupported on ${targetPlatform}`);
  }
  const installedElectronDist = resolve(
    desktopDir,
    'node_modules',
    'electron',
    'dist'
  );
  if (
    targetPlatform === process.platform
    && targetArch === process.arch
    && existsSync(installedElectronDist)
  ) {
    args.push(`--config.electronDist=${installedElectronDist}`);
  }
  return { args, builderEnv: nextEnv };
}

function disableImplicitMacSigning(targetPlatform, targetEnv, args) {
  if (
    targetPlatform !== 'darwin'
    || hasValue(targetEnv.CSC_LINK)
    || hasValue(targetEnv.CSC_NAME)
  ) {
    return;
  }
  targetEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  args.push('--config.mac.notarize=false');
}

function platformFlag(targetPlatform) {
  if (targetPlatform === 'darwin') return '--mac';
  if (targetPlatform === 'win32') return '--win';
  return '--linux';
}

function packageRootCandidates(targetPlatform, targetArch) {
  if (targetPlatform === 'darwin') {
    return [
      join(releaseDir, `mac-${targetArch}`, 'Clawee.app'),
      join(releaseDir, 'mac', 'Clawee.app')
    ];
  }
  if (targetPlatform === 'win32') {
    return [join(releaseDir, 'win-unpacked')];
  }
  return [join(releaseDir, 'linux-unpacked')];
}

function findFreshPackageRoot(candidates) {
  const matches = candidates.filter(existsSync);
  if (matches.length !== 1) {
    throw new Error(
      `Desktop package root is ambiguous or missing: ${JSON.stringify(matches)}`
    );
  }
  return resolve(matches[0]);
}

function findFreshArtifacts(startedAt, packageMode) {
  if (packageMode === 'dir') return [];
  return collectUpdateArtifacts(releaseDir, startedAt, platform);
}

function materializeDesktopRuntimeDependencies() {
  const sourceRoot = resolve(
    desktopRuntimeDeployStage,
    'node_modules',
    '.pnpm',
    'node_modules'
  );
  const targetRoot = resolve(desktopRuntimeStage, 'node_modules');
  rmSync(desktopRuntimeStage, { force: true, recursive: true });
  mkdirSync(targetRoot, { recursive: true });

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue;
    const source = resolve(sourceRoot, entry.name);
    if (entry.name === '@clawee') {
      const protocolSource = resolve(source, 'protocol');
      if (existsSync(protocolSource)) {
        const scopeTarget = resolve(targetRoot, entry.name);
        mkdirSync(scopeTarget, { recursive: true });
        copyDesktopRuntimeDependency(
          protocolSource,
          resolve(scopeTarget, 'protocol')
        );
      }
      continue;
    }
    if (!entry.name.startsWith('@')) {
      copyDesktopRuntimeDependency(source, resolve(targetRoot, entry.name));
      continue;
    }
    const scopeTarget = resolve(targetRoot, entry.name);
    mkdirSync(scopeTarget, { recursive: true });
    for (const scopedEntry of readdirSync(source, { withFileTypes: true })) {
      copyDesktopRuntimeDependency(
        resolve(source, scopedEntry.name),
        resolve(scopeTarget, scopedEntry.name)
      );
    }
  }
  assertNoSymbolicLinks(targetRoot);
}

function copyDesktopRuntimeDependency(source, target) {
  cpSync(source, target, {
    dereference: true,
    preserveTimestamps: true,
    recursive: true
  });
}

function assertNoSymbolicLinks(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Desktop runtime dependency contains a symbolic link: ${path}`
      );
    }
    if (entry.isDirectory()) assertNoSymbolicLinks(path);
  }
}

function assertDesktopRuntimeDependencies() {
  for (const relativePath of [
    'node_modules/@clawee/protocol/dist/index.js',
    'node_modules/@iarna/toml/package.json',
    'node_modules/electron-updater/package.json'
  ]) {
    const path = resolve(desktopRuntimeStage, relativePath);
    if (!existsSync(path)) {
      throw new Error(
        `Desktop runtime dependency deployment is missing: ${path}`
      );
    }
  }
}

function prepareReleaseContext(input) {
  assertReleaseTagMatchesVersion();
  if (input.mode !== 'release') {
    return {
      distributableMac: false,
      distributableWindows: false
    };
  }
  assertFormalReleasePlatform(input.platform);
  const dirty = gitOutput(['status', '--porcelain', '--untracked-files=all']);
  if (dirty.length > 0) {
    throw new Error(
      'Formal Desktop release requires a clean Git worktree. '
      + 'Commit or remove local changes before packaging.'
    );
  }
  if (input.platform === 'win32') {
    assertWindowsSigningConfigured(input.env);
    input.env.CLAWEE_REQUIRE_DISTRIBUTABLE_WINDOWS = '1';
    return {
      distributableMac: false,
      distributableWindows: true
    };
  }
  assertMacSigningConfigured(input.env, input.expectedAppleTeamId);
  const notarytoolCredentialArgs = configureMacNotarization(
    input.env,
    input.expectedAppleTeamId
  );
  input.env.CLAWEE_REQUIRE_DISTRIBUTABLE_MAC = '1';
  input.env.CLAWEE_APPLE_TEAM_ID = input.expectedAppleTeamId;
  return {
    distributableMac: true,
    distributableWindows: false,
    notarytoolCredentialArgs
  };
}

function assertReleaseTagMatchesVersion() {
  const refName = process.env.GITHUB_REF_NAME?.trim();
  if (!refName || !refName.startsWith('v')) return;
  const desktopPackage = JSON.parse(
    readFileSync(join(desktopDir, 'package.json'), 'utf8')
  );
  const expectedTag = desktopReleaseTag(desktopPackage.version);
  if (refName !== expectedTag) {
    throw new Error(
      `Desktop release tag ${refName} does not match package version `
      + `${desktopPackage.version}; expected ${expectedTag}`
    );
  }
}

function assertMacSigningConfigured(targetEnv, teamId) {
  if (hasValue(targetEnv.CSC_LINK)) {
    if (
      hasValue(targetEnv.APPLE_TEAM_ID)
      && targetEnv.APPLE_TEAM_ID.trim() !== teamId
    ) {
      throw new Error(
        `APPLE_TEAM_ID ${targetEnv.APPLE_TEAM_ID.trim()} does not match `
        + `the Clawee release Team ID ${teamId}`
      );
    }
    return;
  }
  const identities = spawnSync('security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning'
  ], {
    encoding: 'utf8',
    timeout: 30_000
  });
  if (
    identities.status !== 0
    || !identities.stdout.includes('Developer ID Application:')
    || !identities.stdout.includes(`(${teamId})`)
  ) {
    throw new Error(
      `Missing Developer ID Application identity for Team ${teamId}. `
      + 'Import the certificate and private key or configure CSC_LINK.'
    );
  }
}

function configureMacNotarization(targetEnv, teamId) {
  const passwordCredentials = [
    targetEnv.APPLE_ID,
    targetEnv.APPLE_APP_SPECIFIC_PASSWORD,
    targetEnv.APPLE_TEAM_ID
  ];
  const apiKeyCredentials = [
    targetEnv.APPLE_API_KEY,
    targetEnv.APPLE_API_KEY_ID,
    targetEnv.APPLE_API_ISSUER
  ];
  if (passwordCredentials.some(hasValue)) {
    if (!passwordCredentials.every(hasValue)) {
      throw new Error(
        'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID '
        + 'must be configured together'
      );
    }
    if (targetEnv.APPLE_TEAM_ID.trim() !== teamId) {
      throw new Error(
        `APPLE_TEAM_ID ${targetEnv.APPLE_TEAM_ID.trim()} does not match `
        + `the Clawee release Team ID ${teamId}`
      );
    }
    return [
      '--apple-id',
      targetEnv.APPLE_ID.trim(),
      '--password',
      targetEnv.APPLE_APP_SPECIFIC_PASSWORD.trim(),
      '--team-id',
      targetEnv.APPLE_TEAM_ID.trim()
    ];
  }
  if (apiKeyCredentials.some(hasValue)) {
    if (!apiKeyCredentials.every(hasValue)) {
      throw new Error(
        'APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER '
        + 'must be configured together'
      );
    }
    return [
      '--key',
      targetEnv.APPLE_API_KEY.trim(),
      '--key-id',
      targetEnv.APPLE_API_KEY_ID.trim(),
      '--issuer',
      targetEnv.APPLE_API_ISSUER.trim()
    ];
  }
  const profile = targetEnv.APPLE_KEYCHAIN_PROFILE?.trim()
    || defaultNotaryKeychainProfile;
  validateNotaryKeychainProfile(profile, targetEnv.APPLE_KEYCHAIN);
  targetEnv.APPLE_KEYCHAIN_PROFILE = profile;
  return [
    '--keychain-profile',
    profile,
    ...(hasValue(targetEnv.APPLE_KEYCHAIN)
      ? ['--keychain', targetEnv.APPLE_KEYCHAIN.trim()]
      : [])
  ];
}

function validateNotaryKeychainProfile(profile, keychain) {
  const args = [
    'notarytool',
    'history',
    '--keychain-profile',
    profile,
    '--output-format',
    'json'
  ];
  if (hasValue(keychain)) args.push('--keychain', keychain.trim());
  const result = spawnSync('xcrun', args, {
    encoding: 'utf8',
    timeout: 60_000
  });
  if (result.status !== 0) {
    throw new Error(
      `Apple notarization Keychain profile "${profile}" is unavailable or `
      + 'invalid. Run pnpm desktop:notary:setup -- <APPLE_ID> first.'
    );
  }
}

function finalizeReleaseDmgArtifacts(artifacts, notarytoolCredentialArgs) {
  for (const artifact of artifacts) {
    runVerificationCommand(
      'DMG filesystem',
      'hdiutil',
      ['verify', artifact]
    );
    runVerificationCommand(
      'DMG code signature',
      'codesign',
      ['--verify', '--verbose=4', artifact]
    );
    runVerificationCommand(
      'DMG notarization',
      'xcrun',
      [
        'notarytool',
        'submit',
        artifact,
        ...notarytoolCredentialArgs,
        '--wait',
        '--output-format',
        'json'
      ],
      30 * 60_000
    );
    runVerificationCommand(
      'DMG notarization ticket staple',
      'xcrun',
      ['stapler', 'staple', artifact],
      5 * 60_000
    );
    runVerificationCommand(
      'DMG notarization ticket',
      'xcrun',
      ['stapler', 'validate', artifact]
    );
    runVerificationCommand(
      'DMG Gatekeeper assessment',
      'spctl',
      [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose=4',
        artifact
      ]
    );
  }
}

function finalizeReleaseWindowsArtifacts(artifacts) {
  for (const artifact of artifacts) {
    runWindowsSignatureVerification(
      'Windows installer Authenticode signature',
      artifact
    );
  }
}

function runWindowsSignatureVerification(label, path) {
  runVerificationCommand(
    label,
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsSignatureVerificationCommand(label, path)
    ]
  );
}

function runVerificationCommand(
  label,
  command,
  args,
  timeoutMs = 2 * 60_000
) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...(command.toLowerCase().endsWith('powershell.exe')
      ? { env: windowsPowerShellEnvironment() }
      : {}),
    timeout: timeoutMs
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} verification failed: ${result.stderr || result.stdout}`
    );
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 10_000
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function defaultElectronCache() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'electron');
  }
  if (process.platform === 'win32') {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      'electron',
      'Cache'
    );
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'electron');
}

function defaultElectronBuilderCache() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'electron-builder');
  }
  if (process.platform === 'win32') {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      'electron-builder',
      'Cache'
    );
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'electron-builder'
  );
}

if (!isAbsolute(manifestPath)) {
  throw new Error('Desktop build manifest path must be absolute');
}
