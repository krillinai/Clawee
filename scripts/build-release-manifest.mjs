import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseReleaseVersion } from './release-version.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildReleaseManifest(input) {
  const artifactDirectory = resolve(input.artifactDirectory);
  const outputDirectory = resolve(input.outputDirectory ?? artifactDirectory);
  const release = parseReleaseVersion(input.version);
  if (input.tag !== release.tag) {
    throw new Error(`Release tag ${input.tag} does not match ${release.tag}`);
  }
  if (!/^[0-9a-f]{40}$/.test(input.commit)) {
    throw new Error(`Release commit must be a full Git SHA: ${input.commit}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) {
    throw new Error(`Invalid image digest: ${input.imageDigest}`);
  }
  const generatedAt = input.generatedAt === undefined
    ? new Date()
    : new Date(input.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error(`Invalid release manifest timestamp: ${input.generatedAt}`);
  }

  const files = listFiles(artifactDirectory)
    .filter(path => !['release-manifest.json', 'SHA256SUMS'].includes(basename(path)));
  if (files.length === 0) throw new Error('Release artifact directory is empty');

  const names = new Set();
  const artifacts = files.map(path => {
    const name = basename(path);
    if (names.has(name)) {
      throw new Error(`Duplicate release artifact filename: ${name}`);
    }
    names.add(name);
    return {
      name,
      source: relative(artifactDirectory, path).split(sep).join('/'),
      bytes: statSync(path).size,
      sha256: hashFile(path)
    };
  });
  const manifest = {
    schemaVersion: 1,
    product: 'Clawee',
    version: release.version,
    tag: release.tag,
    commit: input.commit,
    prerelease: release.prerelease,
    generatedAt: generatedAt.toISOString(),
    desktop: {
      macosSigning: 'developer-id-notarized',
      windowsSigning: 'unsigned'
    },
    serverImage: {
      name: input.image,
      digest: input.imageDigest
    },
    artifacts
  };

  mkdirSync(outputDirectory, { recursive: true });
  const manifestPath = join(outputDirectory, 'release-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumEntries = [
    ...artifacts.map(artifact => ({
      name: artifact.name,
      sha256: artifact.sha256
    })),
    {
      name: basename(manifestPath),
      sha256: hashFile(manifestPath)
    }
  ].sort((left, right) => left.name.localeCompare(right.name));
  const checksumsPath = join(outputDirectory, 'SHA256SUMS');
  writeFileSync(
    checksumsPath,
    checksumEntries.map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n'
  );
  return { manifest, manifestPath, checksumsPath };
}

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Release artifacts cannot contain symlinks: ${path}`);
    }
    if (info.isDirectory()) files.push(...listFiles(path));
    else if (info.isFile()) files.push(path);
  }
  return files.sort();
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readOption(args, name) {
  const prefix = `${name}=`;
  const inline = args.find(argument => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requiredOption(args, name) {
  const value = readOption(args, name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log([
      'Usage: node scripts/build-release-manifest.mjs',
      '  --artifacts <directory> --output <directory>',
      '  --version <version> --tag <tag> --commit <sha>',
      '  --image <name> --image-digest <sha256:digest>',
      '  [--generated-at <ISO timestamp>]'
    ].join('\n'));
    return;
  }
  const result = buildReleaseManifest({
    artifactDirectory: requiredOption(args, '--artifacts'),
    outputDirectory: requiredOption(args, '--output'),
    version: requiredOption(args, '--version'),
    tag: requiredOption(args, '--tag'),
    commit: requiredOption(args, '--commit'),
    image: requiredOption(args, '--image'),
    imageDigest: requiredOption(args, '--image-digest'),
    generatedAt: readOption(args, '--generated-at')
  });
  console.log(JSON.stringify({
    manifestPath: relative(repositoryRoot, result.manifestPath),
    checksumsPath: relative(repositoryRoot, result.checksumsPath)
  }));
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli();
}
