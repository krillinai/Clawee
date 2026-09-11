import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseReleaseVersion } from './release-version.mjs';

const { parse: parseYaml, stringify: stringifyYaml } = createRequire(
  new URL('../client/apps/daemon/package.json', import.meta.url)
)('yaml');

export function validateCosConfiguration(input) {
  const values = {};
  for (const name of ['bucket', 'region', 'publicBaseUrl', 'prefix']) {
    const value = input[name]?.trim();
    if (!value) throw new Error(`COS configuration ${name} is required`);
    values[name] = value;
  }
  if (!/^[a-z0-9][a-z0-9.-]*-\d+$/.test(values.bucket)) {
    throw new Error('COS bucket must include its APPID suffix');
  }
  if (!/^[a-z]+-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.region)) {
    throw new Error(`Invalid COS region: ${values.region}`);
  }
  const baseUrl = new URL(values.publicBaseUrl);
  if (
    baseUrl.protocol !== 'https:'
    || baseUrl.search !== ''
    || baseUrl.hash !== ''
    || baseUrl.pathname !== '/'
    || values.publicBaseUrl.endsWith('/')
  ) {
    throw new Error('COS public base URL must be an HTTPS origin without a trailing slash');
  }
  if (
    values.prefix.startsWith('/')
    || values.prefix.endsWith('/')
    || values.prefix.includes('..')
    || values.prefix.includes('\\')
    || values.prefix.includes('//')
    || values.prefix.split('/').some(part => !/^[A-Za-z0-9._-]+$/.test(part))
  ) {
    throw new Error(`Invalid COS prefix: ${values.prefix}`);
  }
  return values;
}

export function publicObjectUrl(config, key) {
  assertSafeRelativePath(key);
  return `${config.publicBaseUrl}/${[...config.prefix.split('/'), ...key.split('/')]
    .map(part => encodeURIComponent(part))
    .join('/')}`;
}

