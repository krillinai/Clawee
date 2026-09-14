import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseReleaseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (match === null) throw new Error(`Invalid release version: ${version}`);
  const prerelease = match[4];
  if (prerelease?.split('.').some(
    identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')
  )) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return {
    version,
    tag: `v${version}`,
    prerelease: prerelease !== undefined,
    channel: prerelease === undefined ? 'stable' : 'prerelease'
  };
}

export function resolveProductVersion({
  root = repositoryRoot,
  env = process.env,
  tag
} = {}) {
  const requestedTag = tag?.trim();
  if (requestedTag !== undefined) {
    if (!requestedTag.startsWith('v')) {
      throw new Error(`Invalid release tag: ${requestedTag}`);
    }
    return parseReleaseVersion(requestedTag.slice(1));
  }
  const explicit = env.CLAWEE_VERSION?.trim();
  if (explicit) return parseReleaseVersion(explicit.startsWith('v') ? explicit.slice(1) : explicit);
  const refName = env.GITHUB_REF_NAME?.trim() ?? readGitTag(root);
  if (refName?.startsWith('v')) return parseReleaseVersion(refName.slice(1));
  const versionPath = resolve(root, 'VERSION');
  if (existsSync(versionPath)) {
    return parseReleaseVersion(readFileSync(versionPath, 'utf8').trim());
  }
  const packagePath = resolve(root, 'package.json');
  const packageVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  if (typeof packageVersion !== 'string') {
    throw new Error(`Product version is missing from ${packagePath}`);
  }
  return parseReleaseVersion(packageVersion);
}

function readGitTag(root) {
  try {
    return execFileSync('git', ['-C', root, 'describe', '--tags', '--exact-match', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return undefined;
  }
}
