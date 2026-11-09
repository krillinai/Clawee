import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseReleaseVersion,
  repositoryRoot,
  resolveProductVersion
} from './version.mjs';

export { parseReleaseVersion, resolveProductVersion } from './version.mjs';

export function inspectReleaseVersion(root = repositoryRoot, options = {}) {
  return resolveProductVersion({ root, env: options.env ?? process.env, tag: options.tag });
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
