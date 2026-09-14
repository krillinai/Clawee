import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseReleaseVersion,
  repositoryRoot,
  resolveProductVersion
} from './version.mjs';

export { parseReleaseVersion, resolveProductVersion } from './version.mjs';

export function assertReleaseSupportsBundledRuntime(releaseVersion, minimumClaweeVersion) {
  parseReleaseVersion(releaseVersion);
  parseReleaseVersion(minimumClaweeVersion);
  if (compareSemanticVersions(releaseVersion, minimumClaweeVersion) < 0) {
    throw new Error(
      `Release version ${releaseVersion} is below bundled Runtime minimum `
      + `Clawee version ${minimumClaweeVersion}`
    );
  }
}

export function inspectReleaseVersion(root = repositoryRoot, options = {}) {
  const release = resolveProductVersion({
    root,
    env: options.env ?? process.env,
    tag: options.tag
  });
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
    throw new Error(
      `Release version ${release.version} is inconsistent:\n`
      + `${runtimeManifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return release;
}

export function setReleaseVersion(version, root = repositoryRoot) {
  parseReleaseVersion(version);
  inspectReleaseVersion(root, { env: { CLAWEE_VERSION: version } });
  const path = resolve(root, 'VERSION');
  const current = existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
  if (current === version) return [];
  writeFileSync(path, `${version}\n`);
  return ['VERSION'];
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
  const length = Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftParts.prerelease[index];
    const rightIdentifier = rightParts.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftIdentifier) - Number(rightIdentifier));
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function splitSemanticVersion(version) {
  const separatorIndex = version.indexOf('-');
  const core = separatorIndex === -1 ? version : version.slice(0, separatorIndex);
  const prerelease = separatorIndex === -1 ? '' : version.slice(separatorIndex + 1);
  return {
    core: core.split('.').map(Number),
    prerelease: prerelease === '' ? [] : prerelease.split('.')
  };
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
      '  node scripts/release-version.mjs set <version> (writes VERSION only)'
    ].join('\n'));
    return;
  }
  if (command === 'set') {
    const version = args.find(argument => argument !== '--');
    if (version === undefined) throw new Error('Release version is required');
    const changed = setReleaseVersion(version);
    console.log(changed.length === 0
      ? `Release version is already ${version}`
      : `Release version updated to ${version}:\n${changed.join('\n')}`);
    return;
  }
  if (command !== 'check') throw new Error(`Unsupported release-version command: ${command}`);
  const requestedTag = readOption(args, '--tag');
  const release = requestedTag === undefined
    ? inspectReleaseVersion()
    : inspectReleaseVersion(repositoryRoot, { tag: requestedTag });
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
