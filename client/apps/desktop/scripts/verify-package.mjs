import {
  extractFile,
  listPackage
} from '@electron/asar';
import electronFuses from '@electron/fuses';

const {
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire
} = electronFuses;
const FUSE_DISABLED = '0'.charCodeAt(0);
const FUSE_ENABLED = '1'.charCodeAt(0);
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readEnterpriseGatewayPackageConfig
} from './enterprise-package-contract-2026-07-30.mjs';
import {
  assertCodexRuntimePackage
} from './codex-runtime-package-contract.mjs';
import {
  verifyCodexRuntimeDirectory
} from './codex-runtime-assets.mjs';
import {
  findDirectoryDifference,
  inspectDirectory
} from './directory-integrity.mjs';
import {
  windowsPowerShellEnvironment,
  windowsSignatureVerificationCommand
} from './release-platform.mjs';
import {
  readCodexRuntimeManifest,
  resolveCodexRuntimeTarget
} from '../../../scripts/codex-runtime/manifest.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const manifestPath = resolve(
  process.env.CLAWEE_DESKTOP_BUILD_MANIFEST
    ?? join(desktopDir, 'release', 'clawee-desktop-build-manifest.json')
);
const manifest = readBuildManifest(manifestPath);
const targetArch = process.env.CLAWEE_DESKTOP_TARGET_ARCH
  ?? manifest.arch
  ?? process.arch;
const targetPlatform = process.env.CLAWEE_DESKTOP_TARGET_PLATFORM
  ?? manifest.platform
  ?? process.platform;
const packageRoot = process.env.CLAWEE_DESKTOP_PACKAGE_ROOT
  ? resolve(process.env.CLAWEE_DESKTOP_PACKAGE_ROOT)
  : resolve(manifest.packageRoot);
const resourcesDir = platformResourcesDir(packageRoot);
for (const license of [
  'licenses/clawee/LICENSE',
  'licenses/clawee/NOTICE',
  'licenses/electron/LICENSE',
  'licenses/electron/LICENSES.chromium.html',
  'licenses/third_party/runtime/codex-LICENSE',
  'licenses/third_party/runtime/codex-NOTICE',
  'licenses/third_party/runtime/ripgrep-LICENSE-MIT',
  'licenses/third_party/generated/client-NOTICES.txt'
]) assertExists(join(resourcesDir, license));
const appAsar = join(resourcesDir, 'app.asar');
const daemonDir = join(resourcesDir, 'daemon');
const webDir = join(resourcesDir, 'web');
const codexRuntimeDir = join(resourcesDir, 'codex-runtime');
const enterpriseGatewayConfigFilename = 'config.toml';
const enterpriseGatewayConfigPath = join(
  resourcesDir,
  'deployment',
  enterpriseGatewayConfigFilename
);
const sourceWebDir = resolve(desktopDir, '../web/dist');
const sourceCodexRuntimeDir = resolve(desktopDir, '.pack/codex-runtime');
const packagedCodexRuntimeManifestPath = join(
  resourcesDir,
  'deployment',
  'codex-runtime.json'
);
const packagedCodexRuntimeDescriptorPath = join(
  resourcesDir,
  'deployment',
  'codex-runtime-package.json'
);
const executable = packagedExecutable(packageRoot);
const codexRuntimeManifest = readCodexRuntimeManifest(resolve(
  desktopDir,
  '../..',
  'config',
  'codex-runtime.json'
));
const codexRuntimeTarget = resolveCodexRuntimeTarget(codexRuntimeManifest, {
  platform: targetPlatform,
  arch: targetArch
});

