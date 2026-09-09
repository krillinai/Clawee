import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const releasePackagePaths = [
  'package.json',
  'client/package.json',
  'client/apps/daemon/package.json',
  'client/apps/desktop/package.json',
  'client/apps/harness/package.json',
  'client/apps/web/package.json',
  'client/packages/protocol/package.json',
  'client/packages/skill-market/package.json',
  'server/web/package.json'
];

const releaseTextTargets = [
  {
    path: 'deploy/docker-compose.yml',
    pattern: /(CLAWEE_VERSION:-)[^}]+/,
    replacement: version => (_match, prefix) => `${prefix}${version}`
  },
  {
    path: 'server/Dockerfile',
    pattern: /(ARG CLAW_MCP_VERSION=)[^\s]+/,
    replacement: version => (_match, prefix) => `${prefix}${version}`
  },
  {
    path: 'server/internal/buildinfo/buildinfo.go',
    pattern: /(Version\s*=\s*")[^"]+(")/,
    replacement: version => (_match, prefix, suffix) => `${prefix}${version}${suffix}`
  },
  {
    path: 'server/scripts/buildinfo-ldflags.sh',
    pattern: /(CLAW_MCP_VERSION:-)[^}]+/,
    replacement: version => (_match, prefix) => `${prefix}${version}`
  }
];

export function parseReleaseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (match === null) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const prerelease = match[4];
  if (
    prerelease?.split('.').some(
      identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')
    )
  ) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return {
    version,
    tag: `v${version}`,
    prerelease: prerelease !== undefined,
    channel: prerelease === undefined ? 'stable' : 'prerelease'
  };
}

export function assertReleaseSupportsBundledRuntime(
  releaseVersion,
  minimumClaweeVersion
) {
  parseReleaseVersion(releaseVersion);
  parseReleaseVersion(minimumClaweeVersion);
  if (compareSemanticVersions(releaseVersion, minimumClaweeVersion) < 0) {
    throw new Error(
      `Release version ${releaseVersion} is below bundled Runtime minimum `
      + `Clawee version ${minimumClaweeVersion}`
    );
  }
}

export function inspectReleaseVersion(root = repositoryRoot) {
  const rootPackage = readPackage(resolve(root, 'package.json'));
  const release = parseReleaseVersion(rootPackage.version);
  const mismatches = [];

  for (const path of releasePackagePaths) {
    const value = readPackage(resolve(root, path)).version;
    if (value !== release.version) {
      mismatches.push(`${path}: ${value}`);
    }
  }
  for (const target of releaseTextTargets) {
    const raw = readFileSync(resolve(root, target.path), 'utf8');
    const match = target.pattern.exec(raw);
    if (match === null || !match[0].includes(release.version)) {
      mismatches.push(`${target.path}: version marker mismatch`);
    }
  }
  const runtimeManifestPath = 'client/config/codex-runtime.json';
  const runtimeManifest = JSON.parse(
    readFileSync(resolve(root, runtimeManifestPath), 'utf8')
  );
  try {
    assertReleaseSupportsBundledRuntime(
      release.version,
      runtimeManifest.minimumClaweeVersion
    );
  } catch (error) {
    mismatches.push(
      `${runtimeManifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Release version ${release.version} is inconsistent:\n${mismatches.join('\n')}`
    );
  }
  return release;
}

export function setReleaseVersion(version, root = repositoryRoot) {
  parseReleaseVersion(version);
  const runtimeManifest = JSON.parse(
    readFileSync(resolve(root, 'client/config/codex-runtime.json'), 'utf8')
  );
  assertReleaseSupportsBundledRuntime(
    version,
    runtimeManifest.minimumClaweeVersion
  );
  const updates = [];

  for (const path of releasePackagePaths) {
    const absolutePath = resolve(root, path);
    const raw = readFileSync(absolutePath, 'utf8');
    const metadata = JSON.parse(raw);
    if (typeof metadata.version !== 'string') {
      throw new Error(`${path} does not define a string version`);
    }
    const next = raw.replace(
      /("version"\s*:\s*")[^"]+(")/,
      `$1${version}$2`
    );
    if (next === raw && metadata.version !== version) {
      throw new Error(`Unable to update version in ${path}`);
    }
    if (next !== raw) {
      updates.push({ absolutePath, path, content: next });
    }
  }

  for (const target of releaseTextTargets) {
    const absolutePath = resolve(root, target.path);
    const raw = readFileSync(absolutePath, 'utf8');
    const next = raw.replace(
      target.pattern,
      target.replacement(version)
    );
    if (next === raw && !target.pattern.test(raw)) {
      throw new Error(`Unable to update version marker in ${target.path}`);
    }
    if (next !== raw) {
      updates.push({
        absolutePath,
        path: target.path,
        content: next
      });
    }
  }

  for (const update of updates) {
    writeFileSync(update.absolutePath, update.content);
  }
  inspectReleaseVersion(root);
  return updates.map(update => update.path);
}

function compareSemanticVersions(left, right) {
  const leftParts = splitSemanticVersion(left);
  const rightParts = splitSemanticVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts.core[index] - rightParts.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  if (leftParts.prerelease.length === 0) {
    return rightParts.prerelease.length === 0 ? 0 : 1;
  }
  if (rightParts.prerelease.length === 0) return -1;
  const length = Math.max(
    leftParts.prerelease.length,
    rightParts.prerelease.length
  );
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftParts.prerelease[index];
    const rightIdentifier = rightParts.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Math.sign(Number(leftIdentifier) - Number(rightIdentifier));
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function splitSemanticVersion(version) {
  const separatorIndex = version.indexOf('-');
  const core = separatorIndex === -1
    ? version
    : version.slice(0, separatorIndex);
  const prerelease = separatorIndex === -1
    ? ''
    : version.slice(separatorIndex + 1);
  return {
    core: core.split('.').map(Number),
    prerelease: prerelease === '' ? [] : prerelease.split('.')
  };
}

function readPackage(path) {
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof metadata.version !== 'string') {
    throw new Error(`Package does not define a string version: ${path}`);
  }
  return metadata;
}

function readOption(args, name) {
  const prefix = `${name}=`;
  const inline = args.find(argument => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function runCli() {
  const [command = 'check', ...args] = process.argv.slice(2);
  if (command === '--help' || args.includes('--help')) {
    console.log([
      'Usage:',
      '  node scripts/release-version.mjs check [--tag v<version>] [--github-output <path>]',
      '  node scripts/release-version.mjs set <version>'
    ].join('\n'));
    return;
  }

  if (command === 'set') {
    const version = args.find(argument => argument !== '--');
    if (version === undefined) throw new Error('Release version is required');
    const changed = setReleaseVersion(version);
    console.log(
      changed.length === 0
        ? `Release version is already ${version}`
        : `Release version updated to ${version}:\n${changed.join('\n')}`
    );
    return;
  }
  if (command !== 'check') {
    throw new Error(`Unsupported release-version command: ${command}`);
  }

  const release = inspectReleaseVersion();
  const requestedTag = readOption(args, '--tag');
  if (requestedTag !== undefined && requestedTag !== release.tag) {
    throw new Error(
      `Release tag ${requestedTag} does not match version ${release.version}; `
      + `expected ${release.tag}`
    );
  }
  const outputPath = readOption(args, '--github-output');
  if (outputPath !== undefined) {
    appendFileSync(outputPath, [
      `version=${release.version}`,
      `tag=${release.tag}`,
      `prerelease=${release.prerelease}`,
      `channel=${release.channel}`
    ].join('\n') + '\n');
  }
  console.log(JSON.stringify(release));
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli();
}
