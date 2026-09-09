import { isAbsolute, resolve } from 'node:path';

const defaultBuildManifestFilename = 'clawee-desktop-build-manifest.json';

export function normalizeDesktopPlatform(value) {
  if (value === 'mac') return 'darwin';
  if (value === 'win') return 'win32';
  if (value === 'linux') return 'linux';
  if (['darwin', 'win32', 'linux'].includes(value)) return value;
  throw new Error(`Unsupported Clawee Desktop platform: ${value}`);
}

export function codexRuntimeTargetTriple(platform, arch) {
  const normalizedPlatform = normalizeDesktopPlatform(platform);
  const target = {
    'darwin/arm64': 'aarch64-apple-darwin',
    'darwin/x64': 'x86_64-apple-darwin',
    'win32/arm64': 'aarch64-pc-windows-msvc',
    'win32/x64': 'x86_64-pc-windows-msvc',
    'linux/arm64': 'aarch64-unknown-linux-musl',
    'linux/x64': 'x86_64-unknown-linux-musl'
  }[`${normalizedPlatform}/${arch}`];
  if (target === undefined) {
    throw new Error(
      `Unsupported Codex Runtime target: ${normalizedPlatform}/${arch}`
    );
  }
  return target;
}

export function installerExtension(platform) {
  if (platform === 'darwin') return '.dmg';
  if (platform === 'win32') return '.exe';
  throw new Error(`Unsupported Desktop artifact platform: ${platform}`);
}

export function assertFormalReleasePlatform(platform) {
  if (!['darwin', 'win32'].includes(platform)) {
    throw new Error(`Formal Desktop releases do not support ${platform}`);
  }
}

export function assertWindowsSigningConfigured(env) {
  if (!hasValue(env.WIN_CSC_LINK) && !hasValue(env.CSC_LINK)) {
    throw new Error(
      'Formal Windows releases require WIN_CSC_LINK or CSC_LINK '
      + 'with an Authenticode code-signing certificate.'
    );
  }
}

export function desktopReleaseTag(version) {
  return `v${version}`;
}

export function isStableReleaseVersion(version) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
}

export function resolveDesktopBuildManifestPath(
  rootDir,
  releaseDir,
  configuredPath
) {
  if (!hasValue(configuredPath)) {
    return resolve(releaseDir, defaultBuildManifestFilename);
  }
  if (isAbsolute(configuredPath)) return resolve(configuredPath);
  return resolve(rootDir, configuredPath);
}

export function windowsSignatureVerificationCommand(label, path) {
  const escapedLabel = label.replaceAll("'", "''");
  const escapedPath = path.replaceAll("'", "''");
  return [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
    "if ($signature.Status -ne 'Valid') {",
    `  Write-Error ('${escapedLabel} is not valid: ' + $signature.StatusMessage)`,
    '  exit 1',
    '}'
  ].join('\n');
}

export function windowsPowerShellEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key.toLowerCase() !== 'psmodulepath'
    )
  );
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