assertExists(packageRoot);
assertExists(executable);
assertExists(appAsar);
assertExists(join(daemonDir, 'dist', 'main.js'));
assertExists(join(
  daemonDir,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
));
for (const dependency of ['which', 'path-key', 'shebang-command']) {
  assertExists(join(daemonDir, 'node_modules', dependency, 'package.json'));
}
assertExists(join(
  daemonDir,
  'node_modules',
  '@clawee',
  'protocol',
  'dist',
  'index.js'
));
assertExists(join(webDir, 'index.html'));
assertExists(join(codexRuntimeDir, 'codex-package.json'));
assertExists(packagedCodexRuntimeManifestPath);
assertExists(packagedCodexRuntimeDescriptorPath);
assertExists(enterpriseGatewayConfigPath);
assertExists(join(resourcesDir, 'node_modules', '@iarna', 'toml', 'package.json'));
assertExists(join(
  resourcesDir,
  'node_modules',
  '@clawee',
  'protocol',
  'dist',
  'index.js'
));
assertExists(join(
  resourcesDir,
  'node_modules',
  'electron-updater',
  'package.json'
));
assertAsarContents();
assertBrandingContents();
assertDaemonContents();
assertEnterpriseGatewayConfig();
await assertWebContents();
const codexRuntime = await assertCodexRuntimeContents();
assertNoLocalData();
assertSize('app.asar', appAsar, 80 * 1024 * 1024);
assertSize('Daemon resources', daemonDir, 250 * 1024 * 1024);
assertSize('Desktop package', packageRoot, 1024 * 1024 * 1024);
await assertFuseConfiguration();
verifyMacPackageMetadata();
verifyWindowsPackageMetadata();

console.log(JSON.stringify({
  ok: true,
  packageRoot,
  packageBytes: treeSize(packageRoot),
  daemonBytes: treeSize(daemonDir),
  codexRuntimeBytes: treeSize(codexRuntimeDir),
  codexRuntimeHash: codexRuntime.contentSha256,
  fuses: 'verified',
  privacy: 'verified'
}));

function readBuildManifest(path) {
  if (!existsSync(path)) {
    if (process.env.CLAWEE_DESKTOP_PACKAGE_ROOT) {
      return {};
    }
    throw new Error(
      `Desktop build manifest is missing: ${path}. `
      + 'Run the Desktop package command or set CLAWEE_DESKTOP_PACKAGE_ROOT.'
    );
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (
    parsed === null
    || typeof parsed !== 'object'
    || typeof parsed.packageRoot !== 'string'
  ) {
    throw new Error(`Desktop build manifest is invalid: ${path}`);
  }
  return parsed;
}

function platformResourcesDir(root) {
  return process.platform === 'darwin'
    ? join(root, 'Contents', 'Resources')
    : join(root, 'resources');
}

function packagedExecutable(root) {
  if (process.platform === 'darwin') {
    return join(root, 'Contents', 'MacOS', 'Clawee');
  }
  return join(root, process.platform === 'win32' ? 'Clawee.exe' : 'clawee');
}

function assertAsarContents() {
  const entries = listAsarEntries(appAsar);
  const required = [
    '/dist/main/main.js',
    '/dist/preload/index.cjs',
    '/dist/bootstrap/index.html',
    '/dist/shared/ipc.js'
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) {
      throw new Error(`app.asar is missing required entry: ${entry}`);
    }
  }
  const forbidden = entries.find(entry =>
    entry.startsWith('/dist/mac-')
    || entry.startsWith('/dist/win-')
    || entry === '/src'
    || entry.startsWith('/src/')
    || entry === '/dist/main/codex-resolver.js'
    || entry.endsWith('.map')
  );
  if (forbidden !== undefined) {
    throw new Error(`app.asar contains a development artifact: ${forbidden}`);
  }
}

function assertBrandingContents() {
  const desktopResourcesDir = join(resourcesDir, 'desktop-resources');
  const sourceResourcesDir = resolve(desktopDir, 'resources');
  const packagedIcon = join(desktopResourcesDir, 'icon.png');
  const packagedTray = join(desktopResourcesDir, 'tray.png');
  const sourceIcon = join(sourceResourcesDir, 'icon.png');
  const sourceTray = join(sourceResourcesDir, 'tray.png');
  const sourceBootstrapLogo = resolve(desktopDir, 'src', 'bootstrap', 'logo.png');

  assertSameFile('Desktop icon', packagedIcon, sourceIcon);
  assertSameFile('Desktop tray icon', packagedTray, sourceTray);

  const bootstrapLogoEntry = listAsarEntries(appAsar).find(entry =>
    /^\/dist\/bootstrap\/assets\/logo-[^/]+\.png$/.test(entry)
  );
  if (bootstrapLogoEntry === undefined) {
    throw new Error('app.asar is missing the Desktop bootstrap logo');
  }
  const packagedBootstrapLogo = extractFile(
    appAsar,
    bootstrapLogoEntry.slice(1).replaceAll('/', sep)
  );
  const sourceBootstrapLogoHash = hashBuffer(readFileSync(sourceBootstrapLogo));
  if (hashBuffer(packagedBootstrapLogo) !== sourceBootstrapLogoHash) {
    throw new Error('Packaged Desktop bootstrap logo differs from its source asset');
  }

  if (process.platform === 'darwin') {
    assertExists(join(resourcesDir, 'icon.icns'));
  }
}