export function prepareReleaseLayout(input) {
  const config = validateCosConfiguration(input);
  const release = parseReleaseVersion(input.version);
  if (input.tag !== release.tag) {
    throw new Error(`Release tag ${input.tag} does not match ${release.tag}`);
  }
  if (!/^[0-9a-f]{40}$/.test(input.commit)) {
    throw new Error(`Release commit must be a full Git SHA: ${input.commit}`);
  }
  const manifest = JSON.parse(readFileSync(input.manifestPath, 'utf8'));
  if (
    manifest.version !== release.version
    || manifest.tag !== release.tag
    || manifest.commit !== input.commit
  ) {
    throw new Error('Unified release manifest does not match version, tag and commit');
  }
  const publishedAt = new Date(input.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) throw new Error('Invalid publishedAt');

  const versionRoot = resolve(input.outputDirectory, 'releases', release.tag);
  mkdirSync(versionRoot, { recursive: true });
  const sourceNames = new Set();
  const mapped = manifest.artifacts.map(artifact => {
    if (sourceNames.has(artifact.name)) {
      throw new Error(`Duplicate release artifact filename: ${artifact.name}`);
    }
    sourceNames.add(artifact.name);
    const source = resolve(input.artifactDirectory, artifact.source);
    assertWithin(input.artifactDirectory, source);
    const actual = fileDetails(source);
    if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
      throw new Error(`Release artifact changed after manifest generation: ${artifact.name}`);
    }
    return { artifact, source, ...classifyArtifact(artifact.name, release.version) };
  });

  const destinations = new Set();
  assertCompleteRelease(mapped);
  for (const item of mapped) {
    if (destinations.has(item.destination)) {
      throw new Error(`Duplicate COS release path: ${item.destination}`);
    }
    destinations.add(item.destination);
    const destination = join(versionRoot, item.destination);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(item.source, destination);
  }

  copyPublicFile(input.manifestPath, join(versionRoot, 'release-manifest.json'));
  writeReleaseNotes(input.releaseNotesPath, join(versionRoot, 'release-notes.md'));
  const updaterArtifacts = rewriteUpdaterFiles({
    mapped,
    release,
    config,
    versionRoot
  });
  const publicArtifacts = [
    ...mapped.filter(item => item.kind !== 'updater'),
    ...updaterArtifacts
  ].map(item => {
    const path = join(versionRoot, item.destination);
    const details = fileDetails(path);
    return {
      id: item.id,
      component: item.component,
      platform: item.platform,
      arch: item.arch,
      format: item.format,
      name: basename(item.destination),
      bytes: details.bytes,
      sha256: details.sha256,
      downloadUrl: publicObjectUrl(config, `releases/${release.tag}/${item.destination}`)
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const releaseDocument = {
    schemaVersion: 1,
    product: 'Clawee',
    version: release.version,
    tag: release.tag,
    channel: release.channel,
    commit: input.commit,
    publishedAt: publishedAt.toISOString(),
    releaseNotesUrl: publicObjectUrl(config, `releases/${release.tag}/release-notes.md`),
    artifacts: publicArtifacts,
    desktop: manifest.desktop,
    serverImage: manifest.serverImage
  };
  writeJson(join(versionRoot, 'release.json'), releaseDocument);
  writeChecksums(versionRoot);
  return { release: releaseDocument, versionRoot, channel: release.channel };
}

export function buildVersionsCatalog(input) {
  const release = input.release;
  const current = input.current ?? {
    schemaVersion: 1,
    product: 'Clawee',
    channel: release.channel,
    generatedAt: release.publishedAt,
    versions: []
  };
  if (
    current.schemaVersion !== 1
    || current.product !== 'Clawee'
    || current.channel !== release.channel
    || !Array.isArray(current.versions)
  ) {
    throw new Error('Invalid current versions catalog');
  }
  const existing = current.versions.find(item => item.version === release.version);
  const nextEntry = {
    version: release.version,
    tag: release.tag,
    publishedAt: release.publishedAt,
    releaseUrl: input.releaseUrl
  };
  if (existing && JSON.stringify(existing) !== JSON.stringify(nextEntry)) {
    throw new Error(`Version ${release.version} already exists with different metadata`);
  }
  const versions = [
    nextEntry,
    ...current.versions.filter(item => item.version !== release.version)
  ].sort((left, right) => compareSemanticVersions(right.version, left.version));
  return {
    schemaVersion: 1,
    product: 'Clawee',
    channel: release.channel,
    generatedAt: release.publishedAt,
    versions
  };
}

export function assertCanPromote(currentRelease, nextRelease) {
  if (!currentRelease) return 'new';
  if (currentRelease.channel !== nextRelease.channel) {
    throw new Error('Cannot compare releases from different channels');
  }
  const comparison = compareSemanticVersions(nextRelease.version, currentRelease.version);
  if (comparison < 0) {
    throw new Error(`Refusing to downgrade ${currentRelease.version} to ${nextRelease.version}`);
  }
  if (comparison === 0) {
    if (JSON.stringify(currentRelease) !== JSON.stringify(nextRelease)) {
      throw new Error(`Version ${nextRelease.version} already points to different content`);
    }
    return 'same';
  }
  return 'new';
}

export function compareSemanticVersions(left, right) {
  const a = parseSemverParts(left);
  const b = parseSemverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const leftPart = a.pre[index];
    const rightPart = b.pre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart);
    const rightNumber = /^\d+$/.test(rightPart);
    if (leftNumber && rightNumber) return Math.sign(Number(leftPart) - Number(rightPart));
    if (leftNumber) return -1;
    if (rightNumber) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function rewriteUpdaterFiles({ mapped, release, config, versionRoot }) {
  const artifactByName = new Map(mapped
    .filter(item => item.kind !== 'updater')
    .map(item => [item.artifact.name, item]));
  return mapped.filter(item => item.kind === 'updater').map(item => {
    const document = parseYaml(readFileSync(item.source, 'utf8'));
    if (document?.version !== release.version || !Array.isArray(document.files) || document.files.length === 0) {
      throw new Error(`Invalid updater metadata: ${item.artifact.name}`);
    }
    const references = new Set();
    const rewrite = (value, expectedSha512, expectedSize) => {
      if (typeof value !== 'string' || basename(value) !== value || value.includes('..')) {
        throw new Error(`Unsafe updater artifact reference: ${value}`);
      }
      if (references.has(value)) throw new Error(`Duplicate updater artifact reference: ${value}`);
      references.add(value);
      const target = artifactByName.get(value);
      if (!target || target.platform !== item.platform || target.arch !== item.arch) {
        throw new Error(`Updater metadata references an unknown release artifact: ${value}`);
      }
      const content = readFileSync(target.source);
      const sha512 = createHash('sha512').update(content).digest('base64');
      if (expectedSha512 !== sha512 || (expectedSize !== undefined && expectedSize !== content.length)) {
        throw new Error(`Updater checksum or size mismatch: ${value}`);
      }
      return publicObjectUrl(config, `releases/${release.tag}/${target.destination}`);
    };
    for (const file of document.files) file.url = rewrite(file.url, file.sha512, file.size);
    if (document.path !== undefined) {
      const target = artifactByName.get(document.path);
      if (!target || target.platform !== item.platform || target.arch !== item.arch) {
        throw new Error(`Updater metadata references an unknown release artifact: ${document.path}`);
      }
      const content = target && readFileSync(target.source);
      const sha512 = content && createHash('sha512').update(content).digest('base64');
      if (document.sha512 !== sha512) throw new Error(`Updater checksum mismatch: ${document.path}`);
      document.path = publicObjectUrl(config, `releases/${release.tag}/${target.destination}`);
    }
    const destination = `updates/${item.artifact.name}`;
    writeFileSync(join(versionRoot, destination), stringifyYaml(document));
    return { ...item, destination };
  });
}

function assertCompleteRelease(mapped) {
  const destinations = new Set(mapped.map(item => item.destination));
  const required = [
    'updates/latest.yml',
    'updates/latest-mac.yml',
    'updates/latest-arm64-mac.yml'
  ];
  for (const [platform, arch, formats] of [
    ['macos', 'x64', ['dmg', 'zip', 'json']],
    ['macos', 'arm64', ['dmg', 'zip', 'json']],
    ['windows', 'x64', ['exe', 'json']],
    ['linux', 'amd64', ['tar.gz', 'sha256']],
    ['linux', 'arm64', ['tar.gz', 'sha256']]
  ]) {
    for (const format of formats) {
      if (!mapped.some(item => item.platform === platform && item.arch === arch && item.format === format)) {
        required.push(`${platform}/${arch}/${format}`);
      }
    }
  }
  const missing = required.filter(value => value.includes('/') && !destinations.has(value));
  if (missing.length > 0) {
    throw new Error(`Release artifact set is incomplete: ${missing.join(', ')}`);
  }
  for (const updaterItem of mapped.filter(item => item.kind === 'updater')) {
    const document = parseYaml(readFileSync(updaterItem.source, 'utf8'));
    const updatePath = document?.path;
    if (typeof updatePath !== 'string' || !mapped.some(item => item.artifact.name === `${updatePath}.blockmap`)) {
      throw new Error(`Updater blockmap is missing: ${updatePath}`);
    }
  }
}

function classifyArtifact(name, version) {
  if (name === 'latest.yml') return updater('windows', 'x64', name);
  if (name === 'latest-mac.yml') return updater('macos', 'x64', name);
  if (name === 'latest-arm64-mac.yml') return updater('macos', 'arm64', name);
  const server = new RegExp(`^clawee-server-v${escapeRegex(version)}-linux-(amd64|arm64)\\.tar\\.gz$`).exec(name);
  if (server) return artifact('server', 'linux', server[1], 'tar.gz', `server/linux/${server[1]}/${name}`, name);
  const serverSum = /^server-linux-(amd64|arm64)-SHA256SUMS$/.exec(name);
  if (serverSum) return artifact('server', 'linux', serverSum[1], 'sha256', `server/linux/${serverSum[1]}/${name}`, name);
  const build = /^clawee-desktop-build-manifest-(mac|win)-(x64|arm64)\.json$/.exec(name);
  if (build) {
    const platform = build[1] === 'mac' ? 'macos' : 'windows';
    return artifact('desktop', platform, build[2], 'json', `desktop/${platform}/${build[2]}/${name}`, name);
  }
  if (name === `Clawee-Setup-${version}.exe` || name === `Clawee-Setup-${version}.exe.blockmap`) {
    const format = name.endsWith('.blockmap') ? 'blockmap' : 'exe';
    return artifact('desktop', 'windows', 'x64', format, `desktop/windows/x64/${name}`, name);
  }
  const desktop = new RegExp(`^Clawee-${escapeRegex(version)}(-arm64)?\\.(dmg|zip)(\\.blockmap)?$`).exec(name);
  if (desktop) {
    const arch = desktop[1] ? 'arm64' : 'x64';
    const format = desktop[3] ? 'blockmap' : desktop[2];
    return artifact('desktop', 'macos', arch, format, `desktop/macos/${arch}/${name}`, name);
  }
  throw new Error(`Unknown release artifact: ${name}`);
}

function artifact(component, platform, arch, format, destination, name) {
  return {
    kind: 'artifact', component, platform, arch, format, destination,
    id: `${component}-${platform}-${arch}-${format}-${slug(name)}`
  };
}

function updater(platform, arch, name) {
  return {
    kind: 'updater', component: 'desktop', platform, arch, format: 'yml',
    destination: `updates/${name}`,
    id: `desktop-${platform}-${arch}-updater-yml`
  };
}

function writeChecksums(root) {
  const files = listFiles(root)
    .filter(path => basename(path) !== 'SHA256SUMS')
    .map(path => ({
      path: relative(root, path).split(sep).join('/'),
      sha256: fileDetails(path).sha256
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  writeFileSync(join(root, 'SHA256SUMS'), files.map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n');
}

function listFiles(root) {
  const { readdirSync, lstatSync } = createRequire(import.meta.url)('node:fs');
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`Release layout cannot contain symlinks: ${path}`);
    return info.isDirectory() ? listFiles(path) : info.isFile() ? [path] : [];
  });
}

function copyPublicFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function writeReleaseNotes(source, destination) {
  const warning = 'Windows x64 安装包当前未进行 Authenticode 签名。';
  const content = readFileSync(source, 'utf8').trimEnd();
  const output = content.includes(warning)
    ? `${content}\n`
    : `${content}${content ? '\n\n' : ''}## 平台说明\n\n- ${warning}\n`;
  writeFileSync(destination, output);
}

function fileDetails(path) {
  const content = readFileSync(path);
  return { bytes: statSync(path).size, sha256: createHash('sha256').update(content).digest('hex') };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assertWithin(root, path) {
  const value = relative(resolve(root), resolve(path));
  if (value === '..' || value.startsWith(`..${sep}`) || value === '') {
    throw new Error(`Path is outside the artifact directory: ${path}`);
  }
}

function assertSafeRelativePath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error(`Unsafe COS object path: ${path}`);
  }
}

function parseSemverParts(version) {
  parseReleaseVersion(version);
  const [core, prerelease = ''] = version.split('-', 2);
  return { core: core.split('.').map(Number), pre: prerelease ? prerelease.split('.') : [] };
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