function listAsarEntries(path) {
  return listPackage(path).map(entry => entry.replaceAll('\\', '/'));
}

function assertDaemonContents() {
  const forbiddenTopLevelNames = new Set([
    '.runtime',
    '.pnpm',
    'src',
    'test',
    'tests',
    'tsconfig.json',
    'vitest.config.ts'
  ]);
  for (const name of forbiddenTopLevelNames) {
    const path = join(daemonDir, name);
    if (existsSync(path)) {
      throw new Error(`Daemon resources contain a development artifact: ${path}`);
    }
  }
  const napiPackagesRoot = join(daemonDir, 'node_modules', '@napi-rs');
  if (existsSync(napiPackagesRoot)) {
    const keyringPackage = readdirSync(napiPackagesRoot).find(name =>
      name === 'keyring' || name.startsWith('keyring-')
    );
    if (keyringPackage !== undefined) {
      throw new Error(
        `Daemon resources must not contain a Keyring package: ${keyringPackage}`
      );
    }
  }
  walk(daemonDir, path => {
    const name = basename(path);
    if (name.endsWith('.map') || name.endsWith('.d.ts')) {
      throw new Error(`Daemon resources contain a development artifact: ${path}`);
    }
  });
}

function assertEnterpriseGatewayConfig() {
  const config = readEnterpriseGatewayPackageConfig(
    enterpriseGatewayConfigPath,
    manifest.mode ?? 'dir'
  );
  if (typeof manifest.packageRoot !== 'string') return;
  const configHash = hashBuffer(readFileSync(enterpriseGatewayConfigPath));
  if (
    manifest.enterpriseOrigin !== config.gateway
    || manifest.enterpriseTransportSecurity !== config.transportSecurity
    || manifest.enterpriseGatewayConfigHash !== configHash
  ) {
    throw new Error(
      'Packaged enterprise gateway configuration does not match the build manifest'
    );
  }
}

function assertSameFile(label, left, right) {
  assertExists(left);
  assertExists(right);
  if (hashBuffer(readFileSync(left)) !== hashBuffer(readFileSync(right))) {
    throw new Error(`${label} differs between the package and source resources`);
  }
}

function hashBuffer(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function assertWebContents() {
  assertExists(sourceWebDir);
  const source = await inspectDirectory(sourceWebDir);
  const packaged = await inspectDirectory(webDir);
  const difference = findDirectoryDifference(source, packaged);

  if (difference !== undefined) {
    throw new Error(
      `Packaged Web differs from apps/web/dist at: `
      + `${difference.path} (${difference.kind})`
    );
  }
  if (source.hash !== packaged.hash) {
    throw new Error(
      `Packaged Web contents differ from apps/web/dist: `
      + `${packaged.hash} !== ${source.hash}`
    );
  }
  if (typeof manifest.packageRoot === 'string') {
    if (
      manifest.webBuildHash !== source.hash
      || manifest.webFileCount !== source.fileCount
    ) {
      throw new Error(
        'Desktop build manifest Web hash does not match apps/web/dist'
      );
    }
  }
}

async function assertCodexRuntimeContents() {
  assertExists(sourceCodexRuntimeDir);
  const packagedVerification = await verifyCodexRuntimeDirectory({
    directory: codexRuntimeDir,
    manifest: codexRuntimeManifest,
    target: codexRuntimeTarget
  });
  const packageContract = await assertCodexRuntimePackage({
    sourceDirectory: sourceCodexRuntimeDir,
    packagedDirectory: codexRuntimeDir,
    buildManifest: manifest,
    runtimeManifest: codexRuntimeManifest,
    target: codexRuntimeTarget,
    platform: targetPlatform
  });
  if (
    packagedVerification.contentSha256 !== packageContract.contentSha256
    || packagedVerification.fileCount !== packageContract.fileCount
  ) {
    throw new Error(
      'Packaged Codex Runtime verification does not match its package contract'
    );
  }
  const sourceManifestPath = resolve(
    desktopDir,
    '../..',
    'config',
    'codex-runtime.json'
  );
  if (
    !readFileSync(sourceManifestPath).equals(
      readFileSync(packagedCodexRuntimeManifestPath)
    )
  ) {
    throw new Error(
      'Packaged Codex Runtime manifest differs from config/codex-runtime.json'
    );
  }
  const packagedDescriptor = JSON.parse(
    readFileSync(packagedCodexRuntimeDescriptorPath, 'utf8')
  );
  const expectedDescriptor = {
    schemaVersion: 1,
    runtimeId: codexRuntimeManifest.runtimeId,
    codexVersion: codexRuntimeManifest.codexVersion,
    releaseTag: codexRuntimeManifest.releaseTag,
    target: codexRuntimeTarget.targetTriple,
    layoutVersion: codexRuntimeManifest.layoutVersion,
    entrypoint: packagedVerification.entrypoint,
    fileCount: packagedVerification.fileCount,
    contentSha256: packagedVerification.contentSha256,
    archiveSha256: codexRuntimeTarget.archiveSha256
  };
  if (
    JSON.stringify(packagedDescriptor)
    !== JSON.stringify(expectedDescriptor)
  ) {
    throw new Error(
      'Packaged Codex Runtime descriptor does not match verified contents'
    );
  }
  return packageContract;
}

function assertNoLocalData() {
  const forbiddenFragments = [
    homedir(),
    process.env.HOME,
    process.env.USERPROFILE,
    '~/develop/clawee/',
    '~/develop/content-design',
    'content-design',
    'Playground'
  ].filter(value => typeof value === 'string' && value.length > 1);
  const scanPaths = [
    appAsar,
    ...textFiles(webDir),
    ...textFiles(join(daemonDir, 'dist'))
  ];

  for (const path of scanPaths) {
    const contents = readFileSync(path);
    for (const fragment of new Set(forbiddenFragments)) {
      if (contents.includes(Buffer.from(fragment))) {
        throw new Error(
          `Desktop package contains local build data in ${path}: ${fragment}`
        );
      }
    }
  }
}

function textFiles(root) {
  const paths = [];
  walk(root, path => {
    if (!statSync(path).isFile()) return;
    const name = basename(path).toLowerCase();
    if (
      name.endsWith('.js')
      || name.endsWith('.mjs')
      || name.endsWith('.cjs')
      || name.endsWith('.json')
      || name.endsWith('.html')
      || name.endsWith('.css')
    ) {
      paths.push(path);
    }
  });
  return paths;
}

async function assertFuseConfiguration() {
  const wire = await getCurrentFuseWire(executable);
  if (wire.version !== FuseVersion.V1) {
    throw new Error(`Unsupported Electron fuse wire version: ${wire.version}`);
  }
  const expected = [
    [FuseV1Options.RunAsNode, FUSE_DISABLED, 'RunAsNode'],
    [FuseV1Options.EnableCookieEncryption, FUSE_ENABLED, 'CookieEncryption'],
    [
      FuseV1Options.EnableNodeOptionsEnvironmentVariable,
      FUSE_DISABLED,
      'NodeOptionsEnvironmentVariable'
    ],
    [
      FuseV1Options.EnableNodeCliInspectArguments,
      FUSE_DISABLED,
      'NodeCliInspectArguments'
    ],
    [
      FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
      FUSE_ENABLED,
      'EmbeddedAsarIntegrityValidation'
    ],
    [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED, 'OnlyLoadAppFromAsar']
  ];
  for (const [index, expectedState, label] of expected) {
    if (wire[index] !== expectedState) {
      throw new Error(
        `Electron fuse ${label} has state ${wire[index]}, expected ${expectedState}`
      );
    }
  }
}

function verifyMacPackageMetadata() {
  if (process.platform !== 'darwin') return;
  const signature = spawnSync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    packageRoot
  ], {
    encoding: 'utf8',
    timeout: 30_000
  });
  if (signature.status !== 0) {
    throw new Error(
      `Packaged macOS code signature is invalid: `
      + `${signature.stderr || signature.stdout}`
    );
  }
  if (process.env.CLAWEE_REQUIRE_DISTRIBUTABLE_MAC === '1') {
    verifyDistributableMacSignature();
    runMacVerification(
      'macOS notarization ticket',
      'xcrun',
      ['stapler', 'validate', packageRoot]
    );
    runMacVerification(
      'macOS Gatekeeper assessment',
      'spctl',
      ['--assess', '--type', 'execute', '--verbose=4', packageRoot]
    );
  }
  const plist = spawnSync('plutil', [
    '-extract',
    'ElectronAsarIntegrity',
    'json',
    '-o',
    '-',
    join(packageRoot, 'Contents', 'Info.plist')
  ], {
    encoding: 'utf8',
    timeout: 30_000
  });
  if (plist.status !== 0) {
    throw new Error(
      `Packaged ASAR integrity metadata is missing: ${plist.stderr || plist.stdout}`
    );
  }
  const integrity = JSON.parse(plist.stdout);
  if (
    integrity?.['Resources/app.asar']?.algorithm !== 'SHA256'
    || typeof integrity?.['Resources/app.asar']?.hash !== 'string'
  ) {
    throw new Error('Packaged app.asar integrity metadata is invalid');
  }
}

function verifyDistributableMacSignature() {
  const details = spawnSync('codesign', [
    '--display',
    '--verbose=4',
    packageRoot
  ], {
    encoding: 'utf8',
    timeout: 30_000
  });
  if (details.status !== 0) {
    throw new Error(
      `Unable to inspect packaged macOS signature: `
      + `${details.stderr || details.stdout}`
    );
  }
  const output = `${details.stdout}\n${details.stderr}`;
  const expectedTeamId = process.env.CLAWEE_APPLE_TEAM_ID?.trim();
  if (
    !output.includes('Authority=Developer ID Application:')
    || !output.includes('Timestamp=')
    || (
      expectedTeamId
      && !output.includes(`TeamIdentifier=${expectedTeamId}`)
    )
  ) {
    throw new Error(
      'Packaged macOS app is not signed with the expected timestamped '
      + `Developer ID identity for Team ${expectedTeamId ?? '<unspecified>'}`
    );
  }
}

function verifyWindowsPackageMetadata() {
  if (
    process.platform !== 'win32'
    || process.env.CLAWEE_REQUIRE_DISTRIBUTABLE_WINDOWS !== '1'
  ) {
    return;
  }
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    windowsSignatureVerificationCommand(
      'Packaged Windows signature',
      executable
    )
  ], {
    encoding: 'utf8',
    env: windowsPowerShellEnvironment(),
    timeout: 2 * 60_000
  });
  if (result.status !== 0) {
    throw new Error(
      `Packaged Windows code signature is invalid: `
      + `${result.stderr || result.stdout}`
    );
  }
}

function runMacVerification(label, command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 2 * 60_000
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.stderr || result.stdout}`
    );
  }
}

function assertExists(path) {
  if (!existsSync(path)) throw new Error(`Desktop package is missing: ${path}`);
}

function assertSize(label, path, maxBytes) {
  const bytes = statSync(path).isDirectory() ? treeSize(path) : statSync(path).size;
  if (bytes > maxBytes) {
    throw new Error(`${label} is unexpectedly large: ${bytes} bytes`);
  }
}

function treeSize(root) {
  let total = 0;
  walk(root, path => {
    const stat = statSync(path);
    if (stat.isFile()) total += stat.size;
  });
  return total;
}

function walk(root, visitor) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink() && !existsSync(path)) {
      throw new Error(`Desktop package contains a broken symbolic link: ${path}`);
    }
    visitor(path);
    if (entry.isDirectory()) walk(path, visitor);
  }
}
